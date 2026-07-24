import { describe, expect, it } from "vitest";
import {
  createPaidCreativePrompt,
  createPaidExperimentPlan,
  reviewPaidExperiment,
  type AdCreativeSet,
  type PaidExperiment,
  type PaidSafetyPolicy,
} from "../src/paid/model.js";

const experiment: PaidExperiment = {
  schemaVersion: 1,
  id: "search-intent-test",
  campaignId: "launch-ads",
  name: "Search intent test",
  objective: "Generate qualified launch-plan signups",
  hypothesis: "Specific planning language will attract higher-intent founders.",
  channel: "search",
  audience: "Bootstrapped B2B SaaS founders",
  offer: "Build a focused launch plan",
  landingPageUrl: "https://launch.example.com/plan",
  tracking: {
    conversionEvent: "launch_plan_started",
    utmSource: "search",
    utmMedium: "paid",
    utmCampaign: "search-intent-test",
  },
  currency: "USD",
  dailyBudgetMinor: 3000,
  totalBudgetMinor: 30000,
  stopLossSpendMinor: 10000,
  minimumCreativeVariants: 3,
  createdAt: "2026-07-24T15:00:00.000Z",
};

const creative: AdCreativeSet = {
  schemaVersion: 1,
  experimentId: experiment.id,
  variants: [
    {
      id: "variant-a",
      headline: "Plan a focused SaaS launch",
      body: "Turn a rough product idea into a launch plan.",
      callToAction: "Build your plan",
    },
    {
      id: "variant-b",
      headline: "A practical launch map",
      body: "Give your next SaaS launch a clear sequence.",
      callToAction: "See the workflow",
    },
    {
      id: "variant-c",
      headline: "Launch with a credible plan",
      body: "Organize positioning, channels, and next steps.",
      callToAction: "Start planning",
    },
  ],
};

const policy: PaidSafetyPolicy = {
  currency: "USD",
  maxDailyBudgetMinor: 5000,
  maxExperimentBudgetMinor: 50000,
  maxSpendWithoutConversionMinor: 10000,
  minimumCreativeVariants: 3,
  allowedLandingPageHosts: ["launch.example.com"],
  prohibitedPhrases: ["guaranteed results"],
};

describe("paid experiment model", () => {
  it("creates a creative prompt that forbids external action", () => {
    const prompt = createPaidCreativePrompt({
      campaign: {
        name: "Launch Ads",
        product: "Launch Map",
        audience: experiment.audience,
        offer: experiment.offer,
        goal: "Generate qualified signups",
      },
      experiment,
      prohibitedPhrases: policy.prohibitedPhrases,
    });

    expect(prompt).toContain("Minimum distinct variants: 3");
    expect(prompt).toContain("guaranteed results");
    expect(prompt).toContain("Do not create campaigns");
  });

  it("passes creative and budgets within policy", () => {
    const report = reviewPaidExperiment({
      experiment,
      creative,
      policy,
      creativeSha256: "a".repeat(64),
      now: new Date("2026-07-24T16:00:00.000Z"),
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.creativeSha256).toBe("a".repeat(64));
  });

  it("reports budget, destination, and creative safety violations", () => {
    const report = reviewPaidExperiment({
      experiment: {
        ...experiment,
        currency: "EUR",
        dailyBudgetMinor: 60000,
        totalBudgetMinor: 55000,
        stopLossSpendMinor: 60000,
        landingPageUrl: "http://unapproved.example/plan",
      },
      creative: {
        ...creative,
        variants: [
          {
            ...creative.variants[0]!,
            body: "Guaranteed results",
          },
          {
            ...creative.variants[0]!,
            id: "duplicate",
            body: "Guaranteed results",
          },
        ],
      },
      policy,
      creativeSha256: "b".repeat(64),
    });

    expect(report.passed).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "currency-mismatch",
        "daily-budget-limit",
        "experiment-budget-limit",
        "daily-exceeds-total",
        "stop-loss-limit",
        "landing-page-protocol",
        "landing-page-host",
        "creative-count",
        "prohibited-phrase",
      ]),
    );
  });

  it("requires both approval and a passing review for launch plans", () => {
    const readiness = reviewPaidExperiment({
      experiment,
      creative,
      policy,
      creativeSha256: "c".repeat(64),
    });

    expect(() =>
      createPaidExperimentPlan({
        experiment,
        mode: "launch",
        readiness,
      }),
    ).toThrow("approved: true");
    expect(() =>
      createPaidExperimentPlan({
        experiment,
        mode: "launch",
        approved: true,
        readiness: { ...readiness, passed: false },
      }),
    ).toThrow("passing review");
    expect(() =>
      createPaidExperimentPlan({
        experiment,
        mode: "launch",
        approved: true,
        readiness: {
          ...readiness,
          experimentId: "another-experiment",
        },
      }),
    ).toThrow("same experiment");

    const plan = createPaidExperimentPlan({
      experiment,
      mode: "launch",
      approved: true,
      readiness,
    });
    expect(plan.externalActionPerformed).toBe(false);
    expect(plan.approved).toBe(true);
    expect(() =>
      createPaidExperimentPlan({
        experiment,
        mode: "activate" as unknown as "draft",
      }),
    ).toThrow("Unknown paid plan mode: activate");
  });
});
