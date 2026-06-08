import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { runCommand } from "../sandbox/index.js";

const params = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  timeout_ms: z
    .number()
    .optional()
    .describe("超时毫秒数，默认 30000"),
});

export const runCommandTool: ToolDefinition<typeof params> = {
  name: "run_command",
  description: "在工作目录下执行一条 shell 命令，返回 stdout/stderr 与退出码。",
  parameters: params,
  async execute(args, ctx) {
    const result = await runCommand(args.command, {
      cwd: ctx.cwd,
      timeoutMs: args.timeout_ms ?? 30_000,
      onChunk: ctx.onChunk,
    });

    if (result.blocked) {
      return {
        content: `命令被沙箱拦截，拒绝执行。\n${result.stderr}`,
        isError: true,
      };
    }

    const parts = [
      `exit_code: ${result.exitCode}`,
      result.timedOut
        ? `[已超时被终止 (${result.killedBySignal ?? "unknown"})]`
        : "",
      result.truncated ? "[输出已截断，保留头尾]" : "",
      result.stdout ? `--- stdout ---\n${result.stdout}` : "",
      result.stderr ? `--- stderr ---\n${result.stderr}` : "",
    ].filter(Boolean);

    return {
      content: parts.join("\n"),
      isError: result.exitCode !== 0,
    };
  },
};
