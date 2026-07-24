import {
  providerBaseUrl,
  requestProviderJson,
  requestProviderResponse,
} from "../http.js";
import type {
  AdsDraftInput,
  AdsDraftResult,
  AdsProviderAdapter,
  ConnectionVerification,
  NormalizedAdsMetrics,
  ProviderAccount,
  ProviderContext,
} from "../types.js";
import {
  asRecord,
  connectionAccountId,
  connectionMetadataString,
  ensureAdsDraftInput,
  majorToMinor,
  minorToMajorString,
  normalizeMetric,
  requireProviderId,
  sinceDate,
  stableDraftName,
  stringFrom,
  todayUtc,
} from "./common.js";
import { ExternalOutcomeUnknownError } from "../errors.js";

const DISPLAY_NAME = "LinkedIn Ads";
const DEFAULT_BASE_URL = "https://api.linkedin.com";
const DEFAULT_API_VERSION = "202606";

const apiVersion = (context: ProviderContext): string => {
  const value =
    connectionMetadataString(context, "apiVersion") ?? DEFAULT_API_VERSION;
  if (!/^\d{6}$/.test(value)) {
    throw new Error("LinkedIn Ads apiVersion must use YYYYMM");
  }
  return value;
};

const headers = (
  context: ProviderContext,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${context.secret}`,
  "Linkedin-Version": apiVersion(context),
  "X-Restli-Protocol-Version": "2.0.0",
  ...extra,
});

const request = <T>(
  context: ProviderContext,
  options: {
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<T> =>
  requestProviderJson<T>(context, {
    provider: DISPLAY_NAME,
    baseUrl: providerBaseUrl(context, DEFAULT_BASE_URL),
    path: `/rest${options.path}`,
    ...(options.method ? { method: options.method } : {}),
    ...(options.query ? { query: options.query } : {}),
    headers: headers(context, options.headers),
    ...(options.body === undefined ? {} : { body: options.body }),
  });

const accountDetails = async (
  context: ProviderContext,
  accountId: string,
): Promise<ProviderAccount> => {
  const account = asRecord(
    await request<unknown>(context, {
      path: `/adAccounts/${accountId}`,
    }),
  );
  const id = stringFrom(account.id) ?? accountId;
  const currency = stringFrom(account.currency);
  const timezone = stringFrom(account.timezone);
  const status = stringFrom(account.status);
  const type = stringFrom(account.type);
  return {
    connectionId: context.connection.id,
    externalId: id,
    name: stringFrom(account.name) ?? `LinkedIn Ads ${id}`,
    ...(currency ? { currency } : {}),
    ...(timezone ? { timezone } : {}),
    metadata: {
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    },
    syncedAt: new Date().toISOString(),
  };
};

const linkedInDate = (value: string): string => {
  const [year, month, day] = value.split("-").map(Number);
  return `(year:${year},month:${month},day:${day})`;
};

export class LinkedInAdsAdapter implements AdsProviderAdapter {
  readonly descriptor = {
    id: "linkedin-ads",
    category: "ads",
    displayName: DISPLAY_NAME,
    capabilities: {
      createDraft: true,
      activate: true,
      pause: true,
      webhooks: false,
      polling: true,
      accountDiscovery: true,
    },
  } as const;

  async verifyConnection(
    context: ProviderContext,
  ): Promise<ConnectionVerification> {
    const account = await accountDetails(context, connectionAccountId(context));
    return {
      ok: true,
      externalAccountId: account.externalId,
      accountName: account.name,
      message: `Connected to ${account.name}`,
      metadata: {
        ...(account.currency ? { currency: account.currency } : {}),
        ...(account.timezone ? { timezone: account.timezone } : {}),
        apiVersion: apiVersion(context),
      },
    };
  }

  async listAccounts(
    context: ProviderContext,
  ): Promise<readonly ProviderAccount[]> {
    return [
      await accountDetails(context, connectionAccountId(context)),
    ] as const;
  }

  async createDraft(
    context: ProviderContext,
    input: AdsDraftInput,
    idempotencyKey: string,
  ): Promise<AdsDraftResult> {
    ensureAdsDraftInput(input);
    if (input.experiment.channel !== "social") {
      throw new Error("LinkedIn Ads adapter supports social experiments");
    }
    const accountId = connectionAccountId(context, input.externalAccountId);
    const response = await requestProviderResponse<unknown>(context, {
      provider: DISPLAY_NAME,
      baseUrl: providerBaseUrl(context, DEFAULT_BASE_URL),
      path: `/rest/adAccounts/${accountId}/adCampaignGroups`,
      method: "POST",
      headers: headers(context),
      body: {
        account: `urn:li:sponsoredAccount:${accountId}`,
        name: stableDraftName(input, idempotencyKey),
        status: "DRAFT",
        totalBudget: {
          amount: minorToMajorString(
            input.experiment.totalBudgetMinor,
            input.experiment.currency,
          ),
          currencyCode: input.experiment.currency,
        },
      },
    });
    const body = asRecord(response.data ?? {});
    const externalCampaignId =
      stringFrom(body.id) ??
      response.headers.get("x-restli-id") ??
      response.headers.get("x-linkedin-id");
    if (!externalCampaignId) {
      throw new ExternalOutcomeUnknownError(
        "LinkedIn Ads created a campaign group but returned no id",
      );
    }
    return {
      externalCampaignId,
      externalStatus: "DRAFT",
      metadata: {
        accountId,
        entityType: "campaign-group",
        creativeVariantCount: input.creative.variants.length,
        creativeUploadRequired: true,
      },
    };
  }

  async activate(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await this.#setStatus(context, externalCampaignId, "ACTIVE");
  }

  async pause(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await this.#setStatus(context, externalCampaignId, "PAUSED");
  }

  async #setStatus(
    context: ProviderContext,
    externalCampaignId: string,
    status: "ACTIVE" | "PAUSED",
  ): Promise<void> {
    const accountId = connectionAccountId(context);
    await request(context, {
      path: `/adAccounts/${accountId}/adCampaignGroups/${externalCampaignId}`,
      method: "POST",
      headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
      body: { patch: { $set: { status } } },
    });
  }

  async syncMetrics(
    context: ProviderContext,
    externalCampaignId: string,
    since: string,
  ): Promise<readonly NormalizedAdsMetrics[]> {
    const start = sinceDate(since);
    const end = todayUtc();
    const account = await accountDetails(context, connectionAccountId(context));
    if (!account.currency) {
      throw new Error("LinkedIn Ads account is missing currency");
    }
    const response = asRecord(
      await request<unknown>(context, {
        path: "/adAnalytics",
        query: {
          q: "analytics",
          pivot: "CAMPAIGN_GROUP",
          timeGranularity: "DAILY",
          dateRange: `(start:${linkedInDate(start)},end:${linkedInDate(end)})`,
          campaignGroups: `List(urn:li:sponsoredCampaignGroup:${externalCampaignId})`,
          fields:
            "dateRange,impressions,clicks,costInLocalCurrency,externalWebsiteConversions,pivotValues",
        },
      }),
    );
    const elements = Array.isArray(response.elements) ? response.elements : [];
    return elements.map((element) => {
      const row = asRecord(element, "LinkedIn metric row must be an object");
      const range = asRecord(row.dateRange ?? {});
      const startDate = asRecord(range.start ?? {});
      const date = [
        requireProviderId(
          startDate.year,
          "LinkedIn metric row is missing year",
        ),
        String(startDate.month).padStart(2, "0"),
        String(startDate.day).padStart(2, "0"),
      ].join("-");
      return normalizeMetric({
        date,
        impressions: row.impressions,
        clicks: row.clicks,
        spendMinor: majorToMinor(
          stringFrom(row.costInLocalCurrency),
          account.currency!,
        ),
        conversions: row.externalWebsiteConversions,
        currency: account.currency!,
        metadata: {
          pivotValues: Array.isArray(row.pivotValues) ? row.pivotValues : [],
        },
      });
    });
  }
}
