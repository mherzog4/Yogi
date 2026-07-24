import { describe, expect, it } from "vitest";
import { buildOutboundBatch, type Prospect } from "../src/outbound/model.js";

const prospect = (
  email: string,
  overrides: Partial<Prospect> = {},
): Prospect => ({
  email,
  domain: email.split("@")[1]!,
  company: "Acme",
  source: "Research",
  personalization: "Relevant observation",
  status: "prospect",
  ...overrides,
});

describe("outbound batch safety policy", () => {
  it("applies suppression, quality, domain, and daily limits deterministically", () => {
    const batch = buildOutboundBatch({
      prospects: [
        prospect("alice@example.com"),
        prospect("bob@example.com"),
        prospect("charlie@example.com"),
        prospect("info@another.com"),
        prospect("plain@third.com", { personalization: " " }),
        prospect("blocked@blocked.com"),
        prospect("replied@fourth.com", { status: "replied" }),
        prospect("last@fifth.com"),
      ],
      suppressions: [
        {
          type: "domain",
          value: "blocked.com",
          reason: "Customer domain",
          createdAt: "2026-07-24T15:00:00.000Z",
        },
      ],
      policy: {
        dailyProspectLimit: 3,
        maxPerDomain: 2,
      },
      now: new Date("2026-07-24T16:00:00.000Z"),
      id: "batch-1",
    });

    expect(batch.selected.map(({ email }) => email)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "last@fifth.com",
    ]);
    expect(batch.excluded.map(({ reason }) => reason)).toEqual([
      "domain-cap",
      "role-address",
      "missing-personalization",
      "suppressed-domain",
      "invalid-status",
    ]);
  });

  it("requires explicit approval for send-ready batches", () => {
    expect(() =>
      buildOutboundBatch({
        prospects: [prospect("alice@example.com")],
        mode: "send",
      }),
    ).toThrow("require approved: true");

    expect(
      buildOutboundBatch({
        prospects: [prospect("alice@example.com")],
        mode: "send",
        approved: true,
      }).approved,
    ).toBe(true);
  });
});
