import { promises as fs } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { resolvePathInCwd } from "./path-utils.js";

const params = z.object({
  path: z.string().describe("要删除的文件路径（相对工作目录或绝对路径）"),
});

export const deleteFileTool: ToolDefinition<typeof params> = {
  name: "delete_file",
  description: "删除一个文件（不删除目录）。",
  parameters: params,
  async execute(args, ctx) {
    let abs: string;
    try {
      abs = resolvePathInCwd(ctx.cwd, args.path);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        return { content: `是目录而非文件，请用 run_command 删除目录: ${args.path}`, isError: true };
      }
      await fs.unlink(abs);
    } catch (err) {
      return { content: `删除失败: ${(err as Error).message}`, isError: true };
    }
    return { content: `已删除 ${args.path}` };
  },
};
