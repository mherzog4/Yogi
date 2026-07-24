# Yogi roadmap

Yogi's aim is to make repeatable distribution work feel like a versioned,
reviewable engineering workflow.

## Delivery sequence

### 1. Orchestration foundation

Status: merged in PR #1.

- exe.dev isolated sandbox provider
- typed campaign briefs and playbooks
- prompt generation CLI
- approval gates for external actions
- tests, packaging, and architecture documentation

### 2. Campaign workspace

Status: merged in PR #2.

- `yogi init` project scaffolding
- validated `yogi.config.ts`
- campaign creation and status commands
- shared product, positioning, voice, and proof context
- run manifests and artifact provenance

### 3. Outbound email

Status: provider-neutral import, suppression, safety policy, and dry-run batches
merged in PR #4. Sending adapter blocked on human review issue #3.

- ICP and account-import schemas
- enrichment adapters with source tracking
- personalization and sequence QA
- suppression lists, volume caps, and dry runs
- one sending-provider adapter selected from the operator's actual stack

### 4. Content engine

Status: grounded source, brief, repurposing, and editorial-review core
merged in PR #6. Publishing adapters blocked on human review issue #5.

- source library and reusable brand context
- research-to-pillar workflow
- format-specific drafting and repurposing
- editorial scoring and fact checks
- publishing adapters selected from the operator's channels

### 5. Paid acquisition

Status: provider-neutral experiment, creative, budget, stop-loss, and
launch-readiness core implemented on the paid-ads-core branch. First provider
adapter blocked on human review issue #7.

- experiment and creative schemas
- landing-page message briefs
- event and attribution plans
- budget, audience, and stop-loss controls
- channel adapters selected from the operator's ad accounts

### 6. Operations

- scheduled exe.dev runs
- notifications and human approval handoffs
- campaign scorecards
- cost and run observability
- reusable learnings across campaigns

## Decisions requiring operator input

These choices should be made immediately before their implementation slice:

- primary outbound platform and mailbox setup;
- first paid channel and maximum test budget;
- primary content formats and publishing destinations;
- canonical product positioning, proof, and voice sources;
- preferred agent and model defaults;
- whether campaign VMs should normally be ephemeral or persistent.

Until those choices are made, Yogi will keep provider integrations behind
interfaces and use non-mutating preparation stages.
