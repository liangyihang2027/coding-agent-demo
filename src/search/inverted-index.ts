/**
 * ⭐ 倒排索引 + BM25 相关性排序（阶段 4 的「灵魂中的灵魂」）。
 *
 * 为什么是这套数据结构 + 算法：
 *   - 倒排索引（term -> 出现该词的文档及词频）把「查得快」交给哈希表：检索时只需取出
 *     query 里每个词的 posting list，做并集打分，复杂度与命中文档数相关，而不是扫全库。
 *   - BM25 把「查得准」交给排序：在 TF-IDF 基础上加了「词频饱和」(k1) 和「文档长度归一」(b)，
 *     避免长文件因为词多而虚高、也避免某词刷屏堆分。这是工业检索（Lucene/ES）的默认打分。
 *
 * 文档粒度：以「文件」为一个文档做排序。先召回最相关的文件，再由上层在文件内定位最佳行做片段，
 * 这样既复用同一套统计，又能把 token 预算花在真正相关的代码上。
 */

import { tokenize } from "./tokenize.js";

/** BM25 词频饱和参数：越大，越看重高频词；1.2~2.0 是常用区间。 */
const K1 = 1.5;
/** BM25 文档长度归一强度：0 关闭归一，1 完全按长度惩罚；0.75 是经典默认。 */
const B = 0.75;

interface IndexedDoc {
  id: number;
  /** 文档标识（这里是相对路径） */
  ref: string;
  /** 文档长度（token 数），用于 BM25 长度归一 */
  length: number;
}

export interface ScoredDoc {
  ref: string;
  score: number;
}

export class InvertedIndex {
  /** term -> (docId -> 词频 tf)。哈希表套哈希表，取 posting list O(1)。 */
  private postings = new Map<string, Map<number, number>>();
  private docs: IndexedDoc[] = [];
  private totalLength = 0;

  /** 已索引文档数。 */
  get size(): number {
    return this.docs.length;
  }

  /**
   * 索引一篇文档。传入已分好的 tokens（调用方决定分词策略与是否带子词）。
   * @returns 分配的 docId
   */
  addDocument(ref: string, tokens: string[]): number {
    const id = this.docs.length;
    const tf = new Map<string, number>();
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    for (const [term, count] of tf) {
      let list = this.postings.get(term);
      if (!list) {
        list = new Map<number, number>();
        this.postings.set(term, list);
      }
      list.set(id, count);
    }
    this.docs.push({ id, ref, length: tokens.length });
    this.totalLength += tokens.length;
    return id;
  }

  /** 便捷方法：直接对原始文本分词后索引。 */
  addText(ref: string, text: string): number {
    return this.addDocument(ref, tokenize(text));
  }

  /** 平均文档长度（BM25 归一用）。 */
  private avgLength(): number {
    return this.docs.length === 0 ? 0 : this.totalLength / this.docs.length;
  }

  /**
   * 逆文档频率：词越「稀有」（出现在越少文档里），区分度越高、权重越大。
   * 采用带 +0.5 平滑的 BM25 概率版 idf，并下限为 0 防止极常见词产生负权重。
   */
  private idf(df: number): number {
    const n = this.docs.length;
    return Math.max(0, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  /**
   * 用 BM25 对查询打分，返回按分数降序的文档。
   * @param queryTokens 查询分词（建议去重，词频对召回无意义）
   * @param limit 返回条数上限
   */
  search(queryTokens: string[], limit = 10): ScoredDoc[] {
    if (this.docs.length === 0) return [];
    const avgdl = this.avgLength();
    const scores = new Map<number, number>();

    for (const term of new Set(queryTokens)) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = this.idf(list.size);
      if (idf === 0) continue;

      for (const [docId, tf] of list) {
        const dl = this.docs[docId]!.length;
        const denom = tf + K1 * (1 - B + (B * dl) / (avgdl || 1));
        const contribution = idf * ((tf * (K1 + 1)) / denom);
        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }

    return [...scores.entries()]
      .map(([docId, score]) => ({ ref: this.docs[docId]!.ref, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
