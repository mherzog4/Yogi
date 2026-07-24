import { spawn } from "node:child_process";
import type { ExecResult } from "@ai-hero/sandcastle";

export interface ProcessRunOptions {
  readonly stdin?: string;
  readonly onStdoutLine?: (line: string) => void;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ExecResult>;

export const runProcess: ProcessRunner = (
  command,
  args,
  options,
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let partialLine = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;

      if (!options?.onStdoutLine) return;

      const lines = `${partialLine}${chunk}`.split("\n");
      partialLine = lines.pop() ?? "";
      for (const line of lines) options.onStdoutLine(line);
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (partialLine && options?.onStdoutLine) {
        options.onStdoutLine(partialLine);
      }

      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
      });
    });

    if (options?.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
