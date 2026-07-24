import { describe, expect, it } from "vitest";
import {
  contentFormatGuidance,
  createContentPrompt,
  createRepurposePlan,
  reviewEditorialDraft,
  type ContentBrief,
  type ContentSource,
} from "../src/content/model.js";

const brief: ContentBrief = {
  schemaVersion: 1,
  id: "credible-launches",
  campaignId: "founder-content",
  title: "Credible launches compound",
  thesis: "Specific evidence earns more trust than manufactured urgency.",
  format: "linkedin-post",
  callToAction: "Read the launch guide",
  audience: "Bootstrapped B2B SaaS founders",
  sourceIds: ["research-notes"],
  createdAt: "2026-07-24T12:00:00.000Z",
};

const source: ContentSource = {
  id: "research-notes",
  title: "Founder research notes",
  type: "customer-research",
  repositoryPath: "campaigns/founder-content/content/sources/research-notes.md",
  sha256: "a".repeat(64),
  addedAt: "2026-07-24T11:00:00.000Z",
};

describe("content model", () => {
  it("rejects unknown runtime formats with a useful error", () => {
    expect(() =>
      contentFormatGuidance("podcast" as unknown as ContentBrief["format"]),
    ).toThrow("Unknown content format: podcast");
  });

  it("creates a grounded prompt with an explicit citation contract", () => {
    const prompt = createContentPrompt({
      campaign: {
        name: "Founder Content",
        product: "Launch Map",
        audience: "Bootstrapped B2B SaaS founders",
        offer: "A practical launch guide",
        goal: "Earn qualified subscribers",
      },
      brief,
      sources: [source],
    });

    expect(prompt).toContain("[[source:research-notes]]");
    expect(prompt).toContain(source.repositoryPath);
    expect(prompt).toContain("Do not invent metrics");
    expect(prompt).toContain("Read the launch guide");
  });

  it("deduplicates formats in a repurpose plan", () => {
    const plan = createRepurposePlan({
      brief,
      formats: ["newsletter", "x-thread", "newsletter"],
      now: new Date("2026-07-24T13:00:00.000Z"),
    });

    expect(plan.assets.map(({ format }) => format)).toEqual([
      "newsletter",
      "x-thread",
    ]);
    expect(plan.createdAt).toBe("2026-07-24T13:00:00.000Z");
  });

  it("fails drafts with unsupported editorial shortcuts", () => {
    const report = reviewEditorialDraft({
      markdown: "TODO: write a game-changing post.",
      brief,
      sources: [source],
      prohibitedPhrases: ["game-changing"],
      now: new Date("2026-07-24T14:00:00.000Z"),
    });

    expect(report.passed).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "missing-heading",
        "below-minimum-length",
        "missing-source",
        "missing-cta",
        "placeholder",
        "prohibited-phrase",
      ]),
    );
  });

  it("passes a grounded draft that meets the configured standard", () => {
    const body = Array.from(
      { length: 24 },
      () => "Specific evidence helps focused teams make responsible decisions.",
    ).join(" ");
    const report = reviewEditorialDraft({
      markdown: `# Credible launches compound

${body} [[source:research-notes]]

Read the launch guide`,
      brief,
      sources: [source],
      prohibitedPhrases: ["game-changing"],
    });

    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.wordCount).toBeGreaterThanOrEqual(120);
  });
});
