import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";

export const YOGI_CONFIG_FILENAME = "yogi.config.ts";

export interface ProofPoint {
  readonly claim: string;
  readonly source?: string;
}

export interface VoiceGuide {
  readonly traits: readonly string[];
  readonly avoid: readonly string[];
}

export interface OutboundDefaults {
  readonly dailyProspectLimit: number;
  readonly maxPerDomain: number;
  readonly requirePersonalization: boolean;
  readonly allowRoleBasedAddresses: boolean;
}

export interface ContentDefaults {
  readonly editorialMinimumScore: number;
  readonly prohibitedPhrases: readonly string[];
}

export interface PaidAdsDefaults {
  readonly currency: string;
  readonly maxDailyBudgetMinor: number;
  readonly maxExperimentBudgetMinor: number;
  readonly maxSpendWithoutConversionMinor: number;
  readonly minimumCreativeVariants: number;
  readonly allowedLandingPageHosts: readonly string[];
  readonly prohibitedPhrases: readonly string[];
}

export interface YogiConfig {
  readonly schemaVersion: 1;
  readonly workspace: {
    readonly name: string;
  };
  readonly product: {
    readonly name: string;
    readonly description: string;
    readonly positioning: string;
    readonly audiences: readonly string[];
    readonly offers: readonly string[];
    readonly proof: readonly ProofPoint[];
    readonly voice: VoiceGuide;
  };
  readonly outbound?: OutboundDefaults;
  readonly content?: ContentDefaults;
  readonly paidAds?: PaidAdsDefaults;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid Yogi configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateString = (
  value: unknown,
  path: string,
  issues: string[],
): value is string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return false;
  }
  if (value.trim().startsWith("TODO:")) {
    issues.push(`${path} must replace the generated TODO placeholder`);
    return false;
  }
  return true;
};

const validateStringArray = (
  value: unknown,
  path: string,
  issues: string[],
  requireValue = false,
): value is string[] => {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of strings`);
    return false;
  }
  if (requireValue && value.length === 0) {
    issues.push(`${path} must include at least one value`);
    return false;
  }

  let valid = true;
  for (const [index, item] of value.entries()) {
    if (!validateString(item, `${path}[${index}]`, issues)) valid = false;
  }
  return valid;
};

export const validateYogiConfig = (input: unknown): YogiConfig => {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new ConfigValidationError(["config must export an object"]);
  }

  if (input.schemaVersion !== 1) {
    issues.push("schemaVersion must be 1");
  }

  const workspace = input.workspace;
  if (!isRecord(workspace)) {
    issues.push("workspace must be an object");
  } else {
    validateString(workspace.name, "workspace.name", issues);
  }

  const product = input.product;
  if (!isRecord(product)) {
    issues.push("product must be an object");
  } else {
    validateString(product.name, "product.name", issues);
    validateString(product.description, "product.description", issues);
    validateString(product.positioning, "product.positioning", issues);
    validateStringArray(product.audiences, "product.audiences", issues, true);
    validateStringArray(product.offers, "product.offers", issues, true);

    if (!Array.isArray(product.proof)) {
      issues.push("product.proof must be an array");
    } else {
      for (const [index, proof] of product.proof.entries()) {
        if (!isRecord(proof)) {
          issues.push(`product.proof[${index}] must be an object`);
          continue;
        }
        validateString(proof.claim, `product.proof[${index}].claim`, issues);
        if (
          proof.source !== undefined &&
          !validateString(
            proof.source,
            `product.proof[${index}].source`,
            issues,
          )
        ) {
          continue;
        }
      }
    }

    if (!isRecord(product.voice)) {
      issues.push("product.voice must be an object");
    } else {
      validateStringArray(
        product.voice.traits,
        "product.voice.traits",
        issues,
        true,
      );
      validateStringArray(product.voice.avoid, "product.voice.avoid", issues);
    }
  }

  const outbound = input.outbound;
  if (outbound !== undefined) {
    if (!isRecord(outbound)) {
      issues.push("outbound must be an object");
    } else {
      for (const key of ["dailyProspectLimit", "maxPerDomain"] as const) {
        const value = outbound[key];
        if (!Number.isSafeInteger(value) || Number(value) <= 0) {
          issues.push(`outbound.${key} must be a positive integer`);
        }
      }
      for (const key of [
        "requirePersonalization",
        "allowRoleBasedAddresses",
      ] as const) {
        if (typeof outbound[key] !== "boolean") {
          issues.push(`outbound.${key} must be a boolean`);
        }
      }
    }
  }

  const content = input.content;
  if (content !== undefined) {
    if (!isRecord(content)) {
      issues.push("content must be an object");
    } else {
      const minimumScore = content.editorialMinimumScore;
      if (
        !Number.isSafeInteger(minimumScore) ||
        Number(minimumScore) < 0 ||
        Number(minimumScore) > 100
      ) {
        issues.push(
          "content.editorialMinimumScore must be an integer from 0 to 100",
        );
      }
      validateStringArray(
        content.prohibitedPhrases,
        "content.prohibitedPhrases",
        issues,
      );
    }
  }

  const paidAds = input.paidAds;
  if (paidAds !== undefined) {
    if (!isRecord(paidAds)) {
      issues.push("paidAds must be an object");
    } else {
      if (
        typeof paidAds.currency !== "string" ||
        !/^[A-Z]{3}$/.test(paidAds.currency)
      ) {
        issues.push("paidAds.currency must be a three-letter uppercase code");
      }
      for (const key of [
        "maxDailyBudgetMinor",
        "maxExperimentBudgetMinor",
        "maxSpendWithoutConversionMinor",
      ] as const) {
        const value = paidAds[key];
        if (!Number.isSafeInteger(value) || Number(value) <= 0) {
          issues.push(`paidAds.${key} must be a positive integer`);
        }
      }
      if (
        !Number.isSafeInteger(paidAds.minimumCreativeVariants) ||
        Number(paidAds.minimumCreativeVariants) < 2
      ) {
        issues.push(
          "paidAds.minimumCreativeVariants must be an integer of at least 2",
        );
      }
      validateStringArray(
        paidAds.allowedLandingPageHosts,
        "paidAds.allowedLandingPageHosts",
        issues,
        true,
      );
      if (Array.isArray(paidAds.allowedLandingPageHosts)) {
        for (const [index, host] of paidAds.allowedLandingPageHosts.entries()) {
          if (
            typeof host === "string" &&
            (host.includes("://") ||
              host.includes("/") ||
              host !== host.toLocaleLowerCase("en-US"))
          ) {
            issues.push(
              `paidAds.allowedLandingPageHosts[${index}] must be a lowercase hostname without a scheme or path`,
            );
          }
        }
      }
      validateStringArray(
        paidAds.prohibitedPhrases,
        "paidAds.prohibitedPhrases",
        issues,
      );
      if (
        Number.isSafeInteger(paidAds.maxDailyBudgetMinor) &&
        Number.isSafeInteger(paidAds.maxExperimentBudgetMinor) &&
        Number(paidAds.maxDailyBudgetMinor) >
          Number(paidAds.maxExperimentBudgetMinor)
      ) {
        issues.push(
          "paidAds.maxDailyBudgetMinor must not exceed maxExperimentBudgetMinor",
        );
      }
      if (
        Number.isSafeInteger(paidAds.maxSpendWithoutConversionMinor) &&
        Number.isSafeInteger(paidAds.maxExperimentBudgetMinor) &&
        Number(paidAds.maxSpendWithoutConversionMinor) >
          Number(paidAds.maxExperimentBudgetMinor)
      ) {
        issues.push(
          "paidAds.maxSpendWithoutConversionMinor must not exceed maxExperimentBudgetMinor",
        );
      }
    }
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);
  return input as unknown as YogiConfig;
};

export const defineConfig = <T extends YogiConfig>(config: T): T => config;

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly configPath?: string;
}

export const loadYogiConfig = async (
  options: LoadConfigOptions = {},
): Promise<YogiConfig> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? YOGI_CONFIG_FILENAME);
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
  });

  try {
    await access(configPath);
  } catch {
    throw new Error(
      `No ${YOGI_CONFIG_FILENAME} found at ${configPath}. Run \`yogi init\` first.`,
    );
  }

  const loaded = await jiti.import<unknown>(configPath, { default: true });
  return validateYogiConfig(loaded);
};

