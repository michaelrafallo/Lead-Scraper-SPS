import { NextResponse } from "next/server";

import { buildApifyInputFromRow, getDatasetItems, runActor } from "@/lib/apify";
import { getAuthorizedGoogleAuthOrAuthUrl } from "@/lib/googleAuth";
import { google, sheets_v4 } from "googleapis";
import {
  DEFAULT_NICHE_SETTINGS_TAB,
  DEFAULT_SPREADSHEET_ID,
  appendRows,
  ensureHeader,
  getRow,
  getRows,
  rowToDict,
  setCell,
} from "@/lib/sheets";

export const runtime = "nodejs";

type RunBody = {
  spreadsheetId?: string;
  // Backward compatible: old clients send sheetName; new UI sends settingsSheetName.
  sheetName?: string;
  settingsSheetName?: string;
  leadsSheetName?: string;
  apifyToken?: string;
  datasetUrlHeader?: string;
  apifyTokenHeader?: string;
  startRow?: number;
  endRow?: number;
};

function getFromRowCaseInsensitive(row: Record<string, string>, headerName: string) {
  const want = headerName.trim().toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if ((k ?? "").trim().toLowerCase() === want) return (v ?? "").toString();
  }
  return "";
}

function fmtDateTime(d: Date) {
  return d.toLocaleString("en-AU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function getItemField(item: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = item[k];
    if (v === undefined || v === null) continue;
    return v;
  }
  return undefined;
}

function toStringOrEmpty(v: unknown) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function toFirstUrl(v: unknown) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return "";
}

function toJoinedLines(v: unknown) {
  if (!v) return "";
  if (Array.isArray(v)) return v.map((x) => toStringOrEmpty(x)).filter(Boolean).join("\n");
  return toStringOrEmpty(v);
}

function toOpeningHoursText(item: Record<string, unknown>) {
  const v = getItemField(item, ["openingHours", "opening_hours", "openingHoursText", "openingHoursOpenDays"]);
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => toStringOrEmpty(x)).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Common shapes: { weekdayText: [...] } or { periods: [...], weekdayText: [...] }
    const weekdayText = obj.weekdayText;
    if (Array.isArray(weekdayText)) {
      return weekdayText.map((x) => toStringOrEmpty(x)).filter(Boolean).join("\n");
    }
  }
  return toStringOrEmpty(v);
}

