/**
 * 代码分词器（检索召回的地基）。
 *
 * 召回质量取决于「查询词」和「文档词」能否在同一空间对齐。代码标识符常用
 * camelCase / snake_case 拼接，如果整体当一个 token，用户搜 "user name"
 * 就召回不到 `getUserName`。所以这里同时保留「原词」和「拆出来的子词」：
 *   getUserName -> [getusername, get, user, name]
 * 两种形态都进倒排索引，既能精确命中完整标识符，又能按语义子词召回。
 */

const WORD_RE = /[A-Za-z0-9_$]+/g;

/**
 * 把一段文本切成检索 token（带重复，供倒排索引统计词频 tf）。
 *
 * 返回值故意不去重：BM25 需要每篇文档里每个词的出现次数，
 * 去重要交给查询侧（query 不关心词频，只关心命中哪些词）。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text.match(WORD_RE);
  if (!words) return out;

  for (const w of words) {
    const lower = w.toLowerCase();
    out.push(lower);
    for (const sub of splitIdentifier(w)) {
      const s = sub.toLowerCase();
      // 单字母子词（如 x、i）噪声大、区分度低，跳过；与原词相同也不重复加。
      if (s.length > 1 && s !== lower) out.push(s);
    }
  }
  return out;
}

/** 查询侧分词：去重即可，词频对召回无意义。 */
export function tokenizeQuery(text: string): string[] {
  return [...new Set(tokenize(text))];
}

/**
 * 把一个标识符拆成语义子词。
 *
 * 先按下划线/连字符切，再在每段内部按 camelCase 与「连续大写缩写 + 数字」边界切：
 *   getUserName -> [get, User, Name]
 *   HTTPServer  -> [HTTP, Server]
 *   parseJSON2  -> [parse, JSON, 2]
 * 用正则的「前瞻」识别 `HTTPServer` 这类缩写后接单词的边界，避免切成 [H,T,T,P,Server]。
 */
export function splitIdentifier(word: string): string[] {
  const parts: string[] = [];
  for (const chunk of word.split(/[_$-]+/)) {
    if (!chunk) continue;
    const matches = chunk.match(
      /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g
    );
    if (matches) parts.push(...matches);
  }
  return parts;
}
