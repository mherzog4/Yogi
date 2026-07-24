import { sha256Json, type IntegrationDatabase } from "../database.js";
import { IntegrationService, type IntegrationRegistry } from "../registry.js";
import type { SecretResolver } from "../secrets.js";
import {
  isOutboundAdapter,
  type OutboundDraftInput,
  type OutboundDraftResult,
  type ProspectUpsertResult,
} from "../types.js";

export interface PublishOutboundDraftOptions {
  readonly connectionId: string;
  readonly input: OutboundDraftInput;
  readonly approvedBy: string;
  readonly attempt?: number;
}

export interface PublishOutboundDraftResult {
  readonly draft: OutboundDraftResult;
  readonly prospects: ProspectUpsertResult;
}

const attemptNumber = (value: number | undefined): number => {
  const attempt = value ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Operation attempt must be a positive integer");
  }
  return attempt;
};

export class OutboundIntegrationWorkflow {
  readonly #database: IntegrationDatabase;
  readonly #registry: IntegrationRegistry;
  readonly #service: IntegrationService;

  constructor(options: {
    readonly database: IntegrationDatabase;
    readonly registry: IntegrationRegistry;
    readonly secrets?: SecretResolver;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#database = options.database;
    this.#registry = options.registry;
    this.#service = new IntegrationService(options);
  }

  async publishDraft(
    options: PublishOutboundDraftOptions,
  ): Promise<PublishOutboundDraftResult> {
    if (options.input.batch.mode !== "send" || !options.input.batch.approved) {
      throw new Error(
        "Publishing requires a send-ready outbound batch with explicit approval",
      );
    }
    const approvedBy = options.approvedBy.trim();
    if (!approvedBy) throw new Error("approvedBy is required");
    const attempt = attemptNumber(options.attempt);
    const draftRequestSha256 = sha256Json(options.input);
    const context = await this.#service.providerContext(options.connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    if (!isOutboundAdapter(adapter)) {
      throw new Error(
        `${context.connection.provider} is not an outbound provider`,
      );
    }

    const existing = this.#database.findCampaignMapping(
      options.connectionId,
      options.input.campaignId,
    );
    if (
      existing &&
      existing.metadata.draftRequestSha256 !== draftRequestSha256
    ) {
      throw new Error(
        `Campaign ${options.input.campaignId} is already mapped to a different provider draft`,
      );
    }
    if (existing?.state === "active") {
      throw new Error(
        `Campaign ${options.input.campaignId} is active; pause it before publishing again`,
      );
    }
    let draft: OutboundDraftResult;
    if (existing) {
      draft = {
        externalCampaignId: existing.externalCampaignId,
        externalStatus: existing.state,
        metadata: existing.metadata,
      };
    } else {
      const createOperation = this.#service.prepareOperation({
        connectionId: options.connectionId,
        campaignId: options.input.campaignId,
        action: "outbound:create-draft",
        idempotencyKey: `${options.input.campaignId}:create-draft:${options.input.batch.id}:v${attempt}`,
        request: options.input,
      });
      this.#service.approveOperation({
        operation: createOperation,
        scope: "outbound:publish",
        approvedBy,
      });
      draft = await this.#service.executeOperation({
        operation: createOperation,
        approvalScope: "outbound:publish",
        execute: (providerContext) =>
          adapter.createDraft(
            providerContext,
            options.input,
            createOperation.idempotencyKey,
          ),
        externalId: (result) => result.externalCampaignId,
      });
      this.#database.upsertCampaignMapping({
        connectionId: options.connectionId,
        campaignId: options.input.campaignId,
        externalCampaignId: draft.externalCampaignId,
        state: draft.externalStatus,
        metadata: {
          ...(draft.metadata ?? {}),
          batchId: options.input.batch.id,
          draftRequestSha256,
        },
      });
    }

    const prospectOperation = this.#service.prepareOperation({
      connectionId: options.connectionId,
      campaignId: options.input.campaignId,
      action: "outbound:upsert-prospects",
      idempotencyKey: `${options.input.campaignId}:upsert-prospects:${options.input.batch.id}:v${attempt}`,
      request: {
        externalCampaignId: draft.externalCampaignId,
        prospects: options.input.batch.selected,
      },
    });
    this.#service.approveOperation({
      operation: prospectOperation,
      scope: "outbound:publish",
      approvedBy,
    });
    const prospects = await this.#service.executeOperation({
      operation: prospectOperation,
      approvalScope: "outbound:publish",
      execute: (providerContext) =>
        adapter.upsertProspects(
          providerContext,
          draft.externalCampaignId,
          options.input.batch.selected,
          prospectOperation.idempotencyKey,
        ),
    });
    this.#database.upsertCampaignMapping({
      connectionId: options.connectionId,
      campaignId: options.input.campaignId,
      externalCampaignId: draft.externalCampaignId,
      state: existing?.state === "paused" ? "paused" : "draft-ready",
      metadata: {
        ...(draft.metadata ?? {}),
        batchId: options.input.batch.id,
        acceptedProspects: prospects.accepted,
        rejectedProspects: prospects.rejected,
        draftRequestSha256,
      },
    });
    return { draft, prospects };
  }

  async activate(options: {
    readonly connectionId: string;
    readonly campaignId: string;
    readonly approvedBy: string;
    readonly attempt?: number;
  }): Promise<void> {
    const approvedBy = options.approvedBy.trim();
    if (!approvedBy) throw new Error("approvedBy is required");
    const mapping = this.#database.getCampaignMapping(
      options.connectionId,
      options.campaignId,
    );
    if (
      mapping.state !== "draft-ready" &&
      mapping.state !== "paused" &&
      mapping.state !== "active"
    ) {
      throw new Error(
        `Campaign ${options.campaignId} is not ready to activate (state: ${mapping.state})`,
      );
    }
    const context = await this.#service.providerContext(options.connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    if (!isOutboundAdapter(adapter)) {
      throw new Error(
        `${context.connection.provider} is not an outbound provider`,
      );
    }
    const operation = this.#service.prepareOperation({
      connectionId: options.connectionId,
      campaignId: options.campaignId,
      action: "outbound:activate",
      idempotencyKey: `${options.campaignId}:activate:${mapping.externalCampaignId}:v${attemptNumber(options.attempt)}`,
      request: { externalCampaignId: mapping.externalCampaignId },
    });
    this.#service.approveOperation({
      operation,
      scope: "outbound:activate",
      approvedBy,
    });
    await this.#service.executeOperation({
      operation,
      approvalScope: "outbound:activate",
      execute: (providerContext) =>
        adapter.activate(
          providerContext,
          mapping.externalCampaignId,
          operation.idempotencyKey,
        ),
    });
    this.#database.upsertCampaignMapping({
      connectionId: options.connectionId,
      campaignId: options.campaignId,
      externalCampaignId: mapping.externalCampaignId,
      state: "active",
      metadata: mapping.metadata,
    });
  }

  async pause(options: {
    readonly connectionId: string;
    readonly campaignId: string;
    readonly attempt?: number;
  }): Promise<void> {
    const mapping = this.#database.getCampaignMapping(
      options.connectionId,
      options.campaignId,
    );
    const context = await this.#service.providerContext(options.connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    if (!isOutboundAdapter(adapter)) {
      throw new Error(
        `${context.connection.provider} is not an outbound provider`,
      );
    }
    const operation = this.#service.prepareOperation({
      connectionId: options.connectionId,
      campaignId: options.campaignId,
      action: "outbound:pause",
      idempotencyKey: `${options.campaignId}:pause:${mapping.externalCampaignId}:v${attemptNumber(options.attempt)}`,
      request: { externalCampaignId: mapping.externalCampaignId },
    });
    await this.#service.executeOperation({
      operation,
      execute: (providerContext) =>
        adapter.pause(
          providerContext,
          mapping.externalCampaignId,
          operation.idempotencyKey,
        ),
    });
    this.#database.upsertCampaignMapping({
      connectionId: options.connectionId,
      campaignId: options.campaignId,
      externalCampaignId: mapping.externalCampaignId,
      state: "paused",
      metadata: mapping.metadata,
    });
  }

  async syncEvents(options: {
    readonly connectionId: string;
    readonly campaignId: string;
  }): Promise<{
    readonly received: number;
    readonly inserted: number;
    readonly nextCursor?: string;
  }> {
    const mapping = this.#database.getCampaignMapping(
      options.connectionId,
      options.campaignId,
    );
    const context = await this.#service.providerContext(options.connectionId);
    if (context.connection.status !== "verified") {
      throw new Error(
        `Outbound connection ${options.connectionId} must be verified before synchronization`,
      );
    }
    const adapter = this.#registry.get(context.connection.provider);
    if (!isOutboundAdapter(adapter)) {
      throw new Error(
        `${context.connection.provider} is not an outbound provider`,
      );
    }
    const stream = `outbound:${mapping.externalCampaignId}:events`;
    const cursor = this.#database.getSyncCursor(options.connectionId, stream);
    const result = await adapter.syncEvents(
      context,
      mapping.externalCampaignId,
      cursor,
    );
    if (
      result.events.some(
        (event) => event.externalCampaignId !== mapping.externalCampaignId,
      )
    ) {
      throw new Error("Provider returned an event for another campaign");
    }
    const inserted = this.#database.storeOutboundEvents({
      connectionId: options.connectionId,
      campaignId: options.campaignId,
      events: result.events,
    });
    if (result.nextCursor) {
      this.#database.setSyncCursor({
        connectionId: options.connectionId,
        stream,
        cursor: result.nextCursor,
      });
    }
    return {
      received: result.events.length,
      inserted,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }
}
