import { ApifyClient } from "apify-client";

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

export async function runActor(params: {
  token: string;
  input: Record<string, unknown>;
  actorId?: string;
}): Promise<ApifyRunInfo> {
  const client = new ApifyClient({ token: params.token });
  const run = await client.actor(params.actorId ?? DEFAULT_ACTOR_ID).call(params.input);
  return run as unknown as ApifyRunInfo;
}

export async function getDatasetItems(params: {
  token: string;
  datasetId: string;
}): Promise<Record<string, unknown>[]> {
  const client = new ApifyClient({ token: params.token });
  const items: Record<string, unknown>[] = [];
  for await (const item of client.dataset(params.datasetId).iterateItems()) {
    items.push(item as Record<string, unknown>);
  }
  return items;
}
