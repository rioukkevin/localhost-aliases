import { NextResponse } from "next/server";
import { loadConfig } from "@localhost-aliases/core";

export const dynamic = "force-dynamic";

/** Liveness probe. The tray polls this every 5s; e2e waits on it before driving the UI. */
export async function GET() {
  const config = await loadConfig();
  return NextResponse.json({ ok: true, aliasCount: config.aliases.length });
}
