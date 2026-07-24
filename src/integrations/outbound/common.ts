import { createHash } from "node:crypto";
import { ExternalOutcomeUnknownError } from "../errors.js";
import type {
  NormalizedOutboundEvent,
  NormalizedOutboundEventType,
  OutboundDraftInput,
} from "../types.js";
import type { Prospect } from "../../outbound/model.js";

export const asRecord = (
  value: unknown,
  message = "Provider response must be an object",
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Readonly<Record<string, unknown>>;
};

export const arrayFrom = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

export const stringFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const idFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;

export const numberFrom = (value: unknown): number | undefined => {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || value.trim() === "")
  ) {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const emailHash = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export const chunks = <T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

export const ensureDraftInput = (input: OutboundDraftInput): void => {
  if (!input.name.trim()) throw new Error("Outbound campaign name is required");
  if (!input.subject.trim()) throw new Error("Outbound subject is required");
  if (!input.body.trim()) throw new Error("Outbound body is required");
  if (input.senderAccountIds.length === 0) {
    throw new Error("At least one sender account is required");
  }
  if (input.batch.selected.length === 0) {
    throw new Error("Outbound batch has no selected prospects");
  }
  if (new Set(input.senderAccountIds).size !== input.senderAccountIds.length) {
    throw new Error("Sender account IDs must be unique");
  }
  if (input.schedule) {
    if (!input.schedule.timezone.trim()) {
      throw new Error("Schedule timezone is required");
    }
    if (
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.schedule.startHour) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.schedule.endHour)
    ) {
      throw new Error("Schedule hours must use 24-hour HH:MM format");
    }
    if (
      input.schedule.weekdays.length === 0 ||
      input.schedule.weekdays.some(
        (day) => !Number.isSafeInteger(day) || day < 0 || day > 6,
      ) ||
      new Set(input.schedule.weekdays).size !== input.schedule.weekdays.length
    ) {
      throw new Error(
        "Schedule weekdays must be unique numbers from 0 through 6",
      );
    }
  }
  for (const followUp of input.followUps ?? []) {
    if (!followUp.subject.trim() || !followUp.body.trim()) {
      throw new Error("Follow-up subject and body are required");
    }
    if (!Number.isSafeInteger(followUp.delayDays) || followUp.delayDays < 1) {
      throw new Error("Follow-up delayDays must be a positive integer");
    }
  }
};

export const prospectFields = (
  prospect: Prospect,
): Readonly<Record<string, unknown>> => ({
  email: prospect.email,
  ...(prospect.firstName ? { firstName: prospect.firstName } : {}),
  ...(prospect.lastName ? { lastName: prospect.lastName } : {}),
  company: prospect.company,
  ...(prospect.role ? { role: prospect.role } : {}),
  ...(prospect.sourceUrl ? { sourceUrl: prospect.sourceUrl } : {}),
  ...(prospect.personalization
    ? { personalization: prospect.personalization }
    : {}),
});

export const partialMutation = (
  provider: string,
  externalId: string,
  error: unknown,
): ExternalOutcomeUnknownError =>
  error instanceof ExternalOutcomeUnknownError &&
  error.externalId === externalId
    ? error
    : new ExternalOutcomeUnknownError(
        `${provider} draft ${externalId} was created but not fully configured`,
        { cause: error, externalId },
      );

const EVENT_TYPES: Readonly<Record<string, NormalizedOutboundEventType>> = {
  email_sent: "sent",
  sent: "sent",
  email_opened: "opened",
  opened: "opened",
  email_link_clicked: "clicked",
  clicked: "clicked",
  lead_replied: "replied",
  reply_received: "replied",
  replied: "replied",
  email_bounced: "bounced",
  bounced: "bounced",
  lead_unsubscribed: "unsubscribed",
  unsubscribed: "unsubscribed",
};

export const normalizeEvent = (input: {
  readonly providerEventId: string;
  readonly externalCampaignId: string;
  readonly providerType: string;
  readonly occurredAt: string;
  readonly email?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): NormalizedOutboundEvent | undefined => {
  const type = EVENT_TYPES[input.providerType.toLowerCase()];
  if (!type) return undefined;
  return {
    providerEventId: input.providerEventId,
    externalCampaignId: input.externalCampaignId,
    type,
    occurredAt: input.occurredAt,
    ...(input.email ? { prospectEmailHash: emailHash(input.email) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
};
