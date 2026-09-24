import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { publicEnv } from "@/lib/env";

/**
 * The map style with the tile server's address filled in. Served rather than imported so the
 * address is a deployment concern, not a build-time constant, and so MapLibre can fetch it
 * like any other style URL.
 */
export async function GET(req: Request) {
  const tiles = new URL(req.url).searchParams.get("tiles") ?? publicEnv.tilesUrl;
  // only a plain origin, never arbitrary text interpolated into the style we serve
  if (!/^https?:\/\/[A-Za-z0-9.\-:]+$/.test(tiles)) {
    return NextResponse.json({ error: "bad tiles url" }, { status: 400 });
  }
  const raw = await readFile(join(process.cwd(), "public/map/busmitra-dark.json"), "utf8");
  return new NextResponse(raw.replaceAll("{TILES}", tiles), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
