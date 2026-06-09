import { describe, it, expect } from "vitest";
import { extractSymbols, isSupportedSource } from "../src/search/symbols.js";

/**
 * ⭐ 阶段 4 tree-sitter 符号提取用例。
 * 验证用 AST（而非正则）稳定识别函数/类/方法/接口/类型/枚举/函数型变量。
 */
describe("extractSymbols", () => {
  it("从 TypeScript 提取各类符号", async () => {
    const code = [
      "export class Foo extends Bar {",
      "  doWork(a: number) { return a; }",
      "}",
      "export function baz(a: number) { return a; }",
      "const qux = () => 2;",
      "interface IThing { x: number; }",
      "type Alias = string;",
      "enum Color { Red, Green }",
      "const notAFn = 42;",
    ].join("\n");

    const syms = await extractSymbols("sample.ts", code);
    const byName = new Map(syms.map((s) => [s.name, s]));

    expect(byName.get("Foo")?.kind).toBe("class");
    expect(byName.get("doWork")?.kind).toBe("method");
    expect(byName.get("baz")?.kind).toBe("function");
    expect(byName.get("qux")?.kind).toBe("function"); // 箭头函数变量
    expect(byName.get("IThing")?.kind).toBe("interface");
    expect(byName.get("Alias")?.kind).toBe("type");
    expect(byName.get("Color")?.kind).toBe("enum");
    // 普通常量不算函数符号
    expect(byName.has("notAFn")).toBe(false);
  });

  it("行号为 1-based 且正确", async () => {
    const code = "\n\nfunction onLineThree() {}\n";
    const syms = await extractSymbols("x.ts", code);
    expect(syms[0]).toMatchObject({ name: "onLineThree", line: 3 });
  });

  it("从 Python 提取函数与类", async () => {
    const code = ["class Animal:", "    def speak(self):", "        pass", "", "def helper():", "    return 1"].join("\n");
    const syms = await extractSymbols("m.py", code);
    const names = syms.map((s) => s.name).sort();
    expect(names).toContain("Animal");
    expect(names).toContain("speak");
    expect(names).toContain("helper");
  });

  it("不支持的后缀返回空数组且不报错", async () => {
    expect(isSupportedSource("notes.md")).toBe(false);
    expect(await extractSymbols("notes.md", "# hello")).toEqual([]);
  });
});
