/**
 * ⭐⭐⭐ 阶段 4「代码库检索」—— 项目的灵魂，必须做到这一阶段。⭐⭐⭐
 *
 * 目标（蓝图 §阶段4）：解决「大代码库塞不进 context window」。
 *
 * 已实现：
 *   [x] 文件遍历 + .gitignore 忽略规则解析            -> walk.ts / gitignore.ts
 *   [x] 关键词检索（倒排索引取 posting list）          -> inverted-index.ts
 *   [x] 用 tree-sitter 做 AST 解析，提取函数/类/符号    -> symbols.ts
 *   [x] 构建符号索引（符号名进倒排索引并加权）          -> 本文件 build()
 *   [x] 相关性召回（BM25 排序文件 + 文件内最佳行定位）  -> 本文件 query()
 *   [x] 上下文裁剪（召回结果按 token 预算截断）          -> 本文件 query()
 *
 * 设计取向：
 *   - 文档粒度 = 文件，用 BM25 先召回最相关的文件；再在文件内按「命中查询词的行」定位片段，
 *     把宝贵的 token 预算花在真正相关的代码上，而不是整文件塞进上下文。
 *   - 符号名（来自 AST）按权重重复进索引：代码里最该被检索命中的就是定义符号的位置。
 *   - 片段在查询时按需读盘，避免把整库内容常驻内存。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { InvertedIndex } from "./inverted-index.js";
import { extractSymbols, type CodeSymbol } from "./symbols.js";
import { tokenize, tokenizeQuery } from "./tokenize.js";
import { collectFiles, type WalkOptions } from "./walk.js";

export interface SearchHit {
  file: string;
  line: number;
  snippet: string;
  score: number;
}

export interface CodeSearch {
  /** 按 query 召回最相关的若干片段 */
  query(text: string, limit?: number): Promise<SearchHit[]>;
}

export interface IndexStats {
  files: number;
  symbols: number;
  truncated: boolean;
}

export interface BuildOptions extends WalkOptions {
  /** 符号名进索引时的重复次数（提升「定义处」相关性），默认 4 */
  symbolBoost?: number;
}

export interface QueryOptions {
  /** 返回片段数上限（默认 10） */
  limit?: number;
  /** 片段上下文行数（命中行上下各取 N 行，默认 2） */
  contextLines?: number;
  /**
   * token 预算：所有片段合计的约束（按 ~4 字符/token 估算），默认 1500。
   * 这是「上下文裁剪」的开关——召回再多，也不会超过预算喂给模型。
   */
  tokenBudget?: number;
}

/** 粗略 token 估算：英文/代码约 4 字符 1 token，够做预算裁剪。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 代码库索引 + 检索。用 build() 异步构建（要遍历磁盘 + 解析 AST），构建后 query() 同步召回。
 */
export class CodebaseIndex implements CodeSearch {
  private constructor(
    private readonly root: string,
    private readonly index: InvertedIndex,
    private readonly symbolsByFile: Map<string, CodeSymbol[]>,
    private readonly stats: IndexStats
  ) {}

  getStats(): IndexStats {
    return this.stats;
  }

  /** 遍历仓库、读取文本、提取符号，建立倒排索引。 */
  static async build(
    root: string,
    opts: BuildOptions = {}
  ): Promise<CodebaseIndex> {
    const symbolBoost = opts.symbolBoost ?? 4;
    const { files, truncated } = await collectFiles(root, opts);

    const index = new InvertedIndex();
    const symbolsByFile = new Map<string, CodeSymbol[]>();
    let symbolCount = 0;

    for (const rel of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(root, rel), "utf8");
      } catch {
        continue;
      }

      const tokens = tokenize(content);

      // 符号名加权进索引：让「定义了该符号的文件」在按符号名检索时排得更靠前。
      const symbols = await safeExtract(rel, content);
      if (symbols.length > 0) {
        symbolsByFile.set(rel, symbols);
        symbolCount += symbols.length;
        for (const sym of symbols) {
          const symTokens = tokenize(sym.name);
          for (let i = 0; i < symbolBoost; i++) tokens.push(...symTokens);
        }
      }

      index.addDocument(rel, tokens);
    }

    return new CodebaseIndex(root, index, symbolsByFile, {
      files: files.length,
      symbols: symbolCount,
      truncated,
    });
  }

  /**
   * 召回最相关的代码片段。
   * 流程：BM25 排序文件 -> 每个文件内定位命中查询词最多的行 -> 取上下文构成片段 ->
   *       按 token 预算累加，超预算即停（保证至少返回最相关的一条）。
   */
  async query(text: string, limit?: number): Promise<SearchHit[]> {
    return this.queryWith(text, { limit });
  }

  async queryWith(text: string, opts: QueryOptions = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10;
    const contextLines = opts.contextLines ?? 2;
    const tokenBudget = opts.tokenBudget ?? 1500;

    const qTokens = tokenizeQuery(text);
    if (qTokens.length === 0) return [];
    const qSet = new Set(qTokens);

    // 多召回一些候选文件，给「文件内定位失败时跳过」留余地。
    const candidates = this.index.search(qTokens, Math.max(limit * 3, 20));

    const hits: SearchHit[] = [];
    let usedTokens = 0;

    for (const cand of candidates) {
      if (hits.length >= limit) break;

      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, cand.ref), "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const best = bestLine(lines, qSet, this.symbolsByFile.get(cand.ref));
      if (best == null) continue;

      const snippet = buildSnippet(lines, best, contextLines);
      const cost = estimateTokens(snippet);
      // 预算用尽就停；但首条无论如何要给（否则空手而归没意义）。
      if (hits.length > 0 && usedTokens + cost > tokenBudget) break;

      hits.push({
        file: cand.ref,
        line: best + 1,
        snippet,
        score: cand.score,
      });
      usedTokens += cost;
    }

    return hits;
  }
}

/** 符号提取失败（语法 wasm 缺失/解析异常）不应中断建索引，降级为仅文本索引。 */
async function safeExtract(
  rel: string,
  content: string
): Promise<CodeSymbol[]> {
  try {
    return await extractSymbols(rel, content);
  } catch {
    return [];
  }
}

/**
 * 在文件内找「命中查询词最多」的行索引（0-based）。
 * 优先按行内命中的去重词数排序；都未命中时，退而用「名字命中查询词的符号」所在行。
 */
function bestLine(
  lines: string[],
  qSet: Set<string>,
  symbols: CodeSymbol[] | undefined
): number | null {
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineTokens = new Set(tokenize(lines[i]!));
    let score = 0;
    for (const t of lineTokens) if (qSet.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) return bestIdx;

  // 文本行没命中，但文件因符号名加权而被召回 —— 定位到匹配的符号定义行。
  if (symbols) {
    for (const sym of symbols) {
      const symTokens = tokenize(sym.name);
      if (symTokens.some((t) => qSet.has(t))) return sym.line - 1;
    }
  }
  return null;
}

/** 取命中行上下各 contextLines 行，拼成带行号的片段。 */
function buildSnippet(
  lines: string[],
  centerIdx: number,
  contextLines: number
): string {
  const start = Math.max(0, centerIdx - contextLines);
  const end = Math.min(lines.length - 1, centerIdx + contextLines);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const marker = i === centerIdx ? ">" : " ";
    out.push(`${marker} ${String(i + 1).padStart(5)}|${lines[i]}`);
  }
  return out.join("\n");
}
