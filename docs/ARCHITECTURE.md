# Yogi architecture

## Product boundary

Yogi is an opinionated go-to-market layer over Sandcastle:

```text
Campaign brief
  -> Yogi playbook and approval policy
  -> Sandcastle agent orchestration
  -> exe.dev isolated VM
  -> versioned campaign artifacts
  -> reviewed external action
```

Sandcastle owns agent processes, Git branch strategies, repository
synchronization, and run lifecycle. Yogi owns campaign vocabulary, prompts,
artifact conventions, approval gates, and distribution integrations.

Keeping those concerns separate lets Yogi adopt upstream orchestration fixes
without carrying a fork of the full engine.

## Modules

- `src/playbooks.ts` defines channels and their ordered stages.
- `src/campaign.ts` turns a campaign brief and stage into an agent prompt and
  enforces the external-action approval gate.
- `src/config.ts` loads and validates the shared TypeScript workspace config.
- `src/workspace.ts` owns durable campaign records and stage status.
- `src/workspace-run.ts` wraps agent runs with run manifests and artifact
  provenance.
- `src/commands.ts` implements testable CLI commands independently of process
  exit behavior.
- `src/outbound/csv.ts` validates and normalizes provider-neutral prospect
  imports.
- `src/outbound/model.ts` applies deterministic suppression and batch policy.
- `src/outbound/store.ts` separates private contact records from versioned
  aggregate reports.
- `src/content/model.ts` defines grounded briefs, format guidance, repurpose
  plans, and deterministic editorial policy.
- `src/content/store.ts` versions approved source copies, prompts, plans, and
  review reports inside a content campaign.
- `src/paid/model.ts` defines experiments, creative sets, safety policy,
  readiness review, and launch-ready plans.
- `src/paid/store.ts` persists paid artifacts and rechecks canonical creative
  against current workspace ceilings before launch planning.
- `src/integrations/database.ts` owns the private SQLite ledger, migrations,
  backups, idempotency, approvals, cursors, webhook receipts, and metrics.
- `src/integrations/types.ts` defines capability-aware outbound and ads adapter
  contracts.
- `src/integrations/secrets.ts` resolves opaque credential references just in
  time.
- `src/integrations/registry.ts` binds connections to adapters and enforces
  prepare/approve/execute semantics.
- `src/integrations/http.ts` provides redacted, timeout-aware provider HTTP
  handling and distinguishes rejected mutations from unknown outcomes.
- `src/integrations/outbound/` adapts Smartlead, Instantly, and EmailBison to
  one paused-draft, prospect-upload, activation, pause, and polling contract.
- `src/sandboxes/exe.ts` adapts exe.dev's SSH API to Sandcastle's isolated
  sandbox contract.
- `src/process.ts` is the process boundary used by the provider and replaced by
  a fake runner in tests.
- `src/cli.ts` exposes playbook discovery and prompt generation.

## Campaign artifacts

Agents write durable outputs under:

```text
campaigns/<campaign-slug>/
  campaign.json
  <stage-deliverables>
  runs/
    <run-id>.json
```

The repository is the system of record for prepared GTM work. External
providers remain the system of execution for sends, publishing, and ad spend.
Execution stages should record external identifiers and changes back into the
campaign directory.

Each completed run captures SHA-256, byte size, capture time, and Git source ref
for every required stage deliverable. Provenance reads from Sandcastle's
returned branch first, then falls back to the current filesystem for embedded
runners. Missing deliverables fail the run even when the underlying agent
process exits successfully.

## Workspace configuration

`yogi.config.ts` is loaded through Jiti so users get a typed ESM configuration
without a project-specific compilation step. Runtime validation aggregates
configuration issues before any campaign work starts.

The shared config holds durable product context:

- description and positioning;
- audiences and offers;
- proof claims with optional sources;
- desired and avoided voice traits.

Campaign creation copies the selected context into `campaign.json`. This keeps
an individual campaign reproducible even when the global positioning evolves
later.

## Approval boundary

Stages have one of four kinds: `research`, `create`, `review`, or `execute`.
Built-in `execute` stages are approval-required. `runGtmStage()` and
`runWorkspaceStage()` fail before creating a sandbox or run record if an
approval-required stage does not receive `approved: true`.

Future integrations should preserve two layers:

1. Yogi's stage-level approval for operator intent.
2. Provider-specific limits such as daily send caps, maximum ad spend, allowed
   accounts, and dry-run modes.

## exe.dev lifecycle

The provider uses exe.dev's documented SSH interface:

1. `ssh exe.dev new ... --json` creates a VM.
2. A mode-`600` environment file is transferred over SSH stdin.
3. Sandcastle's repository bundle is copied with `scp`.
4. Commands run over SSH with streamed standard output.
5. Sandcastle copies Git artifacts back to the host.
6. `ssh exe.dev rm <name> --json` removes the VM unless persistence was
   requested.

Environment values are not passed in VM-creation arguments. Yogi relies on the
user's SSH configuration for exe.dev authentication.

## Outbound privacy boundary

Prospect emails, personalization, suppressions, and full batches live under
ignored `.yogi/private/`. The versioned campaign tree receives only aggregate
reports, policy snapshots, rejection/exclusion reason counts, and SHA-256
source hashes.

Suppressions are workspace-global rather than campaign-scoped so an unsubscribe
or protected domain cannot re-enter through a different campaign.

Draft and send-ready are planning modes, not transport operations. A send-ready
batch requires explicit approval, while actual sending remains unavailable
until an adapter and mailbox policy are selected.

## Content grounding boundary

Content sources are copied into the campaign tree and recorded in an index with
their SHA-256 hash. A brief selects source IDs; its generated prompt tells the
agent to read those files and place `[[source:<id>]]` beside supported claims.
This makes source use visible in an ordinary diff without embedding source text
inside the prompt.

Customer-research imports require the operator to acknowledge that the source
has been de-identified. Because content sources are versioned, private customer
records and restricted material must not be imported.

Editorial review is deterministic policy, not semantic fact verification. It
checks citation-marker coverage, minimum format length, the exact CTA,
unresolved placeholders, and prohibited phrases. Publishing remains unavailable
until the operator selects destinations and their approval policy.

## Paid acquisition boundary

Paid experiments store currency and budgets as integer minor units. Workspace
configuration defines maximum daily spend, total experiment spend, spend
without a conversion, approved landing-page hosts, minimum creative variants,
and prohibited claims. Each experiment declares budgets and a stop-loss within
that policy.

Creative review copies valid JSON to the canonical campaign path and records
its SHA-256 hash. A launch-ready plan requires explicit approval and reruns
readiness against the canonical creative and current configuration, preventing
an old passing report from surviving later creative or policy changes.

Both draft and launch-ready plans record
`externalActionPerformed: false`. Provider adapters, account credentials, ad
creation, activation, pausing, and spend remain outside the core until issue #7
is resolved.

## Provider-state boundary

Git remains the source of truth for campaign intent. Mutable operational state
lives in `.yogi/private/yogi.sqlite`, which is ignored by Git and protected
with restrictive file permissions. Database rows contain secret references,
never credentials.

Provider mutations are idempotent and approval-bound. A canonical request hash,
connection, action, campaign, and idempotency key identify the operation.
Activation-capable calls require a valid approval for that exact operation.
Successful operations replay their sanitized recorded result instead of
repeating an external mutation.

SQLite is appropriate for a local CLI or one persistent exe.dev control VM.
Ephemeral agent VMs should not receive the database. A multi-replica hosted
deployment should implement the same storage contract with PostgreSQL.
