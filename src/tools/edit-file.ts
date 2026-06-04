import { promises as fs } from "node:fs";
import { z } from "zod";
import { strReplace } from "../diff/index.js";
import type { ToolDefinition } from "../types/index.js";
import { resolvePathInCwd } from "./path-utils.js";

const params = z.object({
  path: z.string().describe("要编辑的文件路径（相对工作目录或绝对路径）"),
  old_string: z.string().describe("要被替换的原文本（须在文件中唯一匹配）"),
  new_string: z.string().describe("替换后的新文本"),
});

/**
 * edit_file：基于 Diff 引擎的局部替换（阶段 2 最小可用版）。
 * 比 write_file 整文件重写更省 token、更可读。
 */
export const editFileTool: ToolDefinition<typeof params> = {
  name: "edit_file",
  description:
    "在文件中用唯一匹配的 old_string 替换为 new_string。匹配 0 次或多于 1 次会报错。",
  parameters: params,
  async execute(args, ctx) {
    let abs: string;
    try {
      abs = resolvePathInCwd(ctx.cwd, args.path);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    let source: string;
    try {
      source = await fs.readFile(abs, "utf8");
    } catch (err) {
      return { content: `读取失败: ${(err as Error).message}`, isError: true };
    }

    const replaced = strReplace({
      source,
      oldText: args.old_string,
      newText: args.new_string,
    });

    if (!replaced.ok) {
      if (replaced.reason === "not_found") {
        return {
          content: `未找到要替换的文本。请确认 old_string 与文件内容完全一致。`,
          isError: true,
        };
      }
      return {
        content: `匹配到 ${replaced.matches} 处，请提供更多上下文使 old_string 唯一。`,
        isError: true,
      };
    }

    try {
      await fs.writeFile(abs, replaced.result, "utf8");
    } catch (err) {
      return { content: `写入失败: ${(err as Error).message}`, isError: true };
    }

    return { content: `已编辑 ${args.path}` };
  },
};
