import { NextResponse } from "next/server";

import { buildApifyInputFromRow, getDatasetItems, startActorRun, waitForRunToFinish } from "@/lib/apify";
import { getAuthorizedGoogleAuthOrAuthUrl } from "@/lib/googleAuth";
import { google, sheets_v4 } from "googleapis";
import { getRow, rowToDict, setCell, appendRows } from "@/lib/sheets";
import { runState } from "../runState";

export const runtime = "nodejs";

type StepBody = {
  runId?: string;
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

function toJoinedLines(v: unknown, separator = "\n") {
  if (!v) return "";
  if (Array.isArray(v)) return v.map((x) => toStringOrEmpty(x)).filter(Boolean).join(separator);
  return toStringOrEmpty(v);
}

function normalizeWeekday(rawDay: string) {
  const cleaned = rawDay.trim().toLowerCase();
  const map: Record<string, string> = {
    monday: "Monday",
    mon: "Monday",
    tuesday: "Tuesday",
    tue: "Tuesday",
    tues: "Tuesday",
    wednesday: "Wednesday",
    wed: "Wednesday",
    thursday: "Thursday",
    thu: "Thursday",
    thurs: "Thursday",
    friday: "Friday",
    fri: "Friday",
    saturday: "Saturday",
    sat: "Saturday",
    sunday: "Sunday",
    sun: "Sunday",
  };
  return map[cleaned] ?? rawDay.trim();
}

function getMeridiem(raw: string) {
  const m = raw.match(/\b(am|pm)\b/i);
  return m ? m[1].toUpperCase() : "";
}

function normalizeTime(raw: string, fallbackMeridiem = "") {
  const cleaned = raw
    .replace(/\u202f/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  const m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return raw.trim();
  const hour = Number(m[1]);
  const minute = m[2] ?? "00";
  const meridiem = m[3] ?? fallbackMeridiem;
  if (!meridiem) return `${hour}:${minute} AM`;
  return minute === "00" ? `${hour} ${meridiem}` : `${hour}:${minute} ${meridiem}`;
}

function normalizeHoursRanges(rawHours: string) {
  const cleaned = rawHours
    .replace(/\u202f/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (/^closed$/i.test(cleaned)) return "Closed";

  const ranges = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
  const formattedRanges = ranges
    .map((range) => {
      const parts = range.split(/\s+to\s+/i);
      if (parts.length !== 2) return normalizeTime(range);
      const startRaw = parts[0].trim();
      const endRaw = parts[1].trim();
      const end = normalizeTime(endRaw);
      const endMeridiem = getMeridiem(endRaw);
      const start = normalizeTime(startRaw, endMeridiem);
      return `${start} to ${end}`;
    })
    .filter(Boolean);
  return formattedRanges.join(", ");
}

function toOpeningHoursText(item: Record<string, unknown>) {
  const v = getItemField(item, ["openingHours", "opening_hours", "openingHoursText", "openingHoursOpenDays"]);
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const formatted = v
      .map((x) => {
        if (!x || typeof x !== "object") return toStringOrEmpty(x);
        const obj = x as Record<string, unknown>;
        const rawDay = toStringOrEmpty(obj.day ?? obj.weekday ?? obj.name);
        const rawHours = toStringOrEmpty(obj.hours ?? obj.open ?? obj.time);
        if (!rawDay) return toStringOrEmpty(x);
        const day = normalizeWeekday(rawDay);
        const hours = normalizeHoursRanges(rawHours);
        return `${day} - ${hours || "Closed"}`;
      })
      .filter(Boolean);
    return formatted.join("\n");
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const weekdayText = obj.weekdayText;
    if (Array.isArray(weekdayText)) {
      return weekdayText.map((x) => toStringOrEmpty(x)).filter(Boolean).join("\n");
    }
  }
  return toStringOrEmpty(v);
}

function normalizePhoneNumber(raw: unknown) {
  const str = toStringOrEmpty(raw);
  if (!str) return "";
  return str.replace(/[^\d]/g, "");
}

function makeSummary(done: boolean) {
  const run = runState.currentRun;
  if (!run) return null;
  return {
    ok: true,
    runId: run.runId,
    settingsSheetName: run.settingsSheetName,
    leadsSheetName: run.leadsSheetName || undefined,
    startRow: run.startRow,
    endRow: run.endRow,
    processed: run.processed,
    skipped: run.skipped,
    totalLeads: run.totalLeads,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    perRow: run.perRow,
    done,
  };
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

    const run = runState.currentRun;
    if (!run) {
      return NextResponse.json({ error: "no_active_run", message: "No active run." }, { status: 400 });
    }

    let body: StepBody = {};
    try {
      body = (await req.json()) as StepBody;
    } catch {
      body = {};
    }

    if (body.runId && body.runId !== run.runId) {
      return NextResponse.json({ error: "run_mismatch", message: "Run id mismatch." }, { status: 400 });
    }

    const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

    const cancelBatch = 10;
    if (runState.cancelRequested) {
      let processedCount = 0;
      while (run.currentIndex < run.rowNumbers.length && processedCount < cancelBatch) {
        const rowNumber = run.rowNumbers[run.currentIndex];
        const cancelledAt = new Date();
        run.skipped += 1;
        await setCell(
          sheets,
          run.spreadsheetId,
          run.settingsSheetName,
          rowNumber,
          run.scrapeStatusCol,
          `FAILED on ${fmtDateTime(cancelledAt)}`,
        );
        await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.commentsCol, "Cancelled by user.");
        await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.statusCol, "Failed");
        await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.scrapedCol, "N");
        await setCell(
          sheets,
          run.spreadsheetId,
          run.settingsSheetName,
          rowNumber,
          run.pushStatusCol,
          `0 leads scraped — Started: ${fmtDateTime(cancelledAt)}, Finished: ${fmtDateTime(cancelledAt)} — CANCELLED`,
        );
        run.perRow.push({ row: rowNumber, status: "skipped", message: "Cancelled by user." });
        run.currentIndex += 1;
        processedCount += 1;
      }
      const done = run.currentIndex >= run.rowNumbers.length;
      if (done) run.finishedAt = fmtDateTime(new Date());
      const summary = makeSummary(done);
      if (done) runState.currentRun = null;
      return NextResponse.json(summary);
    }

    if (run.currentIndex >= run.rowNumbers.length) {
      if (!run.finishedAt) run.finishedAt = fmtDateTime(new Date());
      const summary = makeSummary(true);
      runState.currentRun = null;
      return NextResponse.json(summary);
    }

    const rowNumber = run.rowNumbers[run.currentIndex];
    const rowValues = await getRow(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber);
    const rowDict = rowToDict(run.headersAfterEnsure, rowValues);

    const scrapedVal = getFromRowCaseInsensitive(rowDict, "Scraped").trim().toUpperCase();
    if (scrapedVal === "Y") {
      run.skipped += 1;
      run.perRow.push({ row: rowNumber, status: "skipped", message: "Already completed (Scraped = Y)." });
      run.currentIndex += 1;
      return NextResponse.json(makeSummary(false));
    }

    const apifyToken =
      getFromRowCaseInsensitive(rowDict, run.apifyTokenHeader).trim() ||
      (process.env.APIFY_TOKEN ?? "").trim();

    const input = buildApifyInputFromRow(rowDict);
    const hasRequired = "locationQuery" in input && "searchStringsArray" in input;
    if (!apifyToken || !hasRequired) {
      run.skipped += 1;
      const skippedAt = new Date();
      const reason = !apifyToken
        ? `Missing Apify token in '${run.apifyTokenHeader}'.`
        : "Missing 'Search Location' or 'Sub-Niches'.";
      await setCell(
        sheets,
        run.spreadsheetId,
        run.settingsSheetName,
        rowNumber,
        run.scrapeStatusCol,
        `FAILED on ${fmtDateTime(skippedAt)}`,
      );
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.commentsCol, reason);
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.statusCol, "Failed");
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.scrapedCol, "N");
      await setCell(
        sheets,
        run.spreadsheetId,
        run.settingsSheetName,
        rowNumber,
        run.pushStatusCol,
        `0 leads scraped — Started: ${fmtDateTime(skippedAt)}, Finished: ${fmtDateTime(skippedAt)} — SKIPPED — ${reason}`,
      );
      run.perRow.push({ row: rowNumber, status: "skipped", message: reason });
      run.currentIndex += 1;
      return NextResponse.json(makeSummary(false));
    }

    run.processed += 1;
    const startedAt = new Date();

    try {
      await setCell(
        sheets,
        run.spreadsheetId,
        run.settingsSheetName,
        rowNumber,
        run.scrapeStatusCol,
        `RUNNING on ${fmtDateTime(startedAt)}`,
      );

      const startRun = await startActorRun({ token: apifyToken, input });
      runState.activeRunId = (startRun.id ?? "") as string;
      runState.activeToken = apifyToken;
      if (!runState.activeRunId) throw new Error("Apify run did not return run id");

      const runResult = await waitForRunToFinish({ token: apifyToken, runId: runState.activeRunId });
      const legacy = runResult as { defaultDatasetID?: string };
      const datasetId = (runResult.defaultDatasetId ?? legacy.defaultDatasetID ?? "") as string;
      const status = (runResult.status ?? "") as string;

      runState.activeRunId = null;
      runState.activeToken = null;

      if (runState.cancelRequested || status.toUpperCase() === "ABORTED") {
        const finishedAt = new Date();
        await setCell(
          sheets,
          run.spreadsheetId,
          run.settingsSheetName,
          rowNumber,
          run.scrapeStatusCol,
          `FAILED on ${fmtDateTime(finishedAt)}`,
        );
        await setCell(
          sheets,
          run.spreadsheetId,
          run.settingsSheetName,
          rowNumber,
          run.commentsCol,
          "Cancelled by user.",
        );
        await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.statusCol, "Failed");
        await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.scrapedCol, "N");
        await setCell(
          sheets,
          run.spreadsheetId,
          run.settingsSheetName,
          rowNumber,
          run.pushStatusCol,
          `0 leads scraped — Started: ${fmtDateTime(startedAt)}, Finished: ${fmtDateTime(finishedAt)} — CANCELLED`,
        );
        run.perRow.push({ row: rowNumber, status: "skipped", message: "Cancelled by user." });
        run.currentIndex += 1;
        return NextResponse.json(makeSummary(false));
      }

      if (!datasetId) throw new Error("Apify run did not return defaultDatasetId");

      const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`;
      const items = await getDatasetItems({ token: apifyToken, datasetId });

      let leadRows: string[][] = [];
      if (run.leadsSheetName) {
        const nowStr = fmtDateTime(new Date());
        leadRows = items
          .map((item) => {
            const uniqueId = toStringOrEmpty(getItemField(item, ["placeId", "place_id", "id", "placeID"])).trim();
            if (uniqueId && run.existingUniqueIds.has(uniqueId)) {
              return null;
            }
            if (uniqueId) run.existingUniqueIds.add(uniqueId);
            return run.leadsHeaders.map((h) => {
              const header = (h ?? "").trim();
              if (!header) return "";
              switch (header) {
                case "Unique ID":
                  return uniqueId;
                case "Business Name":
                  return toStringOrEmpty(getItemField(item, ["title", "name"]));
                case "Opening Hours":
                  return toOpeningHoursText(item);
                case "Comments":
                  return "";
                case "Phone Number":
                  return normalizePhoneNumber(getItemField(item, ["phone", "phoneNumber"]));
                case "Other Phones": {
                  const phones = getItemField(item, ["phones", "phoneNumbers", "otherPhones"]);
                  if (Array.isArray(phones)) return phones.map(normalizePhoneNumber).filter(Boolean).join(" | ");
                  return normalizePhoneNumber(phones);
                }
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
                case "List of Services": {
                  const categories = getItemField(item, ["categories", "categoryName", "category"]);
                  if (Array.isArray(categories)) return categories.map(toStringOrEmpty).filter(Boolean).join(" | ");
                  return toStringOrEmpty(categories);
                }
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
          })
          .filter((row): row is string[] => Array.isArray(row));
        await appendRows(sheets, run.spreadsheetId, run.leadsSheetName, leadRows);
      }

      const leadsCount = leadRows.length;
      run.totalLeads += leadsCount;
      const finishedAt = new Date();
      const pushStatus = `${leadsCount} leads scraped — Started: ${fmtDateTime(startedAt)}, Finished: ${fmtDateTime(
        finishedAt,
      )}`;

      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.datasetCol, datasetUrl);
      await setCell(
        sheets,
        run.spreadsheetId,
        run.settingsSheetName,
        rowNumber,
        run.scrapeStatusCol,
        `COMPLETED on ${fmtDateTime(finishedAt)}`,
      );
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.commentsCol, "");
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.statusCol, "Completed");
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.pushStatusCol, pushStatus);
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.scrapedCol, "Y");

      run.perRow.push({ row: rowNumber, status: "succeeded", datasetUrl, leads: leadsCount });
    } catch (e) {
      const finishedAt = new Date();
      const msg = e instanceof Error ? e.message : String(e);
      await setCell(
        sheets,
        run.spreadsheetId,
        run.settingsSheetName,
        rowNumber,
        run.scrapeStatusCol,
        `FAILED on ${fmtDateTime(finishedAt)}`,
      );
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.commentsCol, msg);
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.statusCol, "Failed");
      await setCell(sheets, run.spreadsheetId, run.settingsSheetName, rowNumber, run.scrapedCol, "N");
      await setCell(
        sheets,
        run.spreadsheetId,
        run.settingsSheetName,
        rowNumber,
        run.pushStatusCol,
        `0 leads scraped — Started: ${fmtDateTime(startedAt)}, Finished: ${fmtDateTime(finishedAt)} — ${msg}`,
      );
      run.perRow.push({ row: rowNumber, status: "failed", message: msg });
    }

    run.currentIndex += 1;

    const done = run.currentIndex >= run.rowNumbers.length;
    if (done) run.finishedAt = fmtDateTime(new Date());
    const summary = makeSummary(done);
    if (done) runState.currentRun = null;
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: "server_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
