import type { AdCreativeSet, PaidExperiment } from "../paid/model.js";
import type { OutboundBatch, Prospect } from "../outbound/model.js";

export type OutboundProviderId = "smartlead" | "instantly" | "emailbison";
export type AdsProviderId =
  "google-ads" | "linkedin-ads" | "tiktok-ads" | "meta-ads";
export type IntegrationProviderId = OutboundProviderId | AdsProviderId;
export type IntegrationCategory = "outbound" | "ads";

export const INTEGRATION_PROVIDERS = [
  "smartlead",
  "instantly",
  "emailbison",
  "google-ads",
  "linkedin-ads",
  "tiktok-ads",
  "meta-ads",
] as const satisfies readonly IntegrationProviderId[];

export const isIntegrationProviderId = (
  value: unknown,
): value is IntegrationProviderId =>
  typeof value === "string" &&
  (INTEGRATION_PROVIDERS as readonly string[]).includes(value);

export const integrationCategory = (
  provider: IntegrationProviderId,
): IntegrationCategory =>
  provider === "smartlead" ||
  provider === "instantly" ||
  provider === "emailbison"
    ? "outbound"
    : "ads";

export type ConnectionStatus =
  "configured" | "verified" | "invalid" | "disabled";

export interface ProviderConnection {
  readonly id: string;
  readonly provider: IntegrationProviderId;
  readonly category: IntegrationCategory;
  readonly name: string;
  readonly secretRef: string;
  readonly externalAccountId?: string;
  readonly status: ConnectionStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderAccount {
  readonly connectionId: string;
  readonly externalId: string;
  readonly name: string;
  readonly currency?: string;
  readonly timezone?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly syncedAt: string;
}

export interface ProviderCapabilities {
  readonly createDraft: boolean;
  readonly activate: boolean;
  readonly pause: boolean;
  readonly webhooks: boolean;
  readonly polling: boolean;
  readonly accountDiscovery: boolean;
}

export interface ProviderDescriptor {
  readonly id: IntegrationProviderId;
  readonly category: IntegrationCategory;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
}

export interface ProviderContext {
  readonly connection: ProviderConnection;
  readonly secret: string;
  readonly fetch: typeof globalThis.fetch;
}

export interface ConnectionVerification {
  readonly ok: boolean;
  readonly externalAccountId?: string;
  readonly accountName?: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  verifyConnection(context: ProviderContext): Promise<ConnectionVerification>;
  listAccounts(context: ProviderContext): Promise<readonly ProviderAccount[]>;
}

export interface OutboundDraftInput {
  readonly campaignId: string;
  readonly name: string;
  readonly batch: OutboundBatch;
  readonly subject: string;
  readonly body: string;
  readonly followUps?: readonly {
    readonly subject: string;
    readonly body: string;
    readonly delayDays: number;
  }[];
  readonly senderAccountIds: readonly string[];
  readonly schedule?: {
    readonly timezone: string;
    readonly weekdays: readonly number[];
    readonly startHour: string;
    readonly endHour: string;
  };
}

export interface OutboundDraftResult {
  readonly externalCampaignId: string;
  readonly externalStatus: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProspectUpsertResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type NormalizedOutboundEventType =
  "sent" | "opened" | "clicked" | "replied" | "bounced" | "unsubscribed";

export interface NormalizedOutboundEvent {
  readonly providerEventId: string;
  readonly externalCampaignId: string;
  readonly type: NormalizedOutboundEventType;
  readonly occurredAt: string;
  readonly prospectEmailHash?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OutboundProviderAdapter extends ProviderAdapter {
  readonly descriptor: ProviderDescriptor & { readonly category: "outbound" };
  createDraft(
    context: ProviderContext,
    input: OutboundDraftInput,
    idempotencyKey: string,
  ): Promise<OutboundDraftResult>;
  upsertProspects(
    context: ProviderContext,
    externalCampaignId: string,
    prospects: readonly Prospect[],
    idempotencyKey: string,
  ): Promise<ProspectUpsertResult>;
  activate(
    context: ProviderContext,
    externalCampaignId: string,
    idempotencyKey: string,
  ): Promise<void>;
  pause(
    context: ProviderContext,
    externalCampaignId: string,
    idempotencyKey: string,
  ): Promise<void>;
  syncEvents(
    context: ProviderContext,
    externalCampaignId: string,
    cursor?: string,
  ): Promise<{
    readonly events: readonly NormalizedOutboundEvent[];
    readonly nextCursor?: string;
  }>;
}

export interface AdsDraftInput {
  readonly campaignId: string;
  readonly experiment: PaidExperiment;
  readonly creative: AdCreativeSet;
  readonly externalAccountId: string;
}

export interface AdsDraftResult {
  readonly externalCampaignId: string;
  readonly externalBudgetId?: string;
  readonly externalStatus: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface NormalizedAdsMetrics {
  readonly date: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly spendMinor: number;
  readonly conversions: number;
  readonly currency: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AdsProviderAdapter extends ProviderAdapter {
  readonly descriptor: ProviderDescriptor & { readonly category: "ads" };
  createDraft(
    context: ProviderContext,
    input: AdsDraftInput,
    idempotencyKey: string,
  ): Promise<AdsDraftResult>;
  activate(
    context: ProviderContext,
    externalCampaignId: string,
    idempotencyKey: string,
  ): Promise<void>;
  pause(
    context: ProviderContext,
    externalCampaignId: string,
    idempotencyKey: string,
  ): Promise<void>;
  syncMetrics(
    context: ProviderContext,
    externalCampaignId: string,
    since: string,
  ): Promise<readonly NormalizedAdsMetrics[]>;
}

export const isOutboundAdapter = (
  adapter: ProviderAdapter,
): adapter is OutboundProviderAdapter =>
  adapter.descriptor.category === "outbound";

export const isAdsAdapter = (
  adapter: ProviderAdapter,
): adapter is AdsProviderAdapter => adapter.descriptor.category === "ads";
