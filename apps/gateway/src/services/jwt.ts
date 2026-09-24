import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";

export interface VerifiedUser {
  id: string;
  /** From the custom access token hook; advisory only — admin routes re-check profiles. */
  claimedRole: string | null;
  /** token expiry, epoch seconds — a long-lived SSE stream is closed at it (the client reconnects) */
  exp?: number;
}

/**
 * Supabase issues HS256 tokens signed with the project JWT secret, or asymmetric tokens
 * published at /auth/v1/.well-known/jwks.json on projects that moved to signing keys.
 * Accept both, so rotating the project's signing mode does not take the gateway down.
 */
export function createJwtVerifier(opts: { secret: string; supabaseUrl?: string }) {
  const hs = new TextEncoder().encode(opts.secret);
  const jwks = opts.supabaseUrl
    ? createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", opts.supabaseUrl))
    : null;

  return async function verify(token: string): Promise<VerifiedUser> {
    const { alg } = decodeProtectedHeader(token);
    let payload: JWTPayload;
    if (alg === "HS256") {
      ({ payload } = await jwtVerify(token, hs, { algorithms: ["HS256"] }));
    } else if (jwks) {
      ({ payload } = await jwtVerify(token, jwks));
    } else {
      throw new Error(`unsupported token algorithm ${alg}`);
    }
    if (!payload.sub || payload.role !== "authenticated") throw new Error("not a user token");
    return {
      id: payload.sub,
      claimedRole: typeof payload.user_role === "string" ? payload.user_role : null,
      ...(typeof payload.exp === "number" ? { exp: payload.exp } : {}),
    };
  };
}
export type JwtVerifier = ReturnType<typeof createJwtVerifier>;
