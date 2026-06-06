import { describe, it, expect } from "vitest";
import { strReplace } from "../src/diff/index.js";

/**
 * ⭐ 阶段 2 Diff/Patch 引擎的 TDD 用例。
 * 这些边界决定 edit_file 是否能从“能替换”升级到“可靠替换”。
 */
describe("strReplace", () => {
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
    const r = strReplace({
      source: "function main() {\n    const value   = 1;\n}\n",
      oldText: "const value = 1;",
      newText: "const value = 2;",
    });
    expect(r).toEqual({
      ok: true,
      result: "function main() {\nconst value = 2;\n}\n",
    });
  });

  it("行尾差异 CRLF vs LF：归一化后仍能替换", () => {
    const r = strReplace({
      source: "const a = 1;\r\nconst b = 2;\r\n",
      oldText: "const a = 1;\nconst b = 2;",
      newText: "const a = 10;\nconst b = 20;",
    });
    expect(r).toEqual({
      ok: true,
      result: "const a = 10;\r\nconst b = 20;\r\n",
    });
  });

  it("模糊匹配多处命中：仍报 ambiguous，不猜测替换位置", () => {
    const r = strReplace({
      source: "const value   = 1;\n  const   value = 1;\n",
      oldText: "const value = 1;",
      newText: "const value = 2;",
    });
    expect(r).toEqual({ ok: false, reason: "ambiguous", matches: 2 });
  });

  it("oldText 为空：报 not_found", () => {
    const r = strReplace({
      source: "hello",
      oldText: "",
      newText: "x",
    });
    expect(r).toEqual({ ok: false, reason: "not_found", matches: 0 });
  });

  it("多行替换：通过归一化匹配时保持源文件行尾风格", () => {
    const r = strReplace({
      source: "if (ok) {\r\n  run();\r\n}\r\n",
      oldText: "if (ok) {\n  run();\n}",
      newText: "if (ok) {\n  await run();\n}",
    });
    expect(r).toEqual({
      ok: true,
      result: "if (ok) {\r\n  await run();\r\n}\r\n",
    });
  });
});
