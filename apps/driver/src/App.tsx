import { useEffect, useMemo, useRef, useState } from "react";
import type { TrackerMe } from "@busmitra/contracts";
import { parsePairing, signedClient, type Pairing, type SignedClient } from "./lib/api.ts";
import { kvGet, kvSet, openDb } from "./lib/idb.ts";
import { SurveyRecorder } from "./survey/recorder.ts";
import { idbPingBuffer } from "./tracker/buffer.ts";
import { watchGps, type Fix } from "./tracker/sampler.ts";
import { browserWakeEnv, WakeLockKeeper, type WakeState } from "./tracker/wakelock.ts";
import { TripSession, type SessionView } from "./trip/session.ts";

const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:4000";

interface Ctx {
  db: IDBDatabase;
  pairing: Pairing;
  client: SignedClient;
  session: TripSession;
  survey: SurveyRecorder;
  wake: WakeLockKeeper;
}

export function App() {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const d = await openDb();
        // a pairing link (#pair=…) wins; then clear it from the address bar so the secret
        // does not linger in history or get shared by accident
        const fromLink = parsePairing(location.hash);
        if (fromLink) {
          await kvSet(d, "pairing", fromLink);
          history.replaceState(null, "", location.pathname);
        }
        setPairing(fromLink ?? (await kvGet<Pairing>(d, "pairing")) ?? null);
        setDb(d);
      } catch (e) {
        setBootError(`This phone's storage is unavailable (${(e as Error).message}).`);
      }
    })();
  }, []);

  if (bootError)
    return (
      <Shell>
        <p className="error">{bootError}</p>
      </Shell>
    );
  if (!db || pairing === undefined)
    return (
      <Shell>
        <p className="muted">Starting…</p>
      </Shell>
    );
  if (!pairing) return <PairScreen db={db} onPaired={setPairing} />;
  return <Paired db={db} pairing={pairing} onUnpair={() => setPairing(null)} />;
}

function Shell({ children, bus }: { children: React.ReactNode; bus?: string | null }) {
  return (
    <div className="app">
      <header>
        <h1>Bus Mitra · Driver</h1>
        {bus && <span className="bus">Bus {bus}</span>}
      </header>
      {children}
    </div>
  );
}

function PairScreen({ db, onPaired }: { db: IDBDatabase; onPaired: (p: Pairing) => void }) {
  const [link, setLink] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Shell>
      <section className="panel">
        <h2>Pair this phone</h2>
        <p className="muted">
          Open the pairing link from the Transport Department on this phone, or paste it here.
        </p>
        <input
          type="text"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://…/#pair=…"
        />
        {err && <p className="error">{err}</p>}
        <button
          className="big go"
          onClick={async () => {
            const p = parsePairing(link.slice(link.indexOf("#")));
            if (!p) return setErr("That is not a pairing link.");
            await kvSet(db, "pairing", p);
            onPaired(p);
          }}
        >
          PAIR
        </button>
      </section>
    </Shell>
  );
}

