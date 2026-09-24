import { describe, expect, it } from "vitest";
import { normalisePhone, parseRosterCsv } from "./roster.ts";

describe("normalisePhone", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["0091 9876543210", "+919876543210"],
  ])("normalises %s", (raw, want) => expect(normalisePhone(raw)).toBe(want));

  it("treats blank as absent, not invalid", () => {
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone("  ")).toBeNull();
    expect(normalisePhone(null)).toBeNull();
  });

  it("rejects landlines and short numbers", () => {
    expect(normalisePhone("4023456789")).toBeUndefined();
    expect(normalisePhone("98765")).toBeUndefined();
  });
});

describe("parseRosterCsv", () => {
  it("accepts rows without a phone number (SCHEMA §1)", () => {
    const { rows, errors } = parseRosterCsv(
      "Roll No,Name,Admission Year,Mobile,Branch\n160125737001,Asha K,2025,9876543210,IT\n160125737002,Ravi P,2025,,IT\n",
    );
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.phone_e164)).toEqual(["+919876543210", null]);
  });

  it("normalises roll numbers and tolerates a BOM and header spelling", () => {
    const { rows } = parseRosterCsv(
      "\uFEFFroll_no,full_name,admission_year\n 160125737001x ,A,2025\n",
    );
    expect(rows[0]!.roll_no).toBe("160125737001X");
  });

  it("reports every bad cell with its spreadsheet line and column", () => {
    const { rows, errors } = parseRosterCsv(
      [
        "roll_no,name,admission_year,phone",
        "160125737001,Asha,2025,9876543210",
        "16-01,Ravi,20x5,12345",
        "160125737003,,2025,",
        "160125737001,Dup,2025,",
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { row: 3, column: "roll_no", message: "must be 4–20 letters or digits" },
      { row: 3, column: "admission_year", message: "must be a year" },
      { row: 3, column: "phone_e164", message: "is not a valid Indian mobile number" },
      { row: 4, column: "full_name", message: "is required" },
      { row: 5, column: "roll_no", message: "duplicates line 2" },
    ]);
  });

  it("rejects the whole file when a required column is missing", () => {
    const { rows, errors } = parseRosterCsv("roll_no,name\n1601,A\n");
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { row: 1, column: "admission_year", message: "column is missing from the header" },
    ]);
  });
});
