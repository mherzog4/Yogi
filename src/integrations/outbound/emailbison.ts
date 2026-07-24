import { ExternalOutcomeUnknownError, ProviderHttpError } from "../errors.js";
import { providerBaseUrl, requestProviderJson } from "../http.js";
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
  partialMutation,
  stringFrom,
} from "./common.js";

const DEFAULT_BASE_URL = "https://dedi.emailbison.com";
const DISPLAY_NAME = "EmailBison";

const request = <T>(
  context: ProviderContext,
  options: {
    readonly path: string;
    readonly method?: "GET" | "POST" | "PATCH";
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

const dataRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  const response = asRecord(value);
  return asRecord(response.data, "EmailBison response data must be an object");
};

const paginated = (
  value: unknown,
): {
  readonly data: readonly Readonly<Record<string, unknown>>[];
  readonly currentPage: number;
  readonly lastPage: number;
  readonly nextCursor?: string;
} => {
  const response = asRecord(value);
  const meta =
    typeof response.meta === "object" &&
    response.meta !== null &&
    !Array.isArray(response.meta)
      ? asRecord(response.meta)
      : {};
  const nextCursor = stringFrom(meta.next_cursor);
  return {
    data: arrayFrom(response.data).map((item) =>
      asRecord(item, "EmailBison list item must be an object"),
    ),
    currentPage: typeof meta.current_page === "number" ? meta.current_page : 1,
    lastPage: typeof meta.last_page === "number" ? meta.last_page : 1,
    ...(nextCursor ? { nextCursor } : {}),
  };
};

const listAllAccounts = async (
  context: ProviderContext,
): Promise<readonly Readonly<Record<string, unknown>>[]> => {
  const accounts: Readonly<Record<string, unknown>>[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = paginated(
      await request(context, {
        path: "/api/sender-emails",
        query: { page: pageNumber },
      }),
    );
    accounts.push(...page.data);
    if (page.currentPage >= page.lastPage) return accounts;
  }
};

const extractLeadIds = (value: unknown): readonly string[] => {
  const response = asRecord(value);
  if (!Array.isArray(response.data)) {
    throw new ExternalOutcomeUnknownError(
      "EmailBison lead response did not include a data array",
    );
  }
  return response.data.map((lead) => {
    const id = idFrom(asRecord(lead, "EmailBison lead must be an object").id);
    if (!id) {
      throw new ExternalOutcomeUnknownError(
        "EmailBison lead response included a record without an id",
      );
    }
    return id;
  });
};

const eventCampaignId = (
  event: Readonly<Record<string, unknown>>,
): string | undefined => {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? asRecord(event.payload)
      : {};
  const data =
    typeof payload.data === "object" && payload.data !== null
      ? asRecord(payload.data)
      : {};
  const campaign =
    typeof data.campaign === "object" && data.campaign !== null
      ? asRecord(data.campaign)
      : {};
  return (
    idFrom(campaign.id) ??
    idFrom(campaign.uuid) ??
    idFrom(data.campaign_id) ??
    idFrom(payload.campaign_id)
  );
};

export class EmailBisonAdapter implements OutboundProviderAdapter {
  readonly descriptor = {
    id: "emailbison",
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
    const user = dataRecord(await request(context, { path: "/api/users" }));
    const team =
      typeof user.team === "object" && user.team !== null
        ? asRecord(user.team)
        : {};
    return {
      ok: true,
      externalAccountId:
        context.connection.externalAccountId ??
        idFrom(team.id) ??
        idFrom(user.id) ??
        "default",
      accountName:
        stringFrom(team.name) ??
        stringFrom(user.name) ??
        context.connection.name,
      message: "Connected",
      metadata: {
        ...(stringFrom(user.email)
          ? { userEmail: stringFrom(user.email) }
          : {}),
        baseUrl: providerBaseUrl(context, DEFAULT_BASE_URL),
      },
    };
  }

  async listAccounts(
    context: ProviderContext,
  ): Promise<readonly ProviderAccount[]> {
    const syncedAt = new Date().toISOString();
    return (await listAllAccounts(context)).map((account) => {
      const externalId = idFrom(account.id);
      if (!externalId) throw new Error("EmailBison account is missing id");
      const email = stringFrom(account.email);
      return {
        connectionId: context.connection.id,
        externalId,
        name: stringFrom(account.name) ?? email ?? externalId,
        metadata: {
          ...(email ? { email } : {}),
          ...(stringFrom(account.status)
            ? { status: stringFrom(account.status) }
            : {}),
          ...(stringFrom(account.type)
            ? { type: stringFrom(account.type) }
            : {}),
          warmupEnabled: account.warmup_enabled === true,
          ...(typeof account.daily_limit === "number"
            ? { dailyLimit: account.daily_limit }
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
    const senderAccountIds = input.senderAccountIds.map(Number);
    if (senderAccountIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      throw new Error(
        "EmailBison sender account IDs must be positive integers",
      );
    }
    const created = dataRecord(
      await request(context, {
        path: "/api/campaigns",
        method: "POST",
        body: { name: input.name, type: "outbound" },
      }),
    );
    const externalCampaignId = idFrom(created.id);
    if (!externalCampaignId) {
      throw new ExternalOutcomeUnknownError(
        "EmailBison created a campaign but returned no campaign id",
      );
    }
    try {
      await request(context, {
        path: `/api/campaigns/${externalCampaignId}/pause`,
        method: "PATCH",
      });
      await request(context, {
        path: `/api/campaigns/${externalCampaignId}/sequence-steps`,
        method: "POST",
        body: {
          title: input.name,
          sequence_steps: [
            {
              email_subject: input.subject,
              order: 1,
              email_body: input.body,
              wait_in_days: 0,
              variant: false,
              thread_reply: false,
            },
            ...(input.followUps ?? []).map((followUp, index) => ({
              email_subject: followUp.subject,
              order: index + 2,
              email_body: followUp.body,
              wait_in_days: followUp.delayDays,
              variant: false,
              thread_reply: true,
            })),
          ],
        },
      });
      await request(context, {
        path: `/api/campaigns/${externalCampaignId}/attach-sender-emails`,
        method: "POST",
        body: { sender_email_ids: senderAccountIds },
      });
      await request(context, {
        path: `/api/campaigns/${externalCampaignId}/update`,
        method: "PATCH",
        body: {
          max_emails_per_day: input.batch.policy.dailyProspectLimit,
          max_new_leads_per_day: input.batch.policy.dailyProspectLimit,
          plain_text: true,
          open_tracking: false,
          can_unsubscribe: true,
          sequence_prioritization: "new_leads",
        },
      });
      if (input.schedule) {
        const days = new Set(input.schedule.weekdays);
        await request(context, {
          path: `/api/campaigns/${externalCampaignId}/schedule`,
          method: "POST",
          body: {
            monday: days.has(1),
            tuesday: days.has(2),
            wednesday: days.has(3),
            thursday: days.has(4),
            friday: days.has(5),
            saturday: days.has(6),
            sunday: days.has(0),
            start_time: input.schedule.startHour,
            end_time: input.schedule.endHour,
            timezone: input.schedule.timezone,
            save_as_template: false,
          },
        });
      }
    } catch (error) {
      throw partialMutation(DISPLAY_NAME, externalCampaignId, error);
    }
    return {
      externalCampaignId,
      externalStatus: "Paused",
      metadata: {
        uuid: idFrom(created.uuid) ?? null,
        senderAccountCount: input.senderAccountIds.length,
      },
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
    for (const page of chunks(prospects, 500)) {
      let response: unknown;
      try {
        response = await request(context, {
          path: "/api/leads/create-or-update/multiple",
          method: "POST",
          body: {
            existing_lead_behavior: "patch",
            leads: page.map((prospect) => ({
              first_name: prospect.firstName ?? "there",
              ...(prospect.lastName ? { last_name: prospect.lastName } : {}),
              email: prospect.email,
              ...(prospect.role ? { title: prospect.role } : {}),
              company: prospect.company,
              notes: prospect.personalization ?? "",
              custom_variables: [
                { name: "yogi_source", value: prospect.source },
                ...(prospect.sourceUrl
                  ? [{ name: "source_url", value: prospect.sourceUrl }]
                  : []),
              ],
            })),
          },
        });
      } catch (error) {
        if (
          accepted > 0 ||
          error instanceof ExternalOutcomeUnknownError ||
          (error instanceof ProviderHttpError && error.status === undefined)
        ) {
          throw partialMutation(DISPLAY_NAME, externalCampaignId, error);
        }
        throw error;
      }
      const leadIds = extractLeadIds(response);
      if (leadIds.length > 0) {
        try {
          await request(context, {
            path: `/api/campaigns/${externalCampaignId}/leads/attach-leads`,
            method: "POST",
            body: {
              allow_parallel_sending: false,
              lead_ids: leadIds.map(Number),
            },
          });
        } catch (error) {
          throw partialMutation(DISPLAY_NAME, externalCampaignId, error);
        }
      }
      accepted += leadIds.length;
      rejected += page.length - leadIds.length;
    }
    return { accepted, rejected };
  }

  async activate(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await request(context, {
      path: `/api/campaigns/${externalCampaignId}/resume`,
      method: "PATCH",
    });
  }

  async pause(
    context: ProviderContext,
    externalCampaignId: string,
    _idempotencyKey: string,
  ): Promise<void> {
    await request(context, {
      path: `/api/campaigns/${externalCampaignId}/pause`,
      method: "PATCH",
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
    const page = paginated(
      await request(context, {
        path: "/api/events",
        query: { ...(cursor ? { cursor } : {}) },
      }),
    );
    const events = page.data
      .filter((event) => eventCampaignId(event) === externalCampaignId)
      .map((event) => {
        const payload =
          typeof event.payload === "object" && event.payload !== null
            ? asRecord(event.payload)
            : {};
        const eventDescriptor =
          typeof payload.event === "object" && payload.event !== null
            ? asRecord(payload.event)
            : {};
        const data =
          typeof payload.data === "object" && payload.data !== null
            ? asRecord(payload.data)
            : {};
        const lead =
          typeof data.lead === "object" && data.lead !== null
            ? asRecord(data.lead)
            : {};
        const providerType =
          stringFrom(eventDescriptor.type) ?? stringFrom(payload.type);
        const providerEventId = idFrom(event.uuid) ?? idFrom(event.id);
        const occurredAt =
          stringFrom(event.created_at) ??
          stringFrom(payload.timestamp) ??
          stringFrom(data.created_at);
        if (!providerType || !providerEventId || !occurredAt) return undefined;
        const leadEmail = stringFrom(lead.email);
        return normalizeEvent({
          providerEventId,
          externalCampaignId,
          providerType,
          occurredAt,
          ...(leadEmail ? { email: leadEmail } : {}),
          metadata: {
            source: "events",
            eventName: stringFrom(eventDescriptor.name) ?? null,
          },
        });
      })
      .filter((event): event is NormalizedOutboundEvent => event !== undefined);
    return {
      events,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}
