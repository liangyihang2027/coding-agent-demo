/**
 * ⭐ 阶段 2 Diff 引擎：把 Myers 编辑脚本渲染成 unified diff 文本。
 *
 * 设计目的：
 *   给「这次编辑改了什么」一个**标准、可读、可机器解析**的呈现：
 *     - 给人看：终端高亮、写入前预览、code review。
 *     - 给机器看：本模块产出的格式能被 patch.ts 反向解析并 apply（双向闭环）。
 *
 * 设计价值：
 *   1. 用业界通用格式（git/diff 同款 `@@ -a,b +c,d @@`），不发明私有协议，迁移成本低。
 *   2. 只输出「变更块(hunk) + 周围少量上下文」，而非整文件——省 token、聚焦改动，
 *      这正是「不靠整文件重写」这一核心取舍在「展示层」的延续。
 *
 * 与 str_replace 的分工：str_replace 负责「精确定位并替换一小段」，
 * 本模块负责「描述任意两份文本的完整差异」，二者服务不同场景。
 */

import { diffLines, splitLines, type LineOp } from "./myers.js";

export interface UnifiedDiffOptions {
  /** 旧文件名（diff 头 `--- a/<name>`），默认 a/file。 */
  oldName?: string;
  /** 新文件名（diff 头 `+++ b/<name>`），默认 b/file。 */
  newName?: string;
  /** 每个 hunk 变更行上下保留的上下文行数，默认 3（git 默认值）。 */
  context?: number;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: LineOp[];
}

/** 去掉行尾换行用于展示（unified diff 的每行前缀已自带换行结构）。 */
function visibleLine(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/** 该行是否缺少结尾换行——对应 git 的「\ No newline at end of file」。 */
function lacksNewline(line: string): boolean {
  return line.length > 0 && !line.endsWith("\n");
}

/**
 * 生成 unified diff。两文本相同时返回空串（无差异不产出噪声）。
 */
export function formatUnifiedDiff(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {}
): string {
  const context = options.context ?? 3;
  const oldName = options.oldName ?? "a/file";
  const newName = options.newName ?? "b/file";

  const ops = diffLines(splitLines(oldText), splitLines(newText));
  const hunks = buildHunks(ops, context);
  if (hunks.length === 0) return "";

  const out: string[] = [`--- ${oldName}`, `+++ ${newName}`];
  for (const h of hunks) {
    out.push(
      `@@ -${formatRange(h.oldStart, h.oldLines)} +${formatRange(h.newStart, h.newLines)} @@`
    );
    for (const op of h.ops) {
      const prefix = op.type === "equal" ? " " : op.type === "delete" ? "-" : "+";
      out.push(prefix + visibleLine(op.line));
      if (lacksNewline(op.line)) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}

/** hunk 头的范围格式：单行省略计数（git 习惯），0 行时起始号减 1。 */
function formatRange(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  if (count === 1) return `${start}`;
  return `${start},${count}`;
}

/**
 * 把扁平的 LineOp[] 切成若干 hunk。
 *
 * 思路：变更(delete/insert)前后各保留 context 行上下文；当两段变更之间的 equal
 * 行 ≤ 2*context 时合并成同一个 hunk（避免相邻改动被切成一堆碎 hunk）。
 */
function buildHunks(ops: LineOp[], context: number): Hunk[] {
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== "equal") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return [];

  // 先按「变更点 ± context、间距过近则合并」算出每个 hunk 覆盖的 op 区间。
  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // 行号在遍历中累加：equal/delete 推进旧行号，equal/insert 推进新行号。
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const range of ranges) {
    // 跳过 hunk 之间的 equal 行，但要把行号累加上去。
    for (; cursor < range.start; cursor++) {
      const op = ops[cursor]!;
      if (op.type !== "insert") oldLine++;
      if (op.type !== "delete") newLine++;
    }

    const hunkOps: LineOp[] = [];
    const oldStart = oldLine;
    const newStart = newLine;
    let oldCount = 0;
    let newCount = 0;
    for (; cursor <= range.end; cursor++) {
      const op = ops[cursor]!;
      hunkOps.push(op);
      if (op.type !== "insert") {
        oldLine++;
        oldCount++;
      }
      if (op.type !== "delete") {
        newLine++;
        newCount++;
      }
    }

    hunks.push({
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      ops: hunkOps,
    });
  }

  return hunks;
}
