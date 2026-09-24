"use client";
import { useEffect } from "react";
import { publicEnv } from "@/lib/env";
import { LiveStream } from "@/lib/sse/client";
import { useFleet } from "@/lib/store/fleet";
import { useInbox } from "@/lib/store/inbox";
import { supabaseBrowser } from "@/lib/supabase/client";

/** Session access token, refreshed by supabase-js when it is close to expiry. */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.access_token ?? null;
}

declare global {
  interface Window {
    /** ?measure: every frame received (id, type, local ms) — read by the e2e resilience harness */
    __bmFrames?: { id: string | null; type: string; t: number }[];
  }
}

/** One live stream per mounted page, feeding the fleet store (ARCH §7). */
export function useLiveStream() {
  useEffect(() => {
    const { apply, setConnection } = useFleet.getState();
    if (new URLSearchParams(window.location.search).has("measure")) window.__bmFrames ??= [];
    const stream = new LiveStream({
      url: `${publicEnv.gatewayUrl}/v1/stream`,
      getToken: accessToken,
      onFrame: (f) => {
        window.__bmFrames?.push({ id: f.id, type: f.event.type, t: Date.now() });
        // per-user frames (Stage 6) feed the notification badge; everything else the fleet
        if (f.event.type === "notification" || f.event.type === "ticket.update")
          useInbox.getState().apply(f.event);
        else apply(f.event);
      },
      onState: setConnection,
    });
    return stream.start();
  }, []);
}
