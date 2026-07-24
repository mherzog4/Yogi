import { requestProviderJson, providerBaseUrl } from "../http.js";
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
  minorToMicros,
  microsToMinor,
  normalizeMetric,
  partialAdsMutation,
  requireProviderId,
  sinceDate,
  stableDraftName,
  stringFrom,
} from "./common.js";
import { ExternalOutcomeUnknownError } from "../errors.js";

const DISPLAY_NAME = "Google Ads";
const DEFAULT_BASE_URL = "https://googleads.googleapis.com";
const DEFAULT_API_VERSION = "v25";

interface GoogleAdsCredentials {
  readonly accessToken: string;
  readonly developerToken: string;
}

const credentials = (secret: string): GoogleAdsCredentials => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret) as unknown;
  } catch {
    throw new Error(
      "Google Ads secret must be JSON with accessToken and developerToken",
    );
  }
  const value = asRecord(parsed, "Google Ads secret must be a JSON object");
  const accessToken = stringFrom(value.accessToken);
  const developerToken = stringFrom(value.developerToken);
  if (!accessToken || !developerToken) {
    throw new Error(
      "Google Ads secret must contain accessToken and developerToken",
    );
  }
  return { accessToken, developerToken };
};

const apiVersion = (context: ProviderContext): string => {
  const value =
    connectionMetadataString(context, "apiVersion") ?? DEFAULT_API_VERSION;
  if (!/^v\d+$/.test(value)) {
    throw new Error("Google Ads apiVersion must look like v25");
  }
  return value;
};

