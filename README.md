# Yogi

Yogi is a TypeScript toolkit for running go-to-market work with AI agents in
isolated environments. It builds on
[Sandcastle](https://github.com/mattpocock/sandcastle) and adds:

- an [exe.dev](https://exe.dev) sandbox provider;
- campaign playbooks for outbound email, paid ads, and content;
- approval gates before an agent can send, publish, or spend;
- repository-native artifacts so research and creative work can be reviewed as
  ordinary diffs.

Yogi is in active development. Its orchestration foundation, durable campaign
workspaces, outbound planning core, and grounded content workflow are available;
external sending, publishing, and ad-spend integrations remain deliberately
disabled.

## Try the current source

```bash
git clone https://github.com/mherzog4/Yogi.git
cd Yogi
npm install
npm test
```

The `@mherzog4/yogi` package name is reserved in the project manifest but the
package has not been published yet.

Prerequisites:

- Node.js 22 or later;
- Git;
- an exe.dev account configured for `ssh exe.dev`;
- an agent supported by Sandcastle, such as Codex or Claude Code.

## Create a workspace

```bash
npx yogi init --name "My Growth Lab"
```

This creates:

```text
yogi.config.ts
campaigns/
```

Edit `yogi.config.ts` to capture the product description, positioning,
audiences, offers, proof sources, and voice. Yogi validates this file before
campaign commands run; generated `TODO` values must be replaced. See
[examples/yogi.config.ts](examples/yogi.config.ts) for a complete example.

Create and inspect a campaign:

```bash
npx yogi campaign create outbound-email \
  --name "Founder-led launch" \
  --goal "Book 10 qualified demos"

npx yogi campaign status founder-led-launch
npx yogi campaign prompt founder-led-launch account-research
```

Campaign records, stage status, generated artifacts, and run manifests live
under `campaigns/<campaign-slug>/` so they can be reviewed and versioned.

## Quick start

```ts
import { codex } from "@ai-hero/sandcastle";
import { exe, runGtmStage, type CampaignBrief } from "@mherzog4/yogi";

const campaign: CampaignBrief = {
  name: "Founder-led launch",
  product: "A planning assistant for small SaaS teams",
  audience: "Bootstrapped B2B SaaS founders",
  offer: "Turn a rough idea into a launch plan in one afternoon",
  goal: "Book 10 qualified product demos",
};

await runGtmStage({
  agent: codex("gpt-5.4"),
  sandbox: exe(),
  campaign,
  channel: "outbound-email",
  stage: "account-research",
});
```

To run a stored campaign and record artifact provenance:

```ts
import { codex } from "@ai-hero/sandcastle";
import { exe, runWorkspaceStage } from "@mherzog4/yogi";

await runWorkspaceStage({
  campaignId: "founder-led-launch",
  stage: "account-research",
  agent: codex("gpt-5.4"),
  sandbox: exe(),
});
```

Yogi creates a short-lived exe.dev VM by default, synchronizes the repository
into it, runs the selected agent, and brings the resulting commits back. Set
`persist: true` on `exe()` when you deliberately want to keep the VM.

Each workspace run records its agent, sandbox, timestamps, branch, commits, and
SHA-256 hashes for required deliverables. A run is marked failed when the agent
does not produce every required artifact.

## Provider connections and SQLite

Every workspace has a private SQLite integration ledger at
`.yogi/private/yogi.sqlite`. It stores provider connections, external IDs,
idempotent operations, approval records, reconciliation audits, sync cursors,
normalized outbound events, webhook receipts, and paid metrics. Campaign intent
and aggregate reports remain reviewable in
Git.

Configure connections with secret references:

```bash
yogi integrations connect smartlead \
  --name "Founder outbound" \
  --secret-ref env:SMARTLEAD_API_KEY

yogi integrations verify <connection-id>
yogi integrations accounts <connection-id>
yogi integrations list
yogi integrations status
```

Credentials are resolved only when a provider operation runs; their values are
not stored in SQLite. The provider registry covers Smartlead, Instantly,
EmailBison, Google Ads, LinkedIn Ads, TikTok Ads, and Meta Ads. See
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

Paid-ad connections can create reviewed, paused campaign shells with hard
budget values, activate them through a separate named approval, poll daily
metrics with resumable cursors, and automatically pause at a configured total-budget or
no-conversion stop-loss. See [docs/PAID_ADS.md](docs/PAID_ADS.md).

## Outbound email

Yogi can import and validate prospect CSVs, manage email/domain suppressions,
and prepare deterministic draft or send-ready batches:

```bash
yogi outbound import founder-led-launch .yogi/imports/prospects.csv
yogi outbound suppress founder-led-launch customer.example \
  --type domain \
  --reason "Existing customer"
yogi outbound plan founder-led-launch
```

Contact-level data stays under ignored `.yogi/private/`; versioned campaign
artifacts contain only aggregate counts, reason codes, source hashes, and the
policy used. Yogi can publish paused drafts to Smartlead, Instantly, and
EmailBison, then activate them through a separate named approval:

```bash
yogi outbound plan founder-led-launch --mode send --approved

yogi outbound publish founder-led-launch <batch-id> \
  --connection <connection-id> \
  --name "Founder launch" \
  --subject "A distribution idea" \
  --body-file campaigns/founder-led-launch/sequence.md \
  --sender <sender-account-id> \
  --approved-by "Matthew"

yogi outbound activate founder-led-launch \
  --connection <connection-id> \
  --approved-by "Matthew"
```

Publishing uploads the approved private batch but leaves the remote campaign
paused. See [docs/OUTBOUND.md](docs/OUTBOUND.md).

## Content generation

Yogi turns approved source material into grounded briefs, agent prompts,
repurpose plans, and editorial review reports:

```bash
yogi campaign create content \
  --name "Founder launch lessons" \
  --goal "Earn 100 qualified subscribers"

yogi content source add founder-launch-lessons notes.md \
  --title "Founder research" \
  --type customer-research \
  --deidentified

yogi content brief create founder-launch-lessons \
  --title "Why credible launches compound" \
  --thesis "Specific evidence earns more trust than manufactured urgency" \
  --format article \
  --cta "Read the launch guide" \
  --source founder-research

yogi content prompt founder-launch-lessons why-credible-launches-compound
yogi content repurpose founder-launch-lessons why-credible-launches-compound \
  --format newsletter \
  --format linkedin-post
yogi content review founder-launch-lessons why-credible-launches-compound \
  campaigns/founder-launch-lessons/content/drafts/why-credible-launches-compound.md
```

Prompts require `[[source:<id>]]` markers next to sourced claims. Editorial
review checks source coverage, format length, the exact call to action,
placeholders, and configured prohibited phrases. Yogi does not publish content.
See [docs/CONTENT.md](docs/CONTENT.md).

## Paid acquisition

Yogi can prepare paid experiments without touching an ad account:

```bash
yogi campaign create paid-ads \
  --name "Search intent test" \
  --goal "Generate qualified launch-plan signups"

yogi ads experiment create search-intent-test \
  --name "Founder planning intent" \
  --objective "Generate qualified signups" \
  --hypothesis "Specific planning language attracts higher-intent founders" \
  --channel search \
  --landing-page https://launch.example.com/plan \
  --conversion launch_plan_started \
  --utm-source search \
  --utm-medium paid \
  --utm-campaign founder-planning-intent \
  --daily-budget-minor 3000 \
  --total-budget-minor 30000 \
  --stop-loss-minor 10000

yogi ads creative prompt search-intent-test founder-planning-intent
yogi ads review search-intent-test founder-planning-intent creative.json
yogi ads plan search-intent-test founder-planning-intent \
  --mode launch \
  --approved
```

The launch-ready plan rechecks canonical creative against current budget,
destination, conversion, and claims policy. It does not create or activate ads.
See [docs/PAID_ADS.md](docs/PAID_ADS.md).

## Built-in playbooks

| Channel        | Stages                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| Outbound email | ICP definition, account research, sequence drafting, QA, launch                  |
| Paid ads       | Channel strategy, creative briefs, copy variants, measurement, launch            |
| Content        | Audience research, pillar brief, drafting, repurposing, editorial QA, publishing |

Every stage produces files under `campaigns/<campaign-slug>/`. Execution stages
are marked as approval-required and `runGtmStage()` rejects them unless
`approved: true` is supplied explicitly.

List the current playbooks:

```bash
npx yogi playbooks
```

Generate a stage prompt without running an agent:

```bash
npx yogi prompt outbound-email sequence-draft \
  --name "Founder-led launch" \
  --product "Planning assistant" \
  --audience "Bootstrapped B2B SaaS founders" \
  --offer "A launch plan in one afternoon" \
  --goal "Book 10 qualified demos"
```

## exe.dev provider

```ts
import { exe } from "@mherzog4/yogi/sandboxes/exe";

const sandbox = exe({
  image: "ubuntu:24.04",
  cpu: 4,
  memory: "8GB",
  disk: "30GB",
  tags: ["yogi", "gtm"],
  persist: false,
  env: {
    YOGI_WORKSPACE: "growth",
  },
});
```

Authentication uses your existing SSH configuration. Environment values are
transferred to a mode-`600` file over stdin after VM creation rather than being
included in VM-creation arguments.

## Safety model

Yogi separates preparation from external action:

1. Research and draft stages can run without an approval flag.
2. Send, publish, and launch stages require `approved: true`.
3. Provider credentials are not included in starter playbooks.
4. Campaign artifacts stay reviewable in Git before an external system changes.

Approval is a deliberate code-level guard, not a substitute for provider-side
budgets, sending limits, access controls, or legal review.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

See [docs/ROADMAP.md](docs/ROADMAP.md) for the planned channel integrations and
the decisions that will shape them.

## Attribution

Yogi is an independent project inspired by and built on Matt Pocock's
MIT-licensed Sandcastle. Sandcastle remains a separate upstream dependency.

## License

MIT
