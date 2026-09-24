import { publicEnv } from "./env";

export class GatewayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** JSON call to the Fastify gateway. Error bodies are `{error, message}` (contracts ApiError). */
export async function gateway<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const res = await fetch(`${publicEnv.gatewayUrl}${path}`, {
    method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
    headers: {
      // only when something is actually sent: a DELETE that declares a JSON content-type with
      // no body is refused by Fastify ("Body cannot be empty…")
      ...(init.raw !== undefined
        ? { "content-type": "text/csv" }
        : init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new GatewayError(res.status, (data as { message?: string }).message ?? "Request failed");
  return data as T;
}
