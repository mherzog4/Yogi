import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadYogiConfig } from "../config.js";
import { readCampaign, writeJsonAtomic } from "../workspace.js";
import { parseProspectsCsv } from "./csv.js";
import {
  buildOutboundBatch,
  type OutboundBatch,
  type OutboundBatchMode,
  type Prospect,
  type Suppression,
} from "./model.js";

interface PrivateProspectStore {
  readonly schemaVersion: 1;
  readonly importedAt: string;
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly prospects: readonly Prospect[];
}

interface PrivateSuppressionStore {
  readonly schemaVersion: 1;
  readonly suppressions: readonly Suppression[];
}

const PROSPECT_STATUSES = new Set([
  "prospect",
  "contacted",
  "replied",
  "unsubscribed",
  "bounced",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isProspect = (value: unknown): value is Prospect =>
  typeof value === "object" &&
  value !== null &&
  "email" in value &&
  isString(value.email) &&
  EMAIL_PATTERN.test(value.email) &&
  "domain" in value &&
  isString(value.domain) &&
  value.domain === value.email.split("@")[1] &&
  "company" in value &&
  isString(value.company) &&
  "source" in value &&
  isString(value.source) &&
  "status" in value &&
  isString(value.status) &&
  PROSPECT_STATUSES.has(value.status) &&
  (!("firstName" in value) ||
    value.firstName === undefined ||
    isString(value.firstName)) &&
  (!("lastName" in value) ||
    value.lastName === undefined ||
    isString(value.lastName)) &&
  (!("role" in value) || value.role === undefined || isString(value.role)) &&
  (!("sourceUrl" in value) ||
    value.sourceUrl === undefined ||
    isString(value.sourceUrl)) &&
  (!("personalization" in value) ||
    value.personalization === undefined ||
    typeof value.personalization === "string");

const isSuppression = (value: unknown): value is Suppression =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  (value.type === "email" || value.type === "domain") &&
  "value" in value &&
  isString(value.value) &&
  ((value.type === "email" && EMAIL_PATTERN.test(value.value)) ||
    (value.type === "domain" && DOMAIN_PATTERN.test(value.value))) &&
  "reason" in value &&
  isString(value.reason) &&
  "createdAt" in value &&
  isString(value.createdAt);

const privateRoot = (cwd: string, campaignId: string): string =>
  join(cwd, ".yogi", "private", "campaigns", campaignId, "outbound");

const publicRoot = (cwd: string, campaignId: string): string =>
  join(cwd, "campaigns", campaignId, "outbound");

const suppressionPath = (cwd: string): string =>
  join(cwd, ".yogi", "private", "outbound", "suppressions.json");

const ensureOutboundCampaign = async (
  cwd: string,
  campaignId: string,
): Promise<string> => {
  const campaign = await readCampaign(cwd, campaignId);
  if (campaign.channel !== "outbound-email") {
    throw new Error(
      `Campaign ${campaign.id} uses ${campaign.channel}, not outbound-email`,
    );
  }
  return campaign.id;
};

const countReasons = (
  values: readonly { reason: string }[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { reason } of values) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
};

export interface ImportProspectsOptions {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly csvPath: string;
  readonly replace?: boolean;
  readonly now?: Date;
}

export interface ProspectImportReport {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly importedAt: string;
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly accepted: number;
  readonly rejected: number;
  readonly rejectionReasons: Readonly<Record<string, number>>;
  readonly privateStore: string;
}

export const importProspects = async (
  options: ImportProspectsOptions,
): Promise<ProspectImportReport> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const campaignId = await ensureOutboundCampaign(cwd, options.campaignId);
  const csvPath = resolve(cwd, options.csvPath);
  const contents = await readFile(csvPath, "utf8");
  const parsed = parseProspectsCsv(contents);
  const importedAt = (options.now ?? new Date()).toISOString();
  const sourceSha256 = createHash("sha256").update(contents).digest("hex");
  const privateDirectory = privateRoot(cwd, campaignId);
  const prospectsPath = join(privateDirectory, "prospects.json");

  if (!options.replace) {
    try {
      await access(prospectsPath);
      throw new Error(
        `Prospects already exist for ${campaignId}. Use replace: true or --replace.`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Prospects already")
      ) {
        throw error;
      }
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  await mkdir(privateDirectory, { recursive: true });
  const store: PrivateProspectStore = {
    schemaVersion: 1,
    importedAt,
    sourceFile: basename(csvPath),
    sourceSha256,
    prospects: parsed.prospects,
  };
  await writeJsonAtomic(prospectsPath, store);
  await writeJsonAtomic(join(privateDirectory, "import-details.json"), {
    schemaVersion: 1,
    importedAt,
    sourceFile: basename(csvPath),
    rejections: parsed.rejections,
  });

  const report: ProspectImportReport = {
    schemaVersion: 1,
    campaignId,
    importedAt,
    sourceFile: basename(csvPath),
    sourceSha256,
    accepted: parsed.prospects.length,
    rejected: parsed.rejections.length,
    rejectionReasons: countReasons(parsed.rejections),
    privateStore: ".yogi/private",
  };
  await writeJsonAtomic(
    join(publicRoot(cwd, campaignId), "import-report.json"),
    report,
  );
  return report;
};

const readProspects = async (
  cwd: string,
  campaignId: string,
): Promise<readonly Prospect[]> => {
  const path = join(privateRoot(cwd, campaignId), "prospects.json");
  const store = JSON.parse(
    await readFile(path, "utf8"),
  ) as PrivateProspectStore;
  if (
    store.schemaVersion !== 1 ||
    !Array.isArray(store.prospects) ||
    !store.prospects.every(isProspect)
  ) {
    throw new Error(`Invalid private prospect store at ${path}`);
  }
  return store.prospects;
};

const readSuppressions = async (
  cwd: string,
): Promise<readonly Suppression[]> => {
  const path = suppressionPath(cwd);
  try {
    const store = JSON.parse(
      await readFile(path, "utf8"),
    ) as PrivateSuppressionStore;
    if (
      store.schemaVersion !== 1 ||
      !Array.isArray(store.suppressions) ||
      !store.suppressions.every(isSuppression)
    ) {
      throw new Error(`Invalid private suppression store at ${path}`);
    }
    return store.suppressions;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
};

export interface AddSuppressionOptions {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly type: "email" | "domain";
  readonly value: string;
  readonly reason: string;
  readonly now?: Date;
}

export const addSuppression = async (
  options: AddSuppressionOptions,
): Promise<Suppression> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  await ensureOutboundCampaign(cwd, options.campaignId);
  const value = options.value.trim().toLowerCase();
  const reason = options.reason.trim();
  if (!value) throw new Error("Suppression value cannot be empty");
  if (!reason) throw new Error("Suppression reason cannot be empty");
  if (options.type === "email" && !EMAIL_PATTERN.test(value)) {
    throw new Error("Email suppression must be a valid email address");
  }
  if (options.type === "domain" && !DOMAIN_PATTERN.test(value)) {
    throw new Error("Domain suppression must be a valid domain");
  }

  const suppressions = [...(await readSuppressions(cwd))];
  if (
    suppressions.some(
      (item) => item.type === options.type && item.value === value,
    )
  ) {
    throw new Error(`${options.type} ${value} is already suppressed`);
  }

  const suppression: Suppression = {
    type: options.type,
    value,
    reason,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  suppressions.push(suppression);
  await writeJsonAtomic(suppressionPath(cwd), {
    schemaVersion: 1,
    suppressions,
  } satisfies PrivateSuppressionStore);
  return suppression;
};

export interface PlanOutboundBatchOptions {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly mode?: OutboundBatchMode;
  readonly approved?: boolean;
  readonly now?: Date;
  readonly id?: string;
}

export interface OutboundBatchSummary {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly batchId: string;
  readonly mode: OutboundBatchMode;
  readonly approved: boolean;
  readonly createdAt: string;
  readonly selected: number;
  readonly excluded: number;
  readonly exclusionReasons: Readonly<Record<string, number>>;
  readonly policy: OutboundBatch["policy"];
  readonly privateBatch: string;
}

export const planOutboundBatch = async (
  options: PlanOutboundBatchOptions,
): Promise<{ batch: OutboundBatch; summary: OutboundBatchSummary }> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const campaignId = await ensureOutboundCampaign(cwd, options.campaignId);
  const [config, prospects, suppressions] = await Promise.all([
    loadYogiConfig({ cwd }),
    readProspects(cwd, campaignId),
    readSuppressions(cwd),
  ]);
  const batch = buildOutboundBatch({
    prospects,
    suppressions,
    ...(config.outbound ? { policy: config.outbound } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.approved !== undefined ? { approved: options.approved } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.id ? { id: options.id } : {}),
  });
  const batchPath = join(
    privateRoot(cwd, campaignId),
    "batches",
    `${batch.id}.json`,
  );
  await writeJsonAtomic(batchPath, batch);

  const summary: OutboundBatchSummary = {
    schemaVersion: 1,
    campaignId,
    batchId: batch.id,
    mode: batch.mode,
    approved: batch.approved,
    createdAt: batch.createdAt,
    selected: batch.selected.length,
    excluded: batch.excluded.length,
    exclusionReasons: countReasons(batch.excluded),
    policy: batch.policy,
    privateBatch: ".yogi/private",
  };
  await writeJsonAtomic(
    join(publicRoot(cwd, campaignId), "batch-summaries", `${batch.id}.json`),
    summary,
  );
  return { batch, summary };
};
