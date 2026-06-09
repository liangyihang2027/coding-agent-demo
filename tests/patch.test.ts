import { describe, it, expect } from "vitest";
import { applyPatch } from "../src/diff/patch.js";
import { formatUnifiedDiff } from "../src/diff/unified.js";

/**
 * ⭐ 阶段 2 patch apply 用例。
 * 重点验证两条硬约束：上下文校验（不匹配即拒绝）+ 原子性（任一 hunk 失败整体放弃）。
 */

describe("applyPatch", () => {
  it("正常应用单 hunk", () => {
    const a = "a\nb\nc\n";
    const patch = formatUnifiedDiff(a, "a\nB\nc\n");
    const r = applyPatch(a, patch);
    expect(r).toEqual({ ok: true, result: "a\nB\nc\n", appliedHunks: 1 });
  });

  it("行号漂移：源文件在补丁位置前插了几行，仍按上下文定位成功", () => {
    const base = "a\nb\nc\n";
    const patch = formatUnifiedDiff(base, "a\nB\nc\n");
    // 实际文件比生成补丁时多了前缀行，hunk 标注行号已偏移
    const drifted = "header1\nheader2\na\nb\nc\n";
    const r = applyPatch(drifted, patch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("header1\nheader2\na\nB\nc\n");
  });

  it("上下文不匹配：拒绝并报 context_mismatch", () => {
    const patch = formatUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    const r = applyPatch("totally\ndifferent\nfile\n", patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("context_mismatch");
  });

  it("原子性：多 hunk 中后一个失败，则整体不应用（前一个也不落地）", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
    const b = a.replace("line1", "L1").replace("line18", "L18");
    const goodPatch = formatUnifiedDiff(a, b);
    // 篡改第二个 hunk 的上下文，使其无法匹配
    const brokenPatch = goodPatch.replace("line17", "NOPE17");
    const r = applyPatch(a, brokenPatch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("context_mismatch");
      expect(r.hunkIndex).toBe(2); // 第二个 hunk 失败
    }
  });

  it("空补丁报 empty_patch", () => {
    const r = applyPatch("x\n", "--- a/x\n+++ b/x\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty_patch");
  });

  it("无法解析的行报 parse_error", () => {
    const r = applyPatch("x\n", "@@ -1,1 +1,1 @@\n?garbage line\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse_error");
  });

  it("无结尾换行的往返一致", () => {
    const a = "a\nb";
    const b = "a\nc";
    const patch = formatUnifiedDiff(a, b);
    const r = applyPatch(a, patch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe(b);
  });
});
