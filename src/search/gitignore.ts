/**
 * .gitignore 解析与匹配（检索遍历的「过滤地基」）。
 *
 * 为什么自己写：阶段 4 的目标是「大代码库塞不进 context window」，而决定召回质量的
 * 第一步是「别把垃圾文件喂进索引」。node_modules / dist / 锁文件 一旦进了倒排索引，
 * 既拖慢建索引又污染相关性排序。复用项目里硬编码的「跳过 node_modules/.git」太粗，
 * 真实仓库的忽略规则写在 .gitignore 里，所以这里实现一个够用的 gitignore 匹配器。
 *
 * 支持的语义（gitignore 规范的常用子集）：
 *   - 注释行（# 开头）、空行
 *   - 取反（! 开头）：后一条匹配可以「反悔」前面的忽略
 *   - 目录限定（结尾 /）：只匹配目录
 *   - 锚定（含 / 的模式相对 .gitignore 所在目录锚定；纯名字则任意层级匹配）
 *   - 通配：`*`（不跨 /）、`?`（单个非 / 字符）、`**`（跨目录）
 *
 * 刻意不实现的边角：转义的行尾空格、`[a-z]` 字符类——对代码检索收益极低。
 */

interface CompiledRule {
  /** 编译后的正则，匹配「相对 base 的路径」 */
  re: RegExp;
  /** 是否取反规则（命中后表示「不忽略」） */
  negated: boolean;
  /** 是否只匹配目录 */
  dirOnly: boolean;
  /** 规则锚定的相对目录（该 .gitignore 所在目录相对仓库根的路径，"" 表示根） */
  base: string;
}

/** 把一行 gitignore 模式编译成正则；注释/空行返回 null。 */
function compileLine(raw: string, base: string): CompiledRule | null {
  let line = raw.replace(/\r$/, "");
  // 行尾未转义的空格按规范忽略；这里简化为直接 trimEnd（不处理 "\ " 转义）。
  line = line.replace(/\s+$/, "");
  if (line === "" || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  // 处理开头的转义字符（\# / \!）
  if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return null;

  // 含「中间或开头的 /」=> 相对 base 锚定；纯名字 => 任意层级匹配。
  const anchored = line.includes("/") && !line.startsWith("**/");
  const normalized = line.startsWith("/") ? line.slice(1) : line;

  const body = patternToRegexBody(normalized);
  const prefix = anchored ? "^" : "(?:^|.*/)";
  // 结尾允许 `/...`，这样即便越过父目录直接测试深层路径也能命中。
  const re = new RegExp(prefix + body + "(?:/.*)?$");

  return { re, negated, dirOnly, base };
}

/** 把 gitignore 通配语法转成正则主体（不含锚点）。 */
function patternToRegexBody(pat: string): string {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]!;
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        const prevSlash = i === 0 || pat[i - 1] === "/";
        const afterStars = pat[i + 2];
        if (prevSlash && afterStars === "/") {
          // 形如 `**/`：匹配零或多层目录
          re += "(?:.*/)?";
          i += 2; // 吃掉 `**` 与紧随的 `/`
          continue;
        }
        // 其余 `**`：跨目录任意匹配
        re += ".*";
        i += 1;
        continue;
      }
      // 单个 `*`：匹配同层任意字符（不跨 /）
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return re;
}

/**
 * 一组 gitignore 规则的匹配器。
 *
 * 遍历时按「从仓库根到深层目录」的顺序累积规则，深层 .gitignore 的规则排在后面，
 * 配合「最后命中者生效」的规则，自然实现了 gitignore 的优先级（深层覆盖浅层、取反覆盖忽略）。
 */
export class IgnoreMatcher {
  private rules: CompiledRule[];

  constructor(rules: CompiledRule[] = []) {
    this.rules = rules;
  }

  /** 追加某个目录（base，相对仓库根）下 .gitignore 的内容。返回新实例，保持不可变以便遍历分叉。 */
  add(content: string, base = ""): IgnoreMatcher {
    const next = [...this.rules];
    for (const line of content.split("\n")) {
      const rule = compileLine(line, base);
      if (rule) next.push(rule);
    }
    return new IgnoreMatcher(next);
  }

  /** 直接追加若干模式（用于内置默认忽略，如 .git）。 */
  addPatterns(patterns: string[], base = ""): IgnoreMatcher {
    return this.add(patterns.join("\n"), base);
  }

  /**
   * 判断「相对仓库根的路径」是否被忽略。
   * @param relPath 用 / 分隔的相对路径，如 "src/foo.ts"
   * @param isDir 是否为目录
   */
  ignores(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      const sub = subPath(relPath, rule.base);
      if (sub == null) continue;
      if (rule.re.test(sub)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}

/** 取 relPath 相对 base 的子路径；不在 base 之内则返回 null。 */
function subPath(relPath: string, base: string): string | null {
  if (base === "") return relPath;
  const prefix = base.endsWith("/") ? base : base + "/";
  if (relPath === base) return "";
  if (relPath.startsWith(prefix)) return relPath.slice(prefix.length);
  return null;
}
