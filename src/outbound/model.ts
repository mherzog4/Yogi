import { randomUUID } from "node:crypto";

export type ProspectStatus =
  "prospect" | "contacted" | "replied" | "unsubscribed" | "bounced";

export interface Prospect {
  readonly email: string;
  readonly domain: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly company: string;
  readonly role?: string;
  readonly source: string;
  readonly sourceUrl?: string;
  readonly personalization?: string;
  readonly status: ProspectStatus;
}

export interface Suppression {
  readonly type: "email" | "domain";
  readonly value: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface OutboundPolicy {
  readonly dailyProspectLimit: number;
  readonly maxPerDomain: number;
  readonly requirePersonalization: boolean;
  readonly allowRoleBasedAddresses: boolean;
}

export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = {
  dailyProspectLimit: 20,
  maxPerDomain: 2,
  requirePersonalization: true,
  allowRoleBasedAddresses: false,
};

export type OutboundBatchMode = "draft" | "send";

export type ExclusionReason =
  | "invalid-status"
  | "suppressed-email"
  | "suppressed-domain"
  | "role-address"
  | "missing-personalization"
  | "domain-cap"
  | "daily-cap";

export interface ExcludedProspect {
  readonly prospect: Prospect;
  readonly reason: ExclusionReason;
}

export interface OutboundBatch {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mode: OutboundBatchMode;
  readonly approved: boolean;
  readonly createdAt: string;
  readonly policy: OutboundPolicy;
  readonly selected: readonly Prospect[];
  readonly excluded: readonly ExcludedProspect[];
}

export interface BuildOutboundBatchOptions {
  readonly prospects: readonly Prospect[];
  readonly suppressions?: readonly Suppression[];
  readonly policy?: Partial<OutboundPolicy>;
  readonly mode?: OutboundBatchMode;
  readonly approved?: boolean;
  readonly now?: Date;
  readonly id?: string;
}

const ROLE_ADDRESSES = new Set([
  "admin",
  "billing",
  "contact",
  "hello",
  "info",
  "marketing",
  "sales",
  "security",
  "support",
]);

const isRoleAddress = (email: string): boolean =>
  ROLE_ADDRESSES.has(email.split("@")[0]?.toLowerCase() ?? "");

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export const resolveOutboundPolicy = (
  input: Partial<OutboundPolicy> = {},
): OutboundPolicy => ({
  dailyProspectLimit: positiveInteger(
    input.dailyProspectLimit ?? DEFAULT_OUTBOUND_POLICY.dailyProspectLimit,
    "dailyProspectLimit",
  ),
  maxPerDomain: positiveInteger(
    input.maxPerDomain ?? DEFAULT_OUTBOUND_POLICY.maxPerDomain,
    "maxPerDomain",
  ),
  requirePersonalization:
    input.requirePersonalization ??
    DEFAULT_OUTBOUND_POLICY.requirePersonalization,
  allowRoleBasedAddresses:
    input.allowRoleBasedAddresses ??
    DEFAULT_OUTBOUND_POLICY.allowRoleBasedAddresses,
});

const batchId = (date: Date): string =>
  `${date.toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

export const buildOutboundBatch = (
  options: BuildOutboundBatchOptions,
): OutboundBatch => {
  const mode = options.mode ?? "draft";
  const approved = options.approved === true;
  if (mode === "send" && !approved) {
    throw new Error("Send-ready outbound batches require approved: true");
  }

  const policy = resolveOutboundPolicy(options.policy);
  const suppressedEmails = new Set(
    (options.suppressions ?? [])
      .filter(({ type }) => type === "email")
      .map(({ value }) => value.toLowerCase()),
  );
  const suppressedDomains = new Set(
    (options.suppressions ?? [])
      .filter(({ type }) => type === "domain")
      .map(({ value }) => value.toLowerCase()),
  );
  const domainCounts = new Map<string, number>();
  const selected: Prospect[] = [];
  const excluded: ExcludedProspect[] = [];

  const exclude = (prospect: Prospect, reason: ExclusionReason): void => {
    excluded.push({ prospect, reason });
  };

  for (const prospect of options.prospects) {
    const email = prospect.email.toLowerCase();
    const domain = prospect.domain.toLowerCase();

    if (prospect.status !== "prospect") {
      exclude(prospect, "invalid-status");
    } else if (suppressedEmails.has(email)) {
      exclude(prospect, "suppressed-email");
    } else if (suppressedDomains.has(domain)) {
      exclude(prospect, "suppressed-domain");
    } else if (!policy.allowRoleBasedAddresses && isRoleAddress(email)) {
      exclude(prospect, "role-address");
    } else if (
      policy.requirePersonalization &&
      !prospect.personalization?.trim()
    ) {
      exclude(prospect, "missing-personalization");
    } else if ((domainCounts.get(domain) ?? 0) >= policy.maxPerDomain) {
      exclude(prospect, "domain-cap");
    } else if (selected.length >= policy.dailyProspectLimit) {
      exclude(prospect, "daily-cap");
    } else {
      selected.push(prospect);
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
  }

  const now = options.now ?? new Date();
  return {
    schemaVersion: 1,
    id: options.id ?? batchId(now),
    mode,
    approved,
    createdAt: now.toISOString(),
    policy,
    selected,
    excluded,
  };
};
