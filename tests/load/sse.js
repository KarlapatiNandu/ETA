/**
 * BUILD_PLAN Stage 8 — N students hold the live map open while 30 buses report and one T0
 * announcement goes to everyone. Each virtual user is a distinct student with one SSE stream.
 *
 * Run by `pnpm sim load` (apps/simulator/src/load/run.ts), which seeds the students, starts the
 * stack and the push sink, drives the fleet and sends the T0. On its own:
 *
 *   docker run --rm -v "$PWD/tests/load:/scripts" -e GATEWAY=http://host.docker.internal:4000 \
 *     -e CLIENTS=600 -e DURATION_S=600 busmitra-k6 run /scripts/sse.js
 *
 * Measured per student: the age of every bus.position frame on arrival (fix recorded_at → the
 * frame reaching the client, corrected for this container's clock offset from the gateway's,
 * which `stream.ready.serverTime` gives), and the T0 notification frame's arrival.
 */
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import sse from "k6/x/sse";

const GATEWAY = __ENV.GATEWAY || "http://host.docker.internal:4000";
const CLIENTS = Number(__ENV.CLIENTS || 600);
const DURATION_S = Number(__ENV.DURATION_S || 600);
const T0_MARKER = __ENV.T0_MARKER || "LOADTEST-T0";
const RAMP_S = Number(__ENV.RAMP_S || 60);
const tokens = JSON.parse(open("/scripts/.run/tokens.json"));

export const options = {
  scenarios: {
    students: {
      executor: "per-vu-iterations",
      vus: CLIENTS,
      iterations: 1,
      maxDuration: `${DURATION_S + RAMP_S + 120}s`,
    },
  },
  thresholds: {
    frame_age_ms: ["p(95)<6000"],
    stream_opened: ["rate>0.99"],
  },
  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max", "count"],
};

const frameAge = new Trend("frame_age_ms", true);
// when the T0 frame arrived, on the gateway's clock (epoch ms): the harness subtracts its own send
// time. (Latency against the frame's createdAt would mix two machines' clocks.)
const t0At = new Trend("t0_at_ms", true);
const t0Received = new Counter("t0_received");
const frames = new Counter("frames");
const streamOpened = new Rate("stream_opened");
const streamErrors = new Counter("stream_errors");

export default function () {
  const me = tokens[(__VU - 1) % tokens.length];
  // spread the connects over RAMP_S, as students opening the app over a minute
  const start = Date.now() + ((__VU - 1) / CLIENTS) * RAMP_S * 1000;
  if (start > Date.now()) sleep((start - Date.now()) / 1000);
  const deadline = start + DURATION_S * 1000;
  let offset = 0; // this container's clock minus the gateway's
  let gotT0 = false;
  let ready = false;

  const res = sse.open(
    `${GATEWAY}/v1/stream`,
    { headers: { Authorization: `Bearer ${me.token}` }, tags: { name: "stream" } },
    (client) => {
      client.on("event", (e) => {
        if (e.name === "stream.ready") {
          ready = true;
          offset = Date.now() - Date.parse(JSON.parse(e.data).data.serverTime);
        } else if (e.name === "bus.position") {
          const d = JSON.parse(e.data).data;
          const age = Date.now() - offset - Date.parse(d.ts);
          // a replayed or backfilled fix is history, not latency
          if (age < 120_000) frameAge.add(age);
          frames.add(1);
        } else if (e.name === "notification") {
          const d = JSON.parse(e.data).data;
          if (!gotT0 && d.title && d.title.indexOf(T0_MARKER) !== -1) {
            gotT0 = true;
            t0Received.add(1);
            t0At.add(Date.now() - offset);
          }
        }
        if (Date.now() > deadline) client.close();
      });
      client.on("error", () => streamErrors.add(1));
    },
  );
  streamOpened.add(!!res && res.status === 200 && ready);
  check(res, { "stream opened": (r) => r && r.status === 200 });
}
