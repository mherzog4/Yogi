import { sha256Json, type IntegrationDatabase } from "../database.js";
import { IntegrationService, type IntegrationRegistry } from "../registry.js";
import type { SecretResolver } from "../secrets.js";
import {
  isAdsAdapter,
  type AdsDraftInput,
  type AdsDraftResult,
  type NormalizedAdsMetrics,
} from "../types.js";
import { adsDraftRequestSha256, ensureAdsDraftInput } from "./common.js";

const paidMappingId = (campaignId: string, experimentId: string): string =>
  `${campaignId}:paid:${experimentId}`;

const attemptNumber = (value: number | undefined): number => {
  const attempt = value ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Operation attempt must be a positive integer");
  }
  return attempt;
};

export class PaidAdsIntegrationWorkflow {
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

  async publishDraft(options: {
    readonly connectionId: string;
    readonly input: AdsDraftInput;
    readonly approvedBy: string;
    readonly attempt?: number;
  }): Promise<AdsDraftResult> {
    ensureAdsDraftInput(options.input);
    const approvedBy = options.approvedBy.trim();
    if (!approvedBy) throw new Error("approvedBy is required");
    const attempt = attemptNumber(options.attempt);
    const requestSha256 = adsDraftRequestSha256(options.input);
    const mappingId = paidMappingId(
      options.input.campaignId,
      options.input.experiment.id,
    );
    const connection = this.#database.getConnection(options.connectionId);
    if (connection.status !== "verified") {
      throw new Error(
        `Ad connection ${options.connectionId} must be verified before publishing`,
      );
    }
    if (connection.externalAccountId !== options.input.externalAccountId) {
      throw new Error(
        "Paid draft account does not match the verified connection",
      );
    }
    if (connection.metadata.currency !== options.input.experiment.currency) {
      throw new Error(
        `Experiment currency ${options.input.experiment.currency} does not match the verified ad account`,
      );
    }
    const context = await this.#service.providerContext(options.connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    if (!isAdsAdapter(adapter)) {
      throw new Error(`${context.connection.provider} is not an ads provider`);
    }
    const existing = this.#database.findCampaignMapping(
      options.connectionId,
      mappingId,
    );
    if (existing) {
      if (existing.metadata.draftRequestSha256 !== requestSha256) {
        throw new Error(
          `Campaign ${options.input.campaignId} is already mapped to a different paid draft`,
        );
      }
      if (existing.state === "active") {
        throw new Error(
          `Campaign ${options.input.campaignId} is active; pause it before publishing again`,
        );
      }
      return {
        externalCampaignId: existing.externalCampaignId,
        ...(typeof existing.metadata.externalBudgetId === "string"
          ? { externalBudgetId: existing.metadata.externalBudgetId }
          : {}),
        externalStatus: existing.state,
        metadata: existing.metadata,
      };
    }

    const operation = this.#service.prepareOperation({
      connectionId: options.connectionId,
      campaignId: mappingId,
      action: "ads:create-draft",
      idempotencyKey: `${options.input.campaignId}:ads-create-draft:${options.input.experiment.id}:v${attempt}`,
      request: options.input,
    });
    this.#service.approveOperation({
      operation,
      scope: "ads:publish-draft",
      approvedBy,
    });
    const draft = await this.#service.executeOperation({
      operation,
      approvalScope: "ads:publish-draft",
      execute: (providerContext) =>
        adapter.createDraft(
          providerContext,
          options.input,
          operation.idempotencyKey,
        ),
      externalId: (result) => result.externalCampaignId,
    });
    this.#database.upsertCampaignMapping({
      connectionId: options.connectionId,
      campaignId: mappingId,
      externalCampaignId: draft.externalCampaignId,
      state: "draft-ready",
      metadata: {
        ...(draft.metadata ?? {}),
        ...(draft.externalBudgetId
          ? { externalBudgetId: draft.externalBudgetId }
          : {}),
        experimentId: options.input.experiment.id,
        campaignId: options.input.campaignId,
        currency: options.input.experiment.currency,
        dailyBudgetMinor: options.input.experiment.dailyBudgetMinor,
        totalBudgetMinor: options.input.experiment.totalBudgetMinor,
        stopLossSpendMinor: options.input.experiment.stopLossSpendMinor,
        readinessSha256: sha256Json(options.input.readiness),
        draftRequestSha256: requestSha256,
      },
    });
    return draft;
  }

  async activate(options: {
    readonly connectionId: string;
    readonly campaignId: string;
    readonly experimentId: string;
    readonly approvedBy: string;
    readonly attempt?: number;
  }): Promise<void> {
    const approvedBy = options.approvedBy.trim();
    if (!approvedBy) throw new Error("approvedBy is required");
    const mapping = this.#database.getCampaignMapping(
      options.connectionId,
      paidMappingId(options.campaignId, options.experimentId),
    );
    if (
      mapping.state !== "draft-ready" &&
      mapping.state !== "paused" &&
      mapping.state !== "active"
    ) {
      throw new Error(
        `Paid campaign ${options.campaignId} is not ready to activate`,
      );
    }
    this.#assertWithinSpendLimits(options.connectionId, mapping);
    const context = await this.#service.providerContext(options.connectionId);
    if (context.connection.status !== "verified") {
      throw new Error(
        `Ad connection ${options.connectionId} must be verified before activation`,
      );
    }
    const adapter = this.#registry.get(context.connection.provider);
    if (!isAdsAdapter(adapter)) {
      throw new Error(`${context.connection.provider} is not an ads provider`);
    }
    const operation = this.#service.prepareOperation({
      connectionId: options.connectionId,
      campaignId: paidMappingId(options.campaignId, options.experimentId),
      action: "ads:activate",
      idempotencyKey: `${options.campaignId}:${options.experimentId}:ads-activate:${mapping.externalCampaignId}:v${attemptNumber(options.attempt)}`,
      request: {
        externalCampaignId: mapping.externalCampaignId,
        metadata: mapping.metadata,
      },
    });
    this.#service.approveOperation({
      operation,
      scope: "ads:activate",
      approvedBy,
    });
    await this.#service.executeOperation({
      operation,
      approvalScope: "ads:activate",
      execute: (providerContext) =>
        adapter.activate(
          providerContext,
          mapping.externalCampaignId,
          operation.idempotencyKey,
          mapping.metadata,
        ),
    });
    this.#database.upsertCampaignMapping({
      connectionId: options.connectionId,
      campaignId: paidMappingId(options.campaignId, options.experimentId),
      externalCampaignId: mapping.externalCampaignId,
      state: "active",
      metadata: mapping.metadata,
    });
  }

  async pause(options: {
    readonly connectionId: string;
    readonly campaignId: string;
    readonly experimentId: string;
    readonly attempt?: number;
  }): Promise<void> {
    const mapping = this.#database.getCampaignMapping(
      options.connectionId,
      paidMappingId(options.campaignId, options.experimentId),
    );
    const context = await this.#service.providerContext(options.connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    if (!isAdsAdapter(adapter)) {
      throw new Error(`${context.connection.provider} is not an ads provider`);
    }
    const operation = this.#service.prepareOperation({
      connectionId: options.connectionId,
      campaignId: paidMappingId(options.campaignId, options.experimentId),
      action: "ads:pause",
      idempotencyKey: `${options.campaignId}:${options.experimentId}:ads-pause:${mapping.externalCampaignId}:v${attemptNumber(options.attempt)}`,
      request: {
        externalCampaignId: mapping.externalCampaignId,
        metadata: mapping.metadata,
      },
    });
    await this.#service.executeOperation({
      operation,
      execute: (providerContext) =>
        adapter.pause(
          providerContext,
          mapping.externalCampaignId,
          operation.idempotencyKey,
          mapping.metadata,
        ),
    });
    this.#database.upsertCampaignMapping({
      connectionId: options.connectionId,
      campaignId: paidMappingId(options.campaignId, options.experimentId),
      externalCampaignId: mapping.externalCampaignId,
      state: "paused",
      metadata: mapping.metadata,
    });
  }

  async syncMetrics(options: {
    readonly connectionId: string;
    readonly campaignId: string;
    readonly experimentId: string;
    readonly since: string;
  }): Promise<{
    readonly metrics: readonly NormalizedAdsMetrics[];
    readonly autoPaused: boolean;
  }> {
    const mapping = this.#database.getCampaignMapping(
      options.connectionId,
      paidMappingId(options.campaignId, options.experimentId),
    );
    const context = await this.#service.providerContext(options.connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    if (!isAdsAdapter(adapter)) {
      throw new Error(`${context.connection.provider} is not an ads provider`);
    }
    const metrics = await adapter.syncMetrics(
      context,
      mapping.externalCampaignId,
      options.since,
    );
    const currency = this.#metadataNumberOrString(mapping.metadata, "currency");
    for (const row of metrics) {
      if (row.currency !== currency) {
        throw new Error(
          `Provider metrics currency ${row.currency} does not match ${currency}`,
        );
      }
      this.#database.upsertMetricSnapshot({
        connectionId: options.connectionId,
        campaignId: options.campaignId,
        externalCampaignId: mapping.externalCampaignId,
        metrics: row,
      });
    }
    let autoPaused = false;
    try {
      this.#assertWithinSpendLimits(options.connectionId, mapping);
    } catch (error) {
      if (mapping.state === "active") {
        const operation = this.#service.prepareOperation({
          connectionId: options.connectionId,
          campaignId: paidMappingId(options.campaignId, options.experimentId),
          action: "ads:auto-pause",
          idempotencyKey: `${options.campaignId}:${options.experimentId}:ads-auto-pause:${mapping.externalCampaignId}:${sha256Json(
            {
              since: options.since,
              reason: error instanceof Error ? error.message : String(error),
            },
          ).slice(0, 12)}`,
          request: {
            externalCampaignId: mapping.externalCampaignId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
        await this.#service.executeOperation({
          operation,
          execute: (providerContext) =>
            adapter.pause(
              providerContext,
              mapping.externalCampaignId,
              operation.idempotencyKey,
              mapping.metadata,
            ),
        });
        this.#database.upsertCampaignMapping({
          connectionId: options.connectionId,
          campaignId: paidMappingId(options.campaignId, options.experimentId),
          externalCampaignId: mapping.externalCampaignId,
          state: "paused",
          metadata: {
            ...mapping.metadata,
            autoPauseReason:
              error instanceof Error ? error.message : String(error),
          },
        });
        autoPaused = true;
      }
    }
    return { metrics, autoPaused };
  }

  #assertWithinSpendLimits(
    connectionId: string,
    mapping: {
      readonly externalCampaignId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    },
  ): void {
    const snapshots = this.#database.listMetricSnapshots(
      connectionId,
      mapping.externalCampaignId,
    );
    const spend = snapshots.reduce((sum, row) => sum + row.spendMinor, 0);
    const conversions = snapshots.reduce(
      (sum, row) => sum + row.conversions,
      0,
    );
    const totalBudget = this.#metadataNumber(
      mapping.metadata,
      "totalBudgetMinor",
    );
    const stopLoss = this.#metadataNumber(
      mapping.metadata,
      "stopLossSpendMinor",
    );
    if (spend >= totalBudget) {
      throw new Error(
        `Spend ${spend} reached total budget ${totalBudget}; activation is blocked`,
      );
    }
    if (conversions === 0 && spend >= stopLoss) {
      throw new Error(
        `Spend ${spend} reached the no-conversion stop-loss ${stopLoss}`,
      );
    }
  }

  #metadataNumber(
    metadata: Readonly<Record<string, unknown>>,
    key: string,
  ): number {
    const value = metadata[key];
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
      throw new Error(`Paid campaign mapping is missing ${key}`);
    }
    return Number(value);
  }

  #metadataNumberOrString(
    metadata: Readonly<Record<string, unknown>>,
    key: string,
  ): string {
    const value = metadata[key];
    if (typeof value !== "string" || !value) {
      throw new Error(`Paid campaign mapping is missing ${key}`);
    }
    return value;
  }
}
