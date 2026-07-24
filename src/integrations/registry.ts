import { EnvironmentSecretResolver, type SecretResolver } from "./secrets.js";
import {
  sha256Json,
  type IntegrationDatabase,
  type ProviderOperation,
} from "./database.js";
import type {
  ProviderAdapter,
  ProviderContext,
  IntegrationProviderId,
} from "./types.js";
import { ExternalOutcomeUnknownError } from "./errors.js";

export class IntegrationRegistry {
  readonly #adapters = new Map<IntegrationProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    const provider = adapter.descriptor.id;
    if (this.#adapters.has(provider)) {
      throw new Error(`Integration adapter ${provider} is already registered`);
    }
    this.#adapters.set(provider, adapter);
    return this;
  }

  get(provider: IntegrationProviderId): ProviderAdapter {
    const adapter = this.#adapters.get(provider);
    if (!adapter) {
      throw new Error(`Integration adapter ${provider} is not registered`);
    }
    return adapter;
  }

  list(): readonly ProviderAdapter[] {
    return [...this.#adapters.values()].sort((left, right) =>
      left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }
}

export const operationApprovalHash = (operation: ProviderOperation): string =>
  sha256Json({
    connectionId: operation.connectionId,
    campaignId: operation.campaignId ?? null,
    action: operation.action,
    idempotencyKey: operation.idempotencyKey,
    requestSha256: operation.requestSha256,
  });

export class IntegrationService {
  readonly #database: IntegrationDatabase;
  readonly #registry: IntegrationRegistry;
  readonly #secrets: SecretResolver;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    readonly database: IntegrationDatabase;
    readonly registry: IntegrationRegistry;
    readonly secrets?: SecretResolver;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#database = options.database;
    this.#registry = options.registry;
    this.#secrets = options.secrets ?? new EnvironmentSecretResolver();
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async providerContext(connectionId: string): Promise<ProviderContext> {
    const connection = this.#database.getConnection(connectionId);
    if (connection.status === "disabled") {
      throw new Error(`Integration connection ${connectionId} is disabled`);
    }
    const adapter = this.#registry.get(connection.provider);
    if (adapter.descriptor.category !== connection.category) {
      throw new Error(
        `Adapter ${connection.provider} category does not match its connection`,
      );
    }
    return {
      connection,
      secret: await this.#secrets.resolve(connection.secretRef),
      fetch: this.#fetch,
    };
  }

  async verifyConnection(connectionId: string): Promise<void> {
    const context = await this.providerContext(connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    try {
      const verification = await adapter.verifyConnection(context);
      this.#database.updateConnectionStatus({
        id: connectionId,
        status: verification.ok ? "verified" : "invalid",
        ...(verification.externalAccountId
          ? { externalAccountId: verification.externalAccountId }
          : {}),
        metadata: {
          ...context.connection.metadata,
          verificationMessage: verification.message,
          ...(verification.accountName
            ? { accountName: verification.accountName }
            : {}),
          ...(verification.metadata ?? {}),
        },
      });
      if (!verification.ok) {
        throw new Error(
          `${adapter.descriptor.displayName} verification failed: ${verification.message}`,
        );
      }
    } catch (error) {
      this.#database.updateConnectionStatus({
        id: connectionId,
        status: "invalid",
        metadata: {
          ...context.connection.metadata,
          verificationMessage:
            error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async discoverAccounts(connectionId: string): Promise<number> {
    const context = await this.providerContext(connectionId);
    const adapter = this.#registry.get(context.connection.provider);
    if (!adapter.descriptor.capabilities.accountDiscovery) {
      throw new Error(
        `${adapter.descriptor.displayName} does not support account discovery`,
      );
    }
    const accounts = await adapter.listAccounts(context);
    for (const account of accounts) {
      if (account.connectionId !== connectionId) {
        throw new Error(
          `Adapter ${adapter.descriptor.id} returned an account for another connection`,
        );
      }
    }
    this.#database.upsertAccounts(accounts);
    return accounts.length;
  }

  prepareOperation(input: {
    readonly connectionId: string;
    readonly campaignId?: string;
    readonly action: string;
    readonly idempotencyKey: string;
    readonly request: unknown;
  }): ProviderOperation {
    return this.#database.beginOperation(input);
  }

  approveOperation(input: {
    readonly operation: ProviderOperation;
    readonly scope: string;
    readonly approvedBy: string;
    readonly expiresAt?: string;
  }): string {
    return this.#database.recordApproval({
      operationSha256: operationApprovalHash(input.operation),
      scope: input.scope,
      approvedBy: input.approvedBy,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
  }

  async executeOperation<T>(input: {
    readonly operation: ProviderOperation;
    readonly approvalScope?: string;
    readonly execute: (context: ProviderContext) => Promise<T>;
    readonly externalId?: (result: T) => string | undefined;
  }): Promise<T> {
    const current = this.#database.getOperationByKey(
      input.operation.connectionId,
      input.operation.idempotencyKey,
    );
    if (
      current.id !== input.operation.id ||
      current.requestSha256 !== input.operation.requestSha256
    ) {
      throw new Error("Prepared operation changed before execution");
    }
    if (current.status === "succeeded") {
      return current.response as T;
    }
    if (current.status === "unknown") {
      throw new Error(
        `Operation ${current.idempotencyKey} has an unknown external outcome and requires reconciliation`,
      );
    }
    if (current.status !== "pending") {
      throw new Error(
        `Operation ${current.idempotencyKey} has status ${current.status}`,
      );
    }
    if (
      input.approvalScope &&
      !this.#database.hasValidApproval(
        operationApprovalHash(current),
        input.approvalScope,
      )
    ) {
      throw new Error(
        `Operation ${current.idempotencyKey} requires approval scope ${input.approvalScope}`,
      );
    }

    const context = await this.providerContext(current.connectionId);
    let result: T;
    try {
      result = await input.execute(context);
    } catch (error) {
      this.#database.completeOperation({
        id: current.id,
        status:
          error instanceof ExternalOutcomeUnknownError ? "unknown" : "failed",
        ...(error instanceof ExternalOutcomeUnknownError && error.externalId
          ? { externalId: error.externalId }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const externalId = input.externalId?.(result);
    try {
      this.#database.completeOperation({
        id: current.id,
        status: "succeeded",
        ...(externalId ? { externalId } : {}),
        response: result,
      });
      return result;
    } catch (error) {
      try {
        this.#database.completeOperation({
          id: current.id,
          status: "unknown",
          ...(externalId ? { externalId } : {}),
          error: `Provider call returned, but its result could not be recorded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      } catch {
        // The original persistence error remains the most useful failure.
      }
      throw new Error(
        `Provider call returned, but operation ${current.idempotencyKey} requires reconciliation before retry`,
        { cause: error },
      );
    }
  }
}
