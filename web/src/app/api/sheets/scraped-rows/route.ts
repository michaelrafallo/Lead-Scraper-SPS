import { NextResponse } from "next/server";
import { google } from "googleapis";

import { DEFAULT_NICHE_SETTINGS_TAB, DEFAULT_SPREADSHEET_ID, getRow } from "@/lib/sheets";
import { getAuthorizedGoogleAuthOrAuthUrl } from "@/lib/googleAuth";

export const runtime = "nodejs";

type ScrapedRowsBody = {
  spreadsheetId?: string;
  sheetName?: string;
  scrapedHeader?: string;
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

    let body: ScrapedRowsBody = {};
    try {
      body = (await req.json()) as ScrapedRowsBody;
    } catch {
      body = {};
    }

    const spreadsheetId = (body.spreadsheetId ?? DEFAULT_SPREADSHEET_ID).trim();
    const sheetName = (body.sheetName ?? DEFAULT_NICHE_SETTINGS_TAB).trim();
    const scrapedHeader = (body.scrapedHeader ?? "Scraped").trim();

    const sheets = google.sheets({ version: "v4", auth });
    const headers = await getRow(sheets, spreadsheetId, sheetName, 1);
    const idx0 = findHeaderIndexCaseInsensitive(headers, scrapedHeader);
    if (idx0 === -1) {
      return NextResponse.json({ ok: true, rows: [] });
    }

    const colLetter = colIndexToA1(idx0 + 1);
    const range = `${sheetName}!${colLetter}2:${colLetter}`;
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const values = resp.data.values ?? [];

    const rows: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const cell = (values[i]?.[0] ?? "").toString().trim().toUpperCase();
      if (cell === "Y") rows.push(i + 2);
    }

    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    return NextResponse.json(
      { error: "server_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