export async function POST(req: Request) {
  try {
    const { auth, authUrl } = getAuthorizedGoogleAuthOrAuthUrl();
    if (!auth) {
      return NextResponse.json(
        {
          error: "not_authorized",
          message: "Authorize Google Sheets access first.",
          authUrl,
        },
        { status: 401 },
      );
    }

    let body: RunBody = {};
    try {
      body = (await req.json()) as RunBody;
    } catch {
      body = {};
    }

    const spreadsheetId = (body.spreadsheetId ?? process.env.SPREADSHEET_ID ?? DEFAULT_SPREADSHEET_ID).trim();
    const settingsSheetName = (
      body.settingsSheetName ??
      body.sheetName ??
      process.env.NICHE_SETTINGS_TAB_NAME ??
      DEFAULT_NICHE_SETTINGS_TAB
    ).trim();
    const leadsSheetName = (body.leadsSheetName ?? process.env.LEADS_TAB_NAME ?? "").trim();

    const datasetUrlHeader = (body.datasetUrlHeader ?? process.env.DATASET_URL_HEADER ?? "Dataset URL").trim();
    const apifyTokenHeader = (body.apifyTokenHeader ?? process.env.APIFY_TOKEN_HEADER ?? "Apify API Key").trim();

    const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

    const startRow = Math.max(2, Math.floor(body.startRow ?? 2));
    const endRow = Math.max(startRow, Math.floor(body.endRow ?? startRow));

    // Ensure required status headers exist (once).
    const datasetCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, datasetUrlHeader);
    const scrapedCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Scraped");
    const scrapeStatusCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Google-Maps Scrape Status");
    const pushStatusCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Google-Maps Push Status");

    // Re-read headers in case ensureHeader appended new ones.
    const headersAfterEnsure = await getRow(sheets, spreadsheetId, settingsSheetName, 1);

    // Leads sheet headers (if provided).
    const leadsHeaders = leadsSheetName ? await getRow(sheets, spreadsheetId, leadsSheetName, 1) : [];
    if (leadsSheetName && !leadsHeaders.length) {
      return NextResponse.json(
        {
          error: "missing_leads_headers",
          message: `Leads tab '${leadsSheetName}' has no header row (row 1). Please add headers.`,
        },
        { status: 400 },
      );
    }

    const rows = await getRows(sheets, spreadsheetId, settingsSheetName, startRow, endRow);

    const startedAtAll = new Date();
    let processed = 0;
    let skipped = 0;
    let totalLeads = 0;
    const perRow: Array<{
      row: number;
      status: "skipped" | "succeeded" | "failed";
      message?: string;
      datasetUrl?: string;
      leads?: number;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = startRow + i;
      const rowValues = rows[i] ?? [];
      const rowDict = rowToDict(headersAfterEnsure, rowValues);

      // If already completed, skip to next row.
      const scrapedVal = getFromRowCaseInsensitive(rowDict, "Scraped").trim().toUpperCase();
      if (scrapedVal === "Y") {
        skipped += 1;
        perRow.push({
          row: rowNumber,
          status: "skipped",
          message: "Already completed (Scraped = Y).",
        });
        continue;
      }

      // Apify token: always per-row (sheet), but allow env override if present.
      const apifyToken =
        getFromRowCaseInsensitive(rowDict, apifyTokenHeader).trim() ||
        (process.env.APIFY_TOKEN ?? "").trim() ||
        (body.apifyToken ?? "").trim();

      const input = buildApifyInputFromRow(rowDict);
      const hasRequired = "locationQuery" in input && "searchStringsArray" in input;
      if (!apifyToken || !hasRequired) {
        skipped += 1;
        const skippedAt = new Date();
        const reason = !apifyToken
          ? `Missing Apify token in '${apifyTokenHeader}'.`
          : "Missing 'Search Location' or 'Sub-Niches'.";
        // Fill empty status cells so the sheet reflects why this row didn't run.
        await setCell(
          sheets,
          spreadsheetId,
          settingsSheetName,
          rowNumber,
          scrapeStatusCol,
          `SKIPPED on ${fmtDateTime(skippedAt)} — ${reason}`,
        );
        await setCell(
          sheets,
          spreadsheetId,
          settingsSheetName,
          rowNumber,
          pushStatusCol,
          `0 leads scraped — Started: ${fmtDateTime(skippedAt)}, Finished: ${fmtDateTime(skippedAt)} — SKIPPED — ${reason}`,
        );
        perRow.push({
          row: rowNumber,
          status: "skipped",
          message: reason,
        });
        continue;
      }

      processed += 1;
      const startedAt = new Date();

      try {
        // Mark as running immediately (do NOT set Scraped=Y here).
        await setCell(
          sheets,
          spreadsheetId,
          settingsSheetName,
          rowNumber,
          scrapeStatusCol,
          `RUNNING on ${fmtDateTime(startedAt)}`,
        );
        await setCell(
          sheets,
          spreadsheetId,
          settingsSheetName,
          rowNumber,
          pushStatusCol,
          `0 leads scraped — Started: ${fmtDateTime(startedAt)}, Finished:`,
        );

        const run = await runActor({ token: apifyToken, input });
        const legacy = run as { defaultDatasetID?: string };
        const datasetId = (run.defaultDatasetId ?? legacy.defaultDatasetID ?? "") as string;
        const status = (run.status ?? "") as string;
        if (!datasetId) throw new Error("Apify run did not return defaultDatasetId");

        const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items`;
        const items = await getDatasetItems({ token: apifyToken, datasetId });
        const leadsCount = items.length;
        totalLeads += leadsCount;

        // Append leads (best-effort mapping) if leads tab selected.
        if (leadsSheetName) {
          const nowStr = fmtDateTime(new Date());
          const leadRows: string[][] = items.map((item) => {
            return leadsHeaders.map((h) => {
              const header = (h ?? "").trim();
              if (!header) return "";

              switch (header) {
                case "Unique ID":
                  return toStringOrEmpty(getItemField(item, ["placeId", "place_id", "id", "placeID"]));
                case "Business Name":
                  return toStringOrEmpty(getItemField(item, ["title", "name"]));
                case "Opening Hours":
                  return toOpeningHoursText(item);
                case "Comments":
                  return toStringOrEmpty(getItemField(item, ["description", "about", "additionalInfo"]));
                case "Phone Number":
                  return toStringOrEmpty(getItemField(item, ["phone", "phoneNumber"]));
                case "Other Phones":
                  return toJoinedLines(getItemField(item, ["phones", "phoneNumbers", "otherPhones"]));
                case "Email": {
                  const emails = getItemField(item, ["emails", "email"]);
                  if (Array.isArray(emails)) return toStringOrEmpty(emails[0]);
                  return toStringOrEmpty(emails);
                }
                case "Other Emails": {
                  const emails = getItemField(item, ["emails"]);
                  if (Array.isArray(emails)) return emails.slice(1).map(toStringOrEmpty).filter(Boolean).join("\n");
                  return "";
                }
                case "Website URL":
                  return toStringOrEmpty(getItemField(item, ["website", "web", "domain"]));
                case "Address Street":
                  return toStringOrEmpty(
                    getItemField(item, ["street", "streetAddress", "addressStreet", "address_street"]),
                  );
                case "Address City":
                  return toStringOrEmpty(getItemField(item, ["city", "addressCity"]));
                case "Address State":
                  return toStringOrEmpty(getItemField(item, ["state", "region", "addressState"]));
                case "Address Postal Code":
                  return toStringOrEmpty(getItemField(item, ["postalCode", "zip", "addressPostalCode"]));
                case "Address Country Code":
                  return toStringOrEmpty(getItemField(item, ["countryCode", "addressCountryCode"]));
                case "List of Services":
                  return toStringOrEmpty(getItemField(item, ["categoryName", "category", "categories"]));
                case "Facebook URL":
                  return toFirstUrl(getItemField(item, ["facebook", "facebooks"]));
                case "LinkedIn URL":
                  return toFirstUrl(getItemField(item, ["linkedIn", "linkedIns", "linkedin", "linkedins"]));
                case "Twitter URL":
                  return toFirstUrl(getItemField(item, ["twitter", "twitters"]));
                case "Instagram URL":
                  return toFirstUrl(getItemField(item, ["instagram", "instagrams"]));
                case "Youtube URL":
                  return toFirstUrl(getItemField(item, ["youtube", "youtubes"]));
                case "Tiktok URL":
                  return toFirstUrl(getItemField(item, ["tiktok", "tiktoks"]));
                case "Pinterest URL":
                  return toFirstUrl(getItemField(item, ["pinterest", "pinterests"]));
                case "Discord URL":
                  return toFirstUrl(getItemField(item, ["discord", "discords"]));
                case "Google My Business URL":
                  return toStringOrEmpty(getItemField(item, ["placeUrl", "googleBusinessUrl", "gmbUrl"]));
                case "Google Maps URL":
                  return toStringOrEmpty(getItemField(item, ["url", "googleMapsUrl", "mapsUrl"]));
                case "Search Word":
                  return toStringOrEmpty(getItemField(item, ["searchString", "searchTerm", "keyword"]));
                case "Date First Added":
                  return nowStr;
                default:
                  return "";
              }
            });
          });
          await appendRows(sheets, spreadsheetId, leadsSheetName, leadRows);
        }

        const finishedAt = new Date();
        const scrapeStatus = `${status || "SUCCEEDED"} on ${fmtDateTime(finishedAt)}`;
        const pushStatus = `${leadsCount} leads scraped — Started: ${fmtDateTime(startedAt)}, Finished: ${fmtDateTime(
          finishedAt,
        )}`;

        await setCell(sheets, spreadsheetId, settingsSheetName, rowNumber, datasetCol, datasetUrl);
        await setCell(sheets, spreadsheetId, settingsSheetName, rowNumber, scrapeStatusCol, scrapeStatus);
        await setCell(sheets, spreadsheetId, settingsSheetName, rowNumber, pushStatusCol, pushStatus);
        await setCell(sheets, spreadsheetId, settingsSheetName, rowNumber, scrapedCol, "Y");

        perRow.push({ row: rowNumber, status: "succeeded", datasetUrl, leads: leadsCount });
      } catch (e) {
        const finishedAt = new Date();
        const msg = e instanceof Error ? e.message : String(e);
        const scrapeStatus = `FAILED on ${fmtDateTime(finishedAt)}`;
        await setCell(sheets, spreadsheetId, settingsSheetName, rowNumber, scrapeStatusCol, scrapeStatus);
        await setCell(
          sheets,
          spreadsheetId,
          settingsSheetName,
          rowNumber,
          pushStatusCol,
          `0 leads scraped — Started: ${fmtDateTime(startedAt)}, Finished: ${fmtDateTime(finishedAt)} — ${msg}`,
        );
        perRow.push({ row: rowNumber, status: "failed", message: msg });
      }
    }

    const finishedAtAll = new Date();
    return NextResponse.json({
      ok: true,
      settingsSheetName,
      leadsSheetName: leadsSheetName || undefined,
      startRow,
      endRow,
      processed,
      skipped,
      totalLeads,
      startedAt: fmtDateTime(startedAtAll),
      finishedAt: fmtDateTime(finishedAtAll),
      perRow,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "server_error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

