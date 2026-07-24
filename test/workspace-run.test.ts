import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentProvider,
  RunResult,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/config.js";
import { createCampaign, readCampaign } from "../src/workspace.js";
import { runWorkspaceStage } from "../src/workspace-run.js";
import { writeValidConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];
const agent = { name: "test-agent" } as AgentProvider;
const sandbox = { name: "test-sandbox" } as SandboxProvider;
const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

const setupCampaign = async (
  channel: "outbound-email" | "paid-ads" = "outbound-email",
): Promise<{ cwd: string; id: string }> => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-run-test-"));
  temporaryDirectories.push(cwd);
  await initWorkspace({ cwd, name: "Run Lab" });
  await writeValidConfig(cwd);
  const campaign = await createCampaign({
    cwd,
    channel,
    name: "Launch Test",
    goal: "Generate qualified demand",
  });
  return { cwd, id: campaign.id };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace run manifests", () => {
  it("records a completed run and hashes required artifacts", async () => {
    const { cwd, id } = await setupCampaign();
    const runStage = vi.fn(async (): Promise<RunResult> => {
      const campaignDirectory = join(cwd, "campaigns", id);
      await mkdir(campaignDirectory, { recursive: true });
      await Promise.all([
        writeFile(join(campaignDirectory, "sequence.md"), "Sequence\n"),
        writeFile(
          join(campaignDirectory, "subject-lines.md"),
          "Subject lines\n",
        ),
      ]);
      return {
        iterations: [{}],
        stdout: "complete",
        commits: [{ sha: "abc123" }],
        branch: "yogi/launch-test/sequence-draft",
      };
    });
    const times = [
      new Date("2026-07-24T15:00:00.000Z"),
      new Date("2026-07-24T15:01:00.000Z"),
    ];

    const { manifest } = await runWorkspaceStage({
      cwd,
      campaignId: id,
      stage: "sequence-draft",
      agent,
      sandbox,
      runStage,
      now: () => times.shift()!,
    });

    expect(manifest.status).toBe("completed");
    expect(manifest.commits).toEqual(["abc123"]);
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.artifacts?.[0]?.sha256).toHaveLength(64);
    expect(
      (await readCampaign(cwd, id)).stages.find(
        (stage) => stage.id === "sequence-draft",
      ),
    ).toMatchObject({ status: "completed", lastRunId: manifest.id });

    const stored = JSON.parse(
      await readFile(
        join(cwd, "campaigns", id, "runs", `${manifest.id}.json`),
        "utf8",
      ),
    ) as { status: string };
    expect(stored.status).toBe("completed");
  });

  it("marks the run failed when a required artifact is missing", async () => {
    const { cwd, id } = await setupCampaign();
    const runStage = vi.fn(async (): Promise<RunResult> => ({
      iterations: [{}],
      stdout: "complete",
      commits: [],
      branch: "test",
    }));

    await expect(
      runWorkspaceStage({
        cwd,
        campaignId: id,
        stage: "sequence-draft",
        agent,
        sandbox,
        runStage,
      }),
    ).rejects.toThrow("without required artifacts");

    const campaign = await readCampaign(cwd, id);
    expect(
      campaign.stages.find((stage) => stage.id === "sequence-draft")?.status,
    ).toBe("failed");
    const runFiles = await readdir(join(cwd, "campaigns", id, "runs"));
    const stored = JSON.parse(
      await readFile(join(cwd, "campaigns", id, "runs", runFiles[0]!), "utf8"),
    ) as { status: string };
    expect(stored.status).toBe("failed");
  });

  it("captures artifacts from the branch returned by Sandcastle", async () => {
    const { cwd, id } = await setupCampaign();
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.name", "Yogi Test"]);
    await git(cwd, ["config", "user.email", "yogi@example.test"]);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["switch", "-c", "artifact-branch"]);

    const campaignDirectory = join(cwd, "campaigns", id);
    await Promise.all([
      writeFile(join(campaignDirectory, "sequence.md"), "From branch\n"),
      writeFile(
        join(campaignDirectory, "subject-lines.md"),
        "Branch subjects\n",
      ),
    ]);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "add artifacts"]);
    await git(cwd, ["switch", "main"]);

    const { manifest } = await runWorkspaceStage({
      cwd,
      campaignId: id,
      stage: "sequence-draft",
      agent,
      sandbox,
      runStage: async () => ({
        iterations: [{}],
        stdout: "complete",
        commits: [{ sha: "branch-commit" }],
        branch: "artifact-branch",
      }),
    });

    expect(manifest.artifacts).toHaveLength(2);
    expect(
      manifest.artifacts?.every(
        (artifact) => artifact.sourceRef === "artifact-branch",
      ),
    ).toBe(true);
  });

  it("checks approval before creating an external-action run", async () => {
    const { cwd, id } = await setupCampaign("paid-ads");
    const runStage = vi.fn();

    await expect(
      runWorkspaceStage({
        cwd,
        campaignId: id,
        stage: "launch",
        agent,
        sandbox,
        runStage,
      }),
    ).rejects.toThrow("requires approved: true");
    expect(runStage).not.toHaveBeenCalled();
    await expect(readdir(join(cwd, "campaigns", id, "runs"))).rejects.toThrow();
  });
});
