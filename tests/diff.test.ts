import { describe, it, expect } from "vitest";
import { strReplace } from "../src/diff/index.js";

/**
 * ⭐ 阶段 2 Diff/Patch 引擎的测试骨架（蓝图要求：单测覆盖 ≥ 5 类编辑边界）。
 *
 * 这些用例目前是 .skip 的——实现 src/diff/index.ts 后，
 * 把 describe.skip 改成 describe，逐个让它们转绿。
 * 这就是「工程严谨度」的证明，也是面试可以直接展示的东西。
 */
describe.skip("strReplace（阶段 2 实现后启用）", () => {
  it("唯一匹配：正常替换", () => {
    const r = strReplace({
      source: "const a = 1;\nconst b = 2;\n",
      oldText: "const a = 1;",
      newText: "const a = 42;",
    });
    expect(r).toEqual({ ok: true, result: "const a = 42;\nconst b = 2;\n" });
  });

  it("匹配 0 次：报 not_found", () => {
    const r = strReplace({
      source: "hello",
      oldText: "world",
      newText: "x",
    });
    expect(r).toEqual({ ok: false, reason: "not_found", matches: 0 });
  });

  it("匹配多次：报 ambiguous，要求更多上下文", () => {
    const r = strReplace({
      source: "x\nx\n",
      oldText: "x",
      newText: "y",
    });
    expect(r).toEqual({ ok: false, reason: "ambiguous", matches: 2 });
  });

  it("缩进/空白差异：模糊匹配仍能定位（进阶）", () => {
    // TODO：你的模糊匹配策略决定这里的期望值
    expect(true).toBe(true);
  });

  it("行尾差异 CRLF vs LF：归一化后仍能替换", () => {
    // TODO
    expect(true).toBe(true);
  });
});
