import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { resolvePathInCwd } from "./path-utils.js";

const MAX_FILES = 500;

const params = z.object({
  glob_pattern: z
    .string()
    .describe('glob 模式，如 "**/*.ts" 或 "src/**/*.tsx"'),
  target_directory: z
    .string()
    .optional()
    .describe("搜索根目录，相对工作目录，默认 ."),
});

/** 将简单 glob 转为正则（支持 ** 与 *） */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (/[+^${}()|[\]\\.]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}

export const globFilesTool: ToolDefinition<typeof params> = {
  name: "glob_files",
  description:
    "按 glob 模式在工作目录内查找文件路径。适合按文件名/后缀定位文件。",
  parameters: params,
  async execute(args, ctx) {
    let root: string;
    try {
      root = resolvePathInCwd(ctx.cwd, args.target_directory ?? ".");
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    const matcher = globToRegExp(args.glob_pattern);
    const matches: string[] = [];
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const ent of entries) {
        if (matches.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        if (ent.name === "node_modules" || ent.name === ".git") continue;

        const full = path.join(dir, ent.name);
        const rel = path.relative(ctx.cwd, full).split(path.sep).join("/");

        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile() && matcher.test(rel)) {
          matches.push(rel);
        }
      }
    };

    try {
      const st = await fs.stat(root);
      if (!st.isDirectory()) {
        return { content: `不是目录: ${args.target_directory ?? "."}`, isError: true };
      }
    } catch (err) {
      return { content: `目录不存在: ${(err as Error).message}`, isError: true };
    }

    await walk(root);
    matches.sort();
    const footer = truncated
      ? `\n... [已截断，仅显示前 ${MAX_FILES} 个文件]`
      : "";
    const body =
      matches.length > 0 ? matches.join("\n") : "(无匹配文件)";
    return { content: body + footer };
  },
};
