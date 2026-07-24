import { providerBaseUrl, requestProviderJson } from "../http.js";
import { ExternalOutcomeUnknownError } from "../errors.js";
import type {
  ConnectionVerification,
  NormalizedOutboundEvent,
  OutboundDraftInput,
  OutboundDraftResult,
  OutboundProviderAdapter,
  ProspectUpsertResult,
  ProviderAccount,
  ProviderContext,
} from "../types.js";
import {
  arrayFrom,
  asRecord,
  chunks,
  ensureDraftInput,
  idFrom,
  normalizeEvent,
  numberFrom,
  stringFrom,
} from "./common.js";

const DEFAULT_BASE_URL = "https://api.instantly.ai/api/v2";
const DISPLAY_NAME = "Instantly";

const request = <T>(
  context: ProviderContext,
  options: {
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    readonly body?: unknown;
  },
): Promise<T> =>
  requestProviderJson<T>(context, {
    provider: DISPLAY_NAME,
    baseUrl: providerBaseUrl(context, DEFAULT_BASE_URL),
    path: options.path,
    ...(options.method ? { method: options.method } : {}),
    ...(options.query ? { query: options.query } : {}),
    headers: { authorization: `Bearer ${context.secret}` },
    ...(options.body === undefined ? {} : { body: options.body }),
  });

const listPage = (
  value: unknown,
): {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly next?: string;
} => {
  const response = asRecord(value);
  const next = stringFrom(response.next_starting_after);
  return {
    items: arrayFrom(response.items).map((item) =>
      asRecord(item, "Instantly list item must be an object"),
    ),
    ...(next ? { next } : {}),
  };
};

