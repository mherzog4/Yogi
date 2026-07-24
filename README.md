# Yogi

Yogi is a TypeScript toolkit for running go-to-market work with AI agents in
isolated environments. It builds on
[Sandcastle](https://github.com/mattpocock/sandcastle) and adds:

- an [exe.dev](https://exe.dev) sandbox provider;
- campaign playbooks for outbound email, paid ads, and content;
- approval gates before an agent can send, publish, or spend;
- repository-native artifacts so research and creative work can be reviewed as
  ordinary diffs.

Yogi is in active development. The first release establishes the orchestration
foundation; channel integrations will follow as separate, reviewable changes.

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
