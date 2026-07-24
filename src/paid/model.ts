import type { CampaignBrief } from "../campaign.js";

export type PaidChannel = "search" | "social" | "display";

export interface PaidTrackingPlan {
  readonly conversionEvent: string;
  readonly utmSource: string;
  readonly utmMedium: string;
  readonly utmCampaign: string;
}

export interface PaidExperiment {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly campaignId: string;
  readonly name: string;
  readonly objective: string;
  readonly hypothesis: string;
  readonly channel: PaidChannel;
  readonly audience: string;
  readonly offer: string;
  readonly landingPageUrl: string;
  readonly tracking: PaidTrackingPlan;
  readonly currency: string;
  readonly dailyBudgetMinor: number;
  readonly totalBudgetMinor: number;
  readonly stopLossSpendMinor: number;
  readonly minimumCreativeVariants: number;
  readonly createdAt: string;
}

export interface AdCreativeVariant {
  readonly id: string;
  readonly headline: string;
  readonly body: string;
  readonly callToAction: string;
}

export interface AdCreativeSet {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly variants: readonly AdCreativeVariant[];
}

export interface PaidSafetyPolicy {
  readonly currency: string;
  readonly maxDailyBudgetMinor: number;
  readonly maxExperimentBudgetMinor: number;
  readonly maxSpendWithoutConversionMinor: number;
  readonly minimumCreativeVariants: number;
  readonly allowedLandingPageHosts: readonly string[];
  readonly prohibitedPhrases: readonly string[];
}

export type PaidReadinessIssueCode =
  | "currency-mismatch"
  | "daily-budget-limit"
  | "experiment-budget-limit"
  | "daily-exceeds-total"
  | "stop-loss-limit"
  | "landing-page-protocol"
  | "landing-page-host"
  | "tracking-plan"
  | "creative-count"
  | "duplicate-creative"
  | "duplicate-creative-id"
  | "empty-creative"
  | "prohibited-phrase";

export interface PaidReadinessIssue {
  readonly code: PaidReadinessIssueCode;
  readonly message: string;
}

export interface PaidReadinessReport {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly creativeSha256: string;
  readonly reviewedAt: string;
  readonly passed: boolean;
  readonly policy: PaidSafetyPolicy;
  readonly issues: readonly PaidReadinessIssue[];
}

export type PaidPlanMode = "draft" | "launch";

export interface PaidExperimentPlan {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly mode: PaidPlanMode;
  readonly approved: boolean;
  readonly externalActionPerformed: false;
  readonly currency: string;
  readonly dailyBudgetMinor: number;
  readonly totalBudgetMinor: number;
  readonly stopLossSpendMinor: number;
  readonly plannedAt: string;
}

export const isPaidChannel = (value: unknown): value is PaidChannel =>
  value === "search" || value === "social" || value === "display";

export const createPaidCreativePrompt = (options: {
  readonly campaign: CampaignBrief;
  readonly experiment: PaidExperiment;
  readonly prohibitedPhrases: readonly string[];
}): string => {
  const { campaign, experiment } = options;

  return `# Paid ad creative set

Create creative variants for the **${experiment.name}** experiment.

## Experiment

- Channel type: ${experiment.channel}
- Objective: ${experiment.objective}
- Hypothesis: ${experiment.hypothesis}
- Audience: ${experiment.audience}
- Offer: ${experiment.offer}
- Landing page: ${experiment.landingPageUrl}
- Conversion event: ${experiment.tracking.conversionEvent}
- UTM source: ${experiment.tracking.utmSource}
- UTM medium: ${experiment.tracking.utmMedium}
- UTM campaign: ${experiment.tracking.utmCampaign}
- Minimum distinct variants: ${experiment.minimumCreativeVariants}

## Product context

- Product: ${campaign.product}
- Goal: ${campaign.goal}
- Voice: ${campaign.voice ?? "clear, specific, credible, and human"}
- Available proof: ${campaign.proof?.join("; ") || "none"}
- Constraints: ${campaign.constraints?.join("; ") || "none"}
- Prohibited phrases: ${options.prohibitedPhrases.join("; ") || "none"}

## Required output

Write valid JSON to \`campaigns/${experiment.campaignId}/paid/creative/${experiment.id}.json\`:

\`\`\`json
{
  "schemaVersion": 1,
  "experimentId": "${experiment.id}",
  "variants": [
    {
      "id": "variant-a",
      "headline": "A specific, supportable headline",
      "body": "Copy grounded in the supplied product context",
      "callToAction": "A clear next step"
    }
  ]
}
\`\`\`

## Rules

1. Produce at least ${experiment.minimumCreativeVariants} meaningfully distinct variants.
2. Do not invent performance, customer, scarcity, or product claims.
3. Use only proof included in the campaign context.
4. Keep every headline, body, and call to action non-empty.
5. Do not create campaigns, upload creative, activate ads, or spend money.
`;
};

const normalized = (value: string): string =>
  value.trim().toLocaleLowerCase("en-US");

