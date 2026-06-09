import { describe, it, expect } from "vitest";
import { formatUnifiedDiff } from "../src/diff/unified.js";
import { applyPatch } from "../src/diff/patch.js";

/**
 * ⭐ 阶段 2 unified diff 用例。
 * 验证：hunk 头格式、上下文行、无差异空串、以及与 patch 的往返一致性。
 */

describe("formatUnifiedDiff", () => {
  it("无差异返回空串", () => {
    expect(formatUnifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("含文件头与 hunk 头", () => {
    const diff = formatUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", {
      oldName: "a/f.ts",
      newName: "b/f.ts",
    });
    expect(diff).toContain("--- a/f.ts");
    expect(diff).toContain("+++ b/f.ts");
    expect(diff).toMatch(/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain(" a"); // 上下文行带空格前缀
  });

  it("hunk 头行号正确：第 2 行被改", () => {
    const diff = formatUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    // 上下文 3 行时整段都进同一个 hunk，从第 1 行开始，3 行
    expect(diff).toContain("@@ -1,3 +1,3 @@");
  });

  it("远距离的两处改动切成两个 hunk", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
    const b = a.replace("line1", "L1").replace("line18", "L18");
    const diff = formatUnifiedDiff(a, b);
    const hunks = diff.match(/@@ /g) ?? [];
    expect(hunks.length).toBe(2);
  });

  it("无结尾换行时标注 No newline", () => {
    const diff = formatUnifiedDiff("a\nb", "a\nc");
    expect(diff).toContain("\\ No newline at end of file");
  });

  it("往返：生成的 diff 能被 applyPatch 还原出新文本", () => {
    const a = "function f() {\n  return 1;\n}\n";
    const b = "function f() {\n  return 2;\n}\n";
    const diff = formatUnifiedDiff(a, b);
    const r = applyPatch(a, diff);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe(b);
  });

  it("往返：多 hunk 大文件也能一致还原", () => {
    const a = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") + "\n";
    const b = a.replace("row 2", "ROW 2").replace("row 25", "ROW 25");
    const diff = formatUnifiedDiff(a, b);
    const r = applyPatch(a, diff);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe(b);
  });
});
