export type GtmChannel = "outbound-email" | "paid-ads" | "content";

export type StageKind = "research" | "create" | "review" | "execute";

export interface GtmStage {
  readonly id: string;
  readonly name: string;
  readonly kind: StageKind;
  readonly objective: string;
  readonly deliverables: readonly string[];
  readonly requiresApproval: boolean;
}

export interface GtmPlaybook {
  readonly channel: GtmChannel;
  readonly name: string;
  readonly stages: readonly GtmStage[];
}

const stage = (
  id: string,
  name: string,
  kind: StageKind,
  objective: string,
  deliverables: readonly string[],
  requiresApproval = false,
): GtmStage => ({
  id,
  name,
  kind,
  objective,
  deliverables,
  requiresApproval,
});

export const GTM_PLAYBOOKS: Readonly<Record<GtmChannel, GtmPlaybook>> = {
  "outbound-email": {
    channel: "outbound-email",
    name: "Outbound email",
    stages: [
      stage(
        "icp-definition",
        "ICP definition",
        "research",
        "Define the narrowest credible ideal customer profile and buying trigger.",
        ["icp.md", "qualification-rubric.md"],
      ),
      stage(
        "account-research",
        "Account research",
        "research",
        "Research qualified accounts and capture evidence for personalization.",
        ["accounts.csv", "research-notes.md"],
      ),
      stage(
        "sequence-draft",
        "Sequence draft",
        "create",
        "Draft a concise, evidence-based outbound sequence with useful variants.",
        ["sequence.md", "subject-lines.md"],
      ),
      stage(
        "quality-review",
        "Quality and compliance review",
        "review",
        "Check claims, personalization, deliverability risks, and compliance notes.",
        ["review.md", "approved-prospects.csv"],
      ),
      stage(
        "launch",
        "Launch",
        "execute",
        "Prepare or execute the approved send with explicit volume limits.",
        ["launch-plan.md", "send-log.csv"],
        true,
      ),
    ],
  },
  "paid-ads": {
    channel: "paid-ads",
    name: "Paid ads",
    stages: [
      stage(
        "channel-strategy",
        "Channel strategy",
        "research",
        "Choose a channel, audience, offer, and testable acquisition hypothesis.",
        ["strategy.md", "audience.md"],
      ),
      stage(
        "creative-briefs",
        "Creative briefs",
        "create",
        "Turn the campaign hypothesis into distinct creative concepts.",
        ["creative-briefs.md"],
      ),
      stage(
        "copy-variants",
        "Copy variants",
        "create",
        "Produce channel-native ad copy and landing-page message variants.",
        ["ad-copy.md", "landing-page-brief.md"],
      ),
      stage(
        "measurement-plan",
        "Measurement plan",
        "review",
        "Define events, budget boundaries, success thresholds, and stop conditions.",
        ["measurement.md", "experiment-plan.md"],
      ),
      stage(
        "launch",
        "Launch",
        "execute",
        "Create or update the approved campaign within its spend guardrails.",
        ["launch-plan.md", "change-log.md"],
        true,
      ),
    ],
  },
  content: {
    channel: "content",
    name: "Content",
    stages: [
      stage(
        "audience-research",
        "Audience research",
        "research",
        "Find recurring questions, language, objections, and distribution surfaces.",
        ["audience-insights.md", "source-notes.md"],
      ),
      stage(
        "pillar-brief",
        "Pillar brief",
        "research",
        "Define one useful content thesis and the evidence needed to support it.",
        ["pillar-brief.md"],
      ),
      stage(
        "draft",
        "Draft",
        "create",
        "Create a source-grounded draft in the chosen format and voice.",
        ["draft.md", "fact-check.md"],
      ),
      stage(
        "repurpose",
        "Repurpose",
        "create",
        "Adapt the pillar into channel-native derivative assets.",
        ["social-posts.md", "newsletter.md", "short-form.md"],
      ),
      stage(
        "editorial-review",
        "Editorial review",
        "review",
        "Check accuracy, originality, voice, usefulness, and calls to action.",
        ["editorial-review.md", "final.md"],
      ),
      stage(
        "publish",
        "Publish",
        "execute",
        "Publish approved assets and record their distribution locations.",
        ["distribution-plan.md", "publication-log.md"],
        true,
      ),
    ],
  },
};

export const getPlaybook = (channel: GtmChannel): GtmPlaybook =>
  GTM_PLAYBOOKS[channel];

export const getStage = (channel: GtmChannel, stageId: string): GtmStage => {
  const selected = getPlaybook(channel).stages.find(
    (candidate) => candidate.id === stageId,
  );

  if (!selected) {
    throw new Error(`Unknown ${channel} stage: ${stageId}`);
  }

  return selected;
};
