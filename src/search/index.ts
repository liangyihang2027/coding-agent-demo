/**
 * ⭐⭐⭐ 阶段 4「代码库检索」—— 项目的灵魂，必须做到这一阶段。⭐⭐⭐
 *
 * 目标（蓝图 §阶段4）：解决「大代码库塞不进 context window」。
 *
 * 待你实现：
 *   [ ] 文件遍历 + .gitignore 忽略规则解析
 *   [ ] 关键词 / 正则搜索（仿 ripgrep，可对比性能）
 *   [ ] 用 tree-sitter 做 AST 解析，提取函数/类/符号定义
 *   [ ] 构建符号索引（符号名 -> 位置；思考数据结构选型：哈希表 / Trie / 倒排）
 *   [ ] 相关性召回：根据 query 召回最相关的代码片段
 *   [ ] 上下文裁剪：召回结果按 token 预算截断
 *
 * 设计取向：用索引（倒排 / Trie）把「查得快」和「查得准」分别交给数据结构和
 * 相关性排序解决，避免把整个代码库塞进上下文窗口。
 */

export interface SearchHit {
  file: string;
  line: number;
  snippet: string;
  score: number;
}

export interface CodeSearch {
  /** 按 query 召回最相关的若干片段 */
  query(text: string, limit?: number): Promise<SearchHit[]>;
}

// TODO 阶段4：在这里实现遍历、索引构建、检索与召回。
