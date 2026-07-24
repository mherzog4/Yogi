import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationDatabase,
  integrationDatabasePath,
} from "../src/integrations/database.js";
import { IntegrationRegistry } from "../src/integrations/registry.js";
import { OutboundIntegrationWorkflow } from "../src/integrations/outbound/workflow.js";
import type {
  OutboundDraftInput,
  OutboundProviderAdapter,
} from "../src/integrations/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const input = (approved = true): OutboundDraftInput => ({
  campaignId: "founder-launch",
  name: "Founder launch",
  batch: {
    schemaVersion: 1,
    id: "batch-1",
    mode: "send",
    approved,
    createdAt: "2026-07-24T12:00:00.000Z",
    policy: {
      dailyProspectLimit: 20,
      maxPerDomain: 2,
      requirePersonalization: true,
      allowRoleBasedAddresses: false,
    },
    selected: [
      {
        email: "founder@example.com",
        domain: "example.com",
        company: "Example",
        source: "research",
        personalization: "Relevant context",
        status: "prospect",
      },
    ],
    excluded: [],
  },
  subject: "A distribution idea",
  body: "Hello",
  senderAccountIds: ["sender-1"],
});

const setup = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "yogi-outbound-workflow-"));
  temporaryDirectories.push(cwd);
  const database = new IntegrationDatabase(integrationDatabasePath(cwd));
  database.createConnection({
    id: "connection-1",
    provider: "instantly",
    name: "Instantly",
    secretRef: "env:INSTANTLY_API_KEY",
  });
  const adapter: OutboundProviderAdapter = {
    descriptor: {
      id: "instantly",
      category: "outbound",
      displayName: "Instantly",
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
      message: "Connected",
    })),
    listAccounts: vi.fn(async () => []),
    createDraft: vi.fn(async () => ({
      externalCampaignId: "remote-1",
      externalStatus: "DRAFT",
    })),
    upsertProspects: vi.fn(async () => ({ accepted: 1, rejected: 0 })),
    activate: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    syncEvents: vi.fn(async () => ({ events: [] })),
  };
  const workflow = new OutboundIntegrationWorkflow({
    database,
    registry: new IntegrationRegistry().register(adapter),
    secrets: { resolve: async () => "secret" },
    fetch: vi.fn() as unknown as typeof fetch,
  });
  return { database, adapter, workflow };
};

describe("outbound integration workflow", () => {
  it("publishes once, stores the mapping, and replays safely", async () => {
    const { database, adapter, workflow } = await setup();
    const options = {
      connectionId: "connection-1",
      input: input(),
      approvedBy: "owner",
    };
    await expect(workflow.publishDraft(options)).resolves.toMatchObject({
      draft: { externalCampaignId: "remote-1" },
      prospects: { accepted: 1, rejected: 0 },
    });
    await expect(workflow.publishDraft(options)).resolves.toMatchObject({
      draft: { externalCampaignId: "remote-1" },
    });
    expect(adapter.createDraft).toHaveBeenCalledOnce();
    expect(adapter.upsertProspects).toHaveBeenCalledOnce();
    await expect(
      workflow.publishDraft({
        ...options,
        input: { ...input(), subject: "Changed after publishing" },
      }),
    ).rejects.toThrow("different provider draft");
    expect(
      database.getCampaignMapping("connection-1", "founder-launch"),
    ).toMatchObject({
      externalCampaignId: "remote-1",
      state: "draft-ready",
      metadata: {
        batchId: "batch-1",
        acceptedProspects: 1,
      },
    });

    await workflow.activate({
      connectionId: "connection-1",
      campaignId: "founder-launch",
      approvedBy: "owner",
    });
    expect(adapter.activate).toHaveBeenCalledOnce();
    expect(
      database.getCampaignMapping("connection-1", "founder-launch").state,
    ).toBe("active");

    await workflow.pause({
      connectionId: "connection-1",
      campaignId: "founder-launch",
    });
    expect(adapter.pause).toHaveBeenCalledOnce();
    expect(
      database.getCampaignMapping("connection-1", "founder-launch").state,
    ).toBe("paused");
    database.close();
  });

  it("rejects a batch without the send approval before resolving secrets", async () => {
    const { database, adapter, workflow } = await setup();
    await expect(
      workflow.publishDraft({
        connectionId: "connection-1",
        input: input(false),
        approvedBy: "owner",
      }),
    ).rejects.toThrow("send-ready outbound batch");
    expect(adapter.createDraft).not.toHaveBeenCalled();
    database.close();
  });
});
