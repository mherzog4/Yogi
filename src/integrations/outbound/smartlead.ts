import { requestProviderJson, providerBaseUrl } from "../http.js";
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
  partialMutation,
  prospectFields,
  stringFrom,
} from "./common.js";

const DEFAULT_BASE_URL = "https://server.smartlead.ai/api/v1";
const DISPLAY_NAME = "Smartlead";

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
    query: { ...options.query, api_key: context.secret },
    ...(options.body === undefined ? {} : { body: options.body }),
  });

const accountRows = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  const response = asRecord(value);
  return arrayFrom(response.data);
};

const listAllAccounts = async (
  context: ProviderContext,
): Promise<readonly Readonly<Record<string, unknown>>[]> => {
  const accounts: Readonly<Record<string, unknown>>[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = accountRows(
      await request<unknown>(context, {
        path: "/email-accounts/",
        query: { offset, limit: 100 },
      }),
    ).map((row) => asRecord(row, "Smartlead account must be an object"));
    accounts.push(...page);
    if (page.length < 100) return accounts;
  }
};

const sequencePayload = (input: OutboundDraftInput) => ({
  sequences: [
    {
      id: null,
      seq_number: 1,
      subject: input.subject,
      email_body: input.body,
      seq_delay_details: { delay_in_days: 0 },
    },
    ...(input.followUps ?? []).map((followUp, index) => ({
      id: null,
      seq_number: index + 2,
      subject: followUp.subject,
      email_body: followUp.body,
      seq_delay_details: { delay_in_days: followUp.delayDays },
    })),
  ],
});

const eventRows = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  const response = asRecord(value);
  return arrayFrom(response.data ?? response.results);
};

export class SmartleadAdapter implements OutboundProviderAdapter {
  readonly descriptor = {
    id: "smartlead",
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
    return {
      ok: true,
      externalAccountId: context.connection.externalAccountId ?? "default",
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
      const externalId = idFrom(account.id);
      if (!externalId) throw new Error("Smartlead account is missing id");
      const email =
        stringFrom(account.from_email) ?? stringFrom(account.username);
      return {
        connectionId: context.connection.id,
        externalId,
        name: stringFrom(account.from_name) ?? email ?? externalId,
        metadata: {
          ...(email ? { email } : {}),
          ...(stringFrom(account.type)
            ? { type: stringFrom(account.type) }
            : {}),
          smtpConnected: account.is_smtp_success === true,
          imapConnected: account.is_imap_success === true,
          ...(typeof account.message_per_day === "number"
            ? { dailyLimit: account.message_per_day }
            : {}),
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
    const senderAccountIds = input.senderAccountIds.map((id) => Number(id));
    if (senderAccountIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      throw new Error("Smartlead sender account IDs must be positive integers");
    }
    const created = asRecord(
      await request<unknown>(context, {
        path: "/campaigns/create",
        method: "POST",
        body: { name: input.name },
      }),
      "Smartlead create response must be an object",
    );
    const externalCampaignId = idFrom(created.id);
    if (!externalCampaignId) {
      throw new ExternalOutcomeUnknownError(
        "Smartlead created a campaign but returned no campaign id",
      );
    }
    try {
      await request(context, {
        path: `/campaigns/${externalCampaignId}/sequences`,
        method: "POST",
        body: sequencePayload(input),
      });
      await request(context, {
        path: `/campaigns/${externalCampaignId}/email-accounts`,
        method: "POST",
        body: {
          email_account_ids: senderAccountIds,
        },
      });
      if (input.schedule) {
        await request(context, {
          path: `/campaigns/${externalCampaignId}/schedule`,
          method: "POST",
          body: {
            timezone: input.schedule.timezone,
            days_of_the_week: input.schedule.weekdays,
            start_hour: input.schedule.startHour,
            end_hour: input.schedule.endHour,
            min_time_btw_emails: 10,
            max_new_leads_per_day: input.batch.policy.dailyProspectLimit,
          },
        });
      }
    } catch (error) {
      throw partialMutation(DISPLAY_NAME, externalCampaignId, error);
    }
    return {
      externalCampaignId,
      externalStatus: "DRAFTED",
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
    for (const page of chunks(prospects, 400)) {
      try {
        const upload = asRecord(
          await request(context, {
            path: `/campaigns/${externalCampaignId}/leads`,
            method: "POST",
            body: {
              lead_list: page.map((prospect) => {
                const fields = prospectFields(prospect);
                return {
                  email: fields.email,
                  ...(fields.firstName ? { first_name: fields.firstName } : {}),
                  ...(fields.lastName ? { last_name: fields.lastName } : {}),
                  company_name: fields.company,
                  ...(fields.sourceUrl
                    ? { company_url: fields.sourceUrl }
                    : {}),
                  custom_fields: {
                    ...(fields.role ? { job_title: fields.role } : {}),
                    ...(fields.personalization
                      ? { personalization: fields.personalization }
                      : {}),
                    yogi_source: prospect.source,
                  },
                };
              }),
              settings: {
                ignore_global_block_list: false,
                ignore_unsubscribe_list: false,
                ignore_duplicate_leads_in_other_campaign: false,
                return_lead_ids: true,
              },
            },
          }),
          "Smartlead lead response must be an object",
        );
        const pageAccepted = numberFrom(upload.added_count) ?? page.length;
        accepted += pageAccepted;
        rejected +=
          numberFrom(upload.skipped_count) ?? page.length - pageAccepted;
      } catch (error) {
        if (accepted > 0 || error instanceof ExternalOutcomeUnknownError) {
          throw partialMutation(DISPLAY_NAME, externalCampaignId, error);
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
      path: `/campaigns/${externalCampaignId}/status`,
      method: "POST",
      body: { status: "START" },
    });
  }

  async pause(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await request(context, {
      path: `/campaigns/${externalCampaignId}/status`,
      method: "POST",
      body: { status: "PAUSED" },
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
    const offset = Number(cursor ?? "0");
    const rows = eventRows(
      await request<unknown>(context, {
        path: `/campaigns/${externalCampaignId}/statistics`,
        query: {
          offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
          limit: 100,
        },
      }),
    );
    const events = rows
      .map((value, index) => {
        const row = asRecord(value, "Smartlead statistic must be an object");
        const providerType =
          stringFrom(row.event_type) ??
          stringFrom(row.email_status) ??
          stringFrom(row.status);
        const occurredAt =
          stringFrom(row.event_timestamp) ??
          stringFrom(row.sent_time) ??
          stringFrom(row.created_at);
        if (!providerType || !occurredAt) return undefined;
        return normalizeEvent({
          providerEventId:
            idFrom(row.id) ??
            `${externalCampaignId}:${offset + index}:${providerType}`,
          externalCampaignId,
          providerType,
          occurredAt,
          ...((stringFrom(row.lead_email) ?? stringFrom(row.email))
            ? {
                email:
                  stringFrom(row.lead_email) ?? stringFrom(row.email) ?? "",
              }
            : {}),
          metadata: {
            source: "campaign-statistics",
            sequence: row.email_sequence_number ?? null,
          },
        });
      })
      .filter((event): event is NormalizedOutboundEvent => event !== undefined);
    return {
      events,
      ...(rows.length === 100 ? { nextCursor: String(offset + 100) } : {}),
    };
  }
}
