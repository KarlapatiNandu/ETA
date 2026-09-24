import { defineProject } from "vitest/config";
export default defineProject({
  test: { name: "gateway", testTimeout: 30_000, hookTimeout: 60_000 },
});
