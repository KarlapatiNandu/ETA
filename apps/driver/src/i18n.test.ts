import { describe, expect, it } from "vitest";
import { STRINGS, type Strings } from "./i18n.ts";

const flat = (s: Strings): [string, string][] =>
  Object.entries(s).flatMap(([k, v]) =>
    typeof v === "function"
      ? [[k, String((v as (...a: unknown[]) => string)(7, 5))]]
      : typeof v === "object"
        ? Object.entries(v).map(([kk, vv]) => [`${k}.${kk}`, String(vv)] as [string, string])
        : [[k, v as string]],
  );

describe("driver app strings (Stage 9)", () => {
  const en = Object.fromEntries(flat(STRINGS.en));
  for (const lang of ["te", "hi"] as const) {
    it(`${lang}: every string present, non-empty and actually translated`, () => {
      const got = Object.fromEntries(flat(STRINGS[lang]));
      expect(Object.keys(got).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(got)) {
        expect(v.trim(), k).not.toBe("");
        // the same text as English means someone forgot to translate it
        expect(v, k).not.toBe(en[k]);
      }
    });
  }
  it("the big buttons keep the English word the printed driver sheet uses", () => {
    for (const lang of ["te", "hi"] as const) {
      expect(STRINGS[lang].startTrip).toContain("START TRIP");
      expect(STRINGS[lang].endTrip).toContain("END TRIP");
    }
  });
});
