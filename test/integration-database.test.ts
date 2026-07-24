import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntegrationDatabase,
  integrationDatabasePath,
  sha256Json,
  stableJson,
} from "../src/integrations/database.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "yogi-db-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("integration database", () => {
  it("initializes a private WAL database and stores references, not secrets", async () => {
    const cwd = await temporaryDirectory();
    const path = integrationDatabasePath(cwd);
    const database = new IntegrationDatabase(path);

    expect(database.schemaVersion()).toBe(1);
    expect(database.journalMode()).toBe("wal");
    expect(database.integrityCheck()).toBe("ok");

    const connection = database.createConnection({
      provider: "smartlead",
      name: "Founder outbound",
      secretRef: "env:SMARTLEAD_API_KEY",
      externalAccountId: "client-42",
      metadata: { region: "us" },
      id: "connection-one",
      now: new Date("2026-07-24T12:00:00.000Z"),
    });
    expect(connection.secretRef).toBe("env:SMARTLEAD_API_KEY");
    expect(connection.externalAccountId).toBe("client-42");
    expect(connection.status).toBe("configured");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    database.close();
    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).not.toContain("actual-secret-value");
  });

  it("persists accounts, mappings, idempotent operations, and approvals", async () => {
    const cwd = await temporaryDirectory();
    const database = new IntegrationDatabase(integrationDatabasePath(cwd));
    const connection = database.createConnection({
      provider: "google-ads",
      name: "Google Ads",
      secretRef: "env:GOOGLE_ADS_CREDENTIALS",
      id: "google",
      now: new Date("2026-07-24T12:00:00.000Z"),
    });

    database.upsertAccounts([
      {
        connectionId: connection.id,
        externalId: "1234567890",
        name: "Launch account",
        currency: "USD",
        timezone: "America/New_York",
        metadata: { manager: false },
        syncedAt: "2026-07-24T12:05:00.000Z",
      },
    ]);
    expect(database.listAccounts(connection.id)).toHaveLength(1);

    const mapping = database.upsertCampaignMapping({
      connectionId: connection.id,
      campaignId: "launch-ads",
      externalCampaignId: "customers/123/campaigns/456",
      state: "PAUSED",
      now: new Date("2026-07-24T12:10:00.000Z"),
    });
    expect(mapping.externalCampaignId).toContain("campaigns/456");

    const operation = database.beginOperation({
      connectionId: connection.id,
      campaignId: "launch-ads",
      action: "create-draft",
      idempotencyKey: "launch-ads:create-draft:v1",
      request: { budget: 30000, currency: "USD" },
      now: new Date("2026-07-24T12:15:00.000Z"),
    });
    const repeated = database.beginOperation({
      connectionId: connection.id,
      campaignId: "launch-ads",
      action: "create-draft",
      idempotencyKey: "launch-ads:create-draft:v1",
      request: { currency: "USD", budget: 30000 },
    });
    expect(repeated.id).toBe(operation.id);

    await expect(
      Promise.resolve().then(() =>
        database.beginOperation({
          connectionId: connection.id,
          campaignId: "launch-ads",
          action: "activate",
          idempotencyKey: "launch-ads:create-draft:v1",
          request: { campaign: "other" },
        }),
      ),
    ).rejects.toThrow("already used for another operation");

    const completed = database.completeOperation({
      id: operation.id,
      status: "succeeded",
      externalId: "customers/123/campaigns/456",
      response: { created: true },
      now: new Date("2026-07-24T12:20:00.000Z"),
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.response).toEqual({ created: true });

    const operationHash = sha256Json({
      connectionId: operation.connectionId,
      campaignId: operation.campaignId,
      action: operation.action,
      idempotencyKey: operation.idempotencyKey,
      requestSha256: operation.requestSha256,
    });
    database.recordApproval({
      operationSha256: operationHash,
      scope: "ads:activate",
      approvedBy: "owner",
      expiresAt: "2026-07-25T12:00:00.000Z",
      now: new Date("2026-07-24T12:20:00.000Z"),
    });
    expect(
      database.hasValidApproval(
        operationHash,
        "ads:activate",
        new Date("2026-07-24T13:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      database.hasValidApproval(
        operationHash,
        "ads:activate",
        new Date("2026-07-26T13:00:00.000Z"),
      ),
    ).toBe(false);
    database.close();
  });

  it("deduplicates webhooks and stores cursors and normalized metrics", async () => {
    const cwd = await temporaryDirectory();
    const database = new IntegrationDatabase(integrationDatabasePath(cwd));
    const connection = database.createConnection({
      provider: "meta-ads",
      name: "Meta",
      secretRef: "env:META_ADS_CREDENTIALS",
      id: "meta",
    });

    expect(
      database.claimWebhookEvent({
        connectionId: connection.id,
        providerEventId: "event-1",
        eventType: "campaign.updated",
        payload: { id: 1 },
      }),
    ).toBe(true);
    expect(
      database.claimWebhookEvent({
        connectionId: connection.id,
        providerEventId: "event-1",
        eventType: "campaign.updated",
        payload: { id: 1 },
      }),
    ).toBe(false);
    database.completeWebhookEvent({
      connectionId: connection.id,
      providerEventId: "event-1",
      status: "processed",
    });

    database.setSyncCursor({
      connectionId: connection.id,
      stream: "campaign:42:metrics",
      cursor: "2026-07-24",
    });
    expect(database.getSyncCursor(connection.id, "campaign:42:metrics")).toBe(
      "2026-07-24",
    );

    database.upsertMetricSnapshot({
      connectionId: connection.id,
      campaignId: "launch-ads",
      externalCampaignId: "42",
      metrics: {
        date: "2026-07-24",
        impressions: 1000,
        clicks: 50,
        spendMinor: 1234,
        conversions: 4,
        currency: "USD",
        metadata: { source: "provider" },
      },
    });
    expect(database.listMetricSnapshots(connection.id, "42")).toEqual([
      expect.objectContaining({
        date: "2026-07-24",
        spendMinor: 1234,
        conversions: 4,
      }),
    ]);
    database.close();
  });

  it("creates a consistent online backup", async () => {
    const cwd = await temporaryDirectory();
    const source = new IntegrationDatabase(integrationDatabasePath(cwd));
    source.createConnection({
      provider: "emailbison",
      name: "EmailBison",
      secretRef: "env:EMAILBISON_API_KEY",
    });
    const destination = join(cwd, "backups", "yogi.sqlite");
    expect(await source.backup(destination)).toBeGreaterThan(0);
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
    source.close();

    const restored = new IntegrationDatabase(destination);
    expect(restored.listConnections()).toHaveLength(1);
    expect(restored.integrityCheck()).toBe("ok");
    restored.close();
  });

  it("canonicalizes request JSON for stable hashes", () => {
    expect(stableJson({ b: 2, a: { z: 1, y: 2 } })).toBe(
      '{"a":{"y":2,"z":1},"b":2}',
    );
    expect(sha256Json({ a: 1, b: 2 })).toBe(sha256Json({ b: 2, a: 1 }));
    expect(() => stableJson(undefined)).toThrow(
      "cannot be represented as JSON",
    );
  });
});
