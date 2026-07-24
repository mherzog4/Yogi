import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { assertSecretReference } from "./secrets.js";
import {
  integrationCategory,
  isIntegrationProviderId,
  type ConnectionStatus,
  type IntegrationProviderId,
  type NormalizedAdsMetrics,
  type ProviderAccount,
  type ProviderConnection,
} from "./types.js";

export const integrationDatabasePath = (cwd: string): string =>
  join(resolve(cwd), ".yogi", "private", "yogi.sqlite");

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('outbound', 'ads')),
        name TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        external_account_id TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('configured', 'verified', 'invalid', 'disabled')
        ),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE provider_accounts (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        currency TEXT,
        timezone TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, external_id)
      ) STRICT;

      CREATE TABLE campaign_mappings (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL,
        external_campaign_id TEXT NOT NULL,
        state TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (connection_id, campaign_id)
      ) STRICT;

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        campaign_id TEXT,
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'succeeded', 'failed', 'unknown')
        ),
        external_id TEXT,
        response_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (connection_id, idempotency_key)
      ) STRICT;

      CREATE TABLE sync_cursors (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, stream)
      ) STRICT;

      CREATE TABLE webhook_events (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        provider_event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('received', 'processed', 'failed')
        ),
        received_at TEXT NOT NULL,
        processed_at TEXT,
        error TEXT,
        UNIQUE (connection_id, provider_event_id)
      ) STRICT;

      CREATE TABLE metric_snapshots (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL,
        external_campaign_id TEXT NOT NULL,
        metric_date TEXT NOT NULL,
        impressions INTEGER NOT NULL,
        clicks INTEGER NOT NULL,
        spend_minor INTEGER NOT NULL,
        conversions REAL NOT NULL,
        currency TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        captured_at TEXT NOT NULL,
        UNIQUE (connection_id, external_campaign_id, metric_date)
      ) STRICT;

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        operation_sha256 TEXT NOT NULL,
        scope TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;

      CREATE INDEX idx_operations_campaign
        ON operations(campaign_id, created_at);
      CREATE INDEX idx_webhook_status
        ON webhook_events(status, received_at);
      CREATE INDEX idx_metrics_campaign
        ON metric_snapshots(campaign_id, metric_date);
      CREATE INDEX idx_approvals_operation
        ON approvals(operation_sha256, scope, approved_at);
    `,
  },
] as const;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

export const stableJson = (value: unknown): string => {
  const encoded = JSON.stringify(stableValue(value));
  if (encoded === undefined) {
    throw new Error("Value cannot be represented as JSON");
  }
  return encoded;
};

export const sha256Json = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const jsonObject = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Metadata must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
};

const parseJsonObject = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "string") return {};
  return jsonObject(JSON.parse(value) as unknown);
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

interface ConnectionRow {
  readonly id: string;
  readonly provider: string;
  readonly category: string;
  readonly name: string;
  readonly secret_ref: string;
  readonly external_account_id: string | null;
  readonly status: string;
  readonly metadata_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const connectionFromRow = (row: ConnectionRow): ProviderConnection => {
  if (!isIntegrationProviderId(row.provider)) {
    throw new Error(`Invalid provider in connection ${row.id}`);
  }
  if (row.category !== integrationCategory(row.provider)) {
    throw new Error(`Invalid category in connection ${row.id}`);
  }
  if (
    row.status !== "configured" &&
    row.status !== "verified" &&
    row.status !== "invalid" &&
    row.status !== "disabled"
  ) {
    throw new Error(`Invalid status in connection ${row.id}`);
  }
  return {
    id: row.id,
    provider: row.provider,
    category: integrationCategory(row.provider),
    name: row.name,
    secretRef: row.secret_ref,
    ...(row.external_account_id
      ? { externalAccountId: row.external_account_id }
      : {}),
    status: row.status,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export interface CampaignMapping {
  readonly id: string;
  readonly connectionId: string;
  readonly campaignId: string;
  readonly externalCampaignId: string;
  readonly state: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type OperationStatus = "pending" | "succeeded" | "failed" | "unknown";

export interface ProviderOperation {
  readonly id: string;
  readonly connectionId: string;
  readonly campaignId?: string;
  readonly action: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly status: OperationStatus;
  readonly externalId?: string;
  readonly response?: unknown;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface OperationRow {
  readonly id: string;
  readonly connection_id: string;
  readonly campaign_id: string | null;
  readonly action: string;
  readonly idempotency_key: string;
  readonly request_sha256: string;
  readonly status: OperationStatus;
  readonly external_id: string | null;
  readonly response_json: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const operationFromRow = (row: OperationRow): ProviderOperation => ({
  id: row.id,
  connectionId: row.connection_id,
  ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
  action: row.action,
  idempotencyKey: row.idempotency_key,
  requestSha256: row.request_sha256,
  status: row.status,
  ...(row.external_id ? { externalId: row.external_id } : {}),
  ...(row.response_json
    ? { response: JSON.parse(row.response_json) as unknown }
    : {}),
  ...(row.error ? { error: row.error } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class IntegrationDatabase {
  readonly path: string;
  readonly #database: Database.Database;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#database = new Database(this.path, { timeout: 5_000 });
    this.#configure();
    this.#migrate();
    this.#secureFiles();
  }

  #configure(): void {
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = NORMAL");
    this.#database.pragma("busy_timeout = 5000");
  }

  #secureFiles(): void {
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    const applied = new Set(
      (
        this.#database
          .prepare("SELECT version FROM schema_migrations")
          .all() as { version: number }[]
      ).map(({ version }) => Number(version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, new Date().toISOString());
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.#database.close();
  }

  journalMode(): string {
    const row = this.#database.prepare("PRAGMA journal_mode").get() as
      { journal_mode?: unknown } | undefined;
    return optionalString(row?.journal_mode) ?? "unknown";
  }

  integrityCheck(): string {
    const row = this.#database.prepare("PRAGMA quick_check").get() as
      { quick_check?: unknown } | undefined;
    return optionalString(row?.quick_check) ?? "unknown";
  }

  schemaVersion(): number {
    const row = this.#database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version?: unknown } | undefined;
    return Number(row?.version ?? 0);
  }

  async backup(destination: string): Promise<number> {
    const target = resolve(destination);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const result = await this.#database.backup(target);
    chmodSync(target, 0o600);
    return result.totalPages;
  }

  createConnection(input: {
    readonly provider: IntegrationProviderId;
    readonly name: string;
    readonly secretRef: string;
    readonly externalAccountId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly now?: Date;
    readonly id?: string;
  }): ProviderConnection {
    if (!isIntegrationProviderId(input.provider)) {
      throw new Error(
        `Unknown integration provider: ${String(input.provider)}`,
      );
    }
    const name = input.name.trim();
    if (!name) throw new Error("Connection name cannot be empty");
    const secretRef = assertSecretReference(input.secretRef);
    const timestamp = (input.now ?? new Date()).toISOString();
    const id = input.id ?? randomUUID();
    this.#database
      .prepare(
        `INSERT INTO connections(
          id, provider, category, name, secret_ref, external_account_id,
          status, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?)`,
      )
      .run(
        id,
        input.provider,
        integrationCategory(input.provider),
        name,
        secretRef,
        input.externalAccountId ?? null,
        stableJson(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.getConnection(id);
  }

  getConnection(id: string): ProviderConnection {
    const row = this.#database
      .prepare("SELECT * FROM connections WHERE id = ?")
      .get(id) as ConnectionRow | undefined;
    if (!row) throw new Error(`Integration connection ${id} was not found`);
    return connectionFromRow(row);
  }

  listConnections(): readonly ProviderConnection[] {
    return (
      this.#database
        .prepare("SELECT * FROM connections ORDER BY created_at, id")
        .all() as unknown as ConnectionRow[]
    ).map(connectionFromRow);
  }

  updateConnectionStatus(input: {
    readonly id: string;
    readonly status: ConnectionStatus;
    readonly externalAccountId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly now?: Date;
  }): ProviderConnection {
    if (
      input.status !== "configured" &&
      input.status !== "verified" &&
      input.status !== "invalid" &&
      input.status !== "disabled"
    ) {
      throw new Error(`Invalid connection status: ${String(input.status)}`);
    }
    const current = this.getConnection(input.id);
    this.#database
      .prepare(
        `UPDATE connections
         SET status = ?, external_account_id = ?, metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.externalAccountId ?? current.externalAccountId ?? null,
        stableJson(input.metadata ?? current.metadata),
        (input.now ?? new Date()).toISOString(),
        input.id,
      );
    return this.getConnection(input.id);
  }

  upsertAccounts(accounts: readonly ProviderAccount[]): void {
    if (accounts.length === 0) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.#database.prepare(
        `INSERT INTO provider_accounts(
          connection_id, external_id, name, currency, timezone,
          metadata_json, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, external_id) DO UPDATE SET
          name = excluded.name,
          currency = excluded.currency,
          timezone = excluded.timezone,
          metadata_json = excluded.metadata_json,
          synced_at = excluded.synced_at`,
      );
      for (const account of accounts) {
        statement.run(
          account.connectionId,
          account.externalId,
          account.name,
          account.currency ?? null,
          account.timezone ?? null,
          stableJson(account.metadata),
          account.syncedAt,
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listAccounts(connectionId: string): readonly ProviderAccount[] {
    const rows = this.#database
      .prepare(
        `SELECT connection_id, external_id, name, currency, timezone,
                metadata_json, synced_at
         FROM provider_accounts
         WHERE connection_id = ?
         ORDER BY name, external_id`,
      )
      .all(connectionId) as unknown as {
      connection_id: string;
      external_id: string;
      name: string;
      currency: string | null;
      timezone: string | null;
      metadata_json: string;
      synced_at: string;
    }[];
    return rows.map((row) => ({
      connectionId: row.connection_id,
      externalId: row.external_id,
      name: row.name,
      ...(row.currency ? { currency: row.currency } : {}),
      ...(row.timezone ? { timezone: row.timezone } : {}),
      metadata: parseJsonObject(row.metadata_json),
      syncedAt: row.synced_at,
    }));
  }

  upsertCampaignMapping(input: {
    readonly connectionId: string;
    readonly campaignId: string;
    readonly externalCampaignId: string;
    readonly state: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly now?: Date;
  }): CampaignMapping {
    const timestamp = (input.now ?? new Date()).toISOString();
    this.#database
      .prepare(
        `INSERT INTO campaign_mappings(
          id, connection_id, campaign_id, external_campaign_id, state,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, campaign_id) DO UPDATE SET
          external_campaign_id = excluded.external_campaign_id,
          state = excluded.state,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        input.connectionId,
        input.campaignId,
        input.externalCampaignId,
        input.state,
        stableJson(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.getCampaignMapping(input.connectionId, input.campaignId);
  }

  getCampaignMapping(
    connectionId: string,
    campaignId: string,
  ): CampaignMapping {
    const row = this.#database
      .prepare(
        `SELECT id, connection_id, campaign_id, external_campaign_id, state,
                metadata_json, created_at, updated_at
         FROM campaign_mappings
         WHERE connection_id = ? AND campaign_id = ?`,
      )
      .get(connectionId, campaignId) as
      | {
          id: string;
          connection_id: string;
          campaign_id: string;
          external_campaign_id: string;
          state: string;
          metadata_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      throw new Error(
        `No provider mapping for ${campaignId} on connection ${connectionId}`,
      );
    }
    return {
      id: row.id,
      connectionId: row.connection_id,
      campaignId: row.campaign_id,
      externalCampaignId: row.external_campaign_id,
      state: row.state,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  findCampaignMapping(
    connectionId: string,
    campaignId: string,
  ): CampaignMapping | undefined {
    try {
      return this.getCampaignMapping(connectionId, campaignId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("No provider mapping")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  beginOperation(input: {
    readonly connectionId: string;
    readonly campaignId?: string;
    readonly action: string;
    readonly idempotencyKey: string;
    readonly request: unknown;
    readonly now?: Date;
  }): ProviderOperation {
    const action = input.action.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!action || !idempotencyKey) {
      throw new Error("Operation action and idempotency key are required");
    }
    const requestSha256 = sha256Json(input.request);
    const timestamp = (input.now ?? new Date()).toISOString();
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO operations(
          id, connection_id, campaign_id, action, idempotency_key,
          request_sha256, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        randomUUID(),
        input.connectionId,
        input.campaignId ?? null,
        action,
        idempotencyKey,
        requestSha256,
        timestamp,
        timestamp,
      );
    const operation = this.getOperationByKey(
      input.connectionId,
      idempotencyKey,
    );
    if (
      operation.requestSha256 !== requestSha256 ||
      operation.action !== action ||
      operation.campaignId !== input.campaignId
    ) {
      throw new Error(
        `Idempotency key ${idempotencyKey} was already used for another operation`,
      );
    }
    return operation;
  }

  getOperationByKey(
    connectionId: string,
    idempotencyKey: string,
  ): ProviderOperation {
    const row = this.#database
      .prepare(
        "SELECT * FROM operations WHERE connection_id = ? AND idempotency_key = ?",
      )
      .get(connectionId, idempotencyKey) as OperationRow | undefined;
    if (!row) {
      throw new Error(`Operation ${idempotencyKey} was not found`);
    }
    return operationFromRow(row);
  }

  completeOperation(input: {
    readonly id: string;
    readonly status: Exclude<OperationStatus, "pending">;
    readonly externalId?: string;
    readonly response?: unknown;
    readonly error?: string;
    readonly now?: Date;
  }): ProviderOperation {
    this.#database
      .prepare(
        `UPDATE operations
         SET status = ?, external_id = ?, response_json = ?, error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.externalId ?? null,
        input.response === undefined ? null : stableJson(input.response),
        input.error ?? null,
        (input.now ?? new Date()).toISOString(),
        input.id,
      );
    const row = this.#database
      .prepare("SELECT * FROM operations WHERE id = ?")
      .get(input.id) as OperationRow | undefined;
    if (!row) throw new Error(`Operation ${input.id} was not found`);
    return operationFromRow(row);
  }

  setSyncCursor(input: {
    readonly connectionId: string;
    readonly stream: string;
    readonly cursor: string;
    readonly now?: Date;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO sync_cursors(connection_id, stream, cursor, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id, stream) DO UPDATE SET
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.connectionId,
        input.stream,
        input.cursor,
        (input.now ?? new Date()).toISOString(),
      );
  }

  getSyncCursor(connectionId: string, stream: string): string | undefined {
    const row = this.#database
      .prepare(
        "SELECT cursor FROM sync_cursors WHERE connection_id = ? AND stream = ?",
      )
      .get(connectionId, stream) as { cursor?: unknown } | undefined;
    return optionalString(row?.cursor);
  }

  claimWebhookEvent(input: {
    readonly connectionId: string;
    readonly providerEventId: string;
    readonly eventType: string;
    readonly payload: unknown;
    readonly now?: Date;
  }): boolean {
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO webhook_events(
          id, connection_id, provider_event_id, event_type, payload_sha256,
          status, received_at
        ) VALUES (?, ?, ?, ?, ?, 'received', ?)`,
      )
      .run(
        randomUUID(),
        input.connectionId,
        input.providerEventId,
        input.eventType,
        sha256Json(input.payload),
        (input.now ?? new Date()).toISOString(),
      );
    return Number(result.changes) === 1;
  }

  completeWebhookEvent(input: {
    readonly connectionId: string;
    readonly providerEventId: string;
    readonly status: "processed" | "failed";
    readonly error?: string;
    readonly now?: Date;
  }): void {
    this.#database
      .prepare(
        `UPDATE webhook_events
         SET status = ?, processed_at = ?, error = ?
         WHERE connection_id = ? AND provider_event_id = ?`,
      )
      .run(
        input.status,
        (input.now ?? new Date()).toISOString(),
        input.error ?? null,
        input.connectionId,
        input.providerEventId,
      );
  }

  upsertMetricSnapshot(input: {
    readonly connectionId: string;
    readonly campaignId: string;
    readonly externalCampaignId: string;
    readonly metrics: NormalizedAdsMetrics;
    readonly now?: Date;
  }): void {
    const metrics = input.metrics;
    for (const [name, value] of [
      ["impressions", metrics.impressions],
      ["clicks", metrics.clicks],
      ["spendMinor", metrics.spendMinor],
      ["conversions", metrics.conversions],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative finite number`);
      }
    }
    this.#database
      .prepare(
        `INSERT INTO metric_snapshots(
          id, connection_id, campaign_id, external_campaign_id, metric_date,
          impressions, clicks, spend_minor, conversions, currency,
          metadata_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, external_campaign_id, metric_date)
        DO UPDATE SET
          impressions = excluded.impressions,
          clicks = excluded.clicks,
          spend_minor = excluded.spend_minor,
          conversions = excluded.conversions,
          currency = excluded.currency,
          metadata_json = excluded.metadata_json,
          captured_at = excluded.captured_at`,
      )
      .run(
        randomUUID(),
        input.connectionId,
        input.campaignId,
        input.externalCampaignId,
        metrics.date,
        metrics.impressions,
        metrics.clicks,
        metrics.spendMinor,
        metrics.conversions,
        metrics.currency,
        stableJson(metrics.metadata ?? {}),
        (input.now ?? new Date()).toISOString(),
      );
  }

  listMetricSnapshots(
    connectionId: string,
    externalCampaignId: string,
  ): readonly NormalizedAdsMetrics[] {
    const rows = this.#database
      .prepare(
        `SELECT metric_date, impressions, clicks, spend_minor, conversions,
                currency, metadata_json
         FROM metric_snapshots
         WHERE connection_id = ? AND external_campaign_id = ?
         ORDER BY metric_date`,
      )
      .all(connectionId, externalCampaignId) as unknown as {
      metric_date: string;
      impressions: number;
      clicks: number;
      spend_minor: number;
      conversions: number;
      currency: string;
      metadata_json: string;
    }[];
    return rows.map((row) => ({
      date: row.metric_date,
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      spendMinor: Number(row.spend_minor),
      conversions: Number(row.conversions),
      currency: row.currency,
      metadata: parseJsonObject(row.metadata_json),
    }));
  }

  recordApproval(input: {
    readonly operationSha256: string;
    readonly scope: string;
    readonly approvedBy: string;
    readonly expiresAt?: string;
    readonly now?: Date;
  }): string {
    if (!/^[a-f0-9]{64}$/.test(input.operationSha256)) {
      throw new Error("Approval operation hash must be SHA-256");
    }
    if (!input.scope.trim() || !input.approvedBy.trim()) {
      throw new Error("Approval scope and approver are required");
    }
    const id = randomUUID();
    this.#database
      .prepare(
        `INSERT INTO approvals(
          id, operation_sha256, scope, approved_by, approved_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.operationSha256,
        input.scope,
        input.approvedBy,
        (input.now ?? new Date()).toISOString(),
        input.expiresAt ?? null,
      );
    return id;
  }

  hasValidApproval(
    operationSha256: string,
    scope: string,
    at: Date = new Date(),
  ): boolean {
    const row = this.#database
      .prepare(
        `SELECT id FROM approvals
         WHERE operation_sha256 = ? AND scope = ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY approved_at DESC
         LIMIT 1`,
      )
      .get(operationSha256, scope, at.toISOString());
    return row !== undefined;
  }
}

export const openIntegrationDatabase = (
  cwd: string = process.cwd(),
): IntegrationDatabase => new IntegrationDatabase(integrationDatabasePath(cwd));
