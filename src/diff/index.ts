/**
 * ⭐⭐⭐ 阶段 2「Diff / Patch 引擎」—— 你要亲手实现的灵魂模块。⭐⭐⭐
 *
 * 目标（蓝图 §阶段2）：可靠的文件编辑，不靠「整文件重写」。
 *
 * 待你实现：
 *   [ ] str_replace：在文件文本中精确替换一段 old -> new
 *   [ ] 边界：匹配不唯一时报错并要求更多上下文；匹配 0 次时报错
 *   [ ] 空白/缩进差异、行尾(CRLF/LF)差异的容忍
 *   [ ] 进阶：模糊匹配（轻微空白差异下仍能定位）
 *   [ ] 行级 patch apply + 失败回滚
 *
 * 面试得分点：字符串匹配算法、边界处理、为什么不用整文件重写（token 成本 + diff 可读性）。
 * 可深挖：LCS、编辑距离、Myers diff。
 *
 * 建议先把下面的契约定下来，再用 tests/diff.test.ts 里的用例做 TDD。
 */

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

  let matches = 0;
  let from = 0;
  while (from <= source.length) {
    const idx = source.indexOf(oldText, from);
    if (idx === -1) break;
    matches++;
    from = idx + Math.max(1, oldText.length);
  }

  if (matches === 0) {
    return { ok: false, reason: "not_found", matches: 0 };
  }
  if (matches > 1) {
    return { ok: false, reason: "ambiguous", matches };
  }

  const at = source.indexOf(oldText);
  const result = source.slice(0, at) + newText + source.slice(at + oldText.length);
  return { ok: true, result };
}
