/**
 * ⭐ Diff / Patch 引擎（阶段 2 灵魂模块，全程手写、禁止调库）。
 *
 * 设计目标：可靠的局部文件编辑，不靠「整文件重写」。
 * 整文件重写既浪费 token，又让 diff 难以审阅；局部替换只动必要的几行，
 * 成本低、变更可读、也更容易在出错时定位。
 *
 * 三种能力、各司其职（按「知道多少信息」从强到弱）：
 *   1. str_replace（本文件）——已知「要换哪段精确文本」时最省心：唯一命中才替换，
 *      容忍行尾/空白漂移，非唯一即报 ambiguous，绝不猜位置。
 *   2. Myers diff + unified diff（myers.ts / unified.ts）——只有「新旧两份文本」时，
 *      手写 Myers 最短编辑脚本算出最小增删，渲染成业界通用的 unified diff，用于预览/审阅。
 *   3. patch apply（patch.ts）——拿到「一段补丁」时，带上下文校验 + 原子回滚地打回文本。
 *
 * 三者共享一个底层取舍：永远「最小改动 + 可校验 + 失败不留半成品」。
 */

export {
  diffLines,
  splitLines,
  type LineOp,
} from "./myers.js";
export {
  formatUnifiedDiff,
  type UnifiedDiffOptions,
} from "./unified.js";
export {
  applyPatch,
  type ApplyPatchResult,
} from "./patch.js";

export interface StrReplaceInput {
  source: string;
  oldText: string;
  newText: string;
}

export type StrReplaceResult =
  | { ok: true; result: string }
  | { ok: false; reason: "not_found" | "ambiguous"; matches: number };

export function strReplace(input: StrReplaceInput): StrReplaceResult {
  const { source, oldText, newText } = input;
  if (!oldText) {
    return { ok: false, reason: "not_found", matches: 0 };
  }

  const exact = findExactMatches(source, oldText);
  if (exact.length !== 0) {
    return replaceUnique(source, newText, exact);
  }

  const normalized = findLineEndingMatches(source, oldText);
  if (normalized.length !== 0) {
    return replaceUnique(source, newText, normalized);
  }

  const fuzzy = findFuzzyWhitespaceMatches(source, oldText);
  if (fuzzy.length !== 0) {
    return replaceUnique(source, newText, fuzzy);
  }

  return { ok: false, reason: "not_found", matches: 0 };
}

interface MatchRange {
  start: number;
  end: number;
  lineEnding?: string;
}

interface NormalizedText {
  text: string;
  /** normalized index -> original index */
  map: number[];
}

interface SourceLine {
  start: number;
  contentEnd: number;
  end: number;
  text: string;
  eol: string;
}

/**
 * 统一处理“必须唯一命中”的不变量。
 *
 * Diff 引擎宁可失败也不猜位置，所以所有匹配策略都先产出 MatchRange[]，
 * 再由这里决定 ambiguous / not_found / replace，避免每个策略重复实现安全判断。
 */
function replaceUnique(
  source: string,
  newText: string,
  matches: MatchRange[]
): StrReplaceResult {
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", matches: matches.length };
  }
  const [match] = matches;
  if (!match) {
    return { ok: false, reason: "not_found", matches: 0 };
  }

  const replacement = match.lineEnding
    ? convertLineEndings(newText, match.lineEnding)
    : newText;
  const result = source.slice(0, match.start) + replacement + source.slice(match.end);
  return { ok: true, result };
}

/**
 * 第一优先级的精确匹配。
 *
 * 只要用户给的 oldText 能精确定位，就不进入更宽松的策略；
 * 这样可以避免模糊匹配把本来明确的编辑扩大成 ambiguous。
 */
function findExactMatches(source: string, oldText: string): MatchRange[] {
  const matches: MatchRange[] = [];
  let from = 0;
  while (from <= source.length) {
    const idx = source.indexOf(oldText, from);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + oldText.length });
    from = idx + Math.max(1, oldText.length);
  }
  return matches;
}

/**
 * 处理 CRLF/LF 差异。
 *
 * 模型通常生成 LF 文本，但用户仓库可能是 CRLF；这里用归一化文本查找，
 * 再通过 index map 映射回原始 source 范围，保证替换仍发生在原文件坐标上。
 */
function findLineEndingMatches(source: string, oldText: string): MatchRange[] {
  const normalizedSource = normalizeLineEndingsWithMap(source);
  const normalizedOldText = normalizeLineEndings(oldText);
  if (normalizedSource.text === source && normalizedOldText === oldText) {
    return [];
  }

  return findExactMatches(normalizedSource.text, normalizedOldText).map((match) => {
    const start = normalizedSource.map[match.start] ?? source.length;
    const end = normalizedSource.map[match.end] ?? source.length;
    return {
      start,
      end,
      lineEnding: detectLineEnding(source.slice(start, end), source),
    };
  });
}

