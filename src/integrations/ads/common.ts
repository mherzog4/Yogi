import { createHash } from "node:crypto";
import { sha256Json } from "../database.js";
import { ExternalOutcomeUnknownError } from "../errors.js";
import type {
  AdsDraftInput,
  NormalizedAdsMetrics,
  ProviderContext,
} from "../types.js";
import {
  asRecord,
  idFrom,
  numberFrom,
  stringFrom,
} from "../outbound/common.js";

export { asRecord, idFrom, numberFrom, stringFrom };

export const ensureAdsDraftInput = (input: AdsDraftInput): void => {
  const { experiment, creative, readiness } = input;
  if (!input.campaignId.trim() || !input.externalAccountId.trim()) {
    throw new Error("Campaign and external ad account IDs are required");
  }
  if (
    experiment.campaignId !== input.campaignId ||
    creative.experimentId !== experiment.id ||
    readiness.experimentId !== experiment.id
  ) {
    throw new Error(
      "Paid campaign, experiment, creative, and readiness report must match",
    );
  }
  const creativeSha256 = createHash("sha256")
    .update(`${JSON.stringify(creative, null, 2)}\n`)
    .digest("hex");
  if (
    !readiness.passed ||
    readiness.issues.length > 0 ||
    readiness.creativeSha256 !== creativeSha256
  ) {
    throw new Error("Paid experiment must pass launch readiness");
  }
  if (
    experiment.currency !== readiness.policy.currency ||
    experiment.dailyBudgetMinor > readiness.policy.maxDailyBudgetMinor ||
    experiment.totalBudgetMinor > readiness.policy.maxExperimentBudgetMinor ||
    experiment.stopLossSpendMinor >
      readiness.policy.maxSpendWithoutConversionMinor ||
    experiment.dailyBudgetMinor > experiment.totalBudgetMinor ||
    experiment.stopLossSpendMinor > experiment.totalBudgetMinor
  ) {
    throw new Error("Paid experiment exceeds its reviewed safety policy");
  }
  if (creative.variants.length < readiness.policy.minimumCreativeVariants) {
    throw new Error("Paid creative set no longer meets the reviewed minimum");
  }
};

export const adsDraftRequestSha256 = (input: AdsDraftInput): string =>
  sha256Json({
    campaignId: input.campaignId,
    externalAccountId: input.externalAccountId,
    experiment: input.experiment,
    creative: input.creative,
    readiness: {
      experimentId: input.readiness.experimentId,
      creativeSha256: input.readiness.creativeSha256,
      passed: input.readiness.passed,
      policy: input.readiness.policy,
      issues: input.readiness.issues,
    },
  });

export const currencyDigits = (currency: string): number => {
  try {
    const digits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    if (digits === undefined) {
      throw new Error(`Currency ${currency} has no minor-unit definition`);
    }
    return digits;
  } catch {
    throw new Error(`Unsupported ISO 4217 currency: ${currency}`);
  }
};

export const minorToMajor = (minor: number, currency: string): number => {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new Error("Money in minor units must be a non-negative safe integer");
  }
  return minor / 10 ** currencyDigits(currency);
};

export const minorToMajorString = (minor: number, currency: string): string =>
  minorToMajor(minor, currency).toFixed(currencyDigits(currency));

export const minorToMicros = (minor: number, currency: string): string => {
  const multiplier = 10 ** (6 - currencyDigits(currency));
  const micros = minor * multiplier;
  if (!Number.isSafeInteger(micros)) {
    throw new Error("Budget is too large to represent safely in micros");
  }
  return String(micros);
};

export const majorToMinor = (
  major: string | number | undefined,
  currency: string,
): number => {
  const numeric = Number(major ?? 0);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`Invalid ${currency} money value from provider`);
  }
  return Math.round(numeric * 10 ** currencyDigits(currency));
};

export const microsToMinor = (
  micros: string | number | undefined,
  currency: string,
): number => {
  const numeric = Number(micros ?? 0);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`Invalid ${currency} micros value from provider`);
  }
  return Math.round(numeric / 10 ** (6 - currencyDigits(currency)));
};

export const connectionAccountId = (
  context: ProviderContext,
  requested?: string,
): string => {
  const account = (
    requested ??
    context.connection.externalAccountId ??
    ""
  ).trim();
  if (!account) {
    throw new Error(
      `${context.connection.provider} requires an external ad account ID`,
    );
  }
  return account.replace(/^act_/, "");
};

export const connectionMetadataString = (
  context: ProviderContext,
  key: string,
): string | undefined => {
  const value = context.connection.metadata[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Connection metadata ${key} must be a non-empty string`);
  }
  return value.trim();
};

export const connectionMetadataStrings = (
  context: ProviderContext,
  key: string,
): readonly string[] => {
  const value = context.connection.metadata[key];
  if (!Array.isArray(value)) {
    throw new Error(`Connection metadata ${key} must be a string array`);
  }
  const strings = value.map((entry) =>
    typeof entry === "string" ? entry.trim() : "",
  );
  if (strings.length === 0 || strings.some((entry) => !entry)) {
    throw new Error(`Connection metadata ${key} must contain strings`);
  }
  return strings;
};

export const stableDraftName = (
  input: AdsDraftInput,
  idempotencyKey: string,
): string => {
  const suffix = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 8);
  return `${input.experiment.name} [Yogi ${suffix}]`;
};

export const partialAdsMutation = (
  provider: string,
  externalId: string,
  error: unknown,
): ExternalOutcomeUnknownError =>
  new ExternalOutcomeUnknownError(
    `${provider} partially created a paid campaign; reconcile before retrying`,
    { cause: error, externalId },
  );

export const requireProviderId = (value: unknown, message: string): string => {
  const id = idFrom(value);
  if (!id) throw new ExternalOutcomeUnknownError(message);
  return id;
};

export const normalizeMetric = (input: {
  readonly date: string;
  readonly impressions: unknown;
  readonly clicks: unknown;
  readonly spendMinor: number;
  readonly conversions: unknown;
  readonly currency: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): NormalizedAdsMetrics => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error(`Provider returned invalid metric date: ${input.date}`);
  }
  const impressions = numberFrom(input.impressions) ?? 0;
  const clicks = numberFrom(input.clicks) ?? 0;
  const conversions = numberFrom(input.conversions) ?? 0;
  for (const [name, value] of [
    ["impressions", impressions],
    ["clicks", clicks],
    ["spendMinor", input.spendMinor],
    ["conversions", conversions],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative finite number`);
    }
  }
  return {
    date: input.date,
    impressions,
    clicks,
    spendMinor: input.spendMinor,
    conversions,
    currency: input.currency,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
};

export const sinceDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Metrics since date must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Metrics since date is invalid");
  }
  return value;
};

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);
