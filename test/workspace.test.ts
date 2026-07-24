import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/config.js";
import {
  createCampaign,
  formatCampaignStatus,
  listCampaigns,
  readCampaign,
  updateCampaignStage,
} from "../src/workspace.js";
import { writeValidConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

const workspace = async (): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-workspace-test-"));
  temporaryDirectories.push(cwd);
  await initWorkspace({ cwd, name: "Growth Lab" });
  await writeValidConfig(cwd);
  return cwd;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("campaign workspace", () => {
  it("creates a campaign from shared config defaults", async () => {
    const cwd = await workspace();
    const created = await createCampaign({
      cwd,
      channel: "outbound-email",
      name: "Founder Launch",
      goal: "Book ten demos",
      now: new Date("2026-07-24T15:00:00.000Z"),
    });

    expect(created.id).toBe("founder-launch");
    expect(created.brief.audience).toBe("Bootstrapped B2B SaaS founders");
    expect(created.stages.at(-1)).toMatchObject({
      id: "launch",
      status: "pending",
      requiresApproval: true,
    });
    await expect(readCampaign(cwd, created.id)).resolves.toEqual(created);
  });

  it("lists campaigns and renders compact stage status", async () => {
    const cwd = await workspace();
    const created = await createCampaign({
      cwd,
      channel: "content",
      name: "Category Education",
      goal: "Earn qualified newsletter subscribers",
    });
    const updated = await updateCampaignStage({
      cwd,
      campaignId: created.id,
      stageId: "audience-research",
      status: "completed",
      runId: "run-1",
    });

    expect(await listCampaigns(cwd)).toHaveLength(1);
    expect(formatCampaignStatus(updated)).toContain(
      "completed audience-research",
    );
    expect(formatCampaignStatus(updated)).toContain(
      "publish · approval required",
    );
  });

  it("refuses to overwrite an existing campaign", async () => {
    const cwd = await workspace();
    const input = {
      cwd,
      channel: "paid-ads" as const,
      name: "Demand Test",
      goal: "Validate demand",
    };
    await createCampaign(input);

    await expect(createCampaign(input)).rejects.toThrow("already exists");
  });

  it("surfaces a corrupted campaign record instead of hiding it", async () => {
    const cwd = await workspace();
    const brokenDirectory = join(cwd, "campaigns", "broken");
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(
      join(brokenDirectory, "campaign.json"),
      JSON.stringify({ schemaVersion: 1, id: "broken" }),
      "utf8",
    );

    await expect(listCampaigns(cwd)).rejects.toThrow("Invalid campaign record");
  });
});
