import { mkdtemp, rm } from "node:fs/promises";
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
});