const listAllAccounts = async (
  context: ProviderContext,
): Promise<readonly Readonly<Record<string, unknown>>[]> => {
  const accounts: Readonly<Record<string, unknown>>[] = [];
  let cursor: string | undefined;
  do {
    const page = listPage(
      await request(context, {
        path: "/accounts",
        query: { limit: 100, ...(cursor ? { starting_after: cursor } : {}) },
      }),
    );
    accounts.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return accounts;
};

const campaignPayload = (input: OutboundDraftInput) => {
  const weekdays = new Set(input.schedule?.weekdays ?? [1, 2, 3, 4, 5]);
  const messages = [
    { subject: input.subject, body: input.body },
    ...(input.followUps ?? []).map((followUp) => ({
      subject: followUp.subject,
      body: followUp.body,
    })),
  ];
  const steps = messages.map((message, index) => ({
    type: "email",
    delay: input.followUps?.[index]?.delayDays ?? 0,
    delay_unit: "days",
    variants: [
      {
        subject: message.subject,
        body: message.body,
        v_disabled: false,
      },
    ],
  }));
  return {
    name: input.name,
    sequences: [{ steps }],
    email_list: input.senderAccountIds,
    daily_max_leads: input.batch.policy.dailyProspectLimit,
    daily_limit: input.batch.policy.dailyProspectLimit,
    stop_on_reply: true,
    stop_on_auto_reply: false,
    text_only: true,
    open_tracking: false,
    link_tracking: false,
    insert_unsubscribe_header: true,
    campaign_schedule: {
      schedules: [
        {
          name: "Yogi schedule",
          timing: {
            from: input.schedule?.startHour ?? "09:00",
            to: input.schedule?.endHour ?? "17:00",
          },
          days: Object.fromEntries(
            Array.from({ length: 7 }, (_, day) => [
              String(day),
              weekdays.has(day),
            ]),
          ),
          timezone: input.schedule?.timezone ?? "America/New_York",
        },
      ],
    },
  };
};

export class InstantlyAdapter implements OutboundProviderAdapter {
  readonly descriptor = {
    id: "instantly",
    category: "outbound",
    displayName: DISPLAY_NAME,
    capabilities: {
      createDraft: true,
      activate: true,
      pause: true,
      webhooks: true,
      polling: true,
      accountDiscovery: true,
    },
  } as const;

  async verifyConnection(
    context: ProviderContext,
  ): Promise<ConnectionVerification> {
    const accounts = await listAllAccounts(context);
    const organization = accounts
      .map((account) => stringFrom(account.organization))
      .find(Boolean);
    return {
      ok: true,
      externalAccountId:
        context.connection.externalAccountId ?? organization ?? "default",
      accountName: context.connection.name,
      message: `Connected; ${accounts.length} sender account${accounts.length === 1 ? "" : "s"} visible`,
      metadata: { senderAccountCount: accounts.length },
    };
  }

  async listAccounts(
    context: ProviderContext,
  ): Promise<readonly ProviderAccount[]> {
    const syncedAt = new Date().toISOString();
    return (await listAllAccounts(context)).map((account) => {
      const email = stringFrom(account.email);
      if (!email) throw new Error("Instantly account is missing email");
      const fullName = [
        stringFrom(account.first_name),
        stringFrom(account.last_name),
      ]
        .filter(Boolean)
        .join(" ");
      return {
        connectionId: context.connection.id,
        externalId: email,
        name: fullName || email,
        metadata: {
          email,
          warmupStatus: account.warmup_status ?? null,
          providerCode: account.provider_code ?? null,
          setupPending: account.setup_pending === true,
        },
        syncedAt,
      };
    });
  }

  async createDraft(
    context: ProviderContext,
    input: OutboundDraftInput,
    _idempotencyKey: string,
  ): Promise<OutboundDraftResult> {
    ensureDraftInput(input);
    const response = asRecord(
      await request(context, {
        path: "/campaigns",
        method: "POST",
        body: campaignPayload(input),
      }),
      "Instantly create response must be an object",
    );
    const externalCampaignId = idFrom(response.id);
    if (!externalCampaignId) {
      throw new ExternalOutcomeUnknownError(
        "Instantly created a campaign but returned no campaign id",
      );
    }
    return {
      externalCampaignId,
      externalStatus: "DRAFT",
      metadata: { senderAccountCount: input.senderAccountIds.length },
    };
  }

  async upsertProspects(
    context: ProviderContext,
    externalCampaignId: string,
    prospects: Parameters<OutboundProviderAdapter["upsertProspects"]>[2],
    _idempotencyKey: string,
  ): Promise<ProspectUpsertResult> {
    let accepted = 0;
    let rejected = 0;
    for (const page of chunks(prospects, 1_000)) {
      try {
        const upload = asRecord(
          await request(context, {
            path: "/leads/add",
            method: "POST",
            body: {
              campaign_id: externalCampaignId,
              skip_if_in_workspace: true,
              leads: page.map((prospect) => ({
                email: prospect.email,
                ...(prospect.firstName
                  ? { first_name: prospect.firstName }
                  : {}),
                ...(prospect.lastName ? { last_name: prospect.lastName } : {}),
                company_name: prospect.company,
                ...(prospect.role ? { job_title: prospect.role } : {}),
                ...(prospect.personalization
                  ? { personalization: prospect.personalization }
                  : {}),
                custom_variables: {
                  yogi_source: prospect.source,
                  ...(prospect.sourceUrl
                    ? { source_url: prospect.sourceUrl }
                    : {}),
                },
              })),
            },
          }),
          "Instantly lead response must be an object",
        );
        const pageAccepted = numberFrom(upload.leads_uploaded) ?? page.length;
        accepted += pageAccepted;
        rejected += page.length - pageAccepted;
      } catch (error) {
        if (accepted > 0 || error instanceof ExternalOutcomeUnknownError) {
          throw new ExternalOutcomeUnknownError(
            `Instantly prospect upload for ${externalCampaignId} is incomplete`,
            { cause: error, externalId: externalCampaignId },
          );
        }
        throw error;
      }
    }
    return { accepted, rejected };
  }

  async activate(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await request(context, {
      path: `/campaigns/${externalCampaignId}/activate`,
      method: "POST",
    });
  }

  async pause(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await request(context, {
      path: `/campaigns/${externalCampaignId}/pause`,
      method: "POST",
    });
  }

  async syncEvents(
    context: ProviderContext,
    externalCampaignId: string,
    cursor?: string,
  ): Promise<{
    readonly events: readonly NormalizedOutboundEvent[];
    readonly nextCursor?: string;
  }> {
    const page = listPage(
      await request(context, {
        path: "/emails",
        query: {
          limit: 100,
          campaign_id: externalCampaignId,
          sort_order: "asc",
          ...(cursor ? { starting_after: cursor } : {}),
        },
      }),
    );
    const events = page.items
      .map((email) => {
        const providerEventId = idFrom(email.id);
        const occurredAt =
          stringFrom(email.timestamp_email) ??
          stringFrom(email.timestamp_created);
        const emailType =
          email.ue_type === 1 || email.ue_type === 3
            ? "sent"
            : email.ue_type === 2
              ? "replied"
              : undefined;
        if (!providerEventId || !occurredAt || !emailType) return undefined;
        const leadEmail = stringFrom(email.lead);
        return normalizeEvent({
          providerEventId,
          externalCampaignId,
          providerType: emailType,
          occurredAt,
          ...(leadEmail ? { email: leadEmail } : {}),
          metadata: {
            source: "email-list",
            messageId: stringFrom(email.message_id) ?? null,
          },
        });
      })
      .filter((event): event is NormalizedOutboundEvent => event !== undefined);
    return { events, ...(page.next ? { nextCursor: page.next } : {}) };
  }
}
