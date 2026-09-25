# ADR-0008 — The hardware adapter speaks GT06, as a separate service, signing like a phone

**Status:** accepted (protocol provisional until the TD chooses a device) · **Stage:** 9 ·
**Date:** 2026-09-24

## Context

BUILD_PLAN Stage 9: "a protocol-decoder service in front of `/v1/ingest` speaking the chosen
device protocol and emitting the identical `PingBatch` contract. Everything downstream is
untouched." No device has been chosen or bought yet, so the adapter had to be built against a
protocol, not a device. Three questions: which protocol, where the decoding runs, and how a
device that cannot compute an HMAC gets through a gateway that demands one.

## Options considered — protocol

- **A. GT06 / Concox binary (chosen).** The protocol of the most common low-cost vehicle trackers
  sold in India (Concox GT06N/WeTrack and the many clones), ₹1,500–3,000 a unit, ACC (ignition)
  wire, internal flash buffer, TCP over 2G/4G. Fully documented, with worked examples to test
  against (the adapter's tests use the manual's own packets and CRCs). The 0x22 packet carries
  ignition and a "re-upload" flag — exactly what trip start/end and backfill need.
- **B. Teltonika Codec 8.** Better devices, better documentation, 3–5× the price. The decoder
  seam (`gt06.ts` is one file behind `server.ts`) makes it a second file later, not a rewrite.
- **C. AIS-140 (the Indian standard for public transport).** Mandatory for public service
  vehicles; not obviously for a college's own buses. Vendor dialects differ more than the
  standard admits, and devices come bundled with a state backend. Revisit if the TD's buses must
  be AIS-140 compliant anyway — then the adapter decodes what those devices already send.
- **D. Devices that speak HTTP (OsmAnd/Traccar client format).** Trivial, but those are phone
  apps or premium devices; it would not exercise the seam.

## Options considered — where

- **A. A separate service, `apps/adapter` (chosen).** Trackers dial raw TCP; the gateway speaks
  HTTP. Keeping TCP out of the gateway keeps the gateway stateless and horizontally scalable, and
  the adapter can be deployed only when wired trackers exist.
- **B. Inside the gateway.** One process fewer, but long-lived TCP sessions pinned to one gateway
  instance, and a device protocol inside the service every student depends on.

## Options considered — authentication

- **A. The adapter holds each tracker's HMAC secret and signs as that tracker (chosen).** A GT06
  box cannot sign anything; the adapter is its proxy. The gateway sees an ordinary
  `trackers.kind = 'hardware'` device with its own secret, rate limit, rotation and pairing — no
  gateway change at all, which was the point of the `tracker_kind` seam.
- **B. One adapter-wide secret trusted to speak for any device.** Simpler to configure, but a
  leak impersonates the whole fleet, and per-device rotation/unpairing stops meaning anything.

## Consequences accepted

- The devices file (`ADAPTER_DEVICES_FILE`) holds every wired tracker's secret: it is a secret
  and lives in Fly secrets, never the repository.
- GT06 identifies a device only by IMEI, in clear, over TCP. Anyone who knows an IMEI and the
  adapter's address can send positions as that bus. Accepted: the same plausibility gates that
  bound a stolen phone secret (ARCH §10) bound this, and the alternative (a VPN APN per SIM) is a
  telecom contract, not code. Revisit with the M2M SIM contract.
- Trip start is ignition-driven on the bus's **default route**: a bus with no default route never
  starts a trip from its tracker (logged). A wired bus doing a different route on an event day
  needs its route changed in Fleet first.
- Validated against a byte-exact software device; the Stage 9 exit criterion "validated against
  one physical tracker" is still owed.
