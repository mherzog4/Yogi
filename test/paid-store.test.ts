import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStoredPaidCreativePrompt,
  createStoredPaidExperiment,
  planStoredPaidExperiment,
  readStoredAdsDraftInput,
  reviewStoredPaidExperiment,
} from "../src/paid/store.js";
import { createCampaign } from "../src/workspace.js";
import { writeValidConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

const paidWorkspace = async (): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-paid-test-"));
  temporaryDirectories.push(cwd);
  await writeValidConfig(cwd);
  await createCampaign({
    cwd,
    channel: "paid-ads",
    name: "Launch Ads",
    goal: "Generate qualified launch-plan signups",
  });
  return cwd;
};

const createExperiment = (cwd: string) =>
  createStoredPaidExperiment({
    cwd,
    campaignId: "launch-ads",
    name: "Search intent test",
    objective: "Generate qualified signups",
    hypothesis: "Specific planning language will attract focused founders.",
    channel: "search",
    landingPageUrl: "https://launch.example.com/plan",
    conversionEvent: "launch_plan_started",
    utmSource: "search",
    utmMedium: "paid",
    utmCampaign: "search-intent-test",
    dailyBudgetMinor: 3000,
    totalBudgetMinor: 30000,
    stopLossSpendMinor: 10000,
    now: new Date("2026-07-24T15:00:00.000Z"),
  });

const validCreative = {
  schemaVersion: 1,
  experimentId: "search-intent-test",
  variants: [
    {
      id: "variant-a",
      headline: "Plan a focused SaaS launch",
      body: "Turn a rough idea into a practical launch plan.",
      callToAction: "Build your plan",
    },
    {
      id: "variant-b",
      headline: "Give your launch a clear map",
      body: "Organize positioning, channels, and next steps.",
      callToAction: "See the workflow",
    },
    {
      id: "variant-c",
      headline: "Launch with a credible sequence",
      body: "Move from product idea to focused distribution.",
      callToAction: "Start planning",
    },
  ],
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("paid experiment workspace", () => {
  it("stores experiments, prompts, reviews, and launch-ready plans", async () => {
    const cwd = await paidWorkspace();
    const experiment = await createExperiment(cwd);
    expect(experiment.currency).toBe("USD");
    expect(experiment.stopLossSpendMinor).toBe(10000);

    const prompt = await createStoredPaidCreativePrompt(
      cwd,
      "launch-ads",
      experiment.id,
    );
    expect(prompt).toContain("Do not create campaigns");

    const creativePath = join(cwd, "creative.json");
    await writeFile(
      creativePath,
      `${JSON.stringify(validCreative, null, 2)}\n`,
      "utf8",
    );
    const review = await reviewStoredPaidExperiment({
      cwd,
      campaignId: "launch-ads",
      experimentId: experiment.id,
      creativePath,
      now: new Date("2026-07-24T16:00:00.000Z"),
    });
    expect(review.passed).toBe(true);
    expect(review.creativeSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      readStoredAdsDraftInput(cwd, "launch-ads", experiment.id, "customer-123"),
    ).resolves.toMatchObject({
      campaignId: "launch-ads",
      externalAccountId: "customer-123",
      experiment: { id: experiment.id },
      readiness: { passed: true },
    });

    await expect(
      planStoredPaidExperiment({
        cwd,
        campaignId: "launch-ads",
        experimentId: experiment.id,
        mode: "launch",
      }),
    ).rejects.toThrow("approved: true");

    const plan = await planStoredPaidExperiment({
      cwd,
      campaignId: "launch-ads",
      experimentId: experiment.id,
      mode: "launch",
      approved: true,
      now: new Date("2026-07-24T17:00:00.000Z"),
    });
    expect(plan.externalActionPerformed).toBe(false);
    expect(
      await readFile(
        join(
          cwd,
          "campaigns/launch-ads/paid/plans",
          `${experiment.id}-launch.json`,
        ),
        "utf8",
      ),
    ).toContain('"externalActionPerformed": false');
  });

  it("rechecks canonical creative at launch-plan time", async () => {
    const cwd = await paidWorkspace();
    const experiment = await createExperiment(cwd);
    const creativePath = join(cwd, "creative.json");
    await writeFile(creativePath, JSON.stringify(validCreative), "utf8");
    await reviewStoredPaidExperiment({
      cwd,
      campaignId: "launch-ads",
      experimentId: experiment.id,
      creativePath,
    });

    const canonicalPath = join(
      cwd,
      "campaigns/launch-ads/paid/creative",
      `${experiment.id}.json`,
    );
    await writeFile(
      canonicalPath,
      JSON.stringify({
        ...validCreative,
        variants: [
          {
            ...validCreative.variants[0],
            body: "Guaranteed results for every launch.",
          },
          validCreative.variants[1],
          validCreative.variants[2],
        ],
      }),
      "utf8",
    );

    await expect(
      planStoredPaidExperiment({
        cwd,
        campaignId: "launch-ads",
        experimentId: experiment.id,
        mode: "launch",
        approved: true,
      }),
    ).rejects.toThrow("passing review");
  });

  it("allows over-limit proposals in draft but blocks launch readiness", async () => {
    const cwd = await paidWorkspace();
    const experiment = await createStoredPaidExperiment({
      cwd,
      campaignId: "launch-ads",
      name: "Large proposal",
      objective: "Explore a larger test",
      hypothesis: "More reach may generate more signups.",
      channel: "social",
      landingPageUrl: "https://launch.example.com/plan",
      conversionEvent: "launch_plan_started",
      utmSource: "social",
      utmMedium: "paid",
      utmCampaign: "large-proposal",
      dailyBudgetMinor: 6000,
      totalBudgetMinor: 60000,
      stopLossSpendMinor: 10000,
    });
    const draft = await planStoredPaidExperiment({
      cwd,
      campaignId: "launch-ads",
      experimentId: experiment.id,
      mode: "draft",
    });
    expect(draft.mode).toBe("draft");
    expect(draft.externalActionPerformed).toBe(false);

    const creativePath = join(cwd, "large-creative.json");
    await writeFile(
      creativePath,
      JSON.stringify({
        ...validCreative,
        experimentId: experiment.id,
      }),
      "utf8",
    );
    const report = await reviewStoredPaidExperiment({
      cwd,
      campaignId: "launch-ads",
      experimentId: experiment.id,
      creativePath,
    });
    expect(report.passed).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["daily-budget-limit", "experiment-budget-limit"]),
    );
    await expect(
      planStoredPaidExperiment({
        cwd,
        campaignId: "launch-ads",
        experimentId: experiment.id,
        mode: "launch",
        approved: true,
      }),
    ).rejects.toThrow("passing review");
  });
});
