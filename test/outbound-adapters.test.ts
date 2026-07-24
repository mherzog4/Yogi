import { describe, expect, it, vi } from "vitest";
import { EmailBisonAdapter } from "../src/integrations/outbound/emailbison.js";
import { InstantlyAdapter } from "../src/integrations/outbound/instantly.js";
import { SmartleadAdapter } from "../src/integrations/outbound/smartlead.js";
import type {
  OutboundDraftInput,
  ProviderContext,
} from "../src/integrations/types.js";

const response = (value?: unknown, status = 200): Response =>
  new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const queuedFetch = (...responses: readonly Response[]) => {
  const queue = [...responses];
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error("Unexpected provider request");
    return next;
  });
};

const context = (
  provider: "smartlead" | "instantly" | "emailbison",
  fetchMock: ReturnType<typeof queuedFetch>,
  metadata: Readonly<Record<string, unknown>> = {},
): ProviderContext => ({
  connection: {
    id: `${provider}-connection`,
    provider,
    category: "outbound",
    name: provider,
    secretRef: `env:${provider.toUpperCase()}_API_KEY`,
    status: "verified",
    metadata,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  },
  secret: "test-secret",
  fetch: fetchMock as unknown as typeof fetch,
});

const draftInput = (): OutboundDraftInput => ({
  campaignId: "founder-launch",
  name: "Founder launch",
  batch: {
    schemaVersion: 1,
    id: "batch-1",
    mode: "send",
    approved: true,
    createdAt: "2026-07-24T12:00:00.000Z",
    policy: {
      dailyProspectLimit: 20,
      maxPerDomain: 2,
      requirePersonalization: true,
      allowRoleBasedAddresses: false,
    },
    selected: [
      {
        email: "founder@example.com",
        domain: "example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        company: "Example",
        role: "Founder",
        source: "research",
        sourceUrl: "https://example.com",
        personalization: "Your launch stood out.",
        status: "prospect",
      },
    ],
    excluded: [],
  },
  subject: "A distribution idea",
  body: "Hi {{first_name}}, I have an idea.",
  followUps: [
    {
      subject: "Re: A distribution idea",
      body: "Worth exploring?",
      delayDays: 3,
    },
  ],
  senderAccountIds: ["101"],
  schedule: {
    timezone: "America/New_York",
    weekdays: [1, 2, 3, 4, 5],
    startHour: "09:00",
    endHour: "17:00",
  },
});

