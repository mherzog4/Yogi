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
- `src/sandboxes/exe.ts` adapts exe.dev's SSH API to Sandcastle's isolated
  sandbox contract.
- `src/process.ts` is the process boundary used by the provider and replaced by
  a fake runner in tests.
- `src/cli.ts` exposes playbook discovery and prompt generation.

## Campaign artifacts

Agents write durable outputs under:

```text
campaigns/<campaign-slug>/
```

The repository is the system of record for prepared GTM work. External
providers remain the system of execution for sends, publishing, and ad spend.
Execution stages should record external identifiers and changes back into the
campaign directory.

## Approval boundary

Stages have one of four kinds: `research`, `create`, `review`, or `execute`.
Built-in `execute` stages are approval-required. `runGtmStage()` fails before
creating a sandbox if an approval-required stage does not receive
`approved: true`.

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
