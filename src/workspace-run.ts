import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AgentProvider,
  RunResult,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import { runGtmStage, type RunGtmStageOptions } from "./campaign.js";
import { getStage } from "./playbooks.js";
import {
  readCampaign,
  updateCampaignStage,
  writeJsonAtomic,
} from "./workspace.js";

export interface ArtifactProvenance {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly capturedAt: string;
  readonly sourceRef?: string;
}

export interface WorkspaceRunManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly campaignId: string;
  readonly channel: string;
  readonly stage: string;
  readonly agent: string;
  readonly sandbox: string;
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly branch?: string;
  readonly commits?: readonly string[];
  readonly iterations?: number;
  readonly artifacts?: readonly ArtifactProvenance[];
  readonly error?: string;
}

type RunStage = (options: RunGtmStageOptions) => Promise<RunResult>;

export interface RunWorkspaceStageOptions {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly stage: string;
  readonly agent: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly approved?: boolean;
  readonly maxIterations?: number;
  /** Test seam for deterministic records. */
  readonly now?: () => Date;
  /** @internal */
  readonly runStage?: RunStage;
}

export interface RunWorkspaceStageResult {
  readonly result: RunResult;
  readonly manifest: WorkspaceRunManifest;
}

const runManifestPath = (
  cwd: string,
  campaignId: string,
  runId: string,
): string => join(cwd, "campaigns", campaignId, "runs", `${runId}.json`);

const createRunId = (date: Date): string =>
  `${date.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

const execFileAsync = promisify(execFile);

const readArtifact = async (
  cwd: string,
  path: string,
  sourceRef: string,
): Promise<{ contents: Buffer; sourceRef?: string }> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${sourceRef}:${path}`],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return {
      contents: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      sourceRef,
    };
  } catch {
    return {
      contents: await readFile(join(cwd, path)),
    };
  }
};

const captureArtifacts = async (
  cwd: string,
  campaignId: string,
  channel: Parameters<typeof getStage>[0],
  stageId: string,
  capturedAt: string,
  sourceRef: string,
): Promise<ArtifactProvenance[]> => {
  const selectedStage = getStage(channel, stageId);
  const artifacts: ArtifactProvenance[] = [];
  const missing: string[] = [];

  for (const deliverable of selectedStage.deliverables) {
    const path = posix.join("campaigns", campaignId, deliverable);
    try {
      const artifact = await readArtifact(cwd, path, sourceRef);
      artifacts.push({
        path,
        sha256: createHash("sha256").update(artifact.contents).digest("hex"),
        bytes: artifact.contents.length,
        capturedAt,
        ...(artifact.sourceRef ? { sourceRef: artifact.sourceRef } : {}),
      });
    } catch {
      missing.push(path);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Stage completed without required artifacts: ${missing.join(", ")}`,
    );
  }

  return artifacts;
};

export const runWorkspaceStage = async (
  options: RunWorkspaceStageOptions,
): Promise<RunWorkspaceStageResult> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const campaign = await readCampaign(cwd, options.campaignId);
  const selectedStage = getStage(campaign.channel, options.stage);
  if (selectedStage.requiresApproval && options.approved !== true) {
    throw new Error(
      `${selectedStage.name} affects external systems and requires approved: true`,
    );
  }

  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const runId = createRunId(new Date(startedAt));
  const path = runManifestPath(cwd, campaign.id, runId);
  const running: WorkspaceRunManifest = {
    schemaVersion: 1,
    id: runId,
    campaignId: campaign.id,
    channel: campaign.channel,
    stage: options.stage,
    agent: options.agent.name,
    sandbox: options.sandbox.name,
    status: "running",
    startedAt,
  };

  await writeJsonAtomic(path, running);
  await updateCampaignStage({
    cwd,
    campaignId: campaign.id,
    stageId: options.stage,
    status: "running",
    runId,
    now: new Date(startedAt),
  });

  try {
    const runStage = options.runStage ?? runGtmStage;
    const result = await runStage({
      campaign: campaign.brief,
      channel: campaign.channel,
      stage: options.stage,
      agent: options.agent,
      sandbox: options.sandbox,
      ...(options.approved !== undefined ? { approved: options.approved } : {}),
      ...(options.maxIterations !== undefined
        ? { maxIterations: options.maxIterations }
        : {}),
      cwd,
    });
    const completedAt = clock().toISOString();
    const artifacts = await captureArtifacts(
      cwd,
      campaign.id,
      campaign.channel,
      options.stage,
      completedAt,
      result.branch,
    );
    const completed: WorkspaceRunManifest = {
      ...running,
      status: "completed",
      completedAt,
      branch: result.branch,
      commits: result.commits.map(({ sha }) => sha),
      iterations: result.iterations.length,
      artifacts,
    };

    await writeJsonAtomic(path, completed);
    await updateCampaignStage({
      cwd,
      campaignId: campaign.id,
      stageId: options.stage,
      status: "completed",
      runId,
      now: new Date(completedAt),
    });
    return { result, manifest: completed };
  } catch (error) {
    const completedAt = clock().toISOString();
    const failed: WorkspaceRunManifest = {
      ...running,
      status: "failed",
      completedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJsonAtomic(path, failed);
    await updateCampaignStage({
      cwd,
      campaignId: campaign.id,
      stageId: options.stage,
      status: "failed",
      runId,
      now: new Date(completedAt),
    });
    throw error;
  }
};
