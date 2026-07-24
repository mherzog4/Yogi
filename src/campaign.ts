import {
  run,
  type AgentProvider,
  type RunResult,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { getStage, type GtmChannel } from "./playbooks.js";

export interface CampaignBrief {
  readonly name: string;
  readonly product: string;
  readonly audience: string;
  readonly offer: string;
  readonly goal: string;
  readonly proof?: readonly string[];
  readonly constraints?: readonly string[];
  readonly voice?: string;
}

export interface CampaignPromptOptions {
  readonly campaign: CampaignBrief;
  readonly channel: GtmChannel;
  readonly stage: string;
}

export interface RunGtmStageOptions extends CampaignPromptOptions {
  readonly agent: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly cwd?: string;
  readonly approved?: boolean;
  readonly maxIterations?: number;
}

export const campaignSlug = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

  if (!slug) throw new Error("Campaign name must contain a letter or number");
  return slug;
};

const list = (values: readonly string[] | undefined): string =>
  values?.length ? values.map((value) => `- ${value}`).join("\n") : "- None";

export const createCampaignPrompt = ({
  campaign,
  channel,
  stage: stageId,
}: CampaignPromptOptions): string => {
  const selectedStage = getStage(channel, stageId);
  const artifactDirectory = `campaigns/${campaignSlug(campaign.name)}`;

  return `# Yogi GTM stage

You are working on the **${selectedStage.name}** stage of a **${channel}** campaign.

## Campaign brief

- Name: ${campaign.name}
- Product: ${campaign.product}
- Audience: ${campaign.audience}
- Offer: ${campaign.offer}
- Goal: ${campaign.goal}
- Voice: ${campaign.voice ?? "Clear, specific, credible, and human"}

### Available proof

${list(campaign.proof)}

### Constraints

${list(campaign.constraints)}

## Stage objective

${selectedStage.objective}

## Required deliverables

Write these files under \`${artifactDirectory}/\`:

${selectedStage.deliverables.map((file) => `- \`${file}\``).join("\n")}

## Working rules

1. Inspect existing campaign artifacts before starting and preserve useful prior work.
2. Separate sourced facts from hypotheses. Link or name sources wherever possible.
3. Do not invent customer evidence, performance numbers, testimonials, or product capabilities.
4. Keep personally identifying data to the minimum needed for the approved campaign.
5. Record assumptions and unresolved questions in the deliverables.
6. Commit the completed artifacts with a concise message.
${
  selectedStage.requiresApproval
    ? "7. This stage may affect external systems. Use only the explicitly approved scope, audience, budget, and credentials; record every external change."
    : "7. Do not send email, publish content, create ads, or spend money during this preparation stage."
}
`;
};

export const runGtmStage = async (
  options: RunGtmStageOptions,
): Promise<RunResult> => {
  const selectedStage = getStage(options.channel, options.stage);
  if (selectedStage.requiresApproval && options.approved !== true) {
    throw new Error(
      `${selectedStage.name} affects external systems and requires approved: true`,
    );
  }

  const slug = campaignSlug(options.campaign.name);

  return run({
    agent: options.agent,
    sandbox: options.sandbox,
    prompt: createCampaignPrompt(options),
    name: `${options.channel}-${options.stage}`,
    branchStrategy: {
      type: "branch",
      branch: `yogi/${slug}/${options.stage}`,
    },
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.maxIterations !== undefined
      ? { maxIterations: options.maxIterations }
      : {}),
  });
};
