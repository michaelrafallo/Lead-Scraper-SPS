import { google, sheets_v4 } from "googleapis";

export const DEFAULT_SPREADSHEET_ID =
  "1R5P2K0qBAGCIi3avjtxlUNkDVoG08RiSMtdHyYbpIag";

export const DEFAULT_NICHE_SETTINGS_TAB = "Niche Settings";

export function rowToDict(headers: string[], row: string[]) {
  const out: Record<string, string> = {};
  headers.forEach((h, idx) => {
    const key = (h ?? "").trim();
    if (!key) return;
    out[key] = (row[idx] ?? "").toString();
  });
  return out;
}

export function findHeaderIndex(headers: string[], headerName: string) {
  const want = headerName.trim();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] ?? "").trim() === want) return i; // 0-based
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

function a1Cell(sheetName: string, row1Based: number, col1Based: number) {
  return `${sheetName}!${colIndexToA1(col1Based)}${row1Based}`;
}

export async function getRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  row1Based: number,
) {
  const range = `${sheetName}!${row1Based}:${row1Based}`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = resp.data.values ?? [];
  const row = values[0] ?? [];
  return row.map((v) => (v ?? "").toString());
}

export async function getRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  startRow1Based: number,
  endRow1Based: number,
) {
  const range = `${sheetName}!${startRow1Based}:${endRow1Based}`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = resp.data.values ?? [];
  return values.map((r) => (r ?? []).map((v) => (v ?? "").toString()));
}

export async function appendRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  rows: string[][],
) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

export async function setCell(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  row1Based: number,
  col1Based: number,
  value: string,
) {
  const range = a1Cell(sheetName, row1Based, col1Based);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

export async function ensureHeader(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  headerName: string,
) {
  const headers = await getRow(sheets, spreadsheetId, sheetName, 1);
  const idx0 = findHeaderIndex(headers, headerName);
  if (idx0 !== -1) return idx0 + 1; // to 1-based

  const col = headers.length + 1;
  await setCell(sheets, spreadsheetId, sheetName, 1, col, headerName);
  return col;
}

export async function readNicheSettingsRow2(params: {
  auth: InstanceType<typeof google.auth.OAuth2>;
  spreadsheetId?: string;
  sheetName?: string;
}) {
  const spreadsheetId = params.spreadsheetId ?? DEFAULT_SPREADSHEET_ID;
  const sheetName = params.sheetName ?? DEFAULT_NICHE_SETTINGS_TAB;
  const sheets = google.sheets({ version: "v4", auth: params.auth });

  const headers = await getRow(sheets, spreadsheetId, sheetName, 1);
  const row2 = await getRow(sheets, spreadsheetId, sheetName, 2);
  return { sheets, spreadsheetId, sheetName, headers, row2, rowDict: rowToDict(headers, row2) };
}
