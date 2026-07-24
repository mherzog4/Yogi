import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCampaignPrompt, type CampaignBrief } from "./campaign.js";
import type { ContentSourceType } from "./content/model.js";
import {
  addContentSource,
  createStoredContentBrief,
  createStoredContentPrompt,
  createStoredRepurposePlan,
  isContentFormat,
  reviewStoredContentDraft,
} from "./content/store.js";
import { initWorkspace } from "./config.js";
import {
  integrationDatabasePath,
  openIntegrationDatabase,
} from "./integrations/database.js";
import { createIntegrationRegistry } from "./integrations/defaults.js";
import { normalizeProviderBaseUrl } from "./integrations/http.js";
import { IntegrationService } from "./integrations/registry.js";
import { OutboundIntegrationWorkflow } from "./integrations/outbound/workflow.js";
import {
  INTEGRATION_PROVIDERS,
  isIntegrationProviderId,
} from "./integrations/types.js";
import type { OutboundBatchMode } from "./outbound/model.js";
import {
  addSuppression,
  importProspects,
  planOutboundBatch,
  readOutboundBatch,
} from "./outbound/store.js";
import type { PaidChannel, PaidPlanMode } from "./paid/model.js";
import {
  createStoredPaidCreativePrompt,
  createStoredPaidExperiment,
  planStoredPaidExperiment,
  reviewStoredPaidExperiment,
} from "./paid/store.js";
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
  yogi outbound import <campaign-id> <csv-path> [--replace]
  yogi outbound suppress <campaign-id> <email-or-domain>
    --type <email|domain> --reason <reason>
  yogi outbound plan <campaign-id> [--mode <draft|send>] [--approved]
  yogi outbound publish <campaign-id> <batch-id> --connection <id>
    --name <name> --subject <subject> --body-file <path> --sender <id>...
    --approved-by <name> [--timezone <iana>] [--weekdays <0,1,2,3,4,5,6>]
    [--start <HH:MM>] [--end <HH:MM>] [--attempt <integer>]
  yogi outbound activate <campaign-id> --connection <id>
    --approved-by <name> [--attempt <integer>]
  yogi outbound pause <campaign-id> --connection <id> [--attempt <integer>]
  yogi content source add <campaign-id> <file> --title <title>
    --type <original|customer-research|external> [--url <url>] [--deidentified]
  yogi content brief create <campaign-id> --title <title> --thesis <thesis>
    --format <format> --cta <call-to-action> --source <source-id>...
  yogi content prompt <campaign-id> <brief-id>
  yogi content repurpose <campaign-id> <brief-id> --format <format>...
  yogi content review <campaign-id> <brief-id> <draft-file>
  yogi ads experiment create <campaign-id> --name <name>
    --objective <objective> --hypothesis <hypothesis>
    --channel <search|social|display> --landing-page <https-url>
    --conversion <event> --utm-source <source> --utm-medium <medium>
    --utm-campaign <campaign> --daily-budget-minor <integer>
    --total-budget-minor <integer> --stop-loss-minor <integer>
  yogi ads creative prompt <campaign-id> <experiment-id>
  yogi ads review <campaign-id> <experiment-id> <creative-json>
  yogi ads plan <campaign-id> <experiment-id>
    [--mode <draft|launch>] [--approved]
  yogi integrations init
  yogi integrations status
  yogi integrations providers
  yogi integrations connect <provider> --name <name>
    --secret-ref <env:VARIABLE_NAME> [--account <external-id>]
    [--base-url <https-url>]
  yogi integrations verify <connection-id>
  yogi integrations accounts <connection-id> [--json]
  yogi integrations list [--json]
  yogi integrations backup <destination>
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

const operationAttempt = (value: string | undefined): number => {
  if (value === undefined) return 1;
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new CliError("--attempt must be a positive integer");
  }
  return attempt;
};

