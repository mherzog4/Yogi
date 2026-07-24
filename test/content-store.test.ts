import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addContentSource,
  createStoredContentBrief,
  createStoredContentPrompt,
  createStoredRepurposePlan,
  listContentSources,
  reviewStoredContentDraft,
} from "../src/content/store.js";
import { createCampaign } from "../src/workspace.js";
import { writeValidConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

const contentWorkspace = async (): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-content-test-"));
  temporaryDirectories.push(cwd);
  await writeValidConfig(cwd);
  await createCampaign({
    cwd,
    channel: "content",
    name: "Founder Content",
    goal: "Earn qualified subscribers",
  });
  return cwd;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("content workspace", () => {
  it("stores sources, briefs, prompts, and repurpose plans", async () => {
    const cwd = await contentWorkspace();
    const sourcePath = join(cwd, "research.md");
    await writeFile(
      sourcePath,
      "# Research\n\nFive de-identified founders preferred concrete examples.",
      "utf8",
    );

    await expect(
      addContentSource({
        cwd,
        campaignId: "founder-content",
        filePath: sourcePath,
        title: "Founder research",
        type: "customer-research",
      }),
    ).rejects.toThrow("must be de-identified");

    const source = await addContentSource({
      cwd,
      campaignId: "founder-content",
      filePath: sourcePath,
      title: "Founder research",
      type: "customer-research",
      acknowledgeDeidentified: true,
      now: new Date("2026-07-24T11:00:00.000Z"),
    });
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(cwd, source.repositoryPath), "utf8")).toContain(
      "de-identified founders",
    );
    expect(await listContentSources(cwd, "founder-content")).toEqual([source]);

    const brief = await createStoredContentBrief({
      cwd,
      campaignId: "founder-content",
      title: "Specific launch evidence",
      thesis: "Concrete evidence makes launch advice more credible.",
      format: "linkedin-post",
      callToAction: "Read the launch guide",
      sourceIds: [source.id],
      now: new Date("2026-07-24T12:00:00.000Z"),
    });
    const prompt = await createStoredContentPrompt(
      cwd,
      "founder-content",
      brief.id,
    );
    expect(prompt).toContain(`[[source:${source.id}]]`);

    const plan = await createStoredRepurposePlan({
      cwd,
      campaignId: "founder-content",
      briefId: brief.id,
      formats: ["newsletter", "x-thread"],
      now: new Date("2026-07-24T13:00:00.000Z"),
    });
    expect(plan.assets).toHaveLength(2);
    expect(
      JSON.parse(
        await readFile(
          join(
            cwd,
            "campaigns/founder-content/content/repurpose",
            `${brief.id}.json`,
          ),
          "utf8",
        ),
      ),
    ).toEqual(plan);
  });

  it("writes an editorial report without publishing the draft", async () => {
    const cwd = await contentWorkspace();
    const sourcePath = join(cwd, "source.md");
    await writeFile(sourcePath, "# Source\n\nA grounded observation.", "utf8");
    const source = await addContentSource({
      cwd,
      campaignId: "founder-content",
      filePath: sourcePath,
      title: "Original observation",
      type: "original",
    });
    const brief = await createStoredContentBrief({
      cwd,
      campaignId: "founder-content",
      title: "Grounded distribution",
      thesis: "Useful distribution advice starts with evidence.",
      format: "linkedin-post",
      callToAction: "Read the launch guide",
      sourceIds: [source.id],
    });
    const draftPath = join(cwd, "draft.md");
    const body = Array.from(
      { length: 24 },
      () => "Specific evidence helps focused teams make responsible decisions.",
    ).join(" ");
    await writeFile(
      draftPath,
      `# Grounded distribution\n\n${body} [[source:${source.id}]]\n\nRead the launch guide`,
      "utf8",
    );

    const report = await reviewStoredContentDraft({
      cwd,
      campaignId: "founder-content",
      briefId: brief.id,
      draftPath,
    });
    expect(report.passed).toBe(true);
    expect(
      await readFile(
        join(
          cwd,
          "campaigns/founder-content/content/reviews",
          `${brief.id}.json`,
        ),
        "utf8",
      ),
    ).toContain('"passed": true');
  });

  it("requires valid public URLs for external sources", async () => {
    const cwd = await contentWorkspace();
    const sourcePath = join(cwd, "external.md");
    await writeFile(sourcePath, "# External source", "utf8");

    await expect(
      addContentSource({
        cwd,
        campaignId: "founder-content",
        filePath: sourcePath,
        title: "External source",
        type: "external",
        url: "file:///private/notes",
      }),
    ).rejects.toThrow("must use http or https");
  });

  it("rejects source changes made after approval", async () => {
    const cwd = await contentWorkspace();
    const sourcePath = join(cwd, "source.md");
    await writeFile(sourcePath, "# Original source", "utf8");
    const source = await addContentSource({
      cwd,
      campaignId: "founder-content",
      filePath: sourcePath,
      title: "Approved source",
      type: "original",
    });
    const brief = await createStoredContentBrief({
      cwd,
      campaignId: "founder-content",
      title: "Integrity check",
      thesis: "Approved inputs should remain stable.",
      format: "article",
      callToAction: "Read the launch guide",
      sourceIds: [source.id],
    });
    await writeFile(
      join(cwd, source.repositoryPath),
      "# Replaced source",
      "utf8",
    );

    await expect(
      createStoredContentPrompt(cwd, "founder-content", brief.id),
    ).rejects.toThrow("changed after approval");
  });

  it("rejects invalid values passed through the JavaScript API", async () => {
    const cwd = await contentWorkspace();
    const sourcePath = join(cwd, "source.md");
    await writeFile(sourcePath, "# Source", "utf8");

    await expect(
      addContentSource({
        cwd,
        campaignId: "founder-content",
        filePath: sourcePath,
        title: "Source",
        type: "podcast" as unknown as "original",
      }),
    ).rejects.toThrow("Unknown content source type: podcast");
  });
});