export const reviewPaidExperiment = (options: {
  readonly experiment: PaidExperiment;
  readonly creative: AdCreativeSet;
  readonly creativeSha256: string;
  readonly policy: PaidSafetyPolicy;
  readonly now?: Date;
}): PaidReadinessReport => {
  const { experiment, creative, policy } = options;
  const issues: PaidReadinessIssue[] = [];

  if (experiment.currency !== policy.currency) {
    issues.push({
      code: "currency-mismatch",
      message: `Experiment currency ${experiment.currency} does not match policy currency ${policy.currency}.`,
    });
  }
  if (experiment.dailyBudgetMinor > policy.maxDailyBudgetMinor) {
    issues.push({
      code: "daily-budget-limit",
      message: `Daily budget ${experiment.dailyBudgetMinor} exceeds the ${policy.maxDailyBudgetMinor} policy limit.`,
    });
  }
  if (experiment.totalBudgetMinor > policy.maxExperimentBudgetMinor) {
    issues.push({
      code: "experiment-budget-limit",
      message: `Experiment budget ${experiment.totalBudgetMinor} exceeds the ${policy.maxExperimentBudgetMinor} policy limit.`,
    });
  }
  if (experiment.dailyBudgetMinor > experiment.totalBudgetMinor) {
    issues.push({
      code: "daily-exceeds-total",
      message: "Daily budget cannot exceed the total experiment budget.",
    });
  }
  if (
    experiment.stopLossSpendMinor > policy.maxSpendWithoutConversionMinor ||
    experiment.stopLossSpendMinor > experiment.totalBudgetMinor
  ) {
    issues.push({
      code: "stop-loss-limit",
      message:
        "Stop-loss spend must not exceed the workspace ceiling or total experiment budget.",
    });
  }

  let landingPage: URL | undefined;
  try {
    landingPage = new URL(experiment.landingPageUrl);
  } catch {
    issues.push({
      code: "landing-page-protocol",
      message: "Landing page must be a valid HTTPS URL.",
    });
  }
  if (landingPage && landingPage.protocol !== "https:") {
    issues.push({
      code: "landing-page-protocol",
      message: "Landing page must use HTTPS.",
    });
  }
  if (
    landingPage &&
    !policy.allowedLandingPageHosts.includes(
      landingPage.hostname.toLocaleLowerCase("en-US"),
    )
  ) {
    issues.push({
      code: "landing-page-host",
      message: `Landing page host ${landingPage.hostname} is not allowed by workspace policy.`,
    });
  }
  if (
    !experiment.tracking.conversionEvent.trim() ||
    !experiment.tracking.utmSource.trim() ||
    !experiment.tracking.utmMedium.trim() ||
    !experiment.tracking.utmCampaign.trim()
  ) {
    issues.push({
      code: "tracking-plan",
      message:
        "Conversion event and UTM source, medium, and campaign are required before launch.",
    });
  }
  if (creative.experimentId !== experiment.id) {
    throw new Error(
      `Creative set ${creative.experimentId} belongs to another experiment`,
    );
  }
  if (creative.variants.length < policy.minimumCreativeVariants) {
    issues.push({
      code: "creative-count",
      message: `Creative set has ${creative.variants.length} variants; policy requires ${policy.minimumCreativeVariants}.`,
    });
  }

  const identities = new Set<string>();
  const ids = new Set<string>();
  for (const variant of creative.variants) {
    if (
      !variant.id.trim() ||
      !variant.headline.trim() ||
      !variant.body.trim() ||
      !variant.callToAction.trim()
    ) {
      issues.push({
        code: "empty-creative",
        message: `Creative variant ${variant.id || "(missing id)"} has an empty required field.`,
      });
    }
    const normalizedId = normalized(variant.id);
    if (ids.has(normalizedId)) {
      issues.push({
        code: "duplicate-creative-id",
        message: `Creative variant ID ${variant.id} is duplicated.`,
      });
    }
    ids.add(normalizedId);
    const identity = `${normalized(variant.headline)}\0${normalized(variant.body)}`;
    if (identities.has(identity)) {
      issues.push({
        code: "duplicate-creative",
        message: `Creative variant ${variant.id} duplicates another headline and body.`,
      });
    }
    identities.add(identity);

    const combined = normalized(
      `${variant.headline} ${variant.body} ${variant.callToAction}`,
    );
    for (const phrase of policy.prohibitedPhrases) {
      if (phrase.trim() && combined.includes(normalized(phrase))) {
        issues.push({
          code: "prohibited-phrase",
          message: `Creative variant ${variant.id} contains prohibited phrase: ${phrase}`,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    experimentId: experiment.id,
    creativeSha256: options.creativeSha256,
    reviewedAt: (options.now ?? new Date()).toISOString(),
    passed: issues.length === 0,
    policy,
    issues,
  };
};

export const createPaidExperimentPlan = (options: {
  readonly experiment: PaidExperiment;
  readonly mode: PaidPlanMode;
  readonly approved?: boolean;
  readonly readiness?: PaidReadinessReport;
  readonly now?: Date;
}): PaidExperimentPlan => {
  if (options.mode !== "draft" && options.mode !== "launch") {
    throw new Error(`Unknown paid plan mode: ${String(options.mode)}`);
  }
  if (options.mode === "launch") {
    if (options.approved !== true) {
      throw new Error("Launch-ready paid plans require approved: true");
    }
    if (!options.readiness?.passed) {
      throw new Error("Launch-ready paid plans require a passing review");
    }
    if (options.readiness.experimentId !== options.experiment.id) {
      throw new Error(
        "Launch-ready paid plans require a review for the same experiment",
      );
    }
  }

  return {
    schemaVersion: 1,
    experimentId: options.experiment.id,
    mode: options.mode,
    approved: options.approved === true,
    externalActionPerformed: false,
    currency: options.experiment.currency,
    dailyBudgetMinor: options.experiment.dailyBudgetMinor,
    totalBudgetMinor: options.experiment.totalBudgetMinor,
    stopLossSpendMinor: options.experiment.stopLossSpendMinor,
    plannedAt: (options.now ?? new Date()).toISOString(),
  };
};