function Paired({
  db,
  pairing,
  onUnpair,
}: {
  db: IDBDatabase;
  pairing: Pairing;
  onUnpair: () => void;
}) {
  const [me, setMe] = useState<TrackerMe | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [wake, setWake] = useState<WakeState>("off");
  const [online, setOnline] = useState(navigator.onLine);
  const [tab, setTab] = useState<"trip" | "survey">("trip");

  const ctx = useMemo<Ctx>(() => {
    const client = signedClient(GATEWAY, pairing);
    const wakeKeeper = new WakeLockKeeper(browserWakeEnv(), setWake);
    const session = new TripSession({
      db,
      buffer: idbPingBuffer(db),
      client,
      deviceUid: pairing.deviceUid,
      wake: wakeKeeper,
      watchGps: (onFix, onError) => watchGps(onFix, onError),
      isOnline: () => navigator.onLine,
      onUpdate: setView,
    });
    return { db, pairing, client, session, survey: new SurveyRecorder(db), wake: wakeKeeper };
  }, [db, pairing]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      ctx.session.reconnected();
    };
    const down = () => setOnline(false);
    addEventListener("online", up);
    addEventListener("offline", down);
    void (async () => {
      const res = await ctx.client
        .request<TrackerMe & { error?: string }>("GET", "/v1/tracker/me")
        .catch(() => null);
      if (!res)
        return setMeError("Cannot reach the server. Trips you start will buffer until it is back.");
      if (res.status === 401) {
        return setMeError(
          res.json.error === "stale_timestamp"
            ? "This phone's clock is wrong. Set date & time to automatic, then reopen the app."
            : "This phone is not paired any more. Ask the transport office for a new link.",
        );
      }
      // anything else is an error body, not a TrackerMe: rendering it would tell the driver
      // this phone has no bus, which is a lie they would act on
      if (res.status !== 200)
        return setMeError(`The server answered ${res.status}. Try again shortly.`);
      setMe(res.json);
      setMeError(null);
      await ctx.session.restore(res.json);
    })();
    return () => {
      removeEventListener("online", up);
      removeEventListener("offline", down);
    };
  }, [ctx]);

  const fix = view?.lastFix ?? null;
  return (
    <Shell bus={me?.bus?.bus_number}>
      <div className="chips">
        <GpsChip fix={fix} error={view?.gpsError ?? null} />
        <span className={`chip ${online ? "ok" : "bad"}`}>
          {online ? "Network" : "No network — buffering"}
        </span>
        <WakeChip state={wake} />
      </div>
      {meError && <p className="error">{meError}</p>}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "trip"} onClick={() => setTab("trip")}>
          Trip
        </button>
        <button role="tab" aria-selected={tab === "survey"} onClick={() => setTab("survey")}>
          Route survey
        </button>
      </div>
      {tab === "trip" ? (
        <TripPanel me={me} view={view} session={ctx.session} />
      ) : (
        <SurveyPanel ctx={ctx} busy={!!view?.trip} />
      )}
      <button
        className="link"
        onClick={async () => {
          if (view?.trip) return alert("End the trip before un-pairing.");
          if (
            !confirm(
              "Remove this phone's pairing? You will need a new link from the transport office.",
            )
          )
            return;
          await kvSet(db, "pairing", null);
          onUnpair();
        }}
      >
        Device {pairing.deviceUid} · un-pair
      </button>
    </Shell>
  );
}

function GpsChip({ fix, error }: { fix: Fix | null; error: string | null }) {
  if (error) return <span className="chip bad">{error}</span>;
  if (!fix) return <span className="chip warn">GPS: waiting</span>;
  const acc = Math.round(fix.accuracy);
  return (
    <span className={`chip ${acc <= 25 ? "ok" : acc <= 60 ? "warn" : "bad"}`}>GPS ±{acc} m</span>
  );
}

function WakeChip({ state }: { state: WakeState }) {
  const text: Record<WakeState, [string, string]> = {
    off: ["", "Screen lock: off"],
    held: ["ok", "Screen stays on"],
    released: ["warn", "Screen lock lost — reopen the app"],
    unsupported: ["warn", "Keep the screen on manually"],
    error: ["warn", "Screen lock refused (battery saver?)"],
  };
  const [cls, label] = text[state];
  return <span className={`chip ${cls}`}>{label}</span>;
}

