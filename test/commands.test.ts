import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/commands.js";
import { writeValidConfig } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Yogi CLI", () => {
  it("initializes, creates, lists, and prompts from a campaign", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yogi-cli-test-"));
    temporaryDirectories.push(cwd);
    const output: string[] = [];
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };

    expect(await runCli(["init", "--name", "Growth Lab"], context)).toBe(0);
    await writeValidConfig(cwd);
    expect(
      await runCli(
        [
          "campaign",
          "create",
          "content",
          "--name",
          "Founder Stories",
          "--goal",
          "Earn 100 qualified subscribers",
        ],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(["campaign", "status", "founder-stories"], context),
    ).toBe(0);
    expect(
      await runCli(["campaign", "prompt", "founder-stories", "draft"], context),
    ).toBe(0);

    expect(errors).toEqual([]);
    expect(output.join("\n")).toContain("Created campaign founder-stories");
    expect(output.join("\n")).toContain("publish · approval required");
    expect(output.join("\n")).toContain("campaigns/founder-stories/");
  });

  it("returns a useful error when the config is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yogi-cli-test-"));
    temporaryDirectories.push(cwd);
    const errors: string[] = [];

    const exitCode = await runCli(
      [
        "campaign",
        "create",
        "outbound-email",
        "--name",
        "Missing Config",
        "--goal",
        "Book demos",
      ],
      {
        cwd,
        stdout: () => undefined,
        stderr: (value) => errors.push(value),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Run `yogi init` first");
  });

  it("imports, suppresses, and plans outbound without sending", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yogi-cli-test-"));
    temporaryDirectories.push(cwd);
    const output: string[] = [];
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };

    await runCli(["init", "--name", "Outbound Lab"], context);
    await writeValidConfig(cwd);
    await runCli(
      [
        "campaign",
        "create",
        "outbound-email",
        "--name",
        "Founder Outbound",
        "--goal",
        "Book demos",
      ],
      context,
    );
    const csvPath = join(cwd, "prospects.csv");
    await writeFile(
      csvPath,
      `email,company,source,personalization
alice@example.com,Example,Research,Relevant launch
bob@blocked.com,Blocked,Research,Relevant launch
`,
      "utf8",
    );

    expect(
      await runCli(
        ["outbound", "import", "founder-outbound", csvPath],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "outbound",
          "suppress",
          "founder-outbound",
          "blocked.com",
          "--type",
          "domain",
          "--reason",
          "Existing customer",
        ],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(["outbound", "plan", "founder-outbound"], context),
    ).toBe(0);
    expect(
      await runCli(
        ["outbound", "plan", "founder-outbound", "--mode", "send"],
        context,
      ),
    ).toBe(1);
    expect(
      await runCli(
        [
          "outbound",
          "plan",
          "founder-outbound",
          "--mode",
          "send",
          "--approved",
        ],
        context,
      ),
    ).toBe(0);

    expect(output.join("\n")).toContain("Imported 2 prospects");
    expect(output.join("\n")).toContain("1 selected, 1 excluded");
    expect(output.join("\n")).toContain("No email was sent");
    expect(output.join("\n")).not.toContain("alice@example.com");
    expect(errors.join("\n")).toContain("require approved: true");
  });
});
