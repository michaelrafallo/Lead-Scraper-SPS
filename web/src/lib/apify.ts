export const DEFAULT_ACTOR_ID = "compass/crawler-google-places";

export type ApifyRunInfo = {
  id?: string;
  status?: string;
  defaultDatasetId?: string;
  [key: string]: unknown;
};

function parseSearchStrings(raw: string) {
  if (!raw) return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, ",");
  return normalized
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function buildApifyInputFromRow(row: Record<string, string>) {
  const locationQuery = (row["Search Location"] ?? "").trim();
  const maxLimitRaw = (row["Max Limit"] ?? "").trim();
  const subNichesRaw = row["Sub-Niches"] ?? "";

  const input: Record<string, unknown> = {
    includeWebResults: false,
    language: "en",
    maxImages: 0,
    maximumLeadsEnrichmentRecords: 0,
    scrapeContacts: true,
    scrapeDirectories: false,
    scrapeImageAuthors: true,
    scrapePlaceDetailPage: false,
    scrapeReviewsPersonalData: true,
    scrapeTableReservationProvider: false,
    skipClosedPlaces: true,
  };

  if (locationQuery) input.locationQuery = locationQuery;

  const searchStringsArray = parseSearchStrings(subNichesRaw);
  if (searchStringsArray.length) input.searchStringsArray = searchStringsArray;

  if (maxLimitRaw) {
    const parsed = Number(maxLimitRaw);
    if (Number.isFinite(parsed) && parsed > 0) input.maxCrawledPlacesPerSearch = Math.floor(parsed);
  }

  return input;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startActorRun(params: {
  token: string;
  input: Record<string, unknown>;
  actorId?: string;
}): Promise<ApifyRunInfo> {
  const rawActorId = params.actorId ?? DEFAULT_ACTOR_ID;
  const normalizedActorId = rawActorId.includes("/") ? rawActorId.replace("/", "~") : rawActorId;
  const encodedActorId = encodeURIComponent(normalizedActorId);
  const url = new URL(`https://api.apify.com/v2/acts/${encodedActorId}/runs`);
  url.searchParams.set("token", params.token);
  url.searchParams.set("waitForFinish", "0");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(params.input ?? {}),
  });

  const data = (await res.json()) as { data?: ApifyRunInfo };
  if (!res.ok) {
    throw new Error(`Apify start failed (${res.status}).`);
  }
  if (!data.data?.id) {
    throw new Error("Apify start did not return run id.");
  }
  return data.data;
}

export async function waitForRunToFinish(params: {
  token: string;
  runId: string;
  pollIntervalMs?: number;
}): Promise<ApifyRunInfo> {
  const pollIntervalMs = Math.max(1000, Math.floor(params.pollIntervalMs ?? 3000));
  const url = new URL(`https://api.apify.com/v2/actor-runs/${params.runId}`);
  url.searchParams.set("token", params.token);

  // Poll until the run reaches a terminal state.
  while (true) {
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    const data = (await res.json()) as { data?: ApifyRunInfo };
    if (!res.ok) {
      throw new Error(`Apify status failed (${res.status}).`);
    }
    const run = data.data ?? {};
    const status = (run.status ?? "").toString().toUpperCase();
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      return run;
    }
    await sleep(pollIntervalMs);
  }
}

export async function abortActorRun(params: { token: string; runId: string }): Promise<void> {
  const url = new URL(`https://api.apify.com/v2/actor-runs/${params.runId}/abort`);
  url.searchParams.set("token", params.token);
  await fetch(url.toString(), { method: "POST", headers: { accept: "application/json" } });
}

export async function getDatasetItems(params: {
  token: string;
  datasetId: string;
}): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = new URL(`https://api.apify.com/v2/datasets/${params.datasetId}/items`);
    url.searchParams.set("token", params.token);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("clean", "true");
    url.searchParams.set("format", "json");

    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Apify dataset items failed (${res.status}).`);
    }
    const batch = (await res.json()) as Record<string, unknown>[];
    items.push(...batch);
    if (batch.length < limit) break;
    offset += batch.length;
  }

  return items;
}