const requestBody = (fetchMock: ReturnType<typeof queuedFetch>, call: number) =>
  JSON.parse(
    String((fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.body),
  ) as unknown;

describe("Smartlead adapter", () => {
  it("discovers senders and builds a paused campaign lifecycle", async () => {
    const fetchMock = queuedFetch(
      response([
        {
          id: 101,
          from_name: "Founder",
          from_email: "founder@example.com",
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
        },
      ]),
      response({ ok: true, id: 9001 }),
      response({ ok: true }),
      response({ ok: true }),
      response({ ok: true }),
      response({ success: true, added_count: 1, skipped_count: 0 }),
      response({ success: true }),
      response({ success: true }),
      response({
        data: [
          {
            id: 1,
            status: "replied",
            created_at: "2026-07-24T13:00:00.000Z",
            email: "founder@example.com",
          },
        ],
      }),
    );
    const adapter = new SmartleadAdapter();
    const providerContext = context("smartlead", fetchMock);

    const accounts = await adapter.listAccounts(providerContext);
    expect(accounts[0]).toMatchObject({
      externalId: "101",
      name: "Founder",
    });
    const draft = await adapter.createDraft(
      providerContext,
      draftInput(),
      "draft-key",
    );
    expect(draft).toMatchObject({
      externalCampaignId: "9001",
      externalStatus: "DRAFTED",
    });
    expect(requestBody(fetchMock, 2)).toMatchObject({
      sequences: expect.arrayContaining([
        expect.objectContaining({
          seq_number: 1,
          subject: "A distribution idea",
        }),
      ]),
    });
    expect(requestBody(fetchMock, 3)).toEqual({
      email_account_ids: [101],
    });
    expect(requestBody(fetchMock, 4)).toMatchObject({
      max_new_leads_per_day: 20,
    });
    await expect(
      adapter.upsertProspects(
        providerContext,
        "9001",
        draftInput().batch.selected,
        "leads-key",
      ),
    ).resolves.toEqual({ accepted: 1, rejected: 0 });
    expect(requestBody(fetchMock, 5)).toMatchObject({
      settings: { ignore_global_block_list: false },
    });
    await adapter.activate(providerContext, "9001", "activate-key");
    await adapter.pause(providerContext, "9001", "pause-key");
    expect(requestBody(fetchMock, 6)).toEqual({ status: "START" });
    expect(requestBody(fetchMock, 7)).toEqual({ status: "PAUSED" });
    const synced = await adapter.syncEvents(providerContext, "9001");
    expect(synced.events[0]).toMatchObject({
      providerEventId: "1",
      type: "replied",
      externalCampaignId: "9001",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "api_key=test-secret",
    );
  });
});

describe("Instantly adapter", () => {
  it("uses API v2 bearer auth and normalizes sent and reply emails", async () => {
    const fetchMock = queuedFetch(
      response({
        items: [
          {
            email: "founder@example.com",
            first_name: "Ada",
            last_name: "Lovelace",
            organization: "workspace-1",
          },
        ],
      }),
      response({ id: "campaign-1", status: 0 }, 201),
      response({ leads_uploaded: 1, skipped_count: 0 }),
      response(),
      response(),
      response({
        items: [
          {
            id: "email-1",
            campaign_id: "campaign-1",
            timestamp_email: "2026-07-24T13:00:00.000Z",
            ue_type: 1,
            lead: "founder@example.com",
          },
          {
            id: "email-2",
            campaign_id: "campaign-1",
            timestamp_email: "2026-07-24T14:00:00.000Z",
            ue_type: 2,
            lead: "founder@example.com",
          },
        ],
        next_starting_after: "email-2",
      }),
    );
    const adapter = new InstantlyAdapter();
    const providerContext = context("instantly", fetchMock);
    expect(await adapter.listAccounts(providerContext)).toHaveLength(1);
    const draft = await adapter.createDraft(
      providerContext,
      draftInput(),
      "draft-key",
    );
    expect(draft.externalCampaignId).toBe("campaign-1");
    expect(requestBody(fetchMock, 1)).toMatchObject({
      name: "Founder launch",
      email_list: ["101"],
      stop_on_reply: true,
      open_tracking: false,
      sequences: [
        {
          steps: [
            { type: "email", delay: 3 },
            { type: "email", delay: 0 },
          ],
        },
      ],
    });
    await expect(
      adapter.upsertProspects(
        providerContext,
        "campaign-1",
        draftInput().batch.selected,
        "leads-key",
      ),
    ).resolves.toEqual({ accepted: 1, rejected: 0 });
    await adapter.activate(providerContext, "campaign-1", "activate-key");
    await adapter.pause(providerContext, "campaign-1", "pause-key");
    const synced = await adapter.syncEvents(providerContext, "campaign-1");
    expect(synced.events.map((event) => event.type)).toEqual([
      "sent",
      "replied",
    ]);
    expect(synced.nextCursor).toBe("email-2");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer test-secret");
    expect(
      String(fetchMock.mock.calls[3]?.[0]).endsWith(
        "/campaigns/campaign-1/activate",
      ),
    ).toBe(true);
  });
});

describe("EmailBison adapter", () => {
  it("supports a dedicated base URL and keeps drafts paused", async () => {
    const fetchMock = queuedFetch(
      response({
        data: {
          id: 7,
          name: "Ada",
          email: "ada@example.com",
          team: { id: 42, name: "Founder GTM" },
        },
      }),
      response({
        data: [
          {
            id: 101,
            name: "Founder",
            email: "founder@example.com",
            status: "Connected",
          },
        ],
        meta: { current_page: 1, last_page: 1 },
      }),
      response({ data: { id: 88, uuid: "campaign-uuid", status: "Draft" } }),
      response({ data: { id: 88, status: "Paused" } }),
      response({ data: { success: true } }),
      response({ success: true }),
      response({ data: { id: 88 } }),
      response({ data: { id: 1 } }),
      response({ data: [{ id: 501 }] }),
      response({ data: { success: true } }),
      response({ data: { id: 88, status: "Queued" } }),
      response({ data: { id: 88, status: "Paused" } }),
      response({
        data: [
          {
            id: 77,
            uuid: "event-77",
            created_at: "2026-07-24T15:00:00.000Z",
            payload: {
              event: { type: "LEAD_REPLIED", name: "Lead Replied" },
              data: {
                campaign: { id: 88 },
                lead: { email: "founder@example.com" },
              },
            },
          },
        ],
        meta: { next_cursor: "next-page" },
      }),
    );
    const adapter = new EmailBisonAdapter();
    const providerContext = context("emailbison", fetchMock, {
      baseUrl: "https://mail.example.com",
    });
    await expect(
      adapter.verifyConnection(providerContext),
    ).resolves.toMatchObject({
      externalAccountId: "42",
      accountName: "Founder GTM",
    });
    expect(await adapter.listAccounts(providerContext)).toHaveLength(1);
    const draft = await adapter.createDraft(
      providerContext,
      draftInput(),
      "draft-key",
    );
    expect(draft).toMatchObject({
      externalCampaignId: "88",
      externalStatus: "Paused",
    });
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
      "https://mail.example.com/api/campaigns/88/pause",
    );
    await expect(
      adapter.upsertProspects(
        providerContext,
        "88",
        draftInput().batch.selected,
        "leads-key",
      ),
    ).resolves.toEqual({ accepted: 1, rejected: 0 });
    expect(requestBody(fetchMock, 8)).toMatchObject({
      existing_lead_behavior: "patch",
    });
    expect(requestBody(fetchMock, 9)).toEqual({
      allow_parallel_sending: false,
      lead_ids: [501],
    });
    await adapter.activate(providerContext, "88", "activate-key");
    await adapter.pause(providerContext, "88", "pause-key");
    const synced = await adapter.syncEvents(providerContext, "88");
    expect(synced.events[0]).toMatchObject({
      providerEventId: "event-77",
      type: "replied",
      externalCampaignId: "88",
    });
    expect(synced.nextCursor).toBe("next-page");
  });

  it("rejects non-HTTPS custom base URLs before sending a request", async () => {
    const fetchMock = queuedFetch();
    await expect(
      new EmailBisonAdapter().verifyConnection(
        context("emailbison", fetchMock, {
          baseUrl: "http://mail.example.com",
        }),
      ),
    ).rejects.toThrow("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports provider-skipped leads without attaching an empty list", async () => {
    const fetchMock = queuedFetch(response({ data: [] }));
    const adapter = new EmailBisonAdapter();

    await expect(
      adapter.upsertProspects(
        context("emailbison", fetchMock, {
          baseUrl: "https://mail.example.com",
        }),
        "88",
        draftInput().batch.selected,
        "leads-key",
      ),
    ).resolves.toEqual({ accepted: 0, rejected: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody(fetchMock, 0)).toMatchObject({
      existing_lead_behavior: "patch",
    });
  });
});
