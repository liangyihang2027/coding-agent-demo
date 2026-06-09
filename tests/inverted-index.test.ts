import { describe, it, expect } from "vitest";
import { InvertedIndex } from "../src/search/inverted-index.js";
import { tokenizeQuery } from "../src/search/tokenize.js";

/**
 * ⭐ 阶段 4 倒排索引 + BM25 用例。
 * 验证「查得快（取 posting list）」与「查得准（BM25 排序）」的核心性质。
 */
describe("InvertedIndex + BM25", () => {
  it("空索引返回空结果", () => {
    const idx = new InvertedIndex();
    expect(idx.search(["anything"])).toEqual([]);
  });

  it("命中文档按相关性排序，含查询词的排在前", () => {
    const idx = new InvertedIndex();
    idx.addText("a.ts", "user login authentication token");
    idx.addText("b.ts", "database connection pool config");
    idx.addText("c.ts", "user profile settings page");

    const res = idx.search(tokenizeQuery("user authentication"));
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]!.ref).toBe("a.ts");
    // 不含任何查询词的 b.ts 不应出现
    expect(res.find((r) => r.ref === "b.ts")).toBeUndefined();
  });

  it("稀有词区分度更高：只在少数文档出现的词权重更大", () => {
    const idx = new InvertedIndex();
    // "the" 在所有文档出现（常见词，idf 低）；"quasar" 只在 b 出现（稀有，idf 高）
    idx.addText("a.ts", "the the the common code");
    idx.addText("b.ts", "the quasar special module");
    idx.addText("c.ts", "the another common file");

    const res = idx.search(tokenizeQuery("the quasar"));
    expect(res[0]!.ref).toBe("b.ts");
  });

  it("词频饱和：高频词不会无限堆分", () => {
    const idx = new InvertedIndex();
    idx.addText("few.ts", "alpha beta");
    idx.addText("many.ts", "alpha alpha alpha alpha alpha beta");

    const res = idx.search(tokenizeQuery("alpha"));
    const few = res.find((r) => r.ref === "few.ts")!;
    const many = res.find((r) => r.ref === "many.ts")!;
    // many 词频更高分更高，但由于 k1 饱和，差距远小于词频比（5:1）
    expect(many.score).toBeGreaterThan(few.score);
    expect(many.score / few.score).toBeLessThan(5);
  });

  it("size 反映已索引文档数", () => {
    const idx = new InvertedIndex();
    idx.addText("a.ts", "x");
    idx.addText("b.ts", "y");
    expect(idx.size).toBe(2);
  });
});
