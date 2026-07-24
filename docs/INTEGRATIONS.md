# Provider integrations and private state

Yogi separates reviewable campaign intent from mutable provider state:

| State                                                           | Location                           | Versioned |
| --------------------------------------------------------------- | ---------------------------------- | --------- |
| Briefs, creative, policies, approvals, aggregate reports        | `campaigns/`                       | Yes       |
| Connections, external IDs, operations, cursors, events, metrics | `.yogi/private/yogi.sqlite`        | No        |
| API keys and OAuth credentials                                  | Secret resolver such as `env:NAME` | No        |

`yogi init` creates the private SQLite database automatically. Existing
workspaces can initialize it explicitly:

```bash
yogi integrations init
yogi integrations status
```

The database uses WAL mode, foreign keys, a five-second busy timeout,
transactional migrations, and mode-`600` files on POSIX systems. Backups use
SQLite's online backup API:

```bash
yogi integrations backup .yogi/private/backups/yogi.sqlite
```

## Configure a connection

List the supported provider IDs:

```bash
yogi integrations providers
```

Create a connection using a secret reference:

```bash
export SMARTLEAD_API_KEY="..."

yogi integrations connect smartlead \
  --name "Founder outbound" \
  --secret-ref env:SMARTLEAD_API_KEY

yogi integrations verify <connection-id>
yogi integrations accounts <connection-id>
```

Yogi stores `env:SMARTLEAD_API_KEY`, not its value. Environment variable names
must use uppercase letters, digits, and underscores.

Current provider IDs:

- outbound: `smartlead`, `instantly`, `emailbison`;
- ads: `google-ads`, `linkedin-ads`, `tiktok-ads`, `meta-ads`.

The secret resolver is injectable. Environment references are the built-in
local implementation; a hosted control plane can provide an OS-keychain or
cloud-secret-manager resolver without changing adapters or database rows.

EmailBison supports dedicated and white-label installations. Store the
non-secret HTTPS API origin on the connection:

```bash
yogi integrations connect emailbison \
  --name "Agency workspace" \
  --secret-ref env:EMAILBISON_API_KEY \
  --base-url https://mail.example.com
```

Outbound adapters currently implement connection verification, sender
discovery, paused campaign creation, sequence and schedule configuration,
prospect upload, activation, pausing, and event polling. Provider API contracts
are based on the current
[Smartlead API](https://api.smartlead.ai/),
[Instantly API v2](https://developer.instantly.ai/api-reference/overview), and
[EmailBison API](https://dedi.emailbison.com/api/reference).

Paid-ad connections require an explicit account ID. LinkedIn, TikTok, and Meta
use a bearer access token as the referenced environment value:

```bash
export LINKEDIN_ADS_ACCESS_TOKEN="..."

yogi integrations connect linkedin-ads \
  --name "Founder LinkedIn" \
  --secret-ref env:LINKEDIN_ADS_ACCESS_TOKEN \
  --account 123456789
```

Google Ads requires both an OAuth access token and developer token in one
secret JSON value:

```bash
export GOOGLE_ADS_CREDENTIALS='{"accessToken":"...","developerToken":"..."}'

yogi integrations connect google-ads \
  --name "Founder search" \
  --secret-ref env:GOOGLE_ADS_CREDENTIALS \
  --account 1234567890 \
  --manager-account 9876543210 \
  --eu-political-ads does-not-contain
```

The EU political-ad declaration is required before Google campaign creation;
Yogi never guesses it. Meta requires one or more explicit initial targeting
countries:

```bash
yogi integrations connect meta-ads \
  --name "Founder Meta" \
  --secret-ref env:META_ADS_ACCESS_TOKEN \
  --account 123456789 \
  --target-country US \
  --target-country CA
```

Use `--api-version` to pin a different supported provider version during a
controlled upgrade. Current defaults are Google Ads `v25`, LinkedIn `202606`,
TikTok `v1.3`, and Meta Graph `v25.0`.

Paid adapters verify account identity and currency, create a paused budgeted
campaign shell, activate or pause through the operation ledger, and normalize
daily spend, impression, click, and conversion metrics. Creative and
provider-specific targeting remain explicit review work; adapters do not infer
audiences from prose.

## Database responsibilities

The schema stores:

- connection and accessible-account metadata;
- Yogi-to-provider campaign mappings;
- idempotent provider operations and sanitized responses;
- operation-bound, optionally expiring approvals;
- polling cursors;
- deduplicated webhook receipts;
- normalized, deduplicated outbound delivery and engagement events;
- normalized daily ad metrics.

Provider responses written to the operation ledger must be sanitized. Tokens,
raw authorization headers, contact-level webhook payloads, and unrestricted
provider responses do not belong in SQLite.

## Execution boundary

External mutations use a prepare/approve/execute lifecycle:

1. The exact request is canonically serialized and hashed.
2. A provider operation is created with an idempotency key.
3. Activation or spend-capable actions require an approval tied to that
   operation hash and scope.
4. The adapter executes with a just-in-time resolved secret.
5. Only normalized status, external IDs, and sanitized response metadata are
   recorded.
6. Replaying a successful idempotency key returns the recorded result instead
   of repeating the provider mutation.

If a provider call returns but its result cannot be safely recorded, the
operation becomes `unknown`. Yogi blocks automatic retry until an operator
checks the provider and reconciles the external outcome:

```bash
yogi integrations operations --status unknown

yogi integrations reconcile <connection-id> <idempotency-key> \
  --status succeeded \
  --reviewed-by "Matthew" \
  --note "Confirmed one paused campaign in the provider UI" \
  --external-id <provider-campaign-id> \
  --response-file .yogi/private/reconciliation-response.json

yogi integrations reconciliations
```

Only sanitized JSON up to 64 KiB is accepted as evidence. Credential-like
fields are rejected. Successful campaign-creation reconciliation requires the
sanitized response so replay can restore the provider mapping. Reconciliation
is one-time and creates an immutable audit row with the reviewer, note, and
response SHA-256.

Outbound publishing uses two independently recorded operations: remote draft
creation and prospect upload. Activation uses a third operation with its own
`outbound:activate` approval. This keeps a content or sender edit from
implicitly authorizing a launch.

Paid publishing similarly separates `ads:publish-draft` from `ads:activate`.
The draft hash binds the experiment, creative SHA-256, readiness policy,
account, and budgets while ignoring the review timestamp. Each paid experiment
gets an independent provider mapping even when several experiments belong to
one Yogi campaign.

Polling uses at-least-once delivery. Yogi stores normalized outbound events or
daily metrics before advancing the stream cursor. Provider event IDs and daily
metric keys make a replay idempotent, so an interrupted run may repeat work but
cannot silently skip already fetched results.

## Deployment modes

### Local CLI

SQLite lives on the operator's machine. Scheduled polling is appropriate;
public webhooks are optional.

### Persistent exe.dev control VM

Run the connection registry, scheduler, and webhook receiver on one persistent
VM with durable storage and backups. Agent work should continue to use
short-lived VMs without long-lived provider credentials.

### Multi-user hosted service

Use the same storage contract with PostgreSQL before running multiple writers
or application replicas. SQLite is the local and single-control-plane default,
not a network database.
