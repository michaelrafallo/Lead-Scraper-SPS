"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RunResult =
  | {
      ok: true;
      runId?: string;
      done?: boolean;
      settingsSheetName?: string;
      leadsSheetName?: string;
      startRow: number;
      endRow: number;
      processed: number;
      skipped: number;
      totalLeads: number;
      startedAt: string;
      finishedAt?: string;
      perRow: Array<{
        row: number;
        status: "skipped" | "succeeded" | "failed";
        message?: string;
        datasetUrl?: string;
        leads?: number;
      }>;
    }
  | { error: string; message?: string; authUrl?: string };

type TabsResult =
  | { ok: true; spreadsheetId: string; tabs: { title: string; dataRowCount: number }[] }
  | { error: string; message?: string; authUrl?: string };

type ScrapedRowsResult =
  | { ok: true; rows: number[] }
  | { error: string; message?: string; authUrl?: string };

function isOkTabsResult(r: TabsResult): r is Extract<TabsResult, { ok: true }> {
  return (r as { ok?: boolean }).ok === true;
}

function isOkResult(r: RunResult): r is Extract<RunResult, { ok: true }> {
  return (r as { ok?: boolean }).ok === true;
}

function isOkScrapedRowsResult(r: ScrapedRowsResult): r is Extract<ScrapedRowsResult, { ok: true }> {
  return (r as { ok?: boolean }).ok === true;
}

const SETTINGS_KEY = "leadScraperSettingsV1";

