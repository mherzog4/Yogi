import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { campaignSlug } from "../campaign.js";
import { loadYogiConfig } from "../config.js";
import { readCampaign, writeJsonAtomic } from "../workspace.js";
import {
  createContentPrompt,
  createRepurposePlan,
  reviewEditorialDraft,
  type ContentBrief,
  type ContentFormat,
  type ContentSource,
  type ContentSourceType,
  type EditorialReport,
  type RepurposePlan,
} from "./model.js";

interface SourceIndex {
  readonly schemaVersion: 1;
  readonly sources: readonly ContentSource[];
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

const contentRoot = (cwd: string, campaignId: string): string =>
  join(cwd, "campaigns", campaignId, "content");

const ensureContentCampaign = async (cwd: string, campaignId: string) => {
  const campaign = await readCampaign(cwd, campaignId);
  if (campaign.channel !== "content") {
    throw new Error(
      `Campaign ${campaign.id} uses ${campaign.channel}, not content`,
    );
  }
  return campaign;
};

const isSource = (value: unknown): value is ContentSource =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "title" in value &&
  typeof value.title === "string" &&
  "type" in value &&
  (value.type === "original" ||
    value.type === "customer-research" ||
    value.type === "external") &&
  "repositoryPath" in value &&
  typeof value.repositoryPath === "string" &&
  "sha256" in value &&
  typeof value.sha256 === "string" &&
  /^[a-f0-9]{64}$/.test(value.sha256) &&
  "addedAt" in value &&
  typeof value.addedAt === "string" &&
  (!("url" in value) ||
    value.url === undefined ||
    typeof value.url === "string");

const isSourceType = (value: unknown): value is ContentSourceType =>
  value === "original" || value === "customer-research" || value === "external";

const readSources = async (
  cwd: string,
  campaignId: string,
): Promise<ContentSource[]> => {
  const path = join(contentRoot(cwd, campaignId), "sources", "index.json");
  try {
    const index = JSON.parse(await readFile(path, "utf8")) as SourceIndex;
    if (
      index.schemaVersion !== 1 ||
      !Array.isArray(index.sources) ||
      !index.sources.every(
        (source) =>
          isSource(source) &&
          source.repositoryPath ===
            posix.join(
              "campaigns",
              campaignId,
              "content",
              "sources",
              `${source.id}.md`,
            ),
      )
    ) {
      throw new Error(`Invalid content source index at ${path}`);
    }
    return [...index.sources];
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
};

const verifySourceIntegrity = async (
  cwd: string,
  sources: readonly ContentSource[],
  sourceIds: readonly string[],
): Promise<void> => {
  for (const sourceId of sourceIds) {
    const source = sources.find(({ id }) => id === sourceId);
    if (!source) throw new Error(`Unknown content source: ${sourceId}`);
    const contents = await readFile(join(cwd, source.repositoryPath), "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (sha256 !== source.sha256) {
      throw new Error(
        `Content source ${source.id} changed after approval; add it as a new source or restore the indexed version`,
      );
    }
  }
};

export const listContentSources = async (
  cwd: string,
  campaignId: string,
): Promise<readonly ContentSource[]> => {
  const root = resolve(cwd);
  const campaign = await ensureContentCampaign(root, campaignId);
  return readSources(root, campaign.id);
};

const validateSourceUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Content source URL must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Content source URL must use http or https");
  }
  return parsed.toString();
};

export interface AddContentSourceOptions {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly filePath: string;
  readonly title: string;
  readonly type: ContentSourceType;
  readonly url?: string;
  readonly acknowledgeDeidentified?: boolean;
  readonly now?: Date;
}

export const addContentSource = async (
  options: AddContentSourceOptions,
): Promise<ContentSource> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const campaign = await ensureContentCampaign(cwd, options.campaignId);
  const title = options.title.trim();
  if (!title) throw new Error("Content source title cannot be empty");
  if (!isSourceType(options.type)) {
    throw new Error(`Unknown content source type: ${String(options.type)}`);
  }
  if (options.type === "external" && !options.url?.trim()) {
    throw new Error("External content sources require --url");
  }
  if (
    options.type === "customer-research" &&
    options.acknowledgeDeidentified !== true
  ) {
    throw new Error(
      "Customer research must be de-identified; pass acknowledgeDeidentified: true or --deidentified",
    );
  }

  const inputPath = resolve(cwd, options.filePath);
  const contents = await readFile(inputPath, "utf8");
  if (contents.includes("\0")) {
    throw new Error("Content sources must be UTF-8 text files");
  }
  const url = options.url?.trim()
    ? validateSourceUrl(options.url.trim())
    : undefined;
  const id = campaignSlug(title);
  const repositoryPath = posix.join(
    "campaigns",
    campaign.id,
    "content",
    "sources",
    `${id}.md`,
  );
  const destination = join(cwd, repositoryPath);
  const sources = await readSources(cwd, campaign.id);
  if (sources.some((source) => source.id === id)) {
    throw new Error(`Content source ${id} already exists`);
  }

  await mkdir(join(cwd, posix.dirname(repositoryPath)), {
    recursive: true,
  });
  await writeFile(destination, contents, { flag: "wx" });
  const source: ContentSource = {
    id,
    title,
    type: options.type,
    repositoryPath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    addedAt: (options.now ?? new Date()).toISOString(),
    ...(url ? { url } : {}),
  };
  sources.push(source);
  await writeJsonAtomic(
    join(contentRoot(cwd, campaign.id), "sources", "index.json"),
    { schemaVersion: 1, sources } satisfies SourceIndex,
  );
  return source;
};

