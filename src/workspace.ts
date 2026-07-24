import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { campaignSlug, type CampaignBrief } from "./campaign.js";
import { loadYogiConfig, type YogiConfig } from "./config.js";
import {
  getPlaybook,
  getStage,
  GTM_PLAYBOOKS,
  type GtmChannel,
} from "./playbooks.js";

export type CampaignStageStatus =
  "pending" | "running" | "completed" | "failed";

export interface CampaignStageRecord {
  readonly id: string;
  readonly name: string;
  readonly requiresApproval: boolean;
  readonly status: CampaignStageStatus;
  readonly updatedAt: string;
  readonly lastRunId?: string;
}

export interface CampaignRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly channel: GtmChannel;
  readonly brief: CampaignBrief;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stages: readonly CampaignStageRecord[];
}

export interface CreateCampaignOptions {
  readonly cwd?: string;
  readonly channel: GtmChannel;
  readonly name: string;
  readonly goal: string;
  readonly audience?: string;
  readonly offer?: string;
  readonly proof?: readonly string[];
  readonly constraints?: readonly string[];
  readonly voice?: string;
  /** Test seam for deterministic records. */
  readonly now?: Date;
}

const campaignPath = (cwd: string, id: string): string =>
  join(cwd, "campaigns", id, "campaign.json");

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
};

const proofFromConfig = (config: YogiConfig): string[] =>
  config.product.proof.map(({ claim, source }) =>
    source ? `${claim} (source: ${source})` : claim,
  );

