import { defineProject } from "vitest/config";
// the end-to-end suite builds a PGlite database with every migration, like gateway and engine
export default defineProject({
  test: { name: "adapter", testTimeout: 30_000, hookTimeout: 60_000 },
});
