import { describe, expect, it } from "vitest";
import { SaveDraft } from "./routes.ts";
import { signingPayload, StreamMessage, SurveyUpload } from "./ingest.ts";

describe("signingPayload", () => {
  it("binds device, timestamp and the exact body bytes", () => {
    expect(signingPayload("dev-1", "1758506400", '{"a":1}')).toBe('dev-1\n1758506400\n{"a":1}');
    expect(signingPayload("dev-1", "1758506400", "")).toBe("dev-1\n1758506400\n");
  });
});

describe("StreamMessage", () => {
  const base = {
    trip_id: "0b5b1f3e-1111-4a4a-9c9c-000000000001",
    bus_id: "0b5b1f3e-1111-4a4a-9c9c-000000000002",
  };
  it("accepts a ping and a trip end, rejects anything else", () => {
    expect(
      StreamMessage.safeParse({
        kind: "ping",
        ...base,
        route_id: "0b5b1f3e-1111-4a4a-9c9c-000000000009",
        device_uid: "d",
        cadence_s: 5,
        recorded_at: "2026-09-22T02:00:00.000Z",
        ingested_at: "2026-09-22T02:00:01.000Z",
        lat: 17.4,
        lng: 78.5,
        speed_kmh: null,
        heading_deg: null,
        accuracy_m: 6,
        is_backfill: false,
      }).success,
    ).toBe(true);
    expect(
      StreamMessage.safeParse({
        kind: "trip_end",
        ...base,
        route_id: "0b5b1f3e-1111-4a4a-9c9c-000000000009",
        at: "2026-09-22T03:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(StreamMessage.safeParse({ kind: "other", ...base }).success).toBe(false);
  });
});

describe("SurveyUpload", () => {
  it("needs at least 10 points", () => {
    const p = { t: "2026-09-22T02:00:00.000Z", lat: 17.4, lng: 78.5 };
    expect(SurveyUpload.safeParse({ points: Array(9).fill(p) }).success).toBe(false);
    expect(SurveyUpload.safeParse({ points: Array(10).fill(p) }).success).toBe(true);
  });
});

describe("SaveDraft", () => {
  it("each stop is exactly one of an existing id or a new stop", () => {
    const id = "0b5b1f3e-1111-4a4a-9c9c-000000000003";
    const ns = { name: "Dilsukhnagar", lat: 17.36, lng: 78.52 };
    expect(SaveDraft.safeParse({ stops: [{ stop_id: id }, { new_stop: ns }] }).success).toBe(true);
    expect(SaveDraft.safeParse({ stops: [{}] }).success).toBe(false);
    expect(SaveDraft.safeParse({ stops: [{ stop_id: id, new_stop: ns }] }).success).toBe(false);
  });
});
