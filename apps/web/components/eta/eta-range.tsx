import { formatEtaRange } from "@busmitra/ui";

/**
 * An ETA as a range with a confidence dot (ARCH §5.5: "Report a range, not a point"). The dot is
 * filled for high, half for medium, hollow for low — shape as well as colour.
 */
export function EtaRange({
  p50,
  p90,
  confidence,
  className = "",
}: {
  p50: number;
  p90: number;
  confidence: "high" | "medium" | "low" | null;
  className?: string;
}) {
  const label = confidence ? `${confidence} confidence` : "confidence unknown";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span>{formatEtaRange(p50, p90)}</span>
      <span
        role="img"
        aria-label={label}
        title={label}
        className={`inline-block h-2.5 w-2.5 rounded-full border-2 border-live ${
          confidence === "high"
            ? "bg-live"
            : confidence === "medium"
              ? "bg-live/40"
              : "bg-transparent"
        }`}
      />
    </span>
  );
}
