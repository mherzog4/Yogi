import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  initWorkspace,
  loadYogiConfig,
  validateYogiConfig,
} from "../src/config.js";
import { writeValidConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "yogi-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Yogi configuration", () => {
  it("initializes a typed config and requires placeholder replacement", async () => {
    const cwd = await temporaryDirectory();
    const initialized = await initWorkspace({
      cwd,
      name: "Founder Growth",
    });
    const source = await readFile(initialized.configPath, "utf8");

    await expect(loadYogiConfig({ cwd })).rejects.toThrow(
      "must replace the generated TODO placeholder",
    );
    expect(source).toContain('name: "Founder Growth"');
    expect(source).toContain("satisfies YogiConfig");

    await writeValidConfig(cwd);
    const config = await loadYogiConfig({ cwd });
    expect(config.workspace.name).toBe("Growth Lab");
    expect(config.product.voice.traits).toContain("specific");
  });

  it("does not overwrite an existing config without force", async () => {
    const cwd = await temporaryDirectory();
    await initWorkspace({ cwd, name: "First" });

    await expect(initWorkspace({ cwd, name: "Second" })).rejects.toThrow(
      "already exists",
    );

    await initWorkspace({ cwd, name: "Second", force: true });
    expect(await readFile(join(cwd, "yogi.config.ts"), "utf8")).toContain(
      'name: "Second"',
    );
  });

  it("reports all useful validation failures together", () => {
    expect(() =>
      validateYogiConfig({
        schemaVersion: 2,
        workspace: { name: "" },
        product: {
          name: "Product",
          description: "",
          positioning: "Positioning",
          audiences: [],
          offers: ["Offer"],
          proof: [{ claim: "" }],
          voice: { traits: [], avoid: "hype" },
        },
        outbound: {
          dailyProspectLimit: 0,
          maxPerDomain: 1.5,
          requirePersonalization: "yes",
          allowRoleBasedAddresses: false,
        },
        content: {
          editorialMinimumScore: 101,
          prohibitedPhrases: "guaranteed",
        },
      }),
    ).toThrow(ConfigValidationError);

    try {
      validateYogiConfig({
        schemaVersion: 2,
        workspace: { name: "" },
        product: {
          name: "Product",
          description: "",
          positioning: "Positioning",
          audiences: [],
          offers: ["Offer"],
          proof: [{ claim: "" }],
          voice: { traits: [], avoid: "hype" },
        },
        outbound: {
          dailyProspectLimit: 0,
          maxPerDomain: 1.5,
          requirePersonalization: "yes",
          allowRoleBasedAddresses: false,
        },
        content: {
          editorialMinimumScore: 101,
          prohibitedPhrases: "guaranteed",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual(
        expect.arrayContaining([
          "schemaVersion must be 1",
          "workspace.name must be a non-empty string",
          "product.audiences must include at least one value",
          "product.voice.avoid must be an array of strings",
          "outbound.dailyProspectLimit must be a positive integer",
          "outbound.maxPerDomain must be a positive integer",
          "outbound.requirePersonalization must be a boolean",
          "content.editorialMinimumScore must be an integer from 0 to 100",
          "content.prohibitedPhrases must be an array of strings",
        ]),
      );
    }
  });
});
