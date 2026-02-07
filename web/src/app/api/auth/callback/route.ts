import { NextResponse } from "next/server";

import { exchangeCodeAndStoreToken } from "@/lib/googleAuth";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  if (!code) {
    return NextResponse.json(
      { error: "missing_code", message: "Missing ?code=..." },
      { status: 400 },
    );
  }

  await exchangeCodeAndStoreToken(code);
  return NextResponse.redirect(new URL("/", req.url));
}

