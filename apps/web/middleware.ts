import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "./lib/csp";

/**
 * Keeps the Supabase session cookie fresh (authorisation happens in layouts and RLS), and sets
 * the per-request Content-Security-Policy (Stage 9). The policy goes on the *request* too:
 * that is how Next.js learns the nonce to put on its own scripts.
 */
export async function middleware(request: NextRequest) {
  const csp = buildCsp({
    nonce: newNonce(),
    dev: process.env.NODE_ENV !== "production",
    gatewayUrl: process.env.NEXT_PUBLIC_GATEWAY_URL!,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    tilesUrl: process.env.NEXT_PUBLIC_TILES_URL || "http://localhost:8080",
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });
  request.headers.set("content-security-policy", csp);
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  await supabase.auth.getUser();
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw.js|icons/|apple-touch-icon.png|manifest.webmanifest|offline.html).*)",
  ],
};
