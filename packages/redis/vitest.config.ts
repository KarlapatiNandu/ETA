import { defineProject } from "vitest/config";
export default defineProject({ test: { name: "redis", testTimeout: 20_000 } });
