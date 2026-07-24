import type { CampaignBrief } from "../campaign.js";

export type ContentSourceType = "original" | "customer-research" | "external";

export interface ContentSource {
  readonly id: string;
  readonly title: string;
  readonly type: ContentSourceType;
  readonly repositoryPath: string;
  readonly sha256: string;
  readonly addedAt: string;
  readonly url?: string;
}

export type ContentFormat =
  "article" | "newsletter" | "linkedin-post" | "x-thread" | "video-script";

export interface ContentBrief {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly campaignId: string;
  readonly title: string;
  readonly thesis: string;
  readonly format: ContentFormat;
  readonly callToAction: string;
  readonly audience: string;
  readonly sourceIds: readonly string[];
  readonly createdAt: string;
}

export interface RepurposeAsset {
  readonly format: ContentFormat;
  readonly objective: string;
  readonly guidance: readonly string[];
}

export interface RepurposePlan {
  readonly schemaVersion: 1;
  readonly briefId: string;
  readonly createdAt: string;
  readonly assets: readonly RepurposeAsset[];
}

const FORMAT_GUIDANCE: Readonly<
  Record<ContentFormat, { minimumWords: number; guidance: readonly string[] }>
> = {
  article: {
    minimumWords: 600,
    guidance: [
      "Use a descriptive H1 and scannable H2 sections.",
      "Develop one defensible thesis rather than a list of generic tips.",
      "Cite source markers next to the claims they support.",
    ],
  },
  newsletter: {
    minimumWords: 350,
    guidance: [
      "Open with a concrete observation or tension.",
      "Use short sections suited to email reading.",
      "End with one clear call to action.",
    ],
  },
  "linkedin-post": {
    minimumWords: 120,
    guidance: [
      "Lead with the useful claim, not an engagement hook.",
      "Keep paragraphs short and avoid manufactured controversy.",
      "Use at most one call to action.",
    ],
  },
  "x-thread": {
    minimumWords: 80,
    guidance: [
      "Write five to ten standalone posts with a coherent progression.",
      "Put the core thesis in the first post.",
      "Avoid splitting sentences merely to increase post count.",
    ],
  },
  "video-script": {
    minimumWords: 250,
    guidance: [
      "Write for spoken delivery with explicit scene or visual notes.",
      "State the viewer payoff in the opening.",
      "Close with one natural call to action.",
    ],
  },
};

export const contentFormatGuidance = (
  format: ContentFormat,
): { minimumWords: number; guidance: readonly string[] } => {
  const guidance = FORMAT_GUIDANCE[format];
  if (!guidance) throw new Error(`Unknown content format: ${String(format)}`);
  return guidance;
};

export const createContentPrompt = (options: {
  readonly campaign: CampaignBrief;
  readonly brief: ContentBrief;
  readonly sources: readonly ContentSource[];
}): string => {
  const { campaign, brief, sources } = options;
  const format = contentFormatGuidance(brief.format);
  const selectedSources = brief.sourceIds.map((id) => {
    const source = sources.find((candidate) => candidate.id === id);
    if (!source)
      throw new Error(`Content brief references unknown source: ${id}`);
    return source;
  });

  return `# Grounded content draft

Create a **${brief.format}** for the **${campaign.name}** campaign.

## Brief

- Title: ${brief.title}
- Thesis: ${brief.thesis}
- Audience: ${brief.audience}
- Call to action: ${brief.callToAction}
- Minimum length: ${format.minimumWords} words
- Output: \`campaigns/${brief.campaignId}/content/drafts/${brief.id}.md\`

## Product context

- Product: ${campaign.product}
- Offer: ${campaign.offer}
- Goal: ${campaign.goal}
- Voice: ${campaign.voice ?? "clear, specific, credible, and human"}

## Sources

${selectedSources
  .map(
    (source) =>
      `- \`[[source:${source.id}]]\` — ${source.title} at \`${source.repositoryPath}\`${source.url ? ` (${source.url})` : ""}`,
  )
  .join("\n")}

## Format guidance

${format.guidance.map((item) => `- ${item}`).join("\n")}

## Grounding rules