const outboundWeekdays = (value: string | undefined): readonly number[] => {
  const weekdays = (value ?? "1,2,3,4,5")
    .split(",")
    .map((day) => Number(day.trim()));
  if (
    weekdays.length === 0 ||
    weekdays.some((day) => !Number.isSafeInteger(day) || day < 0 || day > 6) ||
    new Set(weekdays).size !== weekdays.length
  ) {
    throw new CliError(
      "--weekdays must be unique comma-separated numbers from 0 through 6",
    );
  }
  return weekdays;
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

const outboundCommand = async (
  args: readonly string[],
  context: CliContext,
): Promise<void> => {
  const [subcommand, ...rest] = args;

  if (subcommand === "import") {
    const [campaignId, csvPath, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        replace: { type: "boolean", default: false },
      },
      strict: true,
    });
    const report = await importProspects({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      csvPath: requireValue(csvPath, "A CSV path is required"),
      replace: parsed.values.replace,
    });
    context.stdout(
      `Imported ${report.accepted} prospects; rejected ${report.rejected}`,
    );
    if (report.rejected > 0) {
      context.stdout(`Rejections: ${JSON.stringify(report.rejectionReasons)}`);
    }
    context.stdout(
      "Contact-level data was stored under ignored .yogi/private/.",
    );
    context.stdout(
      "The source CSV was not moved; keep it outside Git or under .yogi/imports/.",
    );
    return;
  }

  if (subcommand === "suppress") {
    const [campaignId, value, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        type: { type: "string" },
        reason: { type: "string" },
      },
      strict: true,
    });
    const type = parsed.values.type;
    if (type !== "email" && type !== "domain") {
      throw new CliError("--type must be email or domain");
    }
    const suppression = await addSuppression({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      value: requireValue(value, "A suppression value is required"),
      type,
      reason: requireValue(parsed.values.reason, "--reason is required"),
    });
    context.stdout(`Suppressed ${suppression.type} ${suppression.value}`);
    return;
  }

  if (subcommand === "plan") {
    const [campaignId, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        mode: { type: "string", default: "draft" },
        approved: { type: "boolean", default: false },
      },
      strict: true,
    });
    const mode = parsed.values.mode;
    if (mode !== "draft" && mode !== "send") {
      throw new CliError("--mode must be draft or send");
    }
    const { summary } = await planOutboundBatch({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      mode: mode as OutboundBatchMode,
      approved: parsed.values.approved,
    });
    context.stdout(
      `${summary.mode} batch ${summary.batchId}: ${summary.selected} selected, ${summary.excluded} excluded`,
    );
    if (summary.excluded > 0) {
      context.stdout(`Exclusions: ${JSON.stringify(summary.exclusionReasons)}`);
    }
    context.stdout(
      "No email was sent; the private batch is ready for `yogi outbound publish`.",
    );
    return;
  }

  if (subcommand === "publish") {
    const [campaignIdValue, batchIdValue, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        connection: { type: "string" },
        name: { type: "string" },
        subject: { type: "string" },
        "body-file": { type: "string" },
        sender: { type: "string", multiple: true },
        "approved-by": { type: "string" },
        timezone: { type: "string", default: "America/New_York" },
        weekdays: { type: "string", default: "1,2,3,4,5" },
        start: { type: "string", default: "09:00" },
        end: { type: "string", default: "17:00" },
        attempt: { type: "string" },
      },
      strict: true,
    });
    const campaignId = requireValue(
      campaignIdValue,
      "A campaign ID is required",
    );
    const batchId = requireValue(batchIdValue, "A batch ID is required");
    const senderAccountIds = parsed.values.sender ?? [];
    if (senderAccountIds.length === 0) {
      throw new CliError("At least one --sender is required");
    }
    const bodyPath = requireValue(
      parsed.values["body-file"],
      "--body-file is required",
    );
    const [batch, body] = await Promise.all([
      readOutboundBatch(context.cwd, campaignId, batchId),
      readFile(resolve(context.cwd, bodyPath), "utf8"),
    ]);
    const connectionId = requireValue(
      parsed.values.connection,
      "--connection is required",
    );
    const database = openIntegrationDatabase(context.cwd);
    try {
      const workflow = new OutboundIntegrationWorkflow({
        database,
        registry: createIntegrationRegistry(),
      });
      const result = await workflow.publishDraft({
        connectionId,
        approvedBy: requireValue(
          parsed.values["approved-by"],
          "--approved-by is required",
        ),
        attempt: operationAttempt(parsed.values.attempt),
        input: {
          campaignId,
          name: requireValue(parsed.values.name, "--name is required"),
          batch,
          subject: requireValue(parsed.values.subject, "--subject is required"),
          body,
          senderAccountIds,
          schedule: {
            timezone: parsed.values.timezone,
            weekdays: outboundWeekdays(parsed.values.weekdays),
            startHour: parsed.values.start,
            endHour: parsed.values.end,
          },
        },
      });
      context.stdout(
        `Published paused ${result.draft.externalStatus} campaign ${result.draft.externalCampaignId}`,
      );
      context.stdout(
        `${result.prospects.accepted} prospects accepted; ${result.prospects.rejected} rejected`,
      );
      context.stdout(
        "No email was sent. Run `yogi outbound activate` after reviewing the provider draft.",
      );
    } finally {
      database.close();
    }
    return;
  }

  if (subcommand === "activate" || subcommand === "pause") {
    const [campaignIdValue, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        connection: { type: "string" },
        "approved-by": { type: "string" },
        attempt: { type: "string" },
      },
      strict: true,
    });
    const campaignId = requireValue(
      campaignIdValue,
      "A campaign ID is required",
    );
    const connectionId = requireValue(
      parsed.values.connection,
      "--connection is required",
    );
    const database = openIntegrationDatabase(context.cwd);
    try {
      const workflow = new OutboundIntegrationWorkflow({
        database,
        registry: createIntegrationRegistry(),
      });
      if (subcommand === "activate") {
        await workflow.activate({
          connectionId,
          campaignId,
          approvedBy: requireValue(
            parsed.values["approved-by"],
            "--approved-by is required",
          ),
          attempt: operationAttempt(parsed.values.attempt),
        });
        context.stdout(`Activated provider campaign for ${campaignId}`);
      } else {
        await workflow.pause({
          connectionId,
          campaignId,
          attempt: operationAttempt(parsed.values.attempt),
        });
        context.stdout(`Paused provider campaign for ${campaignId}`);
      }
    } finally {
      database.close();
    }
    return;
  }

  throw new CliError(`Unknown outbound command: ${subcommand ?? "(missing)"}`);
};

