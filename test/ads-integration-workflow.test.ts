import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationDatabase,
  integrationDatabasePath,
} from "../src/integrations/database.js";
import { PaidAdsIntegrationWorkflow } from "../src/integrations/ads/workflow.js";
import { IntegrationRegistry } from "../src/integrations/registry.js";
import type {
  AdsDraftInput,
  AdsProviderAdapter,
} from "../src/integrations/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
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

const input = (): AdsDraftInput =>
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
      channel: "social",
      audience: "B2B founders",
      offer: "GTM planning",
      landingPageUrl: "https://example.com",
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
      minimumCreativeVariants: 1,
      createdAt: "2026-07-24T12:00:00.000Z",
    },
    creative: {
      schemaVersion: 1,
      experimentId: "intent-test",
      variants: [
        {
          id: "a",
          headline: "Plan distribution",
          body: "Build a repeatable system.",
          callToAction: "Start planning",
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
        minimumCreativeVariants: 1,
        allowedLandingPageHosts: ["example.com"],
        prohibitedPhrases: [],
      },
      issues: [],
    },
  });

const setup = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-ads-workflow-"));
  temporaryDirectories.push(cwd);
  const database = new IntegrationDatabase(integrationDatabasePath(cwd));
  database.createConnection({
    id: "connection-1",
    provider: "meta-ads",
    name: "Meta",
    secretRef: "env:META_ADS_ACCESS_TOKEN",
    externalAccountId: "123",
  });
  database.updateConnectionStatus({
    id: "connection-1",
    status: "verified",
    externalAccountId: "123",
    metadata: { currency: "USD" },
  });
  const adapter: AdsProviderAdapter = {
    descriptor: {
      id: "meta-ads",
      category: "ads",
      displayName: "Meta Ads",
      capabilities: {
        createDraft: true,
        activate: true,
        pause: true,
        webhooks: false,
        polling: true,
        accountDiscovery: true,
      },
    },
    verifyConnection: vi.fn(async () => ({
      ok: true,
      message: "Connected",
    })),
    listAccounts: vi.fn(async () => []),
    createDraft: vi.fn(async () => ({
      externalCampaignId: "remote-1",
      externalStatus: "PAUSED",
      metadata: { adSetId: "adset-1" },
    })),
    activate: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    syncMetrics: vi.fn(async () => [
      {
        date: "2026-07-24",
        impressions: 100,
        clicks: 5,
        spendMinor: 10000,
        conversions: 0,
        currency: "USD",
      },
    ]),
  };
  const workflow = new PaidAdsIntegrationWorkflow({
    database,
    registry: new IntegrationRegistry().register(adapter),
    secrets: { resolve: async () => "secret" },
    fetch: vi.fn() as unknown as typeof fetch,
  });
  return { database, adapter, workflow };
};

describe("paid ads integration workflow", () => {
  it("publishes once, activates separately, and auto-pauses at stop-loss", async () => {
    const { database, adapter, workflow } = await setup();
    const options = {
      connectionId: "connection-1",
      input: input(),
      approvedBy: "owner",
    };
    await expect(
      workflow.publishDraft({
        ...options,
        input: {
          ...options.input,
          readiness: {
            ...options.input.readiness,
            reviewedAt: "2026-07-24T13:00:00.000Z",
          },
        },
      }),
    ).resolves.toMatchObject({ externalCampaignId: "remote-1" });
    await expect(workflow.publishDraft(options)).resolves.toMatchObject({
      externalCampaignId: "remote-1",
    });
    expect(adapter.createDraft).toHaveBeenCalledOnce();
    await workflow.activate({
      connectionId: "connection-1",
      campaignId: "launch-ads",
      experimentId: "intent-test",
      approvedBy: "owner",
    });
    expect(adapter.activate).toHaveBeenCalledOnce();
    const sync = await workflow.syncMetrics({
      connectionId: "connection-1",
      campaignId: "launch-ads",
      experimentId: "intent-test",
      since: "2026-07-01",
    });
    expect(sync.autoPaused).toBe(true);
    expect(sync.cursor).toBe("2026-07-24");
    expect(adapter.pause).toHaveBeenCalledOnce();
    expect(
      database.getCampaignMapping(
        "connection-1",
        "launch-ads:paid:intent-test",
      ),
    ).toMatchObject({
      state: "paused",
      metadata: {
        totalBudgetMinor: 30000,
        stopLossSpendMinor: 10000,
      },
    });
    expect(
      database.listMetricSnapshots("connection-1", "remote-1"),
    ).toHaveLength(1);
    await expect(
      workflow.syncMetrics({
        connectionId: "connection-1",
        campaignId: "launch-ads",
        experimentId: "intent-test",
      }),
    ).resolves.toMatchObject({ cursor: "2026-07-24" });
    expect(adapter.syncMetrics).toHaveBeenLastCalledWith(
      expect.anything(),
      "remote-1",
      "2026-07-24",
    );
    await expect(
      workflow.activate({
        connectionId: "connection-1",
        campaignId: "launch-ads",
        experimentId: "intent-test",
        approvedBy: "owner",
        attempt: 2,
      }),
    ).rejects.toThrow("stop-loss");
    database.close();
  });

  it("rejects an unapproved readiness report before resolving secrets", async () => {
    const { database, adapter, workflow } = await setup();
    await expect(
      workflow.publishDraft({
        connectionId: "connection-1",
        input: {
          ...input(),
          readiness: { ...input().readiness, passed: false },
        },
        approvedBy: "owner",
      }),
    ).rejects.toThrow("launch readiness");
    expect(adapter.createDraft).not.toHaveBeenCalled();
    database.close();
  });

  it("keeps multiple experiments under one campaign isolated", async () => {
    const { database, adapter, workflow } = await setup();
    vi.mocked(adapter.createDraft)
      .mockResolvedValueOnce({
        externalCampaignId: "remote-1",
        externalStatus: "PAUSED",
      })
      .mockResolvedValueOnce({
        externalCampaignId: "remote-2",
        externalStatus: "PAUSED",
      });
    const first = input();
    const second = withCreativeHash({
      ...input(),
      experiment: { ...input().experiment, id: "audience-test" },
      creative: { ...input().creative, experimentId: "audience-test" },
      readiness: { ...input().readiness, experimentId: "audience-test" },
    });

    await workflow.publishDraft({
      connectionId: "connection-1",
      input: first,
      approvedBy: "owner",
    });
    await workflow.publishDraft({
      connectionId: "connection-1",
      input: second,
      approvedBy: "owner",
    });

    expect(
      database.getCampaignMapping("connection-1", "launch-ads:paid:intent-test")
        .externalCampaignId,
    ).toBe("remote-1");
    expect(
      database.getCampaignMapping(
        "connection-1",
        "launch-ads:paid:audience-test",
      ).externalCampaignId,
    ).toBe("remote-2");
    database.close();
  });
});
