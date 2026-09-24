import type { SurveyAccepted, SurveyPoint } from "@busmitra/contracts";
import { kvDelete, kvGet, kvSet, request, STORES, transact } from "../lib/idb.ts";
import type { SignedClient } from "../lib/api.ts";
import type { Fix } from "../tracker/sampler.ts";

/**
 * Survey mode (BUILD_PLAN Stage 1): drive the route once, capture a dense 1 Hz trace, upload it
 * raw. No snapping, no cadence rule — the trace → route pipeline on the server does the rest.
 * Points live in IndexedDB until the upload succeeds, so a reload mid-drive loses nothing.
 */

export const SURVEY = {
  MIN_INTERVAL_MS: 900,
  /** fixes worse than this are dropped at capture; the pipeline drops >50 m ones too */
  MAX_ACCURACY_M: 50,
  MIN_POINTS: 10,
} as const;

export interface SurveySession {
  label: string;
  startedAt: number;
}

export class SurveyRecorder {
  private lastT: number | null = null;
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  session(): Promise<SurveySession | undefined> {
    return kvGet<SurveySession>(this.db, "survey");
  }

  async start(label: string, now: number): Promise<void> {
    await this.clearPoints();
    await kvSet(this.db, "survey", { label, startedAt: now } satisfies SurveySession);
    this.lastT = null;
  }

  /** Keep a fix if it is accurate enough and at least ~1 s after the last kept one. */
  async add(fix: Fix): Promise<boolean> {
    if (fix.accuracy > SURVEY.MAX_ACCURACY_M) return false;
    if (this.lastT !== null && fix.timestamp - this.lastT < SURVEY.MIN_INTERVAL_MS) return false;
    this.lastT = fix.timestamp;
    const point: SurveyPoint = {
      t: new Date(fix.timestamp).toISOString(),
      lat: fix.lat,
      lng: fix.lng,
      accuracy_m: Math.round(fix.accuracy * 10) / 10,
      speed_kmh: fix.speed === null ? null : Math.round(fix.speed * 36) / 10,
    };
    await transact(this.db, STORES.survey, "readwrite", (t) =>
      request(t.objectStore(STORES.survey).add(point)),
    );
    return true;
  }

  count(): Promise<number> {
    return transact(this.db, STORES.survey, "readonly", (t) =>
      request(t.objectStore(STORES.survey).count()),
    );
  }

  points(): Promise<SurveyPoint[]> {
    return transact(this.db, STORES.survey, "readonly", (t) =>
      request(t.objectStore(STORES.survey).getAll() as IDBRequest<SurveyPoint[]>),
    );
  }

  /** Upload; the local copy is cleared only after the server has it. */
  async upload(client: SignedClient): Promise<SurveyAccepted> {
    const s = await this.session();
    const points = await this.points();
    if (points.length < SURVEY.MIN_POINTS)
      throw new Error(`Only ${points.length} points — drive further first.`);
    const res = await client.request<SurveyAccepted & { message?: string }>("POST", "/v1/survey", {
      label: s?.label || undefined,
      points,
    });
    if (res.status !== 201) throw new Error(res.json.message ?? `upload failed (${res.status})`);
    await this.discard();
    return res.json;
  }

  async discard(): Promise<void> {
    await this.clearPoints();
    await kvDelete(this.db, "survey");
    this.lastT = null;
  }

  private async clearPoints() {
    await transact(this.db, STORES.survey, "readwrite", (t) =>
      request(t.objectStore(STORES.survey).clear()),
    );
  }
}