const requireContentFormat = (value: string | undefined) => {
  if (!value || !isContentFormat(value)) {
    throw new CliError(
      "--format must be article, newsletter, linkedin-post, x-thread, or video-script",
    );
  }
  return value;
};

const contentCommand = async (
  args: readonly string[],
  context: CliContext,
): Promise<void> => {
  const [subcommand, ...rest] = args;

  if (subcommand === "source" && rest[0] === "add") {
    const [, campaignId, filePath, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        title: { type: "string" },
        type: { type: "string" },
        url: { type: "string" },
        deidentified: { type: "boolean", default: false },
      },
      strict: true,
    });
    const type = parsed.values.type;
    if (
      type !== "original" &&
      type !== "customer-research" &&
      type !== "external"
    ) {
      throw new CliError(
        "--type must be original, customer-research, or external",
      );
    }
    const source = await addContentSource({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      filePath: requireValue(filePath, "A source file is required"),
      title: requireValue(parsed.values.title, "--title is required"),
      type: type as ContentSourceType,
      ...(parsed.values.url ? { url: parsed.values.url } : {}),
      acknowledgeDeidentified: parsed.values.deidentified,
    });
    context.stdout(`Added source ${source.id} at ${source.repositoryPath}`);
    return;
  }

  if (subcommand === "brief" && rest[0] === "create") {
    const [, campaignId, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        title: { type: "string" },
        thesis: { type: "string" },
        format: { type: "string" },
        cta: { type: "string" },
        source: { type: "string", multiple: true },
      },
      strict: true,
    });
    const brief = await createStoredContentBrief({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      title: requireValue(parsed.values.title, "--title is required"),
      thesis: requireValue(parsed.values.thesis, "--thesis is required"),
      format: requireContentFormat(parsed.values.format),
      callToAction: requireValue(parsed.values.cta, "--cta is required"),
      sourceIds: parsed.values.source ?? [],
    });
    context.stdout(`Created content brief ${brief.id}`);
    return;
  }

  if (subcommand === "prompt") {
    const [campaignId, briefId] = rest;
    context.stdout(
      await createStoredContentPrompt(
        context.cwd,
        requireValue(campaignId, "A campaign ID is required"),
        requireValue(briefId, "A brief ID is required"),
      ),
    );
    return;
  }

  if (subcommand === "repurpose") {
    const [campaignId, briefId, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        format: { type: "string", multiple: true },
      },
      strict: true,
    });
    const formats = (parsed.values.format ?? []).map(requireContentFormat);
    const plan = await createStoredRepurposePlan({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      briefId: requireValue(briefId, "A brief ID is required"),
      formats,
    });
    context.stdout(
      `Created repurpose plan with ${plan.assets.length} asset${plan.assets.length === 1 ? "" : "s"}`,
    );
    return;
  }

  if (subcommand === "review") {
    const [campaignId, briefId, draftPath] = rest;
    const report = await reviewStoredContentDraft({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      briefId: requireValue(briefId, "A brief ID is required"),
      draftPath: requireValue(draftPath, "A draft file is required"),
    });
    context.stdout(
      `Editorial review ${report.passed ? "passed" : "failed"}: ${report.score}/${report.minimumScore}`,
    );
    for (const issue of report.issues) {
      context.stdout(`  ${issue.severity}: ${issue.message}`);
    }
    if (!report.passed) {
      throw new Error("Draft did not pass the editorial gate");
    }
    return;
  }

  throw new CliError(`Unknown content command: ${subcommand ?? "(missing)"}`);
};

