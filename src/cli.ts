#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createCampaignPrompt, type CampaignBrief } from "./campaign.js";
import { GTM_PLAYBOOKS, type GtmChannel } from "./playbooks.js";

const usage = `Yogi — agent orchestration for go-to-market work

Usage:
  yogi playbooks
  yogi prompt <channel> <stage> --name <name> --product <product>
    --audience <audience> --offer <offer> --goal <goal> [--voice <voice>]
`;

const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
};

const isChannel = (value: string): value is GtmChannel =>
  Object.hasOwn(GTM_PLAYBOOKS, value);

const [command, ...rest] = process.argv.slice(2);

if (command === "playbooks") {
  for (const playbook of Object.values(GTM_PLAYBOOKS)) {
    console.log(`\n${playbook.name} (${playbook.channel})`);
    for (const stage of playbook.stages) {
      const approval = stage.requiresApproval ? " [approval required]" : "";
      console.log(`  ${stage.id}${approval}`);
    }
  }
} else if (command === "prompt") {
  const [channelValue, stage, ...optionArgs] = rest;
  const channel =
    channelValue && isChannel(channelValue)
      ? channelValue
      : fail(`Unknown channel: ${channelValue ?? "(missing)"}`);
  const stageId = stage ?? fail("A stage is required");

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
    if (!parsed.values[key]) fail(`--${key} is required`);
  }

  const campaign: CampaignBrief = {
    name: parsed.values.name!,
    product: parsed.values.product!,
    audience: parsed.values.audience!,
    offer: parsed.values.offer!,
    goal: parsed.values.goal!,
    ...(parsed.values.voice ? { voice: parsed.values.voice } : {}),
  };

  console.log(
    createCampaignPrompt({
      campaign,
      channel,
      stage: stageId,
    }),
  );
} else {
  fail(command ? `Unknown command: ${command}` : "A command is required");
}
