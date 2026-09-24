/** Public (browser-visible) configuration. Next inlines NEXT_PUBLIC_* at build time. */
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}
export const publicEnv = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
  gatewayUrl: required("NEXT_PUBLIC_GATEWAY_URL", process.env.NEXT_PUBLIC_GATEWAY_URL),
  /** tileserver-gl (ADR-0005). Defaulted rather than required: only the route editor needs it. */
  tilesUrl: process.env.NEXT_PUBLIC_TILES_URL || "http://localhost:8080",
};
