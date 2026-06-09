/**
 * ⭐ 阶段 2 Diff 引擎：解析 unified diff 并行级 apply（带原子回滚）。
 *
 * 设计目的：
 *   反向闭环——unified.ts 把差异**写成**补丁，本模块把补丁**应用回**文本。
 *   让 agent 能以「补丁」为单位做多处、跨片段的编辑，而不是一次只换一段。
 *
 * 设计价值（两条硬约束）：
 *   1. 上下文校验：每个 hunk 带 context 行；apply 前先核对源文件该处是否与补丁的
 *      「旧内容(context + 删除行)」吻合。不吻合就拒绝，绝不盲改——避免文件漂移后误打补丁。
 *   2. 原子性 / 失败回滚：所有 hunk 先打在内存副本上，**任一 hunk 失败则整体放弃**，
 *      不留「打了一半」的脏文件。这是「失败回滚」在算法层的体现（文件写盘层的回滚由
 *      edit_file 另行保证），两层都做到才叫可靠。
 *
 * 容错：允许 hunk 行号轻微漂移（在标注位置附近小范围搜索 context 命中点），
 * 因为模型给的行号常有偏差，但内容校验仍是硬门槛。
 */

import { splitLines } from "./myers.js";

interface ParsedHunk {
  oldStart: number;
  /** 旧文本应有的行（context + 删除行），用于定位与校验。 */
  oldBlock: string[];
  /** 替换后的新行（context + 新增行）。 */
  newBlock: string[];
}

export type ApplyPatchResult =
  | { ok: true; result: string; appliedHunks: number }
  | {
      ok: false;
      reason: "parse_error" | "context_mismatch" | "empty_patch";
      /** 出错的 hunk 序号（从 1 开始），parse_error/empty 时为 0。 */
      hunkIndex: number;
      message: string;
    };

/** hunk 头形如 `@@ -1,3 +1,4 @@`，提取旧块起始行号即可（计数由内容推导）。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 应用一段 unified diff 文本到 source。
 *
 * 行号容错：从补丁标注位置开始，向两侧逐步扩大偏移搜索 oldBlock 的精确命中点。
 */
export function applyPatch(
  source: string,
  patchText: string
): ApplyPatchResult {
  const hunks = parsePatch(patchText);
  if (typeof hunks === "string") {
    return { ok: false, reason: "parse_error", hunkIndex: 0, message: hunks };
  }
  if (hunks.length === 0) {
    return {
      ok: false,
      reason: "empty_patch",
      hunkIndex: 0,
      message: "补丁不含任何 hunk",
    };
  }

  // 关键：先在副本上全部应用成功，再返回结果——保证原子性，失败不留半成品。
  let lines = splitLines(source);
  // 已应用 hunk 造成的累计行偏移，用于把后续 hunk 的原始行号映射到当前数组。
  let drift = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!;
    const guess = hunk.oldStart - 1 + drift; // unified diff 行号是 1-based
    const at = locate(lines, hunk.oldBlock, guess);
    if (at < 0) {
      return {
        ok: false,
        reason: "context_mismatch",
        hunkIndex: i + 1,
        message: `第 ${i + 1} 个 hunk 的上下文与源文件不匹配，已放弃整个补丁`,
      };
    }
    lines = [
      ...lines.slice(0, at),
      ...hunk.newBlock,
      ...lines.slice(at + hunk.oldBlock.length),
    ];
    drift += hunk.newBlock.length - hunk.oldBlock.length;
  }

  return { ok: true, result: lines.join(""), appliedHunks: hunks.length };
}

/**
 * 在 lines 中定位 oldBlock 的精确命中点。
 *
 * 先试标注位置 guess；不中则以 guess 为中心向外扩张搜索（容忍行号漂移）。
 * 命中要求 oldBlock 逐行**完全相等**，绝不模糊——内容校验是补丁安全的底线。
 */
function locate(lines: string[], oldBlock: string[], guess: number): number {
  // 空 oldBlock（纯新增 hunk）直接插在 guess 处。
  if (oldBlock.length === 0) {
    return Math.max(0, Math.min(guess, lines.length));
  }
  if (matchesAt(lines, oldBlock, guess)) return guess;

  const maxOffset = lines.length;
  for (let delta = 1; delta <= maxOffset; delta++) {
    if (matchesAt(lines, oldBlock, guess - delta)) return guess - delta;
    if (matchesAt(lines, oldBlock, guess + delta)) return guess + delta;
  }
  return -1;
}

function matchesAt(lines: string[], block: string[], at: number): boolean {
  if (at < 0 || at + block.length > lines.length) return false;
  for (let i = 0; i < block.length; i++) {
    if (lines[at + i] !== block[i]) return false;
  }
  return true;
}

/**
 * 解析 unified diff 文本为 hunk 列表。
 *
 * 只关心 hunk 体（` ` 上下文 / `-` 删除 / `+` 新增）；文件头(--- / +++)、
 * 「\ No newline」标记按需消费。返回字符串表示解析错误。
 */
function parsePatch(patchText: string): ParsedHunk[] | string {
  const rawLines = patchText.split("\n");
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;

    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;

    const header = HUNK_HEADER.exec(raw);
    if (header) {
      if (current) hunks.push(current);
      current = { oldStart: Number(header[1]), oldBlock: [], newBlock: [] };
      continue;
    }

    if (!current) continue; // hunk 头之前的内容忽略

    if (raw === "\\ No newline at end of file") {
      // 紧邻的上一条 hunk 行其实无结尾换行：去掉我们补的 \n，保证字节级还原。
      dropTrailingNewline(current, rawLines[i - 1]?.[0]);
      continue;
    }

    const marker = raw[0];
    const content = raw.slice(1);
    // 补丁里每行不含换行；这里按 marker 把行尾 \n 补回各自的 block。
    if (marker === " ") {
      current.oldBlock.push(content + "\n");
      current.newBlock.push(content + "\n");
    } else if (marker === "-") {
      current.oldBlock.push(content + "\n");
    } else if (marker === "+") {
      current.newBlock.push(content + "\n");
    } else if (raw === "") {
      continue; // 补丁结尾的空行
    } else {
      return `无法解析的补丁行: ${JSON.stringify(raw)}`;
    }
  }

  if (current) hunks.push(current);
  return hunks;
}

/** 按上一行的 marker，把对应 block 末行多补的 \n 去掉（处理无结尾换行）。 */
function dropTrailingNewline(hunk: ParsedHunk, marker: string | undefined): void {
  const strip = (block: string[]): void => {
    const last = block[block.length - 1];
    if (last?.endsWith("\n")) block[block.length - 1] = last.slice(0, -1);
  };
  if (marker === "-" || marker === " ") strip(hunk.oldBlock);
  if (marker === "+" || marker === " ") strip(hunk.newBlock);
}
