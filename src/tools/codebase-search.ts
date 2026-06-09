import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";
import { CodebaseIndex } from "../search/index.js";
import { resolvePathInCwd } from "./path-utils.js";

/**
 * 语义代码检索工具（阶段 4 的对外出口）。
 *
 * 与 grep 的分工：grep 是「精确文本/正则匹配」，这里是「按相关性召回」——用倒排索引 + BM25
 * 把最相关的代码片段排到前面，配合 tree-sitter 符号加权，适合「我想找处理 X 的代码在哪」这类
 * 模糊意图。两者互补：知道确切字符串用 grep，描述意图用 codebase_search。
 *
 * 索引按工作目录缓存：首次查询构建（要遍历磁盘 + 解析 AST），后续命中缓存秒回；
 * 文件有较大变化时可用 refresh 重建。
 */

const MAX_OUTPUT_CHARS = 20_000;

// 同一 cwd 的索引只构建一次（缓存 Promise 防止并发重复构建）。
const indexCache = new Map<string, Promise<CodebaseIndex>>();

const params = z.object({
  query: z
    .string()
    .describe("查询意图或关键词，按相关性召回最相关的代码片段"),
  limit: z.number().optional().describe("返回片段数上限，默认 8"),
  refresh: z
    .boolean()
    .optional()
    .describe("重建索引（代码有较大变化时使用）"),
});

function getIndex(root: string, refresh: boolean): Promise<CodebaseIndex> {
  if (refresh) indexCache.delete(root);
  let pending = indexCache.get(root);
  if (!pending) {
    pending = CodebaseIndex.build(root).catch((err) => {
      // 构建失败不要把坏 Promise 留在缓存里，否则后续查询永远拿到失败。
      indexCache.delete(root);
      throw err;
    });
    indexCache.set(root, pending);
  }
  return pending;
}

export const codebaseSearchTool: ToolDefinition<typeof params> = {
  name: "codebase_search",
  description:
    "按相关性语义检索代码库：用倒排索引 + BM25 召回与查询最相关的代码片段（含 tree-sitter 符号加权）。适合按意图找代码；要精确匹配字符串请用 grep。",
  parameters: params,
  async execute(args, ctx) {
    let root: string;
    try {
      root = resolvePathInCwd(ctx.cwd, ".");
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    let index: CodebaseIndex;
    try {
      index = await getIndex(root, args.refresh ?? false);
    } catch (err) {
      return {
        content: `构建代码索引失败: ${(err as Error).message}`,
        isError: true,
      };
    }

    const limit = args.limit && args.limit > 0 ? args.limit : 8;
    const hits = await index.query(args.query, limit);
    const stats = index.getStats();

    if (hits.length === 0) {
      return {
        content: `未召回相关片段（已索引 ${stats.files} 文件 / ${stats.symbols} 符号）。可换关键词，或用 grep 精确匹配。`,
      };
    }

    const header =
      `召回 ${hits.length} 个相关片段（索引 ${stats.files} 文件 / ${stats.symbols} 符号` +
      `${stats.truncated ? "，已达文件上限" : ""}）：\n`;

    const blocks = hits.map(
      (h) => `\n${h.file}:${h.line}  [score ${h.score.toFixed(2)}]\n${h.snippet}`
    );

    let out = header + blocks.join("\n");
    if (out.length > MAX_OUTPUT_CHARS) {
      out =
        out.slice(0, MAX_OUTPUT_CHARS) +
        `\n... [输出已截断，超过 ${MAX_OUTPUT_CHARS} 字符]`;
    }
    return { content: out };
  },
};