1. Read every listed source before drafting.
2. Put \`[[source:<id>]]\` immediately after sourced factual claims.
3. Do not invent metrics, customers, quotes, product behavior, or outcomes.
4. Clearly label hypotheses and opinions.
5. Do not copy long passages from a source; synthesize in the campaign voice.
6. Include the exact call to action.
7. Remove TODOs and placeholders before completing the draft.
`;
};

export const createRepurposePlan = (options: {
  readonly brief: ContentBrief;
  readonly formats: readonly ContentFormat[];
  readonly now?: Date;
}): RepurposePlan => {
  const uniqueFormats = [...new Set(options.formats)];
  if (uniqueFormats.length === 0) {
    throw new Error("A repurpose plan requires at least one format");
  }

  return {
    schemaVersion: 1,
    briefId: options.brief.id,
    createdAt: (options.now ?? new Date()).toISOString(),
    assets: uniqueFormats.map((format) => ({
      format,
      objective: `Adapt "${options.brief.title}" into a ${format} without changing its core thesis.`,
      guidance: contentFormatGuidance(format).guidance,
    })),
  };
};

export type EditorialSeverity = "error" | "warning";

export interface EditorialIssue {
  readonly code:
    | "missing-heading"
    | "below-minimum-length"
    | "missing-source"
    | "missing-cta"
    | "placeholder"
    | "prohibited-phrase";
  readonly severity: EditorialSeverity;
  readonly message: string;
}

export interface EditorialReport {
  readonly schemaVersion: 1;
  readonly briefId: string;
  readonly reviewedAt: string;
  readonly wordCount: number;
  readonly score: number;
  readonly minimumScore: number;
  readonly passed: boolean;
  readonly issues: readonly EditorialIssue[];
}

const words = (markdown: string): string[] =>
  markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]()!-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export const reviewEditorialDraft = (options: {
  readonly markdown: string;
  readonly brief: ContentBrief;
  readonly sources: readonly ContentSource[];
  readonly prohibitedPhrases?: readonly string[];
  readonly minimumScore?: number;
  readonly now?: Date;
}): EditorialReport => {
  const issues: EditorialIssue[] = [];
  const wordCount = words(options.markdown).length;
  const format = contentFormatGuidance(options.brief.format);
  const lower = options.markdown.toLowerCase();

  if (!/^#\s+\S+/m.test(options.markdown)) {
    issues.push({
      code: "missing-heading",
      severity: "error",
      message: "Draft must include a descriptive H1 heading.",
    });
  }
  if (wordCount < format.minimumWords) {
    issues.push({
      code: "below-minimum-length",
      severity: "warning",
      message: `Draft has ${wordCount} words; ${options.brief.format} requires at least ${format.minimumWords}.`,
    });
  }
  for (const sourceId of options.brief.sourceIds) {
    if (!options.sources.some(({ id }) => id === sourceId)) {
      throw new Error(`Content brief references unknown source: ${sourceId}`);
    }
    if (!options.markdown.includes(`[[source:${sourceId}]]`)) {
      issues.push({
        code: "missing-source",
        severity: "error",
        message: `Draft does not cite required source ${sourceId}.`,
      });
    }
  }
  if (!lower.includes(options.brief.callToAction.toLowerCase())) {
    issues.push({
      code: "missing-cta",
      severity: "error",
      message: "Draft does not include the brief's exact call to action.",
    });
  }
  if (/\b(?:TODO|TBD|PLACEHOLDER|INSERT\s+HERE)\b/i.test(options.markdown)) {
    issues.push({
      code: "placeholder",
      severity: "error",
      message: "Draft contains an unresolved placeholder.",
    });
  }
  for (const phrase of options.prohibitedPhrases ?? []) {
    if (phrase.trim() && lower.includes(phrase.toLowerCase())) {
      issues.push({
        code: "prohibited-phrase",
        severity: "error",
        message: `Draft contains prohibited phrase: ${phrase}`,
      });
    }
  }

  const score = Math.max(
    0,
    100 -
      issues.reduce(
        (total, issue) => total + (issue.severity === "error" ? 20 : 10),
        0,
      ),
  );
  const minimumScore = options.minimumScore ?? 80;
  return {
    schemaVersion: 1,
    briefId: options.brief.id,
    reviewedAt: (options.now ?? new Date()).toISOString(),
    wordCount,
    score,
    minimumScore,
    passed:
      score >= minimumScore &&
      !issues.some(({ severity }) => severity === "error"),
    issues,
  };
};
