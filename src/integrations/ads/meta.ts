import { providerBaseUrl, requestProviderJson } from "../http.js";
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
  connectionMetadataStrings,
  ensureAdsDraftInput,
  idFrom,
  majorToMinor,
  normalizeMetric,
  partialAdsMutation,
  requireProviderId,
  sinceDate,
  stableDraftName,
  stringFrom,
  todayUtc,
} from "./common.js";

const DISPLAY_NAME = "Meta Ads";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v25.0";

const apiVersion = (context: ProviderContext): string => {
  const value =
    connectionMetadataString(context, "apiVersion") ?? DEFAULT_API_VERSION;
  if (!/^v\d+\.\d+$/.test(value)) {
    throw new Error("Meta Ads apiVersion must look like v25.0");
  }
  return value;
};

const request = <T>(
  context: ProviderContext,
  options: {
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    readonly body?: unknown;
  },
): Promise<T> =>
  requestProviderJson<T>(context, {
    provider: DISPLAY_NAME,
    baseUrl: providerBaseUrl(context, DEFAULT_BASE_URL),
    path: `/${apiVersion(context)}${options.path}`,
    ...(options.method ? { method: options.method } : {}),
    ...(options.query ? { query: options.query } : {}),
    headers: { authorization: `Bearer ${context.secret}` },
    ...(options.body === undefined ? {} : { body: options.body }),
  });

const accountFrom = (
  context: ProviderContext,
  value: unknown,
): ProviderAccount => {
  const account = asRecord(value, "Meta Ads account must be an object");
  const id = (stringFrom(account.account_id) ?? stringFrom(account.id) ?? "")
    .replace(/^act_/, "")
    .trim();
  if (!id) throw new Error("Meta Ads account is missing id");
  const currency = stringFrom(account.currency);
  const timezone = stringFrom(account.timezone_name);
  return {
    connectionId: context.connection.id,
    externalId: id,
    name: stringFrom(account.name) ?? `Meta Ads ${id}`,
    ...(currency ? { currency } : {}),
    ...(timezone ? { timezone } : {}),
    metadata: {
      ...(account.account_status !== undefined
        ? { accountStatus: account.account_status }
        : {}),
    },
    syncedAt: new Date().toISOString(),
  };
};

const accountDetails = async (
  context: ProviderContext,
  accountId: string,
): Promise<ProviderAccount> =>
  accountFrom(
    context,
    await request(context, {
      path: `/act_${accountId}`,
      query: {
        fields: "id,account_id,name,currency,timezone_name,account_status",
      },
    }),
  );

const metaEntityIds = (
  externalCampaignId: string,
  metadata?: Readonly<Record<string, unknown>>,
): { readonly campaignId: string; readonly adSetId: string } => {
  const adSetId = idFrom(metadata?.adSetId);
  if (!adSetId) {
    throw new Error(
      `Meta Ads mapping for ${externalCampaignId} is missing adSetId`,
    );
  }
  return { campaignId: externalCampaignId, adSetId };
};

