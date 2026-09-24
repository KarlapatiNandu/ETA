"use client";
import { useEffect, useState } from "react";
import type { Network } from "@busmitra/contracts";
import { gateway } from "@/lib/gateway";
import { accessToken } from "./use-live-stream";

/**
 * The published network (routes, stops, bus numbers), loaded once per page load and shared by
 * every component that needs it. Published routes are immutable, so there is nothing to refresh.
 */
let cached: Promise<Network> | null = null;

function load(): Promise<Network> {
  cached ??= (async () =>
    gateway<Network>("/v1/network", { token: (await accessToken()) ?? undefined }))().catch(
    (err) => {
      cached = null;
      throw err;
    },
  );
  return cached;
}

export function useNetwork(): { network: Network | null; error: string | null } {
  const [network, setNetwork] = useState<Network | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const go = () =>
      load().then(
        (n) => {
          if (cancelled) return;
          setNetwork(n);
          setError(null);
        },
        () => {
          if (cancelled) return;
          setError("Could not load the route map. Retrying…");
          retry = setTimeout(go, 5000);
        },
      );
    void go();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, []);
  return { network, error };
}
