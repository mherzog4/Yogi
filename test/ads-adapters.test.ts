import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GoogleAdsAdapter } from "../src/integrations/ads/google.js";
import { LinkedInAdsAdapter } from "../src/integrations/ads/linkedin.js";
import { MetaAdsAdapter } from "../src/integrations/ads/meta.js";
import { TikTokAdsAdapter } from "../src/integrations/ads/tiktok.js";
import type {
  AdsDraftInput,
  ProviderContext,
} from "../src/integrations/types.js";

const response = (
  value?: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const queuedFetch = (...responses: readonly Response[]) => {
  const queue = [...responses];
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error("Unexpected provider request");
    return next;
  });
};

const context = (
  provider: "google-ads" | "linkedin-ads" | "tiktok-ads" | "meta-ads",
  fetchMock: ReturnType<typeof queuedFetch>,
  metadata: Readonly<Record<string, unknown>> = {},
  secret = "access-token",
): ProviderContext => ({
  connection: {
    id: `${provider}-connection`,
    provider,
    category: "ads",
    name: provider,
    secretRef: `env:${provider.toUpperCase().replaceAll("-", "_")}_SECRET`,
    externalAccountId: "123",
    status: "verified",
    metadata,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  },
  secret,
  fetch: fetchMock as unknown as typeof fetch,
});

const withCreativeHash = (input: AdsDraftInput): AdsDraftInput => ({
  ...input,
  readiness: {
    ...input.readiness,
    creativeSha256: createHash("sha256")
      .update(`${JSON.stringify(input.creative, null, 2)}\n`)
      .digest("hex"),
  },
});

const draftInput = (channel: "search" | "social" = "social"): AdsDraftInput =>
  withCreativeHash({
    campaignId: "launch-ads",
    externalAccountId: "123",
    experiment: {
      schemaVersion: 1,
      id: "intent-test",
      campaignId: "launch-ads",
      name: "Intent test",
      objective: "Qualified signups",
      hypothesis: "Focused copy will convert",
      channel,
      audience: "B2B founders",
      offer: "GTM planning",
      landingPageUrl: "https://example.com/plan",
      tracking: {
        conversionEvent: "qualified_signup",
        utmSource: "paid",
        utmMedium: "cpc",
        utmCampaign: "intent-test",
      },
      currency: "USD",
      dailyBudgetMinor: 3000,
      totalBudgetMinor: 30000,
      stopLossSpendMinor: 10000,
      minimumCreativeVariants: 2,
      createdAt: "2026-07-24T12:00:00.000Z",
    },
    creative: {
      schemaVersion: 1,
      experimentId: "intent-test",
      variants: [
        {
          id: "a",
          headline: "Plan distribution",
          body: "Build a repeatable GTM system.",
          callToAction: "Start planning",
        },
        {
          id: "b",
          headline: "Find a growth motion",
          body: "Turn experiments into evidence.",
          callToAction: "See how",
        },
      ],
    },
    readiness: {
      schemaVersion: 1,
      experimentId: "intent-test",
      creativeSha256: "a".repeat(64),
      reviewedAt: "2026-07-24T12:00:00.000Z",
      passed: true,
      policy: {
        currency: "USD",
        maxDailyBudgetMinor: 5000,
        maxExperimentBudgetMinor: 50000,
        maxSpendWithoutConversionMinor: 10000,
        minimumCreativeVariants: 2,
        allowedLandingPageHosts: ["example.com"],
        prohibitedPhrases: [],
      },
      issues: [],
    },
  });