const isFormat = (value: unknown): value is ContentFormat =>
  value === "article" ||
  value === "newsletter" ||
  value === "linkedin-post" ||
  value === "x-thread" ||
  value === "video-script";

const isBrief = (value: unknown): value is ContentBrief =>
  typeof value === "object" &&
  value !== null &&
  "schemaVersion" in value &&
  value.schemaVersion === 1 &&
  "id" in value &&
  typeof value.id === "string" &&
  "campaignId" in value &&
  typeof value.campaignId === "string" &&
  "title" in value &&
  typeof value.title === "string" &&
  "thesis" in value &&
  typeof value.thesis === "string" &&
  "format" in value &&
  isFormat(value.format) &&
  "callToAction" in value &&
  typeof value.callToAction === "string" &&
  "audience" in value &&
  typeof value.audience === "string" &&
  "sourceIds" in value &&
  Array.isArray(value.sourceIds) &&
  value.sourceIds.every((id) => typeof id === "string") &&
  "createdAt" in value &&
  typeof value.createdAt === "string";

export interface CreateContentBriefOptions {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly title: string;
  readonly thesis: string;
  readonly format: ContentFormat;
  readonly callToAction: string;
  readonly sourceIds: readonly string[];
  readonly now?: Date;
}

export const createStoredContentBrief = async (
  options: CreateContentBriefOptions,
): Promise<ContentBrief> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const campaign = await ensureContentCampaign(cwd, options.campaignId);
  if (!isFormat(options.format)) {
    throw new Error(`Unknown content format: ${String(options.format)}`);
  }
  const sources = await readSources(cwd, campaign.id);
  const sourceIds = [...new Set(options.sourceIds)];
  if (sourceIds.length === 0) {
    throw new Error("Content briefs require at least one source");
  }
  for (const id of sourceIds) {
    if (!sources.some((source) => source.id === id)) {
      throw new Error(`Unknown content source: ${id}`);
    }
  }

  const title = options.title.trim();
  const thesis = options.thesis.trim();
  const callToAction = options.callToAction.trim();
  if (!title) throw new Error("Content brief title cannot be empty");
  if (!thesis) throw new Error("Content brief thesis cannot be empty");
  if (!callToAction) throw new Error("Content call to action cannot be empty");

  const brief: ContentBrief = {
    schemaVersion: 1,
    id: campaignSlug(title),
    campaignId: campaign.id,
    title,
    thesis,
    format: options.format,
    callToAction,
    audience: campaign.brief.audience,
    sourceIds,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  const path = join(
    contentRoot(cwd, campaign.id),
    "briefs",
    `${brief.id}.json`,
  );
  await mkdir(join(contentRoot(cwd, campaign.id), "briefs"), {
    recursive: true,
  });
  try {
    await access(path);
    throw new Error(`Content brief ${brief.id} already exists`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await writeJsonAtomic(path, brief);
  return brief;
};

export const readContentBrief = async (
  cwd: string,
  campaignId: string,
  briefId: string,
): Promise<ContentBrief> => {
  const path = join(
    contentRoot(resolve(cwd), campaignSlug(campaignId)),
    "briefs",
    `${campaignSlug(briefId)}.json`,
  );
  const brief = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isBrief(brief)) throw new Error(`Invalid content brief at ${path}`);
  if (brief.campaignId !== campaignSlug(campaignId)) {
    throw new Error(`Content brief at ${path} belongs to another campaign`);
  }
  return brief;
};

export const createStoredContentPrompt = async (
  cwd: string,
  campaignId: string,
  briefId: string,
): Promise<string> => {
  const root = resolve(cwd);
  const campaign = await ensureContentCampaign(root, campaignId);
  const [brief, sources] = await Promise.all([
    readContentBrief(root, campaign.id, briefId),
    readSources(root, campaign.id),
  ]);
  await verifySourceIntegrity(root, sources, brief.sourceIds);
  return createContentPrompt({ campaign: campaign.brief, brief, sources });
};

export const createStoredRepurposePlan = async (options: {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly briefId: string;
  readonly formats: readonly ContentFormat[];
  readonly now?: Date;
}): Promise<RepurposePlan> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const campaign = await ensureContentCampaign(cwd, options.campaignId);
  const brief = await readContentBrief(cwd, campaign.id, options.briefId);
  const plan = createRepurposePlan({
    brief,
    formats: options.formats,
    ...(options.now ? { now: options.now } : {}),
  });
  await writeJsonAtomic(
    join(contentRoot(cwd, campaign.id), "repurpose", `${brief.id}.json`),
    plan,
  );
  return plan;
};

export const reviewStoredContentDraft = async (options: {
  readonly cwd?: string;
  readonly campaignId: string;
  readonly briefId: string;
  readonly draftPath: string;
  readonly now?: Date;
}): Promise<EditorialReport> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const campaign = await ensureContentCampaign(cwd, options.campaignId);
  const [brief, sources, config, markdown] = await Promise.all([
    readContentBrief(cwd, campaign.id, options.briefId),
    readSources(cwd, campaign.id),
    loadYogiConfig({ cwd }),
    readFile(resolve(cwd, options.draftPath), "utf8"),
  ]);
  await verifySourceIntegrity(cwd, sources, brief.sourceIds);
  const report = reviewEditorialDraft({
    markdown,
    brief,
    sources,
    prohibitedPhrases: [
      ...config.product.voice.avoid,
      ...(config.content?.prohibitedPhrases ?? []),
    ],
    ...(config.content
      ? { minimumScore: config.content.editorialMinimumScore }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await writeJsonAtomic(
    join(contentRoot(cwd, campaign.id), "reviews", `${brief.id}.json`),
    report,
  );
  return report;
};

export { isFormat as isContentFormat };
