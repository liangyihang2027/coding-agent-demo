import { describe, it, expect } from "vitest";
import { IgnoreMatcher } from "../src/search/gitignore.js";

/**
 * ⭐ 阶段 4 .gitignore 匹配器用例。
 * 这些边界决定遍历是否会把垃圾文件喂进倒排索引（污染相关性 + 拖慢建索引）。
 */
describe("IgnoreMatcher", () => {
  it("目录限定模式只匹配目录", () => {
    const ig = new IgnoreMatcher().addPatterns(["build/"]);
    expect(ig.ignores("build", true)).toBe(true);
    expect(ig.ignores("build", false)).toBe(false);
  });

  it("纯名字模式在任意层级匹配", () => {
    const ig = new IgnoreMatcher().addPatterns(["*.log"]);
    expect(ig.ignores("a.log", false)).toBe(true);
    expect(ig.ignores("src/nested/b.log", false)).toBe(true);
    expect(ig.ignores("a.txt", false)).toBe(false);
  });

  it("含 / 的模式相对根锚定", () => {
    const ig = new IgnoreMatcher().addPatterns(["/dist"]);
    expect(ig.ignores("dist", true)).toBe(true);
    expect(ig.ignores("src/dist", true)).toBe(false);
  });

  it("** 跨目录匹配", () => {
    const ig = new IgnoreMatcher().addPatterns(["**/coverage"]);
    expect(ig.ignores("coverage", true)).toBe(true);
    expect(ig.ignores("a/b/coverage", true)).toBe(true);
  });

  it("取反规则可以反悔前面的忽略（最后命中者生效）", () => {
    const ig = new IgnoreMatcher().addPatterns(["*.log", "!keep.log"]);
    expect(ig.ignores("other.log", false)).toBe(true);
    expect(ig.ignores("keep.log", false)).toBe(false);
  });

  it("注释与空行被忽略", () => {
    const ig = new IgnoreMatcher().add("# comment\n\n*.tmp\n");
    expect(ig.ignores("x.tmp", false)).toBe(true);
    expect(ig.ignores("comment", false)).toBe(false);
  });

  it("深层 .gitignore 仅作用于其所在子树", () => {
    const ig = new IgnoreMatcher().add("*.tmp\n", "src");
    expect(ig.ignores("src/x.tmp", false)).toBe(true);
    expect(ig.ignores("x.tmp", false)).toBe(false);
    expect(ig.ignores("other/x.tmp", false)).toBe(false);
  });

  it("默认不忽略普通源码文件", () => {
    const ig = new IgnoreMatcher().addPatterns(["node_modules/", "*.log"]);
    expect(ig.ignores("src/index.ts", false)).toBe(false);
  });
});
