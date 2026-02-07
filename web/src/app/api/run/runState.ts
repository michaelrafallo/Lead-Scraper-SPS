export type RunProgress = {
  runId: string;
  spreadsheetId: string;
  settingsSheetName: string;
  leadsSheetName: string;
  startRow: number;
  endRow: number;
  rowNumbers: number[];
  currentIndex: number;
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
  headersAfterEnsure: string[];
  leadsHeaders: string[];
  existingUniqueIds: Set<string>;
  datasetCol: number;
  scrapedCol: number;
  statusCol: number;
  commentsCol: number;
  scrapeStatusCol: number;
  pushStatusCol: number;
  apifyTokenHeader: string;
  datasetUrlHeader: string;
};

export type RunState = {
  cancelRequested: boolean;
  activeRunId: string | null;
  activeToken: string | null;
  currentRun: RunProgress | null;
};

export const runState: RunState = {
  cancelRequested: false,
  activeRunId: null,
  activeToken: null,
  currentRun: null,
};