export const createCampaign = async (
  options: CreateCampaignOptions,
): Promise<CampaignRecord> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await loadYogiConfig({ cwd });
  const id = campaignSlug(options.name);
  const path = campaignPath(cwd, id);

  try {
    await readFile(path, "utf8");
    throw new Error(`Campaign ${id} already exists at ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Campaign ")) {
      throw error;
    }
    if (errorCode(error) !== "ENOENT") throw error;
  }

  if (!options.goal.trim()) throw new Error("Campaign goal cannot be empty");
  const timestamp = (options.now ?? new Date()).toISOString();
  const playbook = getPlaybook(options.channel);
  const configProof = proofFromConfig(config);
  const brief: CampaignBrief = {
    name: options.name.trim(),
    product: `${config.product.name}: ${config.product.description}`,
    audience: options.audience?.trim() || config.product.audiences[0]!,
    offer: options.offer?.trim() || config.product.offers[0]!,
    goal: options.goal.trim(),
    proof: [...configProof, ...(options.proof ?? [])],
    constraints: options.constraints ?? [],
    voice: options.voice?.trim() || config.product.voice.traits.join(", "),
  };

  const record: CampaignRecord = {
    schemaVersion: 1,
    id,
    channel: options.channel,
    brief,
    createdAt: timestamp,
    updatedAt: timestamp,
    stages: playbook.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      requiresApproval: stage.requiresApproval,
      status: "pending",
      updatedAt: timestamp,
    })),
  };

  await writeJsonAtomic(path, record);
  return record;
};

const validateCampaignRecord = (
  input: unknown,
  path: string,
): CampaignRecord => {
  const isString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(isString);
  const isChannel = (value: unknown): value is GtmChannel =>
    typeof value === "string" && Object.hasOwn(GTM_PLAYBOOKS, value);
  const isStatus = (value: unknown): value is CampaignStageStatus =>
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed";

  if (
    typeof input !== "object" ||
    input === null ||
    !("schemaVersion" in input) ||
    input.schemaVersion !== 1 ||
    !("id" in input) ||
    !isString(input.id) ||
    !("channel" in input) ||
    !isChannel(input.channel) ||
    !("brief" in input) ||
    typeof input.brief !== "object" ||
    input.brief === null ||
    !("name" in input.brief) ||
    !isString(input.brief.name) ||
    !("product" in input.brief) ||
    !isString(input.brief.product) ||
    !("audience" in input.brief) ||
    !isString(input.brief.audience) ||
    !("offer" in input.brief) ||
    !isString(input.brief.offer) ||
    !("goal" in input.brief) ||
    !isString(input.brief.goal) ||
    ("proof" in input.brief &&
      input.brief.proof !== undefined &&
      !isStringArray(input.brief.proof)) ||
    ("constraints" in input.brief &&
      input.brief.constraints !== undefined &&
      !isStringArray(input.brief.constraints)) ||
    ("voice" in input.brief &&
      input.brief.voice !== undefined &&
      !isString(input.brief.voice)) ||
    !("createdAt" in input) ||
    !isString(input.createdAt) ||
    !("updatedAt" in input) ||
    !isString(input.updatedAt) ||
    !("stages" in input) ||
    !Array.isArray(input.stages) ||
    !input.stages.every(
      (stage) =>
        typeof stage === "object" &&
        stage !== null &&
        "id" in stage &&
        isString(stage.id) &&
        "name" in stage &&
        isString(stage.name) &&
        "requiresApproval" in stage &&
        typeof stage.requiresApproval === "boolean" &&
        "status" in stage &&
        isStatus(stage.status) &&
        "updatedAt" in stage &&
        isString(stage.updatedAt) &&
        (!("lastRunId" in stage) ||
          stage.lastRunId === undefined ||
          isString(stage.lastRunId)),
    )
  ) {
    throw new Error(`Invalid campaign record at ${path}`);
  }

  return input as unknown as CampaignRecord;
};

export const readCampaign = async (
  cwd: string,
  id: string,
): Promise<CampaignRecord> => {
  const root = resolve(cwd);
  const path = campaignPath(root, campaignSlug(id));
  const contents = await readFile(path, "utf8").catch(() => {
    throw new Error(`Campaign ${id} was not found at ${path}`);
  });

  return validateCampaignRecord(JSON.parse(contents) as unknown, path);
};

export const listCampaigns = async (
  cwd = process.cwd(),
): Promise<CampaignRecord[]> => {
  const root = resolve(cwd);
  const campaignsRoot = join(root, "campaigns");
  const entries = await readdir(campaignsRoot, {
    withFileTypes: true,
  }).catch(() => []);
  const records: CampaignRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await access(campaignPath(root, entry.name));
    } catch {
      // Ignore non-campaign directories so agents may store shared assets here.
      continue;
    }
    records.push(await readCampaign(root, entry.name));
  }

  return records.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
};

export interface UpdateStageOptions {
  readonly cwd: string;
  readonly campaignId: string;
  readonly stageId: string;
  readonly status: CampaignStageStatus;
  readonly runId?: string;
  readonly now?: Date;
}

export const updateCampaignStage = async (
  options: UpdateStageOptions,
): Promise<CampaignRecord> => {
  const root = resolve(options.cwd);
  const record = await readCampaign(root, options.campaignId);
  getStage(record.channel, options.stageId);
  const timestamp = (options.now ?? new Date()).toISOString();
  let found = false;

  const stages = record.stages.map((stage) => {
    if (stage.id !== options.stageId) return stage;
    found = true;
    return {
      ...stage,
      status: options.status,
      updatedAt: timestamp,
      ...(options.runId ? { lastRunId: options.runId } : {}),
    };
  });

  if (!found) {
    throw new Error(
      `Campaign ${record.id} does not include stage ${options.stageId}`,
    );
  }

  const updated: CampaignRecord = {
    ...record,
    updatedAt: timestamp,
    stages,
  };
  await writeJsonAtomic(campaignPath(root, record.id), updated);
  return updated;
};

export const formatCampaignStatus = (campaign: CampaignRecord): string => {
  const lines = [
    `${campaign.brief.name} (${campaign.id})`,
    `Channel: ${campaign.channel}`,
    `Goal: ${campaign.brief.goal}`,
    "",
  ];

  for (const stage of campaign.stages) {
    const approval = stage.requiresApproval ? " · approval required" : "";
    lines.push(`  ${stage.status.padEnd(9)} ${stage.id}${approval}`);
  }

  return lines.join("\n");
};

export { writeJsonAtomic };