const requirePositiveInteger = (
  value: string | undefined,
  option: string,
): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${option} must be a positive integer`);
  }
  return parsed;
};

const adsCommand = async (
  args: readonly string[],
  context: CliContext,
): Promise<void> => {
  const [subcommand, ...rest] = args;

  if (subcommand === "experiment" && rest[0] === "create") {
    const [, campaignId, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        name: { type: "string" },
        objective: { type: "string" },
        hypothesis: { type: "string" },
        channel: { type: "string" },
        "landing-page": { type: "string" },
        conversion: { type: "string" },
        "utm-source": { type: "string" },
        "utm-medium": { type: "string" },
        "utm-campaign": { type: "string" },
        "daily-budget-minor": { type: "string" },
        "total-budget-minor": { type: "string" },
        "stop-loss-minor": { type: "string" },
      },
      strict: true,
    });
    const channel = parsed.values.channel;
    if (channel !== "search" && channel !== "social" && channel !== "display") {
      throw new CliError("--channel must be search, social, or display");
    }
    const experiment = await createStoredPaidExperiment({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      name: requireValue(parsed.values.name, "--name is required"),
      objective: requireValue(
        parsed.values.objective,
        "--objective is required",
      ),
      hypothesis: requireValue(
        parsed.values.hypothesis,
        "--hypothesis is required",
      ),
      channel: channel as PaidChannel,
      landingPageUrl: requireValue(
        parsed.values["landing-page"],
        "--landing-page is required",
      ),
      conversionEvent: requireValue(
        parsed.values.conversion,
        "--conversion is required",
      ),
      utmSource: requireValue(
        parsed.values["utm-source"],
        "--utm-source is required",
      ),
      utmMedium: requireValue(
        parsed.values["utm-medium"],
        "--utm-medium is required",
      ),
      utmCampaign: requireValue(
        parsed.values["utm-campaign"],
        "--utm-campaign is required",
      ),
      dailyBudgetMinor: requirePositiveInteger(
        parsed.values["daily-budget-minor"],
        "--daily-budget-minor",
      ),
      totalBudgetMinor: requirePositiveInteger(
        parsed.values["total-budget-minor"],
        "--total-budget-minor",
      ),
      stopLossSpendMinor: requirePositiveInteger(
        parsed.values["stop-loss-minor"],
        "--stop-loss-minor",
      ),
    });
    context.stdout(`Created paid experiment ${experiment.id}`);
    context.stdout(
      `Budget proposal: ${experiment.dailyBudgetMinor} daily / ${experiment.totalBudgetMinor} total ${experiment.currency} minor units`,
    );
    return;
  }

  if (subcommand === "creative" && rest[0] === "prompt") {
    const [, campaignId, experimentId] = rest;
    context.stdout(
      await createStoredPaidCreativePrompt(
        context.cwd,
        requireValue(campaignId, "A campaign ID is required"),
        requireValue(experimentId, "An experiment ID is required"),
      ),
    );
    return;
  }

  if (subcommand === "review") {
    const [campaignId, experimentId, creativePath] = rest;
    const report = await reviewStoredPaidExperiment({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      experimentId: requireValue(experimentId, "An experiment ID is required"),
      creativePath: requireValue(
        creativePath,
        "A creative JSON file is required",
      ),
    });
    context.stdout(
      `Paid launch review ${report.passed ? "passed" : "failed"} with ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}`,
    );
    for (const issue of report.issues) {
      context.stdout(`  ${issue.code}: ${issue.message}`);
    }
    if (!report.passed) {
      throw new Error("Experiment did not pass the paid launch gate");
    }
    return;
  }

  if (subcommand === "plan") {
    const [campaignId, experimentId, ...optionArgs] = rest;
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        mode: { type: "string", default: "draft" },
        approved: { type: "boolean", default: false },
      },
      strict: true,
    });
    const mode = parsed.values.mode;
    if (mode !== "draft" && mode !== "launch") {
      throw new CliError("--mode must be draft or launch");
    }
    const plan = await planStoredPaidExperiment({
      cwd: context.cwd,
      campaignId: requireValue(campaignId, "A campaign ID is required"),
      experimentId: requireValue(experimentId, "An experiment ID is required"),
      mode: mode as PaidPlanMode,
      approved: parsed.values.approved,
    });
    context.stdout(
      `Created ${plan.mode} paid plan for ${plan.experimentId}; no external action was performed`,
    );
    return;
  }

  throw new CliError(`Unknown ads command: ${subcommand ?? "(missing)"}`);
};

const integrationsCommand = async (
  args: readonly string[],
  context: CliContext,
): Promise<void> => {
  const [subcommand, ...rest] = args;

  if (subcommand === "providers") {
    for (const provider of INTEGRATION_PROVIDERS) {
      context.stdout(provider);
    }
    return;
  }

  if (subcommand === "init") {
    const database = openIntegrationDatabase(context.cwd);
    try {
      context.stdout(
        `Initialized integration database at ${database.path} (schema ${database.schemaVersion()}, ${database.journalMode()})`,
      );
    } finally {
      database.close();
    }
    return;
  }

  if (subcommand === "status") {
    const database = openIntegrationDatabase(context.cwd);
    try {
      context.stdout(`Database: ${integrationDatabasePath(context.cwd)}`);
      context.stdout(`Schema: ${database.schemaVersion()}`);
      context.stdout(`Journal: ${database.journalMode()}`);
      context.stdout(`Integrity: ${database.integrityCheck()}`);
      context.stdout(`Connections: ${database.listConnections().length}`);
    } finally {
      database.close();
    }
    return;
  }

  if (subcommand === "connect") {
    const [providerValue, ...optionArgs] = rest;
    if (!isIntegrationProviderId(providerValue)) {
      throw new CliError(
        `Unknown provider: ${providerValue ?? "(missing)"}. Use \`yogi integrations providers\`.`,
      );
    }
    const parsed = parseArgs({
      args: optionArgs,
      options: {
        name: { type: "string" },
        "secret-ref": { type: "string" },
        account: { type: "string" },
        "base-url": { type: "string" },
      },
      strict: true,
    });
    const database = openIntegrationDatabase(context.cwd);
    try {
      const baseUrl = parsed.values["base-url"];
      let normalizedBaseUrl: string | undefined;
      if (baseUrl) {
        try {
          normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
        } catch {
          throw new CliError("--base-url must be a valid HTTPS URL");
        }
      }
      const connection = database.createConnection({
        provider: providerValue,
        name: requireValue(parsed.values.name, "--name is required"),
        secretRef: requireValue(
          parsed.values["secret-ref"],
          "--secret-ref is required",
        ),
        ...(parsed.values.account
          ? { externalAccountId: parsed.values.account }
          : {}),
        ...(normalizedBaseUrl
          ? { metadata: { baseUrl: normalizedBaseUrl } }
          : {}),
      });
      context.stdout(
        `Configured ${connection.provider} connection ${connection.id}`,
      );
      context.stdout(
        "Only the secret reference was stored; the credential was not read or persisted.",
      );
    } finally {
      database.close();
    }
    return;
  }

  if (subcommand === "verify") {
    const [connectionIdValue] = rest;
    const connectionId = requireValue(
      connectionIdValue,
      "A connection ID is required",
    );
    const database = openIntegrationDatabase(context.cwd);
    try {
      const service = new IntegrationService({
        database,
        registry: createIntegrationRegistry(),
      });
      await service.verifyConnection(connectionId);
      const connection = database.getConnection(connectionId);
      context.stdout(
        `Verified ${connection.provider} connection ${connection.id}`,
      );
    } finally {
      database.close();
    }
    return;
  }

  if (subcommand === "accounts") {
    const [connectionIdValue, ...optionArgs] = rest;
    const connectionId = requireValue(
      connectionIdValue,
      "A connection ID is required",
    );
    const parsed = parseArgs({
      args: optionArgs,
      options: { json: { type: "boolean", default: false } },
      strict: true,
    });
    const database = openIntegrationDatabase(context.cwd);
    try {
      const service = new IntegrationService({
        database,
        registry: createIntegrationRegistry(),
      });
      await service.discoverAccounts(connectionId);
      const accounts = database.listAccounts(connectionId);
      if (parsed.values.json) {
        context.stdout(JSON.stringify(accounts, null, 2));
      } else if (accounts.length === 0) {
        context.stdout("No sender accounts are visible to this connection.");
      } else {
        for (const account of accounts) {
          context.stdout(
            `${account.externalId} · ${account.name}${
              typeof account.metadata.email === "string"
                ? ` · ${account.metadata.email}`
                : ""
            }`,
          );
        }
      }
    } finally {
      database.close();
    }
    return;
  }

  if (subcommand === "list") {
    const parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      strict: true,
    });
    const database = openIntegrationDatabase(context.cwd);
    try {
      const connections = database.listConnections();
      if (parsed.values.json) {
        context.stdout(JSON.stringify(connections, null, 2));
      } else if (connections.length === 0) {
        context.stdout("No provider connections configured.");
      } else {
        for (const connection of connections) {
          context.stdout(
            `${connection.id} · ${connection.provider} · ${connection.name} · ${connection.status}`,
          );
        }
      }
    } finally {
      database.close();
    }
    return;
  }

  if (subcommand === "backup") {
    const [destination] = rest;
    const target = requireValue(
      destination,
      "A backup destination is required",
    );
    const database = openIntegrationDatabase(context.cwd);
    try {
      const pages = await database.backup(target);
      context.stdout(`Backed up ${pages} pages to ${target}`);
    } finally {
      database.close();
    }
    return;
  }

  throw new CliError(
    `Unknown integrations command: ${subcommand ?? "(missing)"}`,
  );
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

    if (command === "outbound") {
      await outboundCommand(rest, context);
      return 0;
    }

    if (command === "content") {
      await contentCommand(rest, context);
      return 0;
    }

    if (command === "ads") {
      await adsCommand(rest, context);
      return 0;
    }

    if (command === "integrations") {
      await integrationsCommand(rest, context);
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