const request = <T>(
  context: ProviderContext,
  options: {
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
  },
): Promise<T> => {
  const auth = credentials(context.secret);
  const manager = connectionMetadataString(context, "managerCustomerId");
  return requestProviderJson<T>(context, {
    provider: DISPLAY_NAME,
    baseUrl: providerBaseUrl(context, DEFAULT_BASE_URL),
    path: `/${apiVersion(context)}${options.path}`,
    ...(options.method ? { method: options.method } : {}),
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "developer-token": auth.developerToken,
      ...(manager ? { "login-customer-id": manager.replaceAll("-", "") } : {}),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
};

const resourceId = (
  value: unknown,
  segment: string,
  message: string,
): string => {
  const resourceName = stringFrom(value);
  const marker = `/${segment}/`;
  const index = resourceName?.lastIndexOf(marker) ?? -1;
  if (!resourceName || index < 0) {
    throw new ExternalOutcomeUnknownError(message);
  }
  return resourceName.slice(index + marker.length);
};

const searchStreamRows = (
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] => {
  if (!Array.isArray(value)) {
    throw new Error("Google Ads search stream response must be an array");
  }
  return value.flatMap((batch) => {
    const results = asRecord(batch).results;
    return Array.isArray(results)
      ? results.map((row) => asRecord(row, "Google Ads row must be an object"))
      : [];
  });
};

const customerDetails = async (
  context: ProviderContext,
  customerId: string,
): Promise<ProviderAccount> => {
  const cleanId = customerId.replaceAll("-", "");
  const rows = searchStreamRows(
    await request<unknown>(context, {
      path: `/customers/${cleanId}/googleAds:searchStream`,
      method: "POST",
      body: {
        query:
          "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
      },
    }),
  );
  const customer = asRecord(rows[0]?.customer ?? {});
  const id = stringFrom(customer.id) ?? cleanId;
  const currency = stringFrom(customer.currencyCode);
  const timezone = stringFrom(customer.timeZone);
  return {
    connectionId: context.connection.id,
    externalId: id,
    name: stringFrom(customer.descriptiveName) ?? `Google Ads ${id}`,
    ...(currency ? { currency } : {}),
    ...(timezone ? { timezone } : {}),
    metadata: {},
    syncedAt: new Date().toISOString(),
  };
};

const euPoliticalAdvertising = (context: ProviderContext): string => {
  const value = connectionMetadataString(context, "euPoliticalAdvertising");
  if (
    value !== "CONTAINS_EU_POLITICAL_ADVERTISING" &&
    value !== "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"
  ) {
    throw new Error(
      "Google Ads connection must explicitly configure euPoliticalAdvertising",
    );
  }
  return value;
};

const googleCustomerId = (
  context: ProviderContext,
  requested?: string,
): string => connectionAccountId(context, requested).replaceAll("-", "");

export class GoogleAdsAdapter implements AdsProviderAdapter {
  readonly descriptor = {
    id: "google-ads",
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
    const account = await customerDetails(
      context,
      connectionAccountId(context),
    );
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
    const response = asRecord(
      await request<unknown>(context, {
        path: "/customers:listAccessibleCustomers",
      }),
    );
    const resources = Array.isArray(response.resourceNames)
      ? response.resourceNames
      : [];
    return Promise.all(
      resources.map((resource) =>
        customerDetails(context, String(resource).replace(/^customers\//, "")),
      ),
    );
  }

  async createDraft(
    context: ProviderContext,
    input: AdsDraftInput,
    idempotencyKey: string,
  ): Promise<AdsDraftResult> {
    ensureAdsDraftInput(input);
    if (input.experiment.channel === "social") {
      throw new Error(
        "Google Ads adapter supports search and display channels",
      );
    }
    const customerId = googleCustomerId(context, input.externalAccountId);
    const name = stableDraftName(input, idempotencyKey);
    const politicalAdvertising = euPoliticalAdvertising(context);
    const budgetResponse = asRecord(
      await request<unknown>(context, {
        path: `/customers/${customerId}/campaignBudgets:mutate`,
        method: "POST",
        body: {
          operations: [
            {
              create: {
                name: `${name} budget`,
                deliveryMethod: "STANDARD",
                amountMicros: minorToMicros(
                  input.experiment.dailyBudgetMinor,
                  input.experiment.currency,
                ),
                explicitlyShared: false,
              },
            },
          ],
        },
      }),
    );
    const budgetResult = Array.isArray(budgetResponse.results)
      ? asRecord(budgetResponse.results[0] ?? {})
      : {};
    const budgetResource = stringFrom(budgetResult.resourceName);
    if (!budgetResource) {
      throw new ExternalOutcomeUnknownError(
        "Google Ads created a budget but returned no resource",
      );
    }
    const budgetId = resourceId(
      budgetResource,
      "campaignBudgets",
      "Google Ads budget resource is invalid",
    );
    try {
      const campaignResponse = asRecord(
        await request<unknown>(context, {
          path: `/customers/${customerId}/campaigns:mutate`,
          method: "POST",
          body: {
            operations: [
              {
                create: {
                  name,
                  campaignBudget: budgetResource,
                  advertisingChannelType:
                    input.experiment.channel === "search"
                      ? "SEARCH"
                      : "DISPLAY",
                  status: "PAUSED",
                  manualCpc: {},
                  containsEuPoliticalAdvertising: politicalAdvertising,
                  ...(input.experiment.channel === "search"
                    ? {
                        networkSettings: {
                          targetGoogleSearch: true,
                          targetSearchNetwork: true,
                          targetContentNetwork: false,
                          targetPartnerSearchNetwork: false,
                        },
                      }
                    : {}),
                },
              },
            ],
          },
        }),
      );
      const result = Array.isArray(campaignResponse.results)
        ? asRecord(campaignResponse.results[0] ?? {})
        : {};
      const resourceName = stringFrom(result.resourceName);
      const externalCampaignId = resourceId(
        resourceName,
        "campaigns",
        "Google Ads created a campaign but returned no resource",
      );
      return {
        externalCampaignId,
        externalBudgetId: budgetId,
        externalStatus: "PAUSED",
        metadata: {
          customerId,
          campaignResourceName: resourceName,
          budgetResourceName: budgetResource,
          creativeVariantCount: input.creative.variants.length,
          creativeUploadRequired: true,
        },
      };
    } catch (error) {
      throw partialAdsMutation(DISPLAY_NAME, budgetId, error);
    }
  }

  async activate(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await this.#setStatus(context, externalCampaignId, "ENABLED");
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
    status: "ENABLED" | "PAUSED",
  ): Promise<void> {
    const customerId = googleCustomerId(context);
    await request(context, {
      path: `/customers/${customerId}/campaigns:mutate`,
      method: "POST",
      body: {
        operations: [
          {
            update: {
              resourceName: `customers/${customerId}/campaigns/${externalCampaignId}`,
              status,
            },
            updateMask: "status",
          },
        ],
      },
    });
  }

  async syncMetrics(
    context: ProviderContext,
    externalCampaignId: string,
    since: string,
  ): Promise<readonly NormalizedAdsMetrics[]> {
    const customerId = googleCustomerId(context);
    const start = sinceDate(since);
    const rows = searchStreamRows(
      await request<unknown>(context, {
        path: `/customers/${customerId}/googleAds:searchStream`,
        method: "POST",
        body: {
          query: `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, customer.currency_code FROM campaign WHERE campaign.id = ${externalCampaignId} AND segments.date >= '${start}' ORDER BY segments.date`,
        },
      }),
    );
    return rows.map((row) => {
      const segments = asRecord(row.segments ?? {});
      const metrics = asRecord(row.metrics ?? {});
      const customer = asRecord(row.customer ?? {});
      const currency = stringFrom(customer.currencyCode);
      if (!currency)
        throw new Error("Google Ads metric row is missing currency");
      return normalizeMetric({
        date: requireProviderId(
          segments.date,
          "Google Ads metric row is missing date",
        ),
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        spendMinor: microsToMinor(metrics.costMicros as string, currency),
        conversions: metrics.conversions,
        currency,
      });
    });
  }
}