function ago(t: number | null): string {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

function TripPanel({
  me,
  view,
  session,
}: {
  me: TrackerMe | null;
  view: SessionView | null;
  session: TripSession;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trip = view?.trip ?? null;
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (trip) {
    const s = view!.stats;
    return (
      <section className="panel">
        <p className="onair">{trip.ending ? "ENDING TRIP…" : "ON TRIP"}</p>
        <p>{trip.routeName}</p>
        <div className="counter">
          <div>
            <b>{s.sent}</b>
            <span>pings sent</span>
          </div>
          <div>
            <b>{s.buffered}</b>
            <span>waiting to send</span>
          </div>
        </div>
        <p className="muted">
          Last sent {ago(s.lastSentAt)} · reporting every {view!.cadenceS} s
        </p>
        {s.lastError && <p className="notice">{s.lastError}</p>}
        {trip.ending ? (
          <p className="notice">
            Sending the last {s.buffered} buffered pings, then the trip closes.
          </p>
        ) : (
          <button
            className="big stop"
            disabled={busy}
            onClick={async () => {
              if (!confirm("End this trip?")) return;
              setBusy(true);
              await session.end();
              setBusy(false);
            }}
          >
            END TRIP
          </button>
        )}
      </section>
    );
  }

  if (!me)
    return (
      <section className="panel">
        <p className="muted">Loading routes…</p>
      </section>
    );
  if (!me.bus)
    return (
      <section className="panel">
        <p className="error">This phone is not assigned to a bus yet.</p>
      </section>
    );
  return (
    <section className="panel">
      <h2>Choose today&apos;s route</h2>
      <div className="routes">
        {me.routes.map((r) => (
          <button
            key={r.id}
            className="route"
            aria-pressed={picked === r.id}
            onClick={() => setPicked(r.id)}
          >
            {r.name}
            <small>
              {r.direction === "inbound" ? "to campus" : "from campus"} · v{r.version}
            </small>
          </button>
        ))}
        {!me.routes.length && <p className="muted">No published routes yet.</p>}
      </div>
      {err && <p className="error">{err}</p>}
      <p className="muted">Mount the phone, plug in the charger, keep this screen open.</p>
      <button
        className="big go"
        disabled={!picked || busy}
        onClick={async () => {
          const route = me.routes.find((r) => r.id === picked)!;
          setBusy(true);
          setErr(null);
          try {
            await session.start({ id: route.id, name: route.name });
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        START TRIP
      </button>
    </section>
  );
}

function SurveyPanel({ ctx, busy }: { ctx: Ctx; busy: boolean }) {
  const [label, setLabel] = useState("");
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [fix, setFix] = useState<Fix | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const beginWatch = () => {
    stopRef.current = watchGps(
      (f) => {
        setFix(f);
        void ctx.survey.add(f).then(async (kept) => kept && setCount(await ctx.survey.count()));
      },
      () => setMsg("Waiting for GPS…"),
    );
    void ctx.wake.enable();
    setRecording(true);
  };

  useEffect(() => {
    void (async () => {
      const s = await ctx.survey.session();
      setCount(await ctx.survey.count());
      if (s) {
        setLabel(s.label);
        setStartedAt(s.startedAt);
        beginWatch(); // a reload mid-survey carries on recording
      }
    })();
    return () => stopRef.current?.();
  }, [ctx]); // beginWatch is stable for a given ctx

  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    void ctx.wake.disable();
    setRecording(false);
  };

  if (busy)
    return (
      <section className="panel">
        <p className="muted">End the trip before surveying a route.</p>
      </section>
    );
  return (
    <section className="panel">
      <h2>Route survey</h2>
      <p className="muted">
        Drive the whole route once, start to end. The phone records its position every second; the
        transport office turns it into the route on the map.
      </p>
      {!recording && !count && (
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Route name, e.g. Route 14 to campus"
        />
      )}
      <div className="counter">
        <div>
          <b>{count}</b>
          <span>points</span>
        </div>
        <div>
          <b>{startedAt ? Math.floor((Date.now() - startedAt) / 60000) : 0}</b>
          <span>minutes</span>
        </div>
      </div>
      {fix && <p className="muted">Accuracy ±{Math.round(fix.accuracy)} m</p>}
      {msg && <p className="notice">{msg}</p>}
      {recording ? (
        <button className="big stop" onClick={stop}>
          STOP SURVEY
        </button>
      ) : count ? (
        <>
          <button
            className="big go"
            onClick={async () => {
              setMsg("Uploading…");
              try {
                const r = await ctx.survey.upload(ctx.client);
                setMsg(`Uploaded ${r.point_count} points. Thank you.`);
                setCount(0);
                setStartedAt(null);
              } catch (e) {
                setMsg(`${(e as Error).message} — the points are kept; try again.`);
              }
            }}
          >
            UPLOAD SURVEY
          </button>
          <button
            className="link"
            onClick={async () => {
              if (!confirm("Delete this survey without uploading?")) return;
              await ctx.survey.discard();
              setCount(0);
              setStartedAt(null);
            }}
          >
            discard
          </button>
        </>
      ) : (
        <button
          className="big go"
          onClick={async () => {
            const now = Date.now();
            await ctx.survey.start(label.trim(), now);
            setStartedAt(now);
            setMsg(null);
            beginWatch();
          }}
        >
          START SURVEY
        </button>
      )}
    </section>
  );
}
