import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

const params = z.object({
  path: z.string().describe("要读取的文件路径（相对工作目录或绝对路径）"),
});

/** 单次读取的最大行数，避免超大文件撑爆上下文（阶段 5 会做更智能的裁剪） */
const MAX_LINES = 2000;

export const readFileTool: ToolDefinition<typeof params> = {
  name: "read_file",
  description:
    "读取一个文本文件的内容，返回带行号的文本。超长文件会被截断。",
  parameters: params,
  async execute(args, ctx) {
    // 工具接受相对路径是为了贴近用户表达；真正访问文件前统一落到 cwd 边界内解析。
    const abs = path.resolve(ctx.cwd, args.path);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch (err) {
      return { content: `读取失败: ${(err as Error).message}`, isError: true };
    }

    // 阶段一先用行数做粗粒度保护；阶段五会用 token 预算做更精确的上下文裁剪。
    const lines = text.split("\n");
    const truncated = lines.length > MAX_LINES;
    const shown = truncated ? lines.slice(0, MAX_LINES) : lines;
    const numbered = shown
      .map((line, i) => `${String(i + 1).padStart(6)}|${line}`)
      .join("\n");

    const footer = truncated
      ? `\n... [已截断，共 ${lines.length} 行，仅显示前 ${MAX_LINES} 行]`
      : "";
    return { content: numbered + footer };
  },
};