/**
 * 最后一层轻量模糊匹配。
 *
 * 只容忍行首缩进和空白数量差异，不做语义级 diff。
 * 这个策略服务于 LLM 常见的格式漂移，同时仍要求唯一命中，避免误改相似代码块。
 */
function findFuzzyWhitespaceMatches(source: string, oldText: string): MatchRange[] {
  const oldLines = splitLogicalLines(oldText);
  if (oldLines.length === 0) return [];

  const sourceLines = splitSourceLines(source);
  if (oldLines.length > sourceLines.length) return [];

  const normalizedOld = oldLines.map((line) => normalizeWhitespace(line.text));
  const matches: MatchRange[] = [];

  for (let i = 0; i <= sourceLines.length - oldLines.length; i++) {
    const window = sourceLines.slice(i, i + oldLines.length);
    const normalizedWindow = window.map((line) => normalizeWhitespace(line.text));
    if (!arraysEqual(normalizedWindow, normalizedOld)) continue;

    const first = window[0]!;
    const last = window[window.length - 1]!;
    const end = oldTextHasTrailingLineEnding(oldText) ? last.end : last.contentEnd;
    matches.push({
      start: first.start,
      end,
      lineEnding: detectLineEnding(source.slice(first.start, end), source),
    });
  }

  return matches;
}

/** 将所有行尾折叠为 LF，作为跨平台比较的标准形态。 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * 归一化行尾并保留坐标映射。
 *
 * 普通 normalize 会丢失 CRLF 占两个字符这一事实；Diff 替换需要回到原始字符串切片，
 * 所以这里额外记录 normalized index 到 original index 的映射。
 */
function normalizeLineEndingsWithMap(text: string): NormalizedText {
  let normalized = "";
  const map: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\r") {
      normalized += "\n";
      map.push(i);
      if (text[i + 1] === "\n") i++;
      continue;
    }

    normalized += ch;
    map.push(i);
  }

  map[normalized.length] = text.length;
  return { text: normalized, map };
}

/**
 * 把源文件拆成带坐标的行。
 *
 * 模糊匹配最后仍要替换原始 source 的某个范围，因此每行需要同时记录：
 * 内容结束位置、包含行尾的结束位置，以及原始行尾风格。
 */
function splitSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\n" && ch !== "\r") continue;

    const eol =
      ch === "\r" && text[i + 1] === "\n" ? "\r\n" : ch;
    const contentEnd = i;
    const end = i + eol.length;
    lines.push({
      start,
      contentEnd,
      end,
      text: text.slice(start, contentEnd),
      eol,
    });
    start = end;
    if (eol === "\r\n") i++;
  }

  if (start < text.length) {
    lines.push({
      start,
      contentEnd: text.length,
      end: text.length,
      text: text.slice(start),
      eol: "",
    });
  }

  return lines;
}

/**
 * 把 oldText 拆成逻辑行。
 *
 * oldText 来自模型，不需要保留原始坐标；尾部空行只表示“以换行结束”，
 * 不应该额外变成一行参与模糊匹配。
 */
function splitLogicalLines(text: string): Array<{ text: string }> {
  const normalized = normalizeLineEndings(text);
  const raw = normalized.split("\n");
  if (raw.at(-1) === "") raw.pop();
  return raw.map((line) => ({ text: line }));
}

/**
 * 行内空白归一化规则。
 *
 * 这里只折叠空格和 tab，并 trim 行首尾；不处理字符串字面量语义，
 * 因此它是保守的定位辅助，不是代码格式化器。
 */
function normalizeWhitespace(line: string): string {
  return line.trim().replace(/[ \t]+/g, " ");
}

/** 判断 oldText 是否显式包含最后一个行尾，决定替换范围是否吞掉源文件行尾。 */
function oldTextHasTrailingLineEnding(text: string): boolean {
  return /\r\n?$|\n$/.test(text);
}

/**
 * 推断替换块应该使用的行尾风格。
 *
 * 优先使用命中的源片段；如果片段本身没有行尾，则退回整个文件的行尾风格，
 * 让 newText 多行替换时尽量保持仓库原有格式。
 */
function detectLineEnding(segment: string, fallback: string): string {
  if (segment.includes("\r\n")) return "\r\n";
  if (segment.includes("\n")) return "\n";
  if (segment.includes("\r")) return "\r";
  if (fallback.includes("\r\n")) return "\r\n";
  if (fallback.includes("\n")) return "\n";
  if (fallback.includes("\r")) return "\r";
  return "\n";
}

/** 把模型生成的 replacement 转成目标行尾风格，避免一次编辑混入两种换行。 */
function convertLineEndings(text: string, lineEnding: string): string {
  return normalizeLineEndings(text).replace(/\n/g, lineEnding);
}

/** 小范围字符串数组比较，用于模糊匹配窗口判断，避免引入额外依赖。 */
function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
