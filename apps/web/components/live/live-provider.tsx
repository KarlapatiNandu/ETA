"use client";
import { useEffect } from "react";
import { gateway } from "@/lib/gateway";
import { mergeFocus, useFleet, type FocusPart } from "@/lib/store/fleet";
import { accessToken, useLiveStream } from "./use-live-stream";

/**
 * One live stream for every student page (ARCH §7: one SSE connection per client), and the
 * poster that keeps its focus in step with what the pages are showing. Pages contribute with
 * `useFocusPart`; this merges them and posts `/v1/stream/focus` whenever the merged focus or
 * the connection changes (a reconnect is a new connId, so it is re-posted).
 */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  useLiveStream();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const post = () => {
      const { connId, focusParts } = useFleet.getState();
      const focus = mergeFocus(focusParts);
      if (!connId || !focus) return;
      const body = {
        connId,
        bbox: focus.bbox ?? null,
        busIds: focus.busIds ?? [],
        stopIds: focus.stopIds ?? [],
      };
      const sig = JSON.stringify(body);
      if (sig === last) return;
      last = sig;
      void (async () => {
        try {
          await gateway("/v1/stream/focus", { token: (await accessToken()) ?? undefined, body });
        } catch {
          last = ""; // a failed focus leaves the stream unscoped (safe); try again next change
        }
      })();
    };
    const unsub = useFleet.subscribe((s, prev) => {
      if (s.connId !== prev.connId || s.focusParts !== prev.focusParts) {
        clearTimeout(timer);
        timer = setTimeout(post, 300);
      }
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, []);
  return <>{children}</>;
}

/** A page's share of the focus, for as long as it is mounted. */
export function useFocusPart(key: string, part: FocusPart | null) {
  const sig = JSON.stringify(part);
  useEffect(() => {
    useFleet.getState().setFocusPart(key, part);
    return () => useFleet.getState().setFocusPart(key, null);
    // the signature is the dependency: a new object with the same content is not a change
  }, [key, sig]); // (`part` is read through `sig`)
}
