import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
export default defineProject({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { name: "web", include: ["lib/**/*.test.ts", "components/**/*.test.ts"] },
});
