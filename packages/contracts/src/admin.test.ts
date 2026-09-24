import { describe, expect, it } from "vitest";
import { AudienceSpec, BusInput, parseClock, parseEventDayCsv } from "./admin.ts";

describe("parseClock", () => {
  it.each([
    ["7:40", "07:40"],
    ["07:40", "07:40"],
    ["7.40", "07:40"],
    ["7:40 AM", "07:40"],
    ["7:40pm", "19:40"],
    ["12:05 am", "00:05"],
    ["12:05 PM", "12:05"],
    ["19:05", "19:05"],
  ])("%s → %s", (raw, want) => expect(parseClock(raw)).toBe(want));

  it.each(["25:00", "7:75", "13:00 PM", "seven", "740"])("rejects %s", (raw) =>
    expect(parseClock(raw)).toBeUndefined(),
  );
});

describe("parseEventDayCsv", () => {
  it("reads a TD-style sheet, expanding 'both' into a junior and a senior line", () => {
    const { rows, errors } = parseEventDayCsv(
      [
        "Bus No,Route,Departure,Cohort,Remarks",
        "14,Dilsukhnagar,7:10 AM,Seniors,",
        "22,Dilsukhnagar,8:00,juniors,gate 2",
        "5,,7:30,,",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.line, r.bus_number, r.cohort, r.departure_time])).toEqual([
      [2, "14", "senior", "07:10"],
      [3, "22", "junior", "08:00"],
      [4, "5", "junior", "07:30"],
      [4, "5", "senior", "07:30"],
    ]);
    expect(rows[1]!.notes).toBe("gate 2");
  });

  it("uses the upload's cohort for blank cells", () => {
    const { rows } = parseEventDayCsv("bus,time\n14,7:40", "junior");
    expect(rows.map((r) => r.cohort)).toEqual(["junior"]);
  });

  it("rejects the whole file with per-line, per-column errors — nothing partial", () => {
    const { rows, errors } = parseEventDayCsv(
      [
        "bus,route,time,cohort,direction",
        "14,Uppal,7:40,seniors,inbound",
        ",Uppal,7:40,,",
        "15,Uppal,25:61,freshers,sideways",
        "14,Uppal,8:00,seniors,",
      ].join("\n"),
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { row: 3, column: "bus_number", message: "is required" },
      { row: 4, column: "direction", message: "must be inbound or outbound" },
      { row: 4, column: "departure_time", message: '"25:61" is not a time like 7:40 AM' },
      { row: 4, column: "cohort", message: "must be junior, senior or both" },
      { row: 5, column: "bus_number", message: "bus 14 is already listed for seniors on line 2" },
    ]);
  });

  it("names a missing bus column and an empty file", () => {
    expect(parseEventDayCsv("route,time\nUppal,7:40").errors).toEqual([
      { row: 1, column: "bus_number", message: "column is missing from the header" },
    ]);
    expect(parseEventDayCsv("bus,time\n").errors[0]!.message).toMatch(/no bus lines/);
  });
});

describe("audience and fleet inputs", () => {
  it("requires a ref for route/bus audiences only, and roll numbers for custom", () => {
    const id = "5b0f3f86-4b0b-4b8e-9a39-0f7cd1f0c001";
    expect(AudienceSpec.safeParse({ audience: "bus" }).success).toBe(false);
    expect(AudienceSpec.safeParse({ audience: "bus", audience_ref: id }).success).toBe(true);
    expect(AudienceSpec.safeParse({ audience: "all", audience_ref: id }).success).toBe(false);
    expect(AudienceSpec.safeParse({ audience: "custom", roll_nos: [] }).success).toBe(false);
    expect(
      AudienceSpec.parse({ audience: "custom", roll_nos: [" 160125737001 "] }).roll_nos,
    ).toEqual(["160125737001"]);
  });

  it("normalises a registration number and refuses a strange bus number", () => {
    expect(BusInput.parse({ bus_number: "14", registration_no: "ts 09 ub 1234" })).toMatchObject({
      registration_no: "TS09UB1234",
    });
    expect(BusInput.safeParse({ bus_number: "14; drop" }).success).toBe(false);
  });
});
