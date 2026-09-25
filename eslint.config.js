import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.next-dev/**",
      "**/coverage/**",
      "**/node_modules/**",
      "infra/**/data/**",
      // Next.js regenerates this on every dev/build run; its own header says not to edit it.
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Plain-JS service workers (no build step — see each file's own header). tseslint's
    // recommended config only turns off `no-undef` for .ts/.tsx, so these plain .js files
    // still need their runtime's globals declared, or every worker-only identifier is
    // reported as undefined.
    files: ["**/public/sw.js"],
    languageOptions: {
      globals: { self: "readonly", caches: "readonly", fetch: "readonly", URL: "readonly" },
    },
  },
  {
    // k6 load scripts (Stage 8) run in k6's JavaScript runtime, not Node or a browser: these are
    // its globals (environment, the virtual-user number, reading a file at init)
    files: ["tests/load/**/*.js"],
    languageOptions: {
      globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly", open: "readonly" },
    },
  },
  {
    // Invariant 13: packages/geo is pure — no clock, no randomness, so traces replay exactly.
    // (Its tsconfig has no node types, which already rules out process/fs/timers.)
    files: ["packages/geo/src/**/*.ts"],
    ignores: ["packages/geo/src/**/*.test.ts", "packages/geo/src/testkit.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "geo is pure: take the time as an input" },
        { object: "Math", property: "random", message: "geo is pure: take randomness as an input" },
        { object: "performance", property: "now", message: "geo is pure" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "geo is pure: `new Date()` reads the clock; take the time as an input",
        },
      ],
    },
  },
  prettier,
);
