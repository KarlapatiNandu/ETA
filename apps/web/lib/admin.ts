"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicEnv } from "./env";
import { supabaseBrowser } from "./supabase/client";

/**
 * The admin console's client for /v1/admin/*. Errors keep the gateway's machine-readable code and
 * any extra fields (e.g. `count` on count_changed), because the confirmation dialog needs them.
 */

export class AdminError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? "Request failed"));
    this.status = status;
    this.code = String(body.error ?? "error");
    this.body = body;
  }
}

async function token(): Promise<string | undefined> {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.access_token;
}

export async function admin<T>(
  path: string,
  init: { method?: string; body?: unknown; csv?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const t = await token();
  const res = await fetch(`${publicEnv.gatewayUrl}${path}`, {
    method: init.method ?? (init.body !== undefined || init.csv !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.csv !== undefined
        ? { "content-type": "text/csv" }
        : init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...init.headers,
    },
    body: init.csv ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new AdminError(res.status, data);
  return data as T;
}

/** Load `path`, optionally re-polling every `everyMs`. `reload()` refetches on demand. */
export function useAdmin<T>(path: string | null, everyMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await admin<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Could not load.");
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void reload();
    if (!everyMs) return () => void (alive.current = false);
    const t = setInterval(() => void reload(), everyMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload, everyMs]);
  return { data, error, reload, setError };
}

export const fmtTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export const fmtAge = (s: number | null | undefined) =>
  s == null
    ? "—"
    : s < 60
      ? `${s} s`
      : s < 3600
        ? `${Math.floor(s / 60)} min ${s % 60} s`
        : `${Math.floor(s / 3600)} h`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
