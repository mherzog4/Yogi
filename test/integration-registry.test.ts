import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationDatabase,
  integrationDatabasePath,
} from "../src/integrations/database.js";
import {
  IntegrationRegistry,
  IntegrationService,
  operationApprovalHash,
} from "../src/integrations/registry.js";
import { ExternalOutcomeUnknownError } from "../src/integrations/errors.js";
import type { SecretResolver } from "../src/integrations/secrets.js";
import type { ProviderAdapter } from "../src/integrations/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const setup = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-registry-test-"));
  temporaryDirectories.push(cwd);
  const database = new IntegrationDatabase(integrationDatabasePath(cwd));
  const connection = database.createConnection({
    provider: "smartlead",
    name: "Smartlead",
    secretRef: "env:SMARTLEAD_API_KEY",
    id: "smartlead",
  });
  const adapter: ProviderAdapter = {
    descriptor: {
      id: "smartlead",
      category: "outbound",
      displayName: "Smartlead",
      capabilities: {
        createDraft: true,
        activate: true,
        pause: true,
        webhooks: true,
        polling: true,
        accountDiscovery: true,
      },
    },
    verifyConnection: vi.fn(async () => ({
      ok: true,
      externalAccountId: "workspace-1",
      accountName: "Founder GTM",
      message: "Connected",
    })),
    listAccounts: vi.fn(async () => [
      {
        connectionId: connection.id,
        externalId: "workspace-1",
        name: "Founder GTM",
        metadata: {},
        syncedAt: "2026-07-24T12:00:00.000Z",
      },
    ]),
  };
  const registry = new IntegrationRegistry().register(adapter);
  const secrets: SecretResolver = {
    resolve: vi.fn(async () => "resolved-secret"),
  };
  const service = new IntegrationService({
    database,
    registry,
    secrets,
    fetch: vi.fn() as unknown as typeof fetch,
  });
  return { database, connection, adapter, registry, secrets, service };
};

describe("integration registry and service", () => {
  it("verifies connections and discovers provider accounts", async () => {
    const { database, connection, adapter, service } = await setup();
    await service.verifyConnection(connection.id);
    expect(database.getConnection(connection.id)).toEqual(
      expect.objectContaining({
        status: "verified",
        externalAccountId: "workspace-1",
      }),
    );
    expect(await service.discoverAccounts(connection.id)).toBe(1);
    expect(database.listAccounts(connection.id)).toHaveLength(1);
    expect(adapter.verifyConnection).toHaveBeenCalledOnce();
    database.close();
  });

  it("requires an operation-bound approval and replays successes safely", async () => {
    const { database, connection, service } = await setup();
    const operation = service.prepareOperation({
      connectionId: connection.id,
      campaignId: "founder-outbound",
      action: "activate",
      idempotencyKey: "founder-outbound:activate:v1",
      request: { externalCampaignId: "campaign-1" },
    });
    const execute = vi.fn(async () => ({ activated: true }));

    await expect(
      service.executeOperation({
        operation,
        approvalScope: "outbound:activate",
        execute,
      }),
    ).rejects.toThrow("requires approval scope outbound:activate");

    service.approveOperation({
      operation,
      scope: "outbound:activate",
      approvedBy: "owner",
    });
    expect(
      database.hasValidApproval(
        operationApprovalHash(operation),
        "outbound:activate",
      ),
    ).toBe(true);

    await expect(
      service.executeOperation({
        operation,
        approvalScope: "outbound:activate",
        execute,
      }),
    ).resolves.toEqual({ activated: true });
    await expect(
      service.executeOperation({
        operation,
        approvalScope: "outbound:activate",
        execute,
      }),
    ).resolves.toEqual({ activated: true });
    expect(execute).toHaveBeenCalledOnce();

    const uncertain = service.prepareOperation({
      connectionId: connection.id,
      campaignId: "founder-outbound",
      action: "create-draft",
      idempotencyKey: "founder-outbound:create-draft:uncertain",
      request: { campaign: "founder-outbound" },
    });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const uncertainExecute = vi.fn(async () => circular);
    await expect(
      service.executeOperation({
        operation: uncertain,
        execute: uncertainExecute,
      }),
    ).rejects.toThrow("requires reconciliation before retry");
    expect(
      database.getOperationByKey(connection.id, uncertain.idempotencyKey)
        .status,
    ).toBe("unknown");
    await expect(
      service.executeOperation({
        operation: uncertain,
        execute: uncertainExecute,
      }),
    ).rejects.toThrow("requires reconciliation");
    expect(uncertainExecute).toHaveBeenCalledOnce();

    const providerUncertain = service.prepareOperation({
      connectionId: connection.id,
      campaignId: "founder-outbound",
      action: "activate",
      idempotencyKey: "founder-outbound:activate:provider-uncertain",
      request: { externalCampaignId: "campaign-2" },
    });
    await expect(
      service.executeOperation({
        operation: providerUncertain,
        execute: async () => {
          throw new ExternalOutcomeUnknownError("timed out after send", {
            externalId: "campaign-2",
          });
        },
      }),
    ).rejects.toThrow("timed out after send");
    expect(
      database.getOperationByKey(
        connection.id,
        providerUncertain.idempotencyKey,
      ),
    ).toMatchObject({
      status: "unknown",
      externalId: "campaign-2",
    });
    database.close();
  });

  it("rejects duplicate adapters and missing secret values", async () => {
    const { database, adapter, registry, service } = await setup();
    expect(() => registry.register(adapter)).toThrow("already registered");

    const unavailable = new IntegrationService({
      database,
      registry,
      secrets: {
        resolve: async () => {
          throw new Error("secret unavailable");
        },
      },
    });
    await expect(unavailable.providerContext("smartlead")).rejects.toThrow(
      "secret unavailable",
    );
    await expect(service.providerContext("smartlead")).resolves.toEqual(
      expect.objectContaining({ secret: "resolved-secret" }),
    );
    database.close();
  });
});
