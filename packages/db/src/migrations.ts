import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "../migrations");

/** Migration files in apply order (lexical: 0001_, 0002_, …). */
export function listMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(MIGRATIONS_DIR, name), "utf8") }));
}
