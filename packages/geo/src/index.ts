/**
 * @busmitra/geo — the maths that is silently wrong when it is wrong (BUILD_PLAN Stage 1).
 *
 * Pure: no I/O, no clock reads, no randomness, no dependencies (invariant 13). Every input is
 * explicit so recorded traces in tests/fixtures replay deterministically.
 */
export * from "./cluster.ts";
export * from "./crossings.ts";
export * from "./eta.ts";
export * from "./geometry.ts";
export * from "./match.ts";
export * from "./progress.ts";
export * from "./simplify.ts";
export * from "./snap.ts";
export * from "./trip.ts";
