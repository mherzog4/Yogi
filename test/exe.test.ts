import { describe, expect, it, vi } from "vitest";
import type {
  ExecResult,
  IsolatedCreateOptions,
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "@ai-hero/sandcastle";
import { exe } from "../src/sandboxes/exe.js";
import type { ProcessRunner, ProcessRunOptions } from "../src/process.js";

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions | undefined;
}

const successfulRunner = () => {
  const invocations: Invocation[] = [];
  const runner: ProcessRunner = vi.fn(
    async (
      command: string,
      args: readonly string[],
      options?: ProcessRunOptions,
    ): Promise<ExecResult> => {
      invocations.push({ command, args, options });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  );

  return { runner, invocations };
};

const createHandle = (
  provider: IsolatedSandboxProvider,
  options: IsolatedCreateOptions,
): Promise<IsolatedSandboxHandle> =>
  (
    provider as IsolatedSandboxProvider & {
      create(
        createOptions: IsolatedCreateOptions,
      ): Promise<IsolatedSandboxHandle>;
    }
  ).create(options);

describe("exe.dev sandbox provider", () => {
  it("creates, prepares, runs in, and removes a VM", async () => {
    const { runner, invocations } = successfulRunner();
    const provider = exe({
      name: "yogi-test-123",
      image: "ubuntu:24.04",
      tags: ["yogi", "test"],
      processRunner: runner,
    });

    const handle = await createHandle(provider, {
      env: {
        API_TOKEN: "secret with ' quotes",
      },
    });
    await handle.exec("printf hello", {
      cwd: "/home/exedev/yogi-workspace",
    });
    await handle.close();

    expect(invocations[0]?.args).toEqual([
      "exe.dev",
      "new",
      "--name=yogi-test-123",
      "--json",
      "--image=ubuntu:24.04",
      "--tag=yogi",
      "--tag=test",
    ]);
    expect(invocations[1]?.options?.stdin).toContain(
      `export API_TOKEN='secret with '"'"' quotes'`,
    );
    expect(invocations[2]?.args[0]).toBe("yogi-test-123.exe.xyz");
    expect(invocations[2]?.args[1]).toContain(".yogi-env");
    expect(invocations[3]?.args).toEqual([
      "exe.dev",
      "rm",
      "yogi-test-123",
      "--json",
    ]);
  });

  it("keeps a persistent VM on close", async () => {
    const { runner, invocations } = successfulRunner();
    const provider = exe({
      name: "yogi-persistent-1",
      persist: true,
      processRunner: runner,
    });

    const handle = await createHandle(provider, { env: {} });
    await handle.close();

    expect(
      invocations.some((invocation) => invocation.args.includes("rm")),
    ).toBe(false);
  });

  it("rejects unsafe environment names before transferring secrets", async () => {
    const { runner } = successfulRunner();
    const provider = exe({
      name: "yogi-invalid-env",
      processRunner: runner,
    });

    await expect(
      createHandle(provider, { env: { "NOT-SAFE": "value" } }),
    ).rejects.toThrow("Invalid environment variable name");
  });

  it("rejects malformed VM names before running SSH", async () => {
    const { runner } = successfulRunner();
    const provider = exe({
      name: "UPPERCASE",
      processRunner: runner,
    });

    await expect(createHandle(provider, { env: {} })).rejects.toThrow(
      "exe.dev VM names",
    );
    expect(runner).not.toHaveBeenCalled();
  });
});
