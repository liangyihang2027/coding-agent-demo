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

/**
 * run_command 工具。
 *
 * 阶段 1：仅做一个能跑通的最小封装，内部委托给 sandbox 模块。
 * 阶段 3 ⭐：sandbox/index.ts 才是真正的内核（超时 kill、进程树、僵尸进程、
 * 流式输出、危险命令拦截、输出截断），那时这个工具几乎不用改，只享受能力升级。
 */
export const runCommandTool: ToolDefinition<typeof params> = {
  name: "run_command",
  description: "在工作目录下执行一条 shell 命令，返回 stdout/stderr 与退出码。",
  parameters: params,
  async execute(args, ctx) {
    // 工具层只负责把模型意图转成统一结果；进程、超时和安全细节属于 sandbox 内核。
    const result = await runCommand(args.command, {
      cwd: ctx.cwd,
      timeoutMs: args.timeout_ms ?? 30_000,
      onChunk: ctx.onChunk,
    });

    const parts = [
      `exit_code: ${result.exitCode}`,
      result.timedOut ? "[已超时被终止]" : "",
      result.stdout ? `--- stdout ---\n${result.stdout}` : "",
      result.stderr ? `--- stderr ---\n${result.stderr}` : "",
    ].filter(Boolean);

    return {
      content: parts.join("\n"),
      isError: result.exitCode !== 0,
    };
  },
};
