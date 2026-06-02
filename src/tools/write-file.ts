import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

const params = z.object({
  path: z.string().describe("要写入的文件路径（相对工作目录或绝对路径）"),
  content: z.string().describe("要写入的完整文件内容"),
});

/**
 * write_file：整文件写入（阶段 1 用）。
 *
 * 注意：阶段 2 会用 ⭐ Diff/Patch 引擎实现更省 token、更可读的 str_replace 编辑，
 * 届时这个整文件重写工具会退居二线（仅用于新建文件）。
 */
export const writeFileTool: ToolDefinition<typeof params> = {
  name: "write_file",
  description: "把给定内容整体写入文件（覆盖已有内容，不存在则创建）。",
  parameters: params,
  async execute(args, ctx) {
    const abs = path.resolve(ctx.cwd, args.path);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, "utf8");
    } catch (err) {
      return { content: `写入失败: ${(err as Error).message}`, isError: true };
    }
    const bytes = Buffer.byteLength(args.content, "utf8");
    return { content: `已写入 ${args.path}（${bytes} 字节）` };
  },
};
