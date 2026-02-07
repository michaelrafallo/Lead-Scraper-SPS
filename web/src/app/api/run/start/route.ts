import { NextResponse } from "next/server";
import crypto from "crypto";

import { getAuthorizedGoogleAuthOrAuthUrl } from "@/lib/googleAuth";
import { google, sheets_v4 } from "googleapis";
import {
  DEFAULT_NICHE_SETTINGS_TAB,
  DEFAULT_SPREADSHEET_ID,
  ensureHeader,
  getRow,
} from "@/lib/sheets";
import { runState } from "../runState";

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

function findHeaderIndexCaseInsensitive(headers: string[], headerName: string) {
  const want = headerName.trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] ?? "").trim().toLowerCase() === want) return i; // 0-based
  }
  return -1;
}

function colIndexToA1(colIndex1Based: number) {
  let x = colIndex1Based;
  let letters = "";
  while (x > 0) {
    const rem = (x - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    x = Math.floor((x - 1) / 26);
  }
  return letters;
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

    const datasetCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, datasetUrlHeader);
    const scrapedCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Scraped");
    const statusCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Status");
    const commentsCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Comments");
    const scrapeStatusCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Google-Maps Scrape Status");
    const pushStatusCol = await ensureHeader(sheets, spreadsheetId, settingsSheetName, "Google-Maps Push Status");

    const headersAfterEnsure = await getRow(sheets, spreadsheetId, settingsSheetName, 1);

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

    let existingUniqueIds = new Set<string>();
    if (leadsSheetName) {
      const uniqueIdIdx = findHeaderIndexCaseInsensitive(leadsHeaders, "Unique ID");
      if (uniqueIdIdx !== -1) {
        const colLetter = colIndexToA1(uniqueIdIdx + 1);
        const range = `${leadsSheetName}!${colLetter}2:${colLetter}`;
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const values = resp.data.values ?? [];
        existingUniqueIds = new Set(
          values
            .map((row) => (row?.[0] ?? "").toString().trim())
            .filter(Boolean),
        );
      }
    }

    const rowNumbers = Array.from({ length: endRow - startRow + 1 }, (_, i) => startRow + i);
    const runId = crypto.randomUUID();
    const startedAt = fmtDateTime(new Date());

    runState.cancelRequested = false;
    runState.activeRunId = null;
    runState.activeToken = null;
    runState.currentRun = {
      runId,
      spreadsheetId,
      settingsSheetName,
      leadsSheetName,
      startRow,
      endRow,
      rowNumbers,
      currentIndex: 0,
      processed: 0,
      skipped: 0,
      totalLeads: 0,
      startedAt,
      perRow: [],
      headersAfterEnsure,
      leadsHeaders,
      existingUniqueIds,
      datasetCol,
      scrapedCol,
      statusCol,
      commentsCol,
      scrapeStatusCol,
      pushStatusCol,
      apifyTokenHeader,
      datasetUrlHeader,
    };

    return NextResponse.json({
      ok: true,
      runId,
      settingsSheetName,
      leadsSheetName: leadsSheetName || undefined,
      startRow,
      endRow,
      processed: 0,
      skipped: 0,
      totalLeads: 0,
      startedAt,
      perRow: [],
      done: false,
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
