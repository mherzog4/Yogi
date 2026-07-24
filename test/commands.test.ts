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

  it("runs a grounded content workflow through editorial review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yogi-cli-test-"));
    temporaryDirectories.push(cwd);
    const output: string[] = [];
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };

    await writeValidConfig(cwd);
    await runCli(
      [
        "campaign",
        "create",
        "content",
        "--name",
        "Founder Content",
        "--goal",
        "Earn qualified subscribers",
      ],
      context,
    );
    const sourcePath = join(cwd, "source.md");
    await writeFile(
      sourcePath,
      "# Source\n\nEvidence-based launch advice earns trust.",
      "utf8",
    );
    expect(
      await runCli(
        [
          "content",
          "source",
          "add",
          "founder-content",
          sourcePath,
          "--title",
          "Launch research",
          "--type",
          "original",
        ],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "content",
          "brief",
          "create",
          "founder-content",
          "--title",
          "Credible launches",
          "--thesis",
          "Specific evidence earns trust",
          "--format",
          "linkedin-post",
          "--cta",
          "Read the launch guide",
          "--source",
          "launch-research",
        ],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["content", "prompt", "founder-content", "credible-launches"],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "content",
          "repurpose",
          "founder-content",
          "credible-launches",
          "--format",
          "newsletter",
          "--format",
          "x-thread",
        ],
        context,
      ),
    ).toBe(0);

    const draftPath = join(cwd, "draft.md");
    const body = Array.from(
      { length: 24 },
      () => "Specific evidence helps focused teams make responsible decisions.",
    ).join(" ");
    await writeFile(
      draftPath,
      `# Credible launches\n\n${body} [[source:launch-research]]\n\nRead the launch guide`,
      "utf8",
    );
    expect(
      await runCli(
        [
          "content",
          "review",
          "founder-content",
          "credible-launches",
          draftPath,
        ],
        context,
      ),
    ).toBe(0);

    expect(errors).toEqual([]);
    expect(output.join("\n")).toContain("Added source launch-research");
    expect(output.join("\n")).toContain("Created content brief");
    expect(output.join("\n")).toContain("[[source:launch-research]]");
    expect(output.join("\n")).toContain("Created repurpose plan with 2 assets");
    expect(output.join("\n")).toContain("Editorial review passed: 100/80");
  });

  it("plans a paid experiment without creating or activating ads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yogi-cli-test-"));
    temporaryDirectories.push(cwd);
    const output: string[] = [];
    const errors: string[] = [];
    const context = {
      cwd,
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };
    await writeValidConfig(cwd);
    await runCli(
      [
        "campaign",
        "create",
        "paid-ads",
        "--name",
        "Launch Ads",
        "--goal",
        "Generate qualified signups",
      ],
      context,
    );

    expect(
      await runCli(
        [
          "ads",
          "experiment",
          "create",
          "launch-ads",
          "--name",
          "Search intent test",
          "--objective",
          "Generate qualified signups",
          "--hypothesis",
          "Specific language attracts focused founders",
          "--channel",
          "search",
          "--landing-page",
          "https://launch.example.com/plan",
          "--conversion",
          "launch_plan_started",
          "--utm-source",
          "search",
          "--utm-medium",
          "paid",
          "--utm-campaign",
          "search-intent-test",
          "--daily-budget-minor",
          "3000",
          "--total-budget-minor",
          "30000",
          "--stop-loss-minor",
          "10000",
        ],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["ads", "creative", "prompt", "launch-ads", "search-intent-test"],
        context,
      ),
    ).toBe(0);

    const creativePath = join(cwd, "creative.json");
    await writeFile(
      creativePath,
      JSON.stringify({
        schemaVersion: 1,
        experimentId: "search-intent-test",
        variants: [
          {
            id: "variant-a",
            headline: "Plan a focused SaaS launch",
            body: "Turn a rough idea into a practical launch plan.",
            callToAction: "Build your plan",
          },
          {
            id: "variant-b",
            headline: "Give your launch a clear map",
            body: "Organize positioning, channels, and next steps.",
            callToAction: "See the workflow",
          },
          {
            id: "variant-c",
            headline: "Launch with a credible sequence",
            body: "Move from product idea to focused distribution.",
            callToAction: "Start planning",
          },
        ],
      }),
      "utf8",
    );
    expect(
      await runCli(
        ["ads", "review", "launch-ads", "search-intent-test", creativePath],
        context,
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["ads", "plan", "launch-ads", "search-intent-test", "--mode", "launch"],
        context,
      ),
    ).toBe(1);
    expect(
      await runCli(
        [
          "ads",
          "plan",
          "launch-ads",
          "search-intent-test",
          "--mode",
          "launch",
          "--approved",
        ],
        context,
      ),
    ).toBe(0);

    expect(output.join("\n")).toContain(
      "Created paid experiment search-intent-test",
    );
    expect(output.join("\n")).toContain("Paid launch review passed");
    expect(output.join("\n")).toContain("no external action was performed");
    expect(errors.join("\n")).toContain("approved: true");
  });
});
