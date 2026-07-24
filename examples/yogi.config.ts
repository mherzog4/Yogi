import type { YogiConfig } from "@mherzog4/yogi";

export default {
  schemaVersion: 1,
  workspace: {
    name: "Founder Growth Lab",
  },
  product: {
    name: "Launch Map",
    description: "A planning assistant for focused SaaS launches.",
    positioning:
      "Turn a rough product idea into a credible launch plan in one afternoon.",
    audiences: ["Bootstrapped B2B SaaS founders preparing a product launch"],
    offers: ["Build a focused launch plan in one afternoon"],
    proof: [
      {
        claim: "Used by five design partners",
        source: "Internal customer research notes",
      },
    ],
    voice: {
      traits: ["clear", "specific", "credible", "human"],
      avoid: ["hype", "unsupported claims", "generic AI phrasing"],
    },
  },
  outbound: {
    dailyProspectLimit: 20,
    maxPerDomain: 2,
    requirePersonalization: true,
    allowRoleBasedAddresses: false,
  },
  content: {
    editorialMinimumScore: 80,
    prohibitedPhrases: ["guaranteed", "best-in-class", "game-changing"],
  },
  paidAds: {
    currency: "USD",
    maxDailyBudgetMinor: 5000,
    maxExperimentBudgetMinor: 50000,
    maxSpendWithoutConversionMinor: 10000,
    minimumCreativeVariants: 3,
    allowedLandingPageHosts: ["launch.example.com"],
    prohibitedPhrases: ["guaranteed results"],
  },
} satisfies YogiConfig;
