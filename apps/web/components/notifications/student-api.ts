"use client";
import { accessToken } from "@/components/live/use-live-stream";
import { gateway } from "@/lib/gateway";

/** The student's own endpoints (Stage 6), with the session token attached. */
export async function me<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return gateway<T>(path, { ...init, token: (await accessToken()) ?? undefined });
}

export type Favourite = {
  bus_id: string;
  bus_number: string;
  kind: "main" | "starred";
  muted_until: string | null;
};

export type AlertSettings = {
  alerts_paused_until: string | null;
  max_tier: number;
  critical_breakthrough: boolean;
  quiet_start_min: number | null;
  quiet_duration_min: number | null;
  push_devices: number;
};

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
