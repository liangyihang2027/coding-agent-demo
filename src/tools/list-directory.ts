import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { resolvePathInCwd } from "./path-utils.js";

const MAX_ENTRIES = 500;

const params = z.object({
  path: z
    .string()
    .optional()
    .describe("要列出的目录路径，相对工作目录，默认 ."),
  recursive: z
    .boolean()
    .optional()
    .describe("是否递归列出子目录，默认 false"),
});

export const listDirectoryTool: ToolDefinition<typeof params> = {
  name: "list_directory",
  description:
    "列出目录下的文件和子目录（名称、类型）。用于探索项目结构。",
  parameters: params,
  async execute(args, ctx) {
    let abs: string;
    try {
      abs = resolvePathInCwd(ctx.cwd, args.path ?? ".");
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      return { content: `目录不存在: ${(err as Error).message}`, isError: true };
    }
    if (!stat.isDirectory()) {
      return { content: `不是目录: ${args.path ?? "."}`, isError: true };
    }

    const lines: string[] = [];
    let truncated = false;

    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (lines.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        lines.push(`${prefix}[无法读取: ${(err as Error).message}]`);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const ent of entries) {
        if (lines.length >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const rel = path.relative(ctx.cwd, path.join(dir, ent.name));
        const kind = ent.isDirectory() ? "dir" : ent.isFile() ? "file" : "other";
        lines.push(`${prefix}${rel} (${kind})`);

        if (args.recursive && ent.isDirectory()) {
          await walk(path.join(dir, ent.name), prefix);
        }
      }
    };

    await walk(abs, "");
    const footer = truncated
      ? `\n... [已截断，仅显示前 ${MAX_ENTRIES} 项]`
      : "";
    return { content: (lines.length ? lines.join("\n") : "(空目录)") + footer };
  },
};
