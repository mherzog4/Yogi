# Yogi roadmap

Yogi's aim is to make repeatable distribution work feel like a versioned,
reviewable engineering workflow.

## Delivery sequence

### 1. Orchestration foundation

Status: implemented in draft PR #1.

- exe.dev isolated sandbox provider
- typed campaign briefs and playbooks
- prompt generation CLI
- approval gates for external actions
- tests, packaging, and architecture documentation

### 2. Campaign workspace

Status: implemented on the stacked campaign-workspace branch.

- `yogi init` project scaffolding
- validated `yogi.config.ts`
- campaign creation and status commands
- shared product, positioning, voice, and proof context
- run manifests and artifact provenance

### 3. Outbound email

- ICP and account-import schemas
- enrichment adapters with source tracking
- personalization and sequence QA
- suppression lists, volume caps, and dry runs
- one sending-provider adapter selected from the operator's actual stack

### 4. Content engine

- source library and reusable brand context
- research-to-pillar workflow
- format-specific drafting and repurposing
- editorial scoring and fact checks
- publishing adapters selected from the operator's channels

### 5. Paid acquisition

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
