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

export function strReplace(_input: StrReplaceInput): StrReplaceResult {
  // TODO 阶段2：实现我。先让 tests/diff.test.ts 跑起来再逐个 case 转绿。
  throw new Error("strReplace 尚未实现（阶段 2 ⭐ 你的任务）");
}
