import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { campaignSlug } from "../campaign.js";
import { loadYogiConfig, type PaidAdsDefaults } from "../config.js";
import { readCampaign, writeJsonAtomic } from "../workspace.js";
import {
  createPaidCreativePrompt,
  createPaidExperimentPlan,
  isPaidChannel,
  reviewPaidExperiment,
  type AdCreativeSet,
  type PaidChannel,
  type PaidExperiment,
  type PaidExperimentPlan,
  type PaidPlanMode,
  type PaidReadinessReport,
  type PaidSafetyPolicy,
} from "./model.js";

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

const paidRoot = (cwd: string, campaignId: string): string =>
  join(cwd, "campaigns", campaignId, "paid");

const ensurePaidCampaign = async (cwd: string, campaignId: string) => {
  const campaign = await readCampaign(cwd, campaignId);
  if (campaign.channel !== "paid-ads") {
    throw new Error(
      `Campaign ${campaign.id} uses ${campaign.channel}, not paid-ads`,
    );
  }
  return campaign;
};

const requirePaidConfig = (config: {
  readonly paidAds?: PaidAdsDefaults;
}): PaidAdsDefaults => {
  if (!config.paidAds) {
    throw new Error(
      "Configure paidAds safety limits in yogi.config.ts before creating an experiment",
    );
  }
  return config.paidAds;
};

const isPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const isExperiment = (value: unknown): value is PaidExperiment =>
  typeof value === "object" &&
  value !== null &&
  "schemaVersion" in value &&
  value.schemaVersion === 1 &&
  "id" in value &&
  typeof value.id === "string" &&
  "campaignId" in value &&
  typeof value.campaignId === "string" &&
  "name" in value &&
  typeof value.name === "string" &&
  "objective" in value &&
  typeof value.objective === "string" &&
  "hypothesis" in value &&
  typeof value.hypothesis === "string" &&
  "channel" in value &&
  isPaidChannel(value.channel) &&
  "audience" in value &&
  typeof value.audience === "string" &&
  "offer" in value &&
  typeof value.offer === "string" &&
  "landingPageUrl" in value &&
  typeof value.landingPageUrl === "string" &&
  "tracking" in value &&
  typeof value.tracking === "object" &&
  value.tracking !== null &&
  "conversionEvent" in value.tracking &&
  typeof value.tracking.conversionEvent === "string" &&
  "utmSource" in value.tracking &&
  typeof value.tracking.utmSource === "string" &&
  "utmMedium" in value.tracking &&
  typeof value.tracking.utmMedium === "string" &&
  "utmCampaign" in value.tracking &&
  typeof value.tracking.utmCampaign === "string" &&
  "currency" in value &&
  typeof value.currency === "string" &&
  "dailyBudgetMinor" in value &&
  isPositiveInteger(value.dailyBudgetMinor) &&
  "totalBudgetMinor" in value &&
  isPositiveInteger(value.totalBudgetMinor) &&
  "stopLossSpendMinor" in value &&
  isPositiveInteger(value.stopLossSpendMinor) &&
  "minimumCreativeVariants" in value &&
  isPositiveInteger(value.minimumCreativeVariants) &&
  "createdAt" in value &&
  typeof value.createdAt === "string";

const isCreativeSet = (value: unknown): value is AdCreativeSet =>
  typeof value === "object" &&
  value !== null &&
  "schemaVersion" in value &&
  value.schemaVersion === 1 &&
  "experimentId" in value &&
  typeof value.experimentId === "string" &&
  "variants" in value &&
  Array.isArray(value.variants) &&
  value.variants.every(
    (variant) =>
      typeof variant === "object" &&
      variant !== null &&
      "id" in variant &&
      typeof variant.id === "string" &&
      "headline" in variant &&
      typeof variant.headline === "string" &&
      "body" in variant &&
      typeof variant.body === "string" &&
      "callToAction" in variant &&
      typeof variant.callToAction === "string",
  );

const policyFromConfig = (
  config: PaidAdsDefaults,
  prohibitedPhrases: readonly string[],
): PaidSafetyPolicy => ({
  ...config,
  prohibitedPhrases: [...new Set(prohibitedPhrases)],
});

