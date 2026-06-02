import { describe, it, expect } from "vitest";
import { ToolCallAssembler } from "../src/llm/tool-call-assembler.js";

/**
 * 阶段 1 流式 tool_calls 拼接器的冒烟测试。
 * 这是「我写的胶水」的测试，已可直接跑通（pnpm test）。
 */
describe("ToolCallAssembler", () => {
  it("按 index 把分片拼成完整的工具调用", () => {
    const a = new ToolCallAssembler();
    // 模拟 OpenAI 流式分片：第一片带 id/name，后续只追加 arguments
    a.push([{ index: 0, id: "call_1", function: { name: "read_file" } }]);
    a.push([{ index: 0, function: { arguments: '{"pa' } }]);
    a.push([{ index: 0, function: { arguments: 'th":"a.ts"}' } }]);

    const calls = a.finalize();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: "call_1",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
    });
  });

  it("支持并行多个工具调用（不同 index）", () => {
    const a = new ToolCallAssembler();
    a.push([
      { index: 0, id: "c0", function: { name: "read_file", arguments: "{}" } },
      { index: 1, id: "c1", function: { name: "write_file" } },
    ]);
    a.push([{ index: 1, function: { arguments: '{"path":"b"}' } }]);

    const calls = a.finalize();
    expect(calls.map((c) => c.name)).toEqual(["read_file", "write_file"]);
    expect(calls[1]!.arguments).toBe('{"path":"b"}');
  });

  it("无任何 tool_calls 时 hasAny 为 false", () => {
    const a = new ToolCallAssembler();
    a.push(undefined);
    expect(a.hasAny()).toBe(false);
  });
});
