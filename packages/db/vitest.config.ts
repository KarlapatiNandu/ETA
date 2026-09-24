import { defineProject } from "vitest/config";
// PGlite boots a wasm Postgres per suite; give it room on a cold start.
export default defineProject({ test: { name: "db", testTimeout: 30_000, hookTimeout: 60_000 } });
