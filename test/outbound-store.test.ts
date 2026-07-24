import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/config.js";
import {
  addSuppression,
  importProspects,
  planOutboundBatch,
} from "../src/outbound/store.js";
import { createCampaign } from "../src/workspace.js";
import { writeValidConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

const setup = async (): Promise<{ cwd: string; campaignId: string }> => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-outbound-test-"));
  temporaryDirectories.push(cwd);
  await initWorkspace({ cwd, name: "Outbound Lab" });
  await writeValidConfig(cwd);
  const campaign = await createCampaign({
    cwd,
    channel: "outbound-email",
    name: "Founder Outbound",
    goal: "Book qualified demos",
  });
  return { cwd, campaignId: campaign.id };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("outbound private workspace", () => {
  it("keeps contacts private while versioning aggregate reports", async () => {
    const { cwd, campaignId } = await setup();
    const csvPath = join(cwd, "prospects.csv");
    await writeFile(
      csvPath,
      `email,company,source,personalization
alice@example.com,Example,Research,Relevant launch
bad-email,Invalid,Research,Observation
`,
      "utf8",
    );

    const report = await importProspects({
      cwd,
      campaignId,
      csvPath,
      now: new Date("2026-07-24T15:00:00.000Z"),
    });
    const publicReport = await readFile(
      join(cwd, "campaigns", campaignId, "outbound", "import-report.json"),
      "utf8",
    );
    const privateStore = await readFile(
      join(
        cwd,
        ".yogi",
        "private",
        "campaigns",
        campaignId,
        "outbound",
        "prospects.json",
      ),
      "utf8",
    );

    expect(report).toMatchObject({ accepted: 1, rejected: 1 });
    expect(publicReport).not.toContain("alice@example.com");
    expect(privateStore).toContain("alice@example.com");
    await expect(importProspects({ cwd, campaignId, csvPath })).rejects.toThrow(
      "Prospects already exist",
    );
  });

  it("applies private suppressions and writes a PII-free batch summary", async () => {
    const { cwd, campaignId } = await setup();
    const csvPath = join(cwd, "prospects.csv");
    await writeFile(
      csvPath,
      `email,company,source,personalization
alice@example.com,Example,Research,Relevant launch
bob@blocked.com,Blocked,Research,Relevant launch
`,
      "utf8",
    );
    await importProspects({ cwd, campaignId, csvPath });
    await addSuppression({
      cwd,
      campaignId,
      type: "domain",
      value: "blocked.com",
      reason: "Existing customer",
      now: new Date("2026-07-24T15:00:00.000Z"),
    });

    const { batch, summary } = await planOutboundBatch({
      cwd,
      campaignId,
      now: new Date("2026-07-24T16:00:00.000Z"),
      id: "batch-safe",
    });
    const publicSummary = await readFile(
      join(
        cwd,
        "campaigns",
        campaignId,
        "outbound",
        "batch-summaries",
        "batch-safe.json",
      ),
      "utf8",
    );

    expect(batch.selected.map(({ email }) => email)).toEqual([
      "alice@example.com",
    ]);
    expect(summary).toMatchObject({
      selected: 1,
      excluded: 1,
      exclusionReasons: { "suppressed-domain": 1 },
    });
    expect(publicSummary).not.toContain("@");
    await expect(
      planOutboundBatch({
        cwd,
        campaignId,
        mode: "send",
      }),
    ).rejects.toThrow("require approved: true");
  });

  it("fails closed when the private suppression store is corrupted", async () => {
    const { cwd, campaignId } = await setup();
    const csvPath = join(cwd, "prospects.csv");
    await writeFile(
      csvPath,
      `email,company,source,personalization
alice@example.com,Example,Research,Relevant launch
`,
      "utf8",
    );
    await importProspects({ cwd, campaignId, csvPath });
    await mkdir(join(cwd, ".yogi", "private", "outbound"), {
      recursive: true,
    });
    await writeFile(
      join(cwd, ".yogi", "private", "outbound", "suppressions.json"),
      JSON.stringify({ schemaVersion: 1, suppressions: "corrupted" }),
      "utf8",
    );

    await expect(planOutboundBatch({ cwd, campaignId })).rejects.toThrow(
      "Invalid private suppression store",
    );
  });

  it("applies suppressions across every campaign in the workspace", async () => {
    const { cwd, campaignId } = await setup();
    const secondCampaign = await createCampaign({
      cwd,
      channel: "outbound-email",
      name: "Second Outbound",
      goal: "Test another segment",
    });
    const csvPath = join(cwd, "prospects.csv");
    await writeFile(
      csvPath,
      `email,company,source,personalization
alice@example.com,Example,Research,Relevant launch
`,
      "utf8",
    );
    await importProspects({
      cwd,
      campaignId: secondCampaign.id,
      csvPath,
    });
    await addSuppression({
      cwd,
      campaignId,
      type: "domain",
      value: "example.com",
      reason: "Protected account",
    });

    const { summary } = await planOutboundBatch({
      cwd,
      campaignId: secondCampaign.id,
    });
    expect(summary).toMatchObject({
      selected: 0,
      excluded: 1,
      exclusionReasons: { "suppressed-domain": 1 },
    });
  });
});