type Settings = {
  spreadsheetId: string;
  settingsSheetName: string;
  leadsSheetName: string;
  startRow: number; // 1-based sheet row number (includes header row 1)
  endRow: number; // 1-based sheet row number (includes header row 1)
};

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [activeView, setActiveView] = useState<"leadScraper" | "googleSheet">("leadScraper");

  const [settings, setSettings] = useState<Settings>({
    spreadsheetId: "1R5P2K0qBAGCIi3avjtxlUNkDVoG08RiSMtdHyYbpIag",
    settingsSheetName: "Niche Settings",
    leadsSheetName: "Scraped Leads",
    startRow: 2,
    endRow: 2,
  });
  const [tabs, setTabs] = useState<{ title: string; dataRowCount: number }[]>([]);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [tabsResult, setTabsResult] = useState<TabsResult | null>(null);
  const [scrapedRows, setScrapedRows] = useState<number[]>([]);
  const [scrapedRowsResult, setScrapedRowsResult] = useState<ScrapedRowsResult | null>(null);
  const [scrapedRowsLoading, setScrapedRowsLoading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepInFlightRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Settings> & { sheetName?: string };
      setSettings((s) => ({
        spreadsheetId: typeof parsed.spreadsheetId === "string" ? parsed.spreadsheetId : s.spreadsheetId,
        settingsSheetName:
          typeof parsed.settingsSheetName === "string"
            ? parsed.settingsSheetName
            : typeof parsed.sheetName === "string"
              ? parsed.sheetName
              : s.settingsSheetName,
        leadsSheetName: typeof parsed.leadsSheetName === "string" ? parsed.leadsSheetName : s.leadsSheetName,
        startRow: typeof parsed.startRow === "number" && Number.isFinite(parsed.startRow) ? parsed.startRow : s.startRow,
        endRow: typeof parsed.endRow === "number" && Number.isFinite(parsed.endRow) ? parsed.endRow : s.endRow,
      }));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

  const authUrl = useMemo(() => {
    if (!result) return null;
    if ("authUrl" in result && result.authUrl) return result.authUrl;
    return null;
  }, [result]);

  const tabsAuthUrl = useMemo(() => {
    if (!tabsResult) return null;
    if ("authUrl" in tabsResult && tabsResult.authUrl) return tabsResult.authUrl;
    return null;
  }, [tabsResult]);

  const canShowSheetConfig = !tabsAuthUrl;

  function buildSheetTabUrl(tabTitle: string) {
    const spreadsheetId = settings.spreadsheetId.trim();
    if (!spreadsheetId) return "#";
    const encodedTitle = encodeURIComponent(tabTitle);
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#sheet=${encodedTitle}`;
  }


  async function readJson<T>(res: Response): Promise<T> {
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!text) {
      throw new Error(`Empty response (HTTP ${res.status}). content-type=${contentType || "unknown"}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      const snippet = text.slice(0, 200);
      throw new Error(
        `Non-JSON response (HTTP ${res.status}). content-type=${contentType || "unknown"} body=${snippet}`,
      );
    }
  }

  async function loadTabs() {
    setTabsLoading(true);
    setTabsResult(null);
    try {
      const res = await fetch("/api/sheets/tabs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spreadsheetId: settings.spreadsheetId }),
      });
      const data = await readJson<TabsResult>(res);
      setTabsResult(data);
      if (isOkTabsResult(data)) setTabs(data.tabs);
    } catch (e) {
      setTabsResult({ error: "network_error", message: String(e) });
    } finally {
      setTabsLoading(false);
    }
  }

  async function loadScrapedRows() {
    setScrapedRowsLoading(true);
    setScrapedRowsResult(null);
    try {
      const res = await fetch("/api/sheets/scraped-rows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spreadsheetId: settings.spreadsheetId,
          sheetName: settings.settingsSheetName,
          scrapedHeader: "Scraped",
        }),
      });
      const data = await readJson<ScrapedRowsResult>(res);
      setScrapedRowsResult(data);
      if (isOkScrapedRowsResult(data)) {
        setScrapedRows(data.rows);
      }
    } catch (e) {
      setScrapedRowsResult({ error: "network_error", message: String(e) });
    } finally {
      setScrapedRowsLoading(false);
    }
  }


  // Auto-load tab list whenever Spreadsheet ID changes (debounced).
  useEffect(() => {
    const id = settings.spreadsheetId.trim();
    if (!id) {
      setTabs([]);
      return;
    }

    const handle = window.setTimeout(() => {
      void loadTabs();
    }, 500);

    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.spreadsheetId]);

  useEffect(() => {
    const id = settings.spreadsheetId.trim();
    if (!id || !settings.settingsSheetName.trim()) {
      setScrapedRows([]);
      return;
    }
    void loadScrapedRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.spreadsheetId, settings.settingsSheetName]);

  useEffect(() => {
    if (activeView !== "leadScraper") return;
    if (!canShowSheetConfig) return;
    void loadScrapedRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, canShowSheetConfig]);

  // Keep selected tab valid after tabs load/change.
  useEffect(() => {
    if (!tabs.length) return;
    setSettings((s) => {
      const next = { ...s };
      if (!tabs.some((t) => t.title === next.settingsSheetName)) {
        next.settingsSheetName = tabs[0]?.title ?? next.settingsSheetName;
      }
      if (!tabs.some((t) => t.title === next.leadsSheetName)) {
        next.leadsSheetName = tabs[0]?.title ?? next.leadsSheetName;
      }
      return next;
    });
  }, [tabs]);

  const settingsTabInfo = useMemo(() => {
    return tabs.find((t) => t.title === settings.settingsSheetName) ?? null;
  }, [tabs, settings.settingsSheetName]);

  const settingsRowMin = 2;
  const settingsRowMax = useMemo(() => {
    if (!settingsTabInfo) return 2;
    // dataRowCount excludes header row 1. So max sheet row index = 1 + dataRowCount.
    return Math.max(2, 1 + settingsTabInfo.dataRowCount);
  }, [settingsTabInfo]);

  const availableRows = useMemo(() => {
    const scrapedSet = new Set(scrapedRows);
    const rows = Array.from({ length: settingsRowMax - settingsRowMin + 1 }, (_, i) => settingsRowMin + i);
    return rows.filter((r) => !scrapedSet.has(r));
  }, [scrapedRows, settingsRowMax]);

  useEffect(() => {
    setSettings((s) => {
      const next = { ...s };
      const minRow = availableRows[0] ?? settingsRowMin;
      const maxRow = availableRows[availableRows.length - 1] ?? settingsRowMax;
      if (next.startRow < minRow) next.startRow = minRow;
      if (next.startRow > maxRow) next.startRow = maxRow;
      if (next.endRow < next.startRow) next.endRow = next.startRow;
      if (next.endRow > maxRow) next.endRow = maxRow;
      return next;
    });
  }, [settingsRowMax, availableRows, settingsRowMin]);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function stepRun(activeRunId: string) {
    if (stepInFlightRef.current) return;
    stepInFlightRef.current = true;
    try {
      const res = await fetch("/api/run/step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: activeRunId }),
      });
      const data = await readJson<RunResult>(res);
      setResult(data);
      if (isOkResult(data) && data.done) {
        stopPolling();
        setLoading(false);
        setCanceling(false);
        setRunId(null);
      }
    } catch (e) {
      setResult({ error: "network_error", message: String(e) });
      stopPolling();
      setLoading(false);
      setCanceling(false);
      setRunId(null);
    } finally {
      stepInFlightRef.current = false;
    }
  }

  function startPolling(activeRunId: string) {
    stopPolling();
    pollRef.current = setInterval(() => {
      void stepRun(activeRunId);
    }, 1500);
  }

  async function run() {
    setLoading(true);
    setResult(null);
    setCanceling(false);
    setRunId(null);
    stopPolling();
    try {
      const res = await fetch("/api/run/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spreadsheetId: settings.spreadsheetId,
          settingsSheetName: settings.settingsSheetName,
          leadsSheetName: settings.leadsSheetName,
          startRow: settings.startRow,
          endRow: settings.endRow,
        }),
      });
      const data = await readJson<RunResult>(res);
      setResult(data);
      if (isOkResult(data) && data.runId) {
        setRunId(data.runId);
        startPolling(data.runId);
      } else {
        setLoading(false);
      }
    } catch (e) {
      setResult({ error: "network_error", message: String(e) });
      setLoading(false);
    } finally {
      void loadScrapedRows();
    }
  }

  async function stopRun() {
    if (!runId) return;
    setCanceling(true);
    try {
      await fetch("/api/run/cancel", { method: "POST" });
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    return () => {
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="flex min-h-screen">
        <aside className="w-60 border-r border-zinc-200 bg-white px-4 py-6">
          <div className="text-lg font-semibold tracking-tight">Lead Scraper</div>
          <div className="mt-6 space-y-2 text-sm">
            <button
              type="button"
              onClick={() => setActiveView("leadScraper")}
              className={`w-full rounded-lg px-3 py-2 text-left font-medium ${
                activeView === "leadScraper" ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              Lead Scraper
            </button>
            <button
              type="button"
              onClick={() => setActiveView("googleSheet")}
              className={`w-full rounded-lg px-3 py-2 text-left font-medium ${
                activeView === "googleSheet" ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              Google Sheet
            </button>
          </div>
        </aside>

        <main className="flex-1">
          <div className="px-6 py-10">
            {activeView === "leadScraper" ? (
              <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
                <h1 className="text-2xl font-semibold tracking-tight">Lead Scraper Dashboard</h1>
                <p className="mt-2 text-sm text-zinc-600">
                  Reads settings from Google Sheets (tab <span className="font-medium">Niche Settings</span>, row{" "}
                  <span className="font-medium">2</span>), runs Apify, then writes the Dataset URL back to the sheet.
                </p>

                <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">Spreadsheet ID</label>
                    <input
                      className="h-11 w-full rounded-xl border border-zinc-300 px-3 text-sm"
                      value={settings.spreadsheetId}
                      onChange={(e) => setSettings((s) => ({ ...s, spreadsheetId: e.target.value }))}
                      placeholder="Paste spreadsheet ID"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        className="inline-flex h-10 items-center justify-center rounded-xl border border-zinc-300 bg-white px-3 text-sm font-medium hover:bg-zinc-50 disabled:opacity-60"
                        onClick={loadTabs}
                        disabled={tabsLoading || !settings.spreadsheetId.trim()}
                      >
                        {tabsLoading ? "Loading tabs…" : "Refresh tabs"}
                      </button>
                      {tabsAuthUrl ? (
                        <a className="text-sm underline" href={tabsAuthUrl}>
                          Authorize to load tabs
                        </a>
                      ) : null}
                    </div>
                    {tabsResult && !isOkTabsResult(tabsResult) ? (
                      <div className="text-xs text-zinc-600">
                        {tabsResult.error}
                        {tabsResult.message ? ` — ${tabsResult.message}` : null}
                      </div>
                    ) : null}
                  </div>

                  {canShowSheetConfig ? (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Settings</label>
                        <select
                          className="h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm"
                          value={settings.settingsSheetName}
                          onChange={(e) => setSettings((s) => ({ ...s, settingsSheetName: e.target.value }))}
                        >
                          {tabs.length ? (
                            tabs.map((t) => (
                              <option key={t.title} value={t.title}>
                                {t.title} ({t.dataRowCount})
                              </option>
                            ))
                          ) : (
                            <>
                              <option value="Niche Settings">Niche Settings</option>
                              <option value={settings.settingsSheetName}>{settings.settingsSheetName}</option>
                            </>
                          )}
                        </select>
                        <p className="text-xs text-zinc-500">
                          Tabs load automatically after you enter a Spreadsheet ID (requires Google authorization).
                        </p>
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-medium">Leads</label>
                        <select
                          className="h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm"
                          value={settings.leadsSheetName}
                          onChange={(e) => setSettings((s) => ({ ...s, leadsSheetName: e.target.value }))}
                        >
                          {tabs.length ? (
                            tabs.map((t) => (
                              <option key={t.title} value={t.title}>
                                {t.title} ({t.dataRowCount})
                              </option>
                            ))
                          ) : (
                            <>
                              <option value="Scraped Leads">Scraped Leads</option>
                              <option value={settings.leadsSheetName}>{settings.leadsSheetName}</option>
                            </>
                          )}
                        </select>
                        <p className="text-xs text-zinc-500">
                          This is where scraped leads will be written (Dataset URL writeback still uses Settings tab).
                        </p>
                      </div>

                      <div className="space-y-2 md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-sm font-medium">Settings rows</label>
                    <button
                      type="button"
                      className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                      onClick={loadScrapedRows}
                      disabled={!settings.spreadsheetId.trim() || scrapedRowsLoading}
                    >
                      {scrapedRowsLoading ? "Refreshing…" : "Refresh rows"}
                    </button>
                  </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <div className="text-xs text-zinc-600">Start row</div>
                          <select
                              className="h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm"
                              value={settings.startRow}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                setSettings((s) => ({
                                  ...s,
                                  startRow: v,
                                  endRow: Math.max(v, s.endRow),
                                }));
                              }}
                            disabled={!availableRows.length}
                            >
                            {availableRows.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="space-y-1">
                            <div className="text-xs text-zinc-600">End row</div>
                          <select
                              className="h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm"
                              value={settings.endRow}
                              onChange={(e) => setSettings((s) => ({ ...s, endRow: Number(e.target.value) }))}
                            disabled={!availableRows.length}
                            >
                            {availableRows.filter((r) => r >= settings.startRow).map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      <p className="text-xs text-zinc-500">
                        Select which Settings rows to run (sheet row numbers; row 1 is the header).
                        {scrapedRowsResult && !isOkScrapedRowsResult(scrapedRowsResult)
                          ? ` Unable to load scraped rows (${scrapedRowsResult.error}).`
                          : ""}
                        {!availableRows.length ? " All rows are already scraped." : ""}
                      </p>
                      </div>
                    </>
                  ) : null}
                </div>

                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <a
                    className="inline-flex h-11 items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 text-sm font-medium hover:bg-zinc-50"
                    href="/api/auth/start"
                  >
                    Authorize Google
                  </a>
                  {canShowSheetConfig ? (
                    <>
                      <button
                        className="inline-flex h-11 items-center justify-center rounded-xl bg-black px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
                        onClick={run}
                        disabled={loading}
                      >
                        {loading ? "Running…" : "Run scraper"}
                      </button>
                      {loading ? (
                        <button
                          className="inline-flex h-11 items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                          onClick={stopRun}
                          disabled={canceling}
                        >
                          {canceling ? "Stopping…" : "Stop Scraper"}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>

                {result ? (
                  <div className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm">
                    {isOkResult(result) ? (
                      <div className="space-y-3">
                        <div>
                          <span className="font-medium">Rows:</span> {result.startRow}–{result.endRow} (
                          {result.processed} processed, {result.skipped} skipped)
                        </div>
                        <div>
                          <span className="font-medium">Leads appended:</span> {result.totalLeads}
                        </div>
                        <div>
                          <span className="font-medium">Started:</span> {result.startedAt}
                        </div>
                        <div>
                          <span className="font-medium">Finished:</span> {result.finishedAt}
                        </div>
                        <div className="rounded-xl border border-zinc-200 bg-white p-3">
                          <div className="text-xs font-medium text-zinc-700">Per row</div>
                          <ul className="mt-2 max-h-56 space-y-2 overflow-auto text-xs text-zinc-700">
                            {result.perRow.map((r) => (
                              <li key={r.row} className="rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <span className="font-medium">Row {r.row}</span> — {r.status}
                                    {typeof r.leads === "number" ? ` (${r.leads} leads)` : ""}
                                  </div>
                                  {r.datasetUrl ? (
                                    <a className="underline" href={r.datasetUrl} target="_blank" rel="noreferrer">
                                      Dataset URL
                                    </a>
                                  ) : null}
                                </div>
                                {r.message ? <div className="mt-1 text-zinc-600">{r.message}</div> : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div>
                          <span className="font-medium">Error:</span> {result.error}
                        </div>
                        {result.message ? <div className="text-zinc-700">{result.message}</div> : null}
                        {authUrl ? (
                          <div>
                            <a className="underline" href={authUrl}>
                              Click here to authorize Google
                            </a>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
                <h1 className="text-2xl font-semibold tracking-tight">Google Sheet</h1>
                <p className="mt-2 text-sm text-zinc-600">
                  Authorize access, then review available tabs in your spreadsheet.
                </p>

                <div className="mt-6 space-y-4">
                  <div>
                    <a
                      className="inline-flex h-11 items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 text-sm font-medium hover:bg-zinc-50"
                      href="/api/auth/start"
                    >
                      Authorize Google
                    </a>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Spreadsheet ID</label>
                    <input
                      className="h-11 w-full rounded-xl border border-zinc-300 px-3 text-sm"
                      value={settings.spreadsheetId}
                      onChange={(e) => setSettings((s) => ({ ...s, spreadsheetId: e.target.value }))}
                      placeholder="Paste spreadsheet ID"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        className="inline-flex h-10 items-center justify-center rounded-xl border border-zinc-300 bg-white px-3 text-sm font-medium hover:bg-zinc-50 disabled:opacity-60"
                        onClick={loadTabs}
                        disabled={tabsLoading || !settings.spreadsheetId.trim()}
                      >
                        {tabsLoading ? "Loading tabs…" : "Refresh tabs"}
                      </button>
                      {tabsAuthUrl ? (
                        <a className="text-sm underline" href={tabsAuthUrl}>
                          Authorize to load tabs
                        </a>
                      ) : null}
                    </div>
                    {tabsResult && !isOkTabsResult(tabsResult) ? (
                      <div className="text-xs text-zinc-600">
                        {tabsResult.error}
                        {tabsResult.message ? ` — ${tabsResult.message}` : null}
                      </div>
                    ) : null}
                  </div>

                  {canShowSheetConfig ? (
                    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                      <div className="flex items-center justify-between text-sm font-medium text-zinc-700">
                        <span>Tabs</span>
                        <span className="text-xs font-normal text-zinc-500">{tabs.length} total</span>
                      </div>
                      {tabs.length ? (
                        <ul className="mt-3 space-y-2 text-sm">
                          {tabs.map((tab) => (
                            <li
                              key={tab.title}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2"
                            >
                              <div>
                                <div className="font-medium text-zinc-800">{tab.title}</div>
                                <div className="text-xs text-zinc-500">{tab.dataRowCount} rows</div>
                              </div>
                              <a
                                className={`inline-flex h-9 items-center justify-center rounded-lg px-3 text-xs font-medium ${
                                  settings.spreadsheetId.trim()
                                    ? "bg-black text-white hover:bg-zinc-800"
                                    : "cursor-not-allowed bg-zinc-200 text-zinc-500"
                                }`}
                                href={buildSheetTabUrl(tab.title)}
                                target="_blank"
                                rel="noreferrer"
                                aria-disabled={!settings.spreadsheetId.trim()}
                              >
                                View
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-3 text-xs text-zinc-600">No tabs loaded yet.</div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-600">Authorize to view tabs.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
