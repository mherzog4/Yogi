import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const validConfigSource = `export default {
  schemaVersion: 1,
  workspace: {
    name: "Growth Lab",
  },
  product: {
    name: "Launch Map",
    description: "A planning assistant for focused SaaS launches.",
    positioning: "Turn a rough idea into a credible launch plan in one afternoon.",
    audiences: ["Bootstrapped B2B SaaS founders"],
    offers: ["Build a launch plan in one afternoon"],
    proof: [
      {
        claim: "Used by five design partners",
        source: "Customer research notes",
      },
    ],
    voice: {
      traits: ["clear", "specific", "credible", "human"],
      avoid: ["hype", "unsupported claims"],
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
};
`;

export const writeValidConfig = (cwd: string): Promise<void> =>
  writeFile(join(cwd, "yogi.config.ts"), validConfigSource, "utf8");
