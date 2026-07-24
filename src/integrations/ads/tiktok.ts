import { ProviderHttpError } from "../errors.js";
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
  ensureAdsDraftInput,
  majorToMinor,
  minorToMajor,
  normalizeMetric,
  requireProviderId,
  sinceDate,
  stableDraftName,
  stringFrom,
  todayUtc,
} from "./common.js";

const DISPLAY_NAME = "TikTok Ads";
const DEFAULT_BASE_URL = "https://business-api.tiktok.com";
const API_ROOT = "/open_api/v1.3";

const request = async <T>(
  context: ProviderContext,
  options: {
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    readonly body?: unknown;
  },
): Promise<T> => {
  const response = asRecord(
    await requestProviderJson<unknown>(context, {
      provider: DISPLAY_NAME,
      baseUrl: providerBaseUrl(context, DEFAULT_BASE_URL),
      path: `${API_ROOT}${options.path}`,
      ...(options.method ? { method: options.method } : {}),
      ...(options.query ? { query: options.query } : {}),
      headers: { "Access-Token": context.secret },
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
  );
  const code = Number(response.code ?? 0);
  if (code !== 0) {
    throw new ProviderHttpError(
      `${DISPLAY_NAME} request failed with provider code ${code}`,
      { provider: DISPLAY_NAME, status: 200 },
    );
  }
  return response.data as T;
};

const accountDetails = async (
  context: ProviderContext,
  accountId: string,
): Promise<ProviderAccount> => {
  const data = asRecord(
    await request<unknown>(context, {
      path: "/advertiser/info/",
      query: {
        advertiser_ids: JSON.stringify([accountId]),
        fields: JSON.stringify([
          "advertiser_id",
          "name",
          "currency",
          "timezone",
          "status",
        ]),
      },
    }),
  );
  const rows = Array.isArray(data.list) ? data.list : [];
  const account = asRecord(
    rows[0] ?? {},
    "TikTok Ads account response must include an advertiser",
  );
  const id = stringFrom(account.advertiser_id) ?? accountId;
  const currency = stringFrom(account.currency);
  const timezone = stringFrom(account.timezone);
  const status = stringFrom(account.status);
  return {
    connectionId: context.connection.id,
    externalId: id,
    name: stringFrom(account.name) ?? `TikTok Ads ${id}`,
    ...(currency ? { currency } : {}),
    ...(timezone ? { timezone } : {}),
    metadata: {
      ...(status ? { status } : {}),
    },
    syncedAt: new Date().toISOString(),
  };
};

export class TikTokAdsAdapter implements AdsProviderAdapter {
  readonly descriptor = {
    id: "tiktok-ads",
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
      throw new Error("TikTok Ads adapter supports social experiments");
    }
    const accountId = connectionAccountId(context, input.externalAccountId);
    const data = asRecord(
      await request<unknown>(context, {
        path: "/campaign/create/",
        method: "POST",
        body: {
          advertiser_id: accountId,
          campaign_name: stableDraftName(input, idempotencyKey),
          objective_type: "TRAFFIC",
          budget_mode: "BUDGET_MODE_DAY",
          budget: minorToMajor(
            input.experiment.dailyBudgetMinor,
            input.experiment.currency,
          ),
          operation_status: "DISABLE",
          request_id: idempotencyKey.slice(0, 64),
        },
      }),
    );
    const externalCampaignId = requireProviderId(
      data.campaign_id,
      "TikTok Ads created a campaign but returned no id",
    );
    return {
      externalCampaignId,
      externalStatus: "DISABLE",
      metadata: {
        accountId,
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
    await this.#setStatus(context, externalCampaignId, "ENABLE");
  }

  async pause(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await this.#setStatus(context, externalCampaignId, "DISABLE");
  }

  async #setStatus(
    context: ProviderContext,
    externalCampaignId: string,
    operationStatus: "ENABLE" | "DISABLE",
  ): Promise<void> {
    await request(context, {
      path: "/campaign/update/",
      method: "POST",
      body: {
        advertiser_id: connectionAccountId(context),
        campaign_id: externalCampaignId,
        operation_status: operationStatus,
      },
    });
  }

  async syncMetrics(
    context: ProviderContext,
    externalCampaignId: string,
    since: string,
  ): Promise<readonly NormalizedAdsMetrics[]> {
    const account = await accountDetails(context, connectionAccountId(context));
    if (!account.currency) {
      throw new Error("TikTok Ads account is missing currency");
    }
    const rows: Readonly<Record<string, unknown>>[] = [];
    for (let page = 1; ; page += 1) {
      const data = asRecord(
        await request<unknown>(context, {
          path: "/report/integrated/get/",
          query: {
            advertiser_id: account.externalId,
            report_type: "BASIC",
            data_level: "AUCTION_CAMPAIGN",
            dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
            metrics: JSON.stringify([
              "spend",
              "impressions",
              "clicks",
              "conversion",
            ]),
            start_date: sinceDate(since),
            end_date: todayUtc(),
            filtering: JSON.stringify([
              {
                field_name: "campaign_ids",
                filter_type: "IN",
                filter_value: JSON.stringify([externalCampaignId]),
              },
            ]),
            page,
            page_size: 1000,
          },
        }),
      );
      const pageRows = Array.isArray(data.list)
        ? data.list.map((row) =>
            asRecord(row, "TikTok Ads metric row must be an object"),
          )
        : [];
      rows.push(...pageRows);
      const pageInfo = asRecord(data.page_info ?? {});
      const totalPages = Number(pageInfo.total_page ?? page);
      if (page >= totalPages || pageRows.length === 0) break;
    }
    return rows.map((row) => {
      const dimensions = asRecord(row.dimensions ?? {});
      const metrics = asRecord(row.metrics ?? {});
      return normalizeMetric({
        date: requireProviderId(
          dimensions.stat_time_day,
          "TikTok Ads metric row is missing date",
        ).slice(0, 10),
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        spendMinor: majorToMinor(stringFrom(metrics.spend), account.currency!),
        conversions: metrics.conversion,
        currency: account.currency!,
      });
    });
  }
}
