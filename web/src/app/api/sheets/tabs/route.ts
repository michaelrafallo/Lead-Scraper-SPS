import { NextResponse } from "next/server";

import { getAuthorizedGoogleAuthOrAuthUrl } from "@/lib/googleAuth";
import { DEFAULT_SPREADSHEET_ID } from "@/lib/sheets";
import { google } from "googleapis";

export const runtime = "nodejs";

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

    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const spreadsheetId =
      (typeof body === "object" &&
        body !== null &&
        "spreadsheetId" in body &&
        typeof (body as { spreadsheetId?: unknown }).spreadsheetId === "string" &&
        (body as { spreadsheetId: string }).spreadsheetId.trim()) ||
      (process.env.SPREADSHEET_ID ?? DEFAULT_SPREADSHEET_ID).trim();

    const sheets = google.sheets({ version: "v4", auth });

    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });

    const titles =
      meta.data.sheets?.map((s) => s.properties?.title).filter((t): t is string => Boolean(t)) ?? [];

    const tabs = await Promise.all(
      titles.map(async (title) => {
        // `values.get` returns only the used range, which is good for estimating "data rows".
        // Count rows and subtract header row (row 1).
        const values = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: title,
          majorDimension: "ROWS",
        });
        const rowCount = values.data.values?.length ?? 0;
        const dataRowCount = Math.max(0, rowCount - 1);
        return { title, dataRowCount };
      }),
    );

    return NextResponse.json({ ok: true, spreadsheetId, tabs });
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