export class MetaAdsAdapter implements AdsProviderAdapter {
  readonly descriptor = {
    id: "meta-ads",
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
    const accounts: ProviderAccount[] = [];
    let after: string | undefined;
    do {
      const response = asRecord(
        await request<unknown>(context, {
          path: "/me/adaccounts",
          query: {
            fields: "id,account_id,name,currency,timezone_name,account_status",
            limit: 100,
            ...(after ? { after } : {}),
          },
        }),
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      accounts.push(...rows.map((row) => accountFrom(context, row)));
      const cursors = asRecord(asRecord(response.paging ?? {}).cursors ?? {});
      after = stringFrom(cursors.after);
      if (!stringFrom(asRecord(response.paging ?? {}).next)) after = undefined;
    } while (after);
    return accounts;
  }

  async createDraft(
    context: ProviderContext,
    input: AdsDraftInput,
    idempotencyKey: string,
  ): Promise<AdsDraftResult> {
    ensureAdsDraftInput(input);
    if (input.experiment.channel !== "social") {
      throw new Error("Meta Ads adapter supports social experiments");
    }
    const accountId = connectionAccountId(context, input.externalAccountId);
    const name = stableDraftName(input, idempotencyKey);
    const targetCountries = connectionMetadataStrings(
      context,
      "targetCountries",
    );
    const campaign = asRecord(
      await request<unknown>(context, {
        path: `/act_${accountId}/campaigns`,
        method: "POST",
        body: {
          name,
          objective: "OUTCOME_TRAFFIC",
          status: "PAUSED",
          special_ad_categories: [],
          is_adset_budget_sharing_enabled: false,
        },
      }),
    );
    const campaignId = requireProviderId(
      campaign.id,
      "Meta Ads created a campaign but returned no id",
    );
    try {
      const adSet = asRecord(
        await request<unknown>(context, {
          path: `/act_${accountId}/adsets`,
          method: "POST",
          body: {
            name: `${name} ad set`,
            campaign_id: campaignId,
            daily_budget: input.experiment.dailyBudgetMinor,
            billing_event: "LINK_CLICKS",
            optimization_goal: "LINK_CLICKS",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            destination_type: "WEBSITE",
            targeting: {
              geo_locations: {
                countries: targetCountries,
              },
            },
            status: "PAUSED",
          },
        }),
      );
      const adSetId = requireProviderId(
        adSet.id,
        "Meta Ads created an ad set but returned no id",
      );
      return {
        externalCampaignId: campaignId,
        externalStatus: "PAUSED",
        metadata: {
          accountId,
          adSetId,
          creativeVariantCount: input.creative.variants.length,
          creativeUploadRequired: true,
        },
      };
    } catch (error) {
      throw partialAdsMutation(DISPLAY_NAME, campaignId, error);
    }
  }

  async activate(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const ids = metaEntityIds(externalCampaignId, metadata);
    await this.#setStatus(context, ids.campaignId, "ACTIVE");
    try {
      await this.#setStatus(context, ids.adSetId, "ACTIVE");
    } catch (error) {
      throw partialAdsMutation(DISPLAY_NAME, ids.campaignId, error);
    }
  }

  async pause(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const ids = metaEntityIds(externalCampaignId, metadata);
    await this.#setStatus(context, ids.adSetId, "PAUSED");
    await this.#setStatus(context, ids.campaignId, "PAUSED");
  }

  async #setStatus(
    context: ProviderContext,
    entityId: string,
    status: "ACTIVE" | "PAUSED",
  ): Promise<void> {
    await request(context, {
      path: `/${entityId}`,
      method: "POST",
      body: { status },
    });
  }

  async syncMetrics(
    context: ProviderContext,
    externalCampaignId: string,
    since: string,
  ): Promise<readonly NormalizedAdsMetrics[]> {
    const account = await accountDetails(context, connectionAccountId(context));
    if (!account.currency)
      throw new Error("Meta Ads account is missing currency");
    const response = asRecord(
      await request<unknown>(context, {
        path: `/${externalCampaignId}/insights`,
        query: {
          fields: "date_start,impressions,clicks,spend,actions",
          time_range: JSON.stringify({
            since: sinceDate(since),
            until: todayUtc(),
          }),
          time_increment: 1,
          limit: 500,
        },
      }),
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map((value) => {
      const row = asRecord(value, "Meta Ads metric row must be an object");
      const actions = Array.isArray(row.actions) ? row.actions : [];
      const conversions = actions.reduce((sum, action) => {
        const item = asRecord(action);
        const type = stringFrom(item.action_type) ?? "";
        if (!type.includes("conversion") && !type.includes("lead")) return sum;
        return sum + Number(item.value ?? 0);
      }, 0);
      return normalizeMetric({
        date: requireProviderId(
          row.date_start,
          "Meta Ads metric row is missing date",
        ),
        impressions: row.impressions,
        clicks: row.clicks,
        spendMinor: majorToMinor(stringFrom(row.spend), account.currency!),
        conversions,
        currency: account.currency!,
        metadata: { actions },
      });
    });
  }
}
