import { describe, it, expect } from "vitest";
import { diffLines, splitLines, type LineOp } from "../src/diff/myers.js";

/**
 * ⭐ 阶段 2 Myers 行级 diff 用例。
 * 验证：最短编辑脚本的正确性（增删/前后缀复用/可逆还原）与边界。
 */

/** 从编辑脚本反推旧文本（equal+delete）。 */
function rebuildOld(ops: LineOp[]): string {
  return ops
    .filter((o) => o.type !== "insert")
    .map((o) => o.line)
    .join("");
}
/** 从编辑脚本反推新文本（equal+insert）。 */
function rebuildNew(ops: LineOp[]): string {
  return ops
    .filter((o) => o.type !== "delete")
    .map((o) => o.line)
    .join("");
}

describe("splitLines", () => {
  it("保留行尾，join 后字节级还原", () => {
    for (const text of ["a\nb\n", "a\nb", "", "\n", "x\r\ny\r\n"]) {
      expect(splitLines(text).join("")).toBe(text);
    }
  });
});

describe("diffLines", () => {
  it("完全相同：全是 equal", () => {
    const ops = diffLines(splitLines("a\nb\n"), splitLines("a\nb\n"));
    expect(ops.every((o) => o.type === "equal")).toBe(true);
  });

  it("纯新增：旧为空时全部 insert", () => {
    const ops = diffLines(splitLines(""), splitLines("a\nb\n"));
    expect(ops.every((o) => o.type === "insert")).toBe(true);
    expect(rebuildNew(ops)).toBe("a\nb\n");
  });

  it("纯删除：新为空时全部 delete", () => {
    const ops = diffLines(splitLines("a\nb\n"), splitLines(""));
    expect(ops.every((o) => o.type === "delete")).toBe(true);
    expect(rebuildOld(ops)).toBe("a\nb\n");
  });

  it("中间替换一行：复用前后缀，只改中间", () => {
    const ops = diffLines(
      splitLines("a\nb\nc\n"),
      splitLines("a\nB\nc\n")
    );
    expect(ops.filter((o) => o.type === "delete").length).toBe(1);
    expect(ops.filter((o) => o.type === "insert").length).toBe(1);
    expect(ops.filter((o) => o.type === "equal").length).toBe(2);
  });

  it("可逆性：任意两文本，编辑脚本能还原双方", () => {
    const cases: Array<[string, string]> = [
      ["a\nb\nc\nd\n", "a\nc\nd\ne\n"],
      ["1\n2\n3\n", "0\n1\n2\n3\n4\n"],
      ["x\ny\nz\n", "z\ny\nx\n"],
      ["same\n", "same\n"],
    ];
    for (const [a, b] of cases) {
      const ops = diffLines(splitLines(a), splitLines(b));
      expect(rebuildOld(ops)).toBe(a);
      expect(rebuildNew(ops)).toBe(b);
    }
  });

  it("最短性：插入一行只产生 1 个 insert，其余 equal", () => {
    const ops = diffLines(
      splitLines("a\nb\nc\n"),
      splitLines("a\nb\nNEW\nc\n")
    );
    expect(ops.filter((o) => o.type === "insert").length).toBe(1);
    expect(ops.filter((o) => o.type === "delete").length).toBe(0);
  });
});