const requestBody = (fetchMock: ReturnType<typeof queuedFetch>, call: number) =>
  JSON.parse(
    String((fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.body),
  ) as unknown;

describe("Google Ads adapter", () => {
  it("creates a paused budgeted campaign and normalizes micros", async () => {
    const fetchMock = queuedFetch(
      response({
        results: [{ resourceName: "customers/123/campaignBudgets/456" }],
      }),
      response({
        results: [{ resourceName: "customers/123/campaigns/789" }],
      }),
      response({ results: [] }),
      response({ results: [] }),
      response([
        {
          results: [
            {
              segments: { date: "2026-07-24" },
              metrics: {
                impressions: "100",
                clicks: "10",
                costMicros: "12500000",
                conversions: 2,
              },
              customer: { currencyCode: "USD" },
            },
          ],
        },
      ]),
    );
    const adapter = new GoogleAdsAdapter();
    const providerContext = context(
      "google-ads",
      fetchMock,
      {
        currency: "USD",
        euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      },
      JSON.stringify({
        accessToken: "oauth-token",
        developerToken: "developer-token",
      }),
    );
    const draft = await adapter.createDraft(
      providerContext,
      draftInput("search"),
      "draft-key",
    );
    expect(draft).toMatchObject({
      externalCampaignId: "789",
      externalBudgetId: "456",
      externalStatus: "PAUSED",
    });
    expect(requestBody(fetchMock, 0)).toMatchObject({
      operations: [{ create: { amountMicros: "30000000" } }],
    });
    expect(requestBody(fetchMock, 1)).toMatchObject({
      operations: [
        {
          create: {
            status: "PAUSED",
            containsEuPoliticalAdvertising:
              "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          },
        },
      ],
    });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["developer-token"]).toBe("developer-token");
    await adapter.activate(providerContext, "789", "activate-key");
    await adapter.pause(providerContext, "789", "pause-key");
    expect(requestBody(fetchMock, 2)).toMatchObject({
      operations: [{ update: { status: "ENABLED" }, updateMask: "status" }],
    });
    await expect(
      adapter.syncMetrics(providerContext, "789", "2026-07-01"),
    ).resolves.toEqual([
      {
        date: "2026-07-24",
        impressions: 100,
        clicks: 10,
        spendMinor: 1250,
        conversions: 2,
        currency: "USD",
      },
    ]);
  });

  it("requires the EU political-ad declaration before creating a budget", async () => {
    const fetchMock = queuedFetch();
    await expect(
      new GoogleAdsAdapter().createDraft(
        context(
          "google-ads",
          fetchMock,
          { currency: "USD" },
          JSON.stringify({
            accessToken: "oauth-token",
            developerToken: "developer-token",
          }),
        ),
        draftInput("search"),
        "draft-key",
      ),
    ).rejects.toThrow("euPoliticalAdvertising");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LinkedIn Ads adapter", () => {
  it("uses a draft campaign group and reads daily analytics", async () => {
    const fetchMock = queuedFetch(
      response(undefined, 201, { "x-restli-id": "group-1" }),
      response(undefined, 204),
      response(undefined, 204),
      response({
        id: "123",
        name: "Founder GTM",
        currency: "USD",
        timezone: "America/New_York",
      }),
      response({
        elements: [
          {
            dateRange: { start: { year: 2026, month: 7, day: 24 } },
            impressions: 200,
            clicks: 12,
            costInLocalCurrency: "42.50",
            externalWebsiteConversions: 3,
            pivotValues: ["urn:li:sponsoredCampaignGroup:group-1"],
          },
        ],
      }),
    );
    const adapter = new LinkedInAdsAdapter();
    const providerContext = context("linkedin-ads", fetchMock, {
      currency: "USD",
    });
    const draft = await adapter.createDraft(
      providerContext,
      draftInput(),
      "draft-key",
    );
    expect(draft.externalCampaignId).toBe("group-1");
    expect(requestBody(fetchMock, 0)).toMatchObject({
      status: "DRAFT",
      totalBudget: { amount: "300.00", currencyCode: "USD" },
    });
    await adapter.activate(providerContext, "group-1", "activate-key");
    await adapter.pause(providerContext, "group-1", "pause-key");
    expect(requestBody(fetchMock, 1)).toEqual({
      patch: { $set: { status: "ACTIVE" } },
    });
    const metrics = await adapter.syncMetrics(
      providerContext,
      "group-1",
      "2026-07-01",
    );
    expect(metrics[0]).toMatchObject({
      date: "2026-07-24",
      spendMinor: 4250,
      conversions: 3,
    });
  });
});

describe("TikTok Ads adapter", () => {
  it("creates a disabled campaign and reads integrated reporting", async () => {
    const fetchMock = queuedFetch(
      response({ code: 0, data: { campaign_id: "campaign-1" } }),
      response({ code: 0, data: {} }),
      response({ code: 0, data: {} }),
      response({
        code: 0,
        data: {
          list: [
            {
              advertiser_id: "123",
              name: "Founder GTM",
              currency: "USD",
              timezone: "America/New_York",
            },
          ],
        },
      }),
      response({
        code: 0,
        data: {
          list: [
            {
              dimensions: {
                campaign_id: "campaign-1",
                stat_time_day: "2026-07-24 00:00:00",
              },
              metrics: {
                impressions: "300",
                clicks: "20",
                spend: "55.25",
                conversion: "4",
              },
            },
          ],
          page_info: { total_page: 1 },
        },
      }),
    );
    const adapter = new TikTokAdsAdapter();
    const providerContext = context("tiktok-ads", fetchMock, {
      currency: "USD",
    });
    expect(
      await adapter.createDraft(providerContext, draftInput(), "draft-key"),
    ).toMatchObject({
      externalCampaignId: "campaign-1",
      externalStatus: "DISABLE",
    });
    expect(requestBody(fetchMock, 0)).toMatchObject({
      budget: 30,
      operation_status: "DISABLE",
    });
    await adapter.activate(providerContext, "campaign-1", "activate-key");
    await adapter.pause(providerContext, "campaign-1", "pause-key");
    const metrics = await adapter.syncMetrics(
      providerContext,
      "campaign-1",
      "2026-07-01",
    );
    expect(metrics[0]).toMatchObject({
      date: "2026-07-24",
      spendMinor: 5525,
      conversions: 4,
    });
  });
});

describe("Meta Ads adapter", () => {
  it("creates paused campaign and ad set, then controls both", async () => {
    const fetchMock = queuedFetch(
      response({ id: "campaign-1" }),
      response({ id: "adset-1" }),
      response({ success: true }),
      response({ success: true }),
      response({ success: true }),
      response({ success: true }),
      response({
        id: "act_123",
        account_id: "123",
        name: "Founder GTM",
        currency: "USD",
        timezone_name: "America/New_York",
      }),
      response({
        data: [
          {
            date_start: "2026-07-24",
            impressions: "400",
            clicks: "30",
            spend: "67.89",
            actions: [{ action_type: "offsite_conversion.lead", value: "5" }],
          },
        ],
      }),
    );
    const adapter = new MetaAdsAdapter();
    const providerContext = context("meta-ads", fetchMock, {
      currency: "USD",
      targetCountries: ["US"],
    });
    const draft = await adapter.createDraft(
      providerContext,
      draftInput(),
      "draft-key",
    );
    expect(draft).toMatchObject({
      externalCampaignId: "campaign-1",
      externalStatus: "PAUSED",
      metadata: { adSetId: "adset-1" },
    });
    expect(requestBody(fetchMock, 1)).toMatchObject({
      daily_budget: 3000,
      status: "PAUSED",
      targeting: { geo_locations: { countries: ["US"] } },
    });
    await adapter.activate(
      providerContext,
      "campaign-1",
      "activate-key",
      draft.metadata,
    );
    await adapter.pause(
      providerContext,
      "campaign-1",
      "pause-key",
      draft.metadata,
    );
    expect(requestBody(fetchMock, 2)).toEqual({ status: "ACTIVE" });
    expect(requestBody(fetchMock, 3)).toEqual({ status: "ACTIVE" });
    const metrics = await adapter.syncMetrics(
      providerContext,
      "campaign-1",
      "2026-07-01",
    );
    expect(metrics[0]).toMatchObject({
      date: "2026-07-24",
      spendMinor: 6789,
      conversions: 5,
    });
  });

  it("requires explicit countries before creating a campaign", async () => {
    const fetchMock = queuedFetch();
    await expect(
      new MetaAdsAdapter().createDraft(
        context("meta-ads", fetchMock, { currency: "USD" }),
        draftInput(),
        "draft-key",
      ),
    ).rejects.toThrow("targetCountries");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
