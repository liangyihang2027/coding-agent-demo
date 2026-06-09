/**
 * ⭐ 基于 tree-sitter 的符号提取（阶段 4：用 AST 而非正则识别函数/类/定义）。
 *
 * 为什么用 AST 而不是正则：正则面对「字符串里写了 function」「注释里的 class」「跨行签名」
 * 会误报漏报，而 tree-sitter 给出的是真正的语法树，节点类型与语言语义一一对应，提取符号稳。
 *
 * 这里把符号名也喂进倒排索引（见 index.ts），让用户搜 "parse user" 时，定义了
 * `parseUser` 的文件能因为「符号名命中」获得额外权重——符号是代码里最具检索价值的信号。
 *
 * 语法 wasm 来自 tree-sitter-wasms（预编译），运行时按文件后缀懒加载并缓存，
 * 避免每次解析都重新加载语言。Parser.init() 全局只跑一次。
 */

import { createRequire } from "node:module";
import path from "node:path";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based 行号 */
  line: number;
}

/** 某语言的提取规则：要访问的节点类型 -> 如何从该节点产出符号（返回 null 表示跳过）。 */
type NodeHandler = (node: Parser.SyntaxNode) => CodeSymbol | null;

interface LanguageSpec {
  /** tree-sitter-wasms 内的语法文件名 */
  wasm: string;
  handlers: Record<string, NodeHandler>;
}

/** 取 name 字段的文本；没有则返回 null。 */
function named(node: Parser.SyntaxNode, kind: SymbolKind): CodeSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  return { name: nameNode.text, kind, line: node.startPosition.row + 1 };
}

/** JS/TS 共用：仅当 `const x = () => {}` / `= function(){}` 时才把变量当函数符号收录。 */
function functionVariable(node: Parser.SyntaxNode): CodeSymbol | null {
  const value = node.childForFieldName("value");
  if (!value) return null;
  if (
    value.type === "arrow_function" ||
    value.type === "function" ||
    value.type === "function_expression"
  ) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    return {
      name: nameNode.text,
      kind: "function",
      line: node.startPosition.row + 1,
    };
  }
  return null;
}

const JS_TS_HANDLERS: Record<string, NodeHandler> = {
  class_declaration: (n) => named(n, "class"),
  abstract_class_declaration: (n) => named(n, "class"),
  function_declaration: (n) => named(n, "function"),
  generator_function_declaration: (n) => named(n, "function"),
  method_definition: (n) => named(n, "method"),
  interface_declaration: (n) => named(n, "interface"),
  type_alias_declaration: (n) => named(n, "type"),
  enum_declaration: (n) => named(n, "enum"),
  variable_declarator: functionVariable,
};

const PY_HANDLERS: Record<string, NodeHandler> = {
  function_definition: (n) => named(n, "function"),
  class_definition: (n) => named(n, "class"),
};

/** 文件后缀 -> 语言规则。 */
const EXT_TO_SPEC: Record<string, LanguageSpec> = {
  ".ts": { wasm: "tree-sitter-typescript.wasm", handlers: JS_TS_HANDLERS },
  ".mts": { wasm: "tree-sitter-typescript.wasm", handlers: JS_TS_HANDLERS },
  ".cts": { wasm: "tree-sitter-typescript.wasm", handlers: JS_TS_HANDLERS },
  ".tsx": { wasm: "tree-sitter-tsx.wasm", handlers: JS_TS_HANDLERS },
  ".js": { wasm: "tree-sitter-javascript.wasm", handlers: JS_TS_HANDLERS },
  ".jsx": { wasm: "tree-sitter-javascript.wasm", handlers: JS_TS_HANDLERS },
  ".mjs": { wasm: "tree-sitter-javascript.wasm", handlers: JS_TS_HANDLERS },
  ".cjs": { wasm: "tree-sitter-javascript.wasm", handlers: JS_TS_HANDLERS },
  ".py": { wasm: "tree-sitter-python.wasm", handlers: PY_HANDLERS },
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Parser.Language>();

/** Parser.init() 全局只执行一次。 */
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

/** 按 wasm 文件名懒加载并缓存 Language。 */
async function loadLanguage(wasm: string): Promise<Parser.Language> {
  const cached = languageCache.get(wasm);
  if (cached) return cached;
  const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasm}`);
  const lang = await Parser.Language.load(wasmPath);
  languageCache.set(wasm, lang);
  return lang;
}

/** 该后缀是否支持符号提取。 */
export function isSupportedSource(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() in EXT_TO_SPEC;
}

/**
 * 从源码中提取符号（函数/类/方法/接口/类型/枚举/函数型变量）。
 * 不支持的语言返回空数组（不报错，让上层照常只用文本索引）。
 */
export async function extractSymbols(
  filePath: string,
  source: string
): Promise<CodeSymbol[]> {
  const spec = EXT_TO_SPEC[path.extname(filePath).toLowerCase()];
  if (!spec) return [];

  await ensureInit();
  const lang = await loadLanguage(spec.wasm);
  const parser = new Parser();
  parser.setLanguage(lang);

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } finally {
    // parser 实例较轻，但显式释放底层 wasm 句柄更稳妥。
  }

  const out: CodeSymbol[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    const handler = spec.handlers[node.type];
    if (handler) {
      const sym = handler(node);
      if (sym) out.push(sym);
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  tree.delete();
  parser.delete();

  return out;
}
