import { NextResponse } from "next/server";

export const runtime = "nodejs";

type DatasetsBody = {
  token?: string;
  limit?: number;
};

export async function POST(req: Request) {
  try {
    let body: DatasetsBody = {};
    try {
      body = (await req.json()) as DatasetsBody;
    } catch {
      body = {};
    }

    const token = (body.token ?? "").trim();
    if (!token) {
      return NextResponse.json(
        { error: "missing_token", message: "Provide an Apify token." },
        { status: 400 },
      );
    }

    const limitRaw = Number.isFinite(body.limit) ? Number(body.limit) : 20;
    const limit = Math.min(Math.max(Math.floor(limitRaw), 1), 100);

    const url = new URL("https://api.apify.com/v2/datasets");
    url.searchParams.set("token", token);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });

    const text = await response.text();
    if (!text) {
      return NextResponse.json(
        { error: "empty_response", message: `Empty response (HTTP ${response.status}).` },
        { status: 502 },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "non_json_response", message: `Non-JSON response (HTTP ${response.status}).` },
        { status: 502 },
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "apify_error",
          message: typeof payload === "object" && payload ? JSON.stringify(payload) : String(payload),
        },
        { status: response.status },
      );
    }

    const data = payload as {
      data?: {
        items?: Array<{
          id?: string;
          name?: string;
          itemCount?: number;
          createdAt?: string | number | Date;
          modifiedAt?: string | number | Date;
        }>;
      };
    };

    const items = (data.data?.items ?? []).map((item) => ({
      id: item.id ?? "",
      name: item.name,
      itemCount: item.itemCount,
      createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : undefined,
      modifiedAt: item.modifiedAt ? new Date(item.modifiedAt).toISOString() : undefined,
    }));

    return NextResponse.json({ ok: true, items });
  } catch (err) {
    return NextResponse.json(
      { error: "server_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
