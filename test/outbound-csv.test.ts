import { describe, expect, it } from "vitest";
import { parseProspectsCsv } from "../src/outbound/csv.js";

describe("outbound prospect CSV", () => {
  it("parses quoted fields, normalizes email, and tracks provenance", () => {
    const result =
      parseProspectsCsv(`email,first_name,company,source,personalization
ALICE@EXAMPLE.COM,Alice,"Example, Inc.",Conference,"Loved the launch post"
`);

    expect(result.rejections).toEqual([]);
    expect(result.prospects[0]).toMatchObject({
      email: "alice@example.com",
      domain: "example.com",
      firstName: "Alice",
      company: "Example, Inc.",
      source: "Conference",
      personalization: "Loved the launch post",
      status: "prospect",
    });
  });

  it("rejects malformed and duplicate rows without retaining their PII", () => {
    const result = parseProspectsCsv(`email,company,source,status
bad-email,Acme,Research,prospect
good@example.com,Acme,Research,prospect
GOOD@example.com,Acme,Research,prospect
missing@example.com,,Research,prospect
status@example.com,Acme,Research,unknown
`);

    expect(result.prospects).toHaveLength(1);
    expect(result.rejections).toEqual([
      { row: 2, reason: "invalid-email" },
      { row: 4, reason: "duplicate-email" },
      { row: 5, reason: "missing-company" },
      { row: 6, reason: "invalid-status" },
    ]);
    expect(JSON.stringify(result.rejections)).not.toContain("example.com");
  });

  it("requires source columns for provenance", () => {
    expect(() =>
      parseProspectsCsv("email,company\nalice@example.com,Acme\n"),
    ).toThrow("missing required column: source");
  });
});
