import { parseArgs } from "node:util";
import { createCampaignPrompt, type CampaignBrief } from "./campaign.js";
import { initWorkspace } from "./config.js";
import { GTM_PLAYBOOKS, type GtmChannel } from "./playbooks.js";
import {
  createCampaign,
  formatCampaignStatus,
  listCampaigns,
  readCampaign,
} from "./workspace.js";

export const CLI_USAGE = `Yogi — agent orchestration for go-to-market work

Usage:
  yogi init [--name <workspace>] [--force]
  yogi playbooks
  yogi prompt <channel> <stage> --name <name> --product <product>
    --audience <audience> --offer <offer> --goal <goal> [--voice <voice>]
  yogi campaign create <channel> --name <name> --goal <goal>
    [--audience <audience>] [--offer <offer>] [--proof <claim>...]
    [--constraint <constraint>...]
  yogi campaign status [campaign-id] [--json]
  yogi campaign prompt <campaign-id> <stage>
`;

export interface CliContext {
  readonly cwd: string;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const defaultContext = (): CliContext => ({
  cwd: process.cwd(),
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
});

class CliError extends Error {}

const requireValue = (value: string | undefined, message: string): string => {
  if (!value) throw new CliError(message);
  return value;
};

const isChannel = (value: string): value is GtmChannel =>
  Object.hasOwn(GTM_PLAYBOOKS, value);

const requireChannel = (value: string | undefined): GtmChannel => {
  if (!value || !isChannel(value)) {
    throw new CliError(`Unknown channel: ${value ?? "(missing)"}`);
  }
  return value;
};

const statelessPrompt = (
  args: readonly string[],
  context: CliContext,
): void => {
  const [channelValue, stage, ...optionArgs] = args;
  const channel = requireChannel(channelValue);
  const stageId = requireValue(stage, "A stage is required");
  const parsed = parseArgs({
    args: optionArgs,
    options: {
      name: { type: "string" },
      product: { type: "string" },
      audience: { type: "string" },
      offer: { type: "string" },
      goal: { type: "string" },
      voice: { type: "string" },
    },
    strict: true,
  });

  const required = ["name", "product", "audience", "offer", "goal"] as const;
  for (const key of required) {
    if (!parsed.values[key]) throw new CliError(`--${key} is required`);
  }

  const campaign: CampaignBrief = {
    name: parsed.values.name!,
    product: parsed.values.product!,
    audience: parsed.values.audience!,
    offer: parsed.values.offer!,
    goal: parsed.values.goal!,
    ...(parsed.values.voice ? { voice: parsed.values.voice } : {}),
  };

  context.stdout(createCampaignPrompt({ campaign, channel, stage: stageId }));
};

const campaignCommand = async (
  args: readonly string[],
  context: CliContext,
): Promise<void> => {
  const [subcommand, ...rest] = args;

  if (subcommand === "create") {
    const [channelValue, ...optionArgs] = rest;
    const channel = requireChannel(channelValue);
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        name: { type: "string" },
        goal: { type: "string" },
        audience: { type: "string" },
        offer: { type: "string" },
        proof: { type: "string", multiple: true },
        constraint: { type: "string", multiple: true },
        voice: { type: "string" },
      },
      strict: true,
    });

    const record = await createCampaign({
      cwd: context.cwd,
      channel,
      name: requireValue(parsed.values.name, "--name is required"),
      goal: requireValue(parsed.values.goal, "--goal is required"),
      ...(parsed.values.audience ? { audience: parsed.values.audience } : {}),
      ...(parsed.values.offer ? { offer: parsed.values.offer } : {}),
      ...(parsed.values.proof ? { proof: parsed.values.proof } : {}),
      ...(parsed.values.constraint
        ? { constraints: parsed.values.constraint }
        : {}),
      ...(parsed.values.voice ? { voice: parsed.values.voice } : {}),
    });
    context.stdout(`Created campaign ${record.id}`);
    context.stdout(formatCampaignStatus(record));
    return;
  }

  if (subcommand === "status") {
    const [possibleId, ...remaining] = rest;
    const id = possibleId?.startsWith("--") ? undefined : possibleId;
    const optionArgs = id ? remaining : rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: { json: { type: "boolean", default: false } },
      strict: true,
    });
    const campaigns = id
      ? [await readCampaign(context.cwd, id)]
      : await listCampaigns(context.cwd);

    if (parsed.values.json) {
      context.stdout(JSON.stringify(campaigns, null, 2));
    } else if (campaigns.length === 0) {
      context.stdout(
        "No campaigns yet. Create one with `yogi campaign create`.",
      );
    } else {
      context.stdout(campaigns.map(formatCampaignStatus).join("\n\n"));
    }
    return;
  }

  if (subcommand === "prompt") {
    const [id, stage] = rest;
    const campaign = await readCampaign(
      context.cwd,
      requireValue(id, "A campaign ID is required"),
    );
    context.stdout(
      createCampaignPrompt({
        campaign: campaign.brief,
        channel: campaign.channel,
        stage: requireValue(stage, "A stage is required"),
      }),
    );
    return;
  }

  throw new CliError(`Unknown campaign command: ${subcommand ?? "(missing)"}`);
};

export const runCli = async (
  args: readonly string[],
  overrides: Partial<CliContext> = {},
): Promise<number> => {
  const context = { ...defaultContext(), ...overrides };
  const [command, ...rest] = args;

  try {
    if (command === "init") {
      const parsed = parseArgs({
        args: rest,
        options: {
          name: { type: "string" },
          force: { type: "boolean", default: false },
        },
        strict: true,
      });
      const initialized = await initWorkspace({
        cwd: context.cwd,
        ...(parsed.values.name ? { name: parsed.values.name } : {}),
        force: parsed.values.force,
      });
      context.stdout(`Initialized Yogi workspace at ${initialized.root}`);
      context.stdout(`Edit ${initialized.configPath} before your first run.`);
      return 0;
    }

    if (command === "playbooks") {
      for (const playbook of Object.values(GTM_PLAYBOOKS)) {
        context.stdout(`\n${playbook.name} (${playbook.channel})`);
        for (const stage of playbook.stages) {
          const approval = stage.requiresApproval ? " [approval required]" : "";
          context.stdout(`  ${stage.id}${approval}`);
        }
      }
      return 0;
    }

    if (command === "prompt") {
      statelessPrompt(rest, context);
      return 0;
    }

    if (command === "campaign") {
      await campaignCommand(rest, context);
      return 0;
    }

    throw new CliError(
      command ? `Unknown command: ${command}` : "A command is required",
    );
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : String(error));
    if (error instanceof CliError) context.stderr(`\n${CLI_USAGE}`);
    return 1;
  }
};