export interface CreatePaidExperimentOptions {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly name: string;
  readonly objective: string;
  readonly hypothesis: string;
  readonly channel: PaidChannel;
  readonly landingPageUrl: string;
  readonly conversionEvent: string;
  readonly utmSource: string;
  readonly utmMedium: string;
  readonly utmCampaign: string;
  readonly dailyBudgetMinor: number;
  readonly totalBudgetMinor: number;
  readonly stopLossSpendMinor: number;
  readonly now?: Date;
}

export const createStoredPaidExperiment = async (
  options: CreatePaidExperimentOptions,
): Promise<PaidExperiment> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const [campaign, config] = await Promise.all([
    ensurePaidCampaign(cwd, options.campaignId),
    loadYogiConfig({ cwd }),
  ]);
  const paid = requirePaidConfig(config);
  if (!isPaidChannel(options.channel)) {
    throw new Error(`Unknown paid channel: ${String(options.channel)}`);
  }
  for (const [name, value] of [
    ["dailyBudgetMinor", options.dailyBudgetMinor],
    ["totalBudgetMinor", options.totalBudgetMinor],
    ["stopLossSpendMinor", options.stopLossSpendMinor],
  ] as const) {
    if (!isPositiveInteger(value)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  const name = options.name.trim();
  const objective = options.objective.trim();
  const hypothesis = options.hypothesis.trim();
  const conversionEvent = options.conversionEvent.trim();
  const utmSource = options.utmSource.trim();
  const utmMedium = options.utmMedium.trim();
  const utmCampaign = options.utmCampaign.trim();
  if (
    !name ||
    !objective ||
    !hypothesis ||
    !conversionEvent ||
    !utmSource ||
    !utmMedium ||
    !utmCampaign
  ) {
    throw new Error(
      "Paid experiment name, objective, hypothesis, conversion event, and UTM fields are required",
    );
  }
  let landingPage: URL;
  try {
    landingPage = new URL(options.landingPageUrl);
  } catch {
    throw new Error("Landing page must be a valid URL");
  }

  const experiment: PaidExperiment = {
    schemaVersion: 1,
    id: campaignSlug(name),
    campaignId: campaign.id,
    name,
    objective,
    hypothesis,
    channel: options.channel,
    audience: campaign.brief.audience,
    offer: campaign.brief.offer,
    landingPageUrl: landingPage.toString(),
    tracking: {
      conversionEvent,
      utmSource,
      utmMedium,
      utmCampaign,
    },
    currency: paid.currency,
    dailyBudgetMinor: options.dailyBudgetMinor,
    totalBudgetMinor: options.totalBudgetMinor,
    stopLossSpendMinor: options.stopLossSpendMinor,
    minimumCreativeVariants: paid.minimumCreativeVariants,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  const path = join(
    paidRoot(cwd, campaign.id),
    "experiments",
    `${experiment.id}.json`,
  );
  await mkdir(join(paidRoot(cwd, campaign.id), "experiments"), {
    recursive: true,
  });
  try {
    await access(path);
    throw new Error(`Paid experiment ${experiment.id} already exists`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await writeJsonAtomic(path, experiment);
  return experiment;
};

export const readPaidExperiment = async (
  cwd: string,
  campaignId: string,
  experimentId: string,
): Promise<PaidExperiment> => {
  const campaign = campaignSlug(campaignId);
  const path = join(
    paidRoot(resolve(cwd), campaign),
    "experiments",
    `${campaignSlug(experimentId)}.json`,
  );
  const experiment = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isExperiment(experiment)) {
    throw new Error(`Invalid paid experiment at ${path}`);
  }
  if (experiment.campaignId !== campaign) {
    throw new Error(`Paid experiment at ${path} belongs to another campaign`);
  }
  return experiment;
};

export const createStoredPaidCreativePrompt = async (
  cwd: string,
  campaignId: string,
  experimentId: string,
): Promise<string> => {
  const root = resolve(cwd);
  const [campaign, experiment, config] = await Promise.all([
    ensurePaidCampaign(root, campaignId),
    readPaidExperiment(root, campaignId, experimentId),
    loadYogiConfig({ cwd: root }),
  ]);
  const paid = requirePaidConfig(config);
  return createPaidCreativePrompt({
    campaign: campaign.brief,
    experiment,
    prohibitedPhrases: [
      ...config.product.voice.avoid,
      ...paid.prohibitedPhrases,
    ],
  });
};

export const reviewStoredPaidExperiment = async (options: {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly experimentId: string;
  readonly creativePath: string;
  readonly now?: Date;
}): Promise<PaidReadinessReport> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const [campaign, experiment, config, creativeInput] = await Promise.all([
    ensurePaidCampaign(cwd, options.campaignId),
    readPaidExperiment(cwd, options.campaignId, options.experimentId),
    loadYogiConfig({ cwd }),
    readFile(resolve(cwd, options.creativePath), "utf8"),
  ]);
  const paid = requirePaidConfig(config);
  const creative = JSON.parse(creativeInput) as unknown;
  if (!isCreativeSet(creative)) {
    throw new Error(`Invalid paid creative set at ${options.creativePath}`);
  }
  const canonicalCreative = `${JSON.stringify(creative, null, 2)}\n`;
  const creativeSha256 = createHash("sha256")
    .update(canonicalCreative)
    .digest("hex");
  await writeJsonAtomic(
    join(paidRoot(cwd, campaign.id), "creative", `${experiment.id}.json`),
    creative,
  );
  const report = reviewPaidExperiment({
    experiment,
    creative,
    creativeSha256,
    policy: policyFromConfig(paid, [
      ...config.product.voice.avoid,
      ...paid.prohibitedPhrases,
    ]),
    ...(options.now ? { now: options.now } : {}),
  });
  await writeJsonAtomic(
    join(paidRoot(cwd, campaign.id), "reviews", `${experiment.id}.json`),
    report,
  );
  return report;
};

export const planStoredPaidExperiment = async (options: {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly experimentId: string;
  readonly mode: PaidPlanMode;
  readonly approved?: boolean;
  readonly now?: Date;
}): Promise<PaidExperimentPlan> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.mode !== "draft" && options.mode !== "launch") {
    throw new Error(`Unknown paid plan mode: ${String(options.mode)}`);
  }
  const campaign = await ensurePaidCampaign(cwd, options.campaignId);
  const experiment = await readPaidExperiment(
    cwd,
    campaign.id,
    options.experimentId,
  );
  let readiness: PaidReadinessReport | undefined;
  if (options.mode === "launch") {
    const creativePath = join(
      paidRoot(cwd, campaign.id),
      "creative",
      `${experiment.id}.json`,
    );
    const [config, creativeInput] = await Promise.all([
      loadYogiConfig({ cwd }),
      readFile(creativePath, "utf8"),
    ]);
    const paid = requirePaidConfig(config);
    const creative = JSON.parse(creativeInput) as unknown;
    if (!isCreativeSet(creative)) {
      throw new Error(`Invalid paid creative set at ${creativePath}`);
    }
    readiness = reviewPaidExperiment({
      experiment,
      creative,
      creativeSha256: createHash("sha256").update(creativeInput).digest("hex"),
      policy: policyFromConfig(paid, [
        ...config.product.voice.avoid,
        ...paid.prohibitedPhrases,
      ]),
      ...(options.now ? { now: options.now } : {}),
    });
    await writeJsonAtomic(
      join(paidRoot(cwd, campaign.id), "reviews", `${experiment.id}.json`),
      readiness,
    );
  }
  const plan = createPaidExperimentPlan({
    experiment,
    mode: options.mode,
    ...(options.approved !== undefined ? { approved: options.approved } : {}),
    ...(readiness ? { readiness } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await writeJsonAtomic(
    join(
      paidRoot(cwd, campaign.id),
      "plans",
      `${experiment.id}-${options.mode}.json`,
    ),
    plan,
  );
  return plan;
};