const configSource = (
  workspaceName: string,
): string => `import type { YogiConfig } from "@mherzog4/yogi";

export default {
  schemaVersion: 1,
  workspace: {
    name: ${JSON.stringify(workspaceName)},
  },
  product: {
    name: "TODO: Product name",
    description: "TODO: Describe the product and the job it helps customers complete.",
    positioning: "TODO: Explain why the right customer should choose this product now.",
    audiences: ["TODO: Describe the first narrow ideal customer profile."],
    offers: ["TODO: Describe the first concrete offer or call to action."],
    proof: [],
    voice: {
      traits: ["clear", "specific", "credible", "human"],
      avoid: ["hype", "unsupported claims", "generic AI phrasing"],
    },
  },
  outbound: {
    dailyProspectLimit: 20,
    maxPerDomain: 2,
    requirePersonalization: true,
    allowRoleBasedAddresses: false,
  },
  content: {
    editorialMinimumScore: 80,
    prohibitedPhrases: ["guaranteed", "best-in-class", "game-changing"],
  },
  paidAds: {
    currency: "TODO: Three-letter billing currency",
    maxDailyBudgetMinor: 0, // Replace with an approved ceiling in minor units.
    maxExperimentBudgetMinor: 0,
    maxSpendWithoutConversionMinor: 0,
    minimumCreativeVariants: 3,
    allowedLandingPageHosts: ["TODO: approved.example"],
    prohibitedPhrases: ["guaranteed results"],
  },
} satisfies YogiConfig;
`;

export interface InitWorkspaceOptions {
  readonly cwd?: string;
  readonly name?: string;
  readonly force?: boolean;
}

export interface InitWorkspaceResult {
  readonly root: string;
  readonly configPath: string;
  readonly campaignsPath: string;
}

export const initWorkspace = async (
  options: InitWorkspaceOptions = {},
): Promise<InitWorkspaceResult> => {
  const root = resolve(options.cwd ?? process.cwd());
  const workspaceName = options.name?.trim() || basename(root) || "Yogi";
  const configPath = join(root, YOGI_CONFIG_FILENAME);
  const campaignsPath = join(root, "campaigns");

  await mkdir(campaignsPath, { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configSource(workspaceName), {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
  }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "EEXIST" && options.force !== true) {
      throw new Error(
        `${YOGI_CONFIG_FILENAME} already exists. Use --force to replace it.`,
      );
    }
    throw error;
  });
  await writeFile(join(campaignsPath, ".gitkeep"), "", {
    encoding: "utf8",
    flag: "a",
  });

  return { root, configPath, campaignsPath };
};
