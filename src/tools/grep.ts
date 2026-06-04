import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { findRipgrepPath } from "../utils/rg-path.js";
import { resolvePathInCwd } from "./path-utils.js";

const MAX_OUTPUT_CHARS = 50_000;

const params = z.object({
  pattern: z.string().describe("正则搜索模式"),
  path: z
    .string()
    .optional()
    .describe("文件或目录路径，相对工作目录，默认 ."),
  glob: z
    .string()
    .optional()
    .describe('文件 glob 过滤，如 "*.ts"'),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe("输出模式：content（默认）| files_with_matches | count"),
  "-i": z
    .boolean()
    .optional()
    .describe("忽略大小写"),
  head_limit: z
    .number()
    .optional()
    .describe("最多返回多少条匹配（content 模式为行数）"),
  "-A": z.number().optional().describe("匹配行后显示 N 行上下文"),
  "-B": z.number().optional().describe("匹配行前显示 N 行上下文"),
  "-C": z.number().optional().describe("匹配行前后各 N 行上下文"),
});

export const grepTool: ToolDefinition<typeof params> = {
  name: "grep",
  description:
    "在代码库中搜索文本（基于 ripgrep/rg）。优先用于按内容查找符号、字符串、用法。",
  parameters: params,
  async execute(args, ctx) {
    const rg = findRipgrepPath();
    if (!rg) {
      return {
        content:
          "未找到 ripgrep (rg)。请安装: brew install ripgrep，或设置 CURSOR_RIPGREP_PATH",
        isError: true,
      };
    }

    let searchPath: string;
    try {
      searchPath = resolvePathInCwd(ctx.cwd, args.path ?? ".");
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    const mode = args.output_mode ?? "content";
    const rgArgs: string[] = ["--color=never", "--no-heading"];

    if (args["-i"]) rgArgs.push("-i");
    if (args.glob) rgArgs.push("--glob", args.glob);

    if (mode === "files_with_matches") {
      rgArgs.push("-l");
    } else if (mode === "count") {
      rgArgs.push("--count-matches");
    } else {
      rgArgs.push("-n");
      if (args["-C"] != null) {
        rgArgs.push("-C", String(args["-C"]));
      } else {
        if (args["-A"] != null) rgArgs.push("-A", String(args["-A"]));
        if (args["-B"] != null) rgArgs.push("-B", String(args["-B"]));
      }
    }

    if (args.head_limit != null && args.head_limit > 0) {
      rgArgs.push("-m", String(args.head_limit));
    }

    rgArgs.push("--", args.pattern, searchPath);

    const { stdout, stderr, exitCode } = await runRg(rg, rgArgs, ctx.cwd);

    if (exitCode === 2) {
      return {
        content: stderr || stdout || "rg 执行失败",
        isError: true,
      };
    }

    let out = stdout.trimEnd();
    if (!out) {
      return { content: "(无匹配)" };
    }

    if (out.length > MAX_OUTPUT_CHARS) {
      out =
        out.slice(0, MAX_OUTPUT_CHARS) +
        `\n... [输出已截断，超过 ${MAX_OUTPUT_CHARS} 字符]`;
    }

    if (stderr.trim()) {
      out += `\n--- rg stderr ---\n${stderr.trim()}`;
    }

    return { content: out };
  },
};

function runRg(
  rg: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(rg, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString();
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: -1 });
    });
  });
}
