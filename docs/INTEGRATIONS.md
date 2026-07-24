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
```

Yogi stores `env:SMARTLEAD_API_KEY`, not its value. Environment variable names
must use uppercase letters, digits, and underscores.

Current provider IDs:

- outbound: `smartlead`, `instantly`, `emailbison`;
- ads: `google-ads`, `linkedin-ads`, `tiktok-ads`, `meta-ads`.

The secret resolver is injectable. Environment references are the built-in
local implementation; a hosted control plane can provide an OS-keychain or
cloud-secret-manager resolver without changing adapters or database rows.

## Database responsibilities

The schema stores:

- connection and accessible-account metadata;
- Yogi-to-provider campaign mappings;
- idempotent provider operations and sanitized responses;
- operation-bound, optionally expiring approvals;
- polling cursors;
- deduplicated webhook receipts;
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
operation becomes `unknown`. Yogi blocks automatic retry until synchronization
reconciles the external outcome.

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
