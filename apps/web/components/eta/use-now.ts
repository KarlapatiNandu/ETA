"use client";
import { useEffect, useState } from "react";
import { serverNow, useFleet } from "@/lib/store/fleet";

/** The gateway's clock, ticking once a second — every countdown on the page shares it. */
export function useServerNow(): number {
  const offset = useFleet((s) => s.clockOffsetMs);
  const [now, setNow] = useState(() => serverNow(offset));
  useEffect(() => {
    setNow(serverNow(offset));
    const t = setInterval(() => setNow(serverNow(offset)), 1000);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}
