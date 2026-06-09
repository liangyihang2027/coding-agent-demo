import { describe, it, expect } from "vitest";
import {
  HeuristicContextManager,
  defaultSummarizer,
} from "../src/context/index.js";
import type { Message } from "../src/types/index.js";

/**
 * ⭐ 阶段 5 上下文管理用例。
 * 验证：token 计量、未超限不动、恒留 system、超限折叠最旧 turn、协议完整、预算上限。
 */

const cm = new HeuristicContextManager();

/** 构造一个完整的工具调用轮：user -> assistant(toolCalls) -> tool 结果。 */
function toolRound(id: string, userText: string, toolOut: string): Message[] {
  return [
    { role: "user", content: userText },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "read_file", arguments: '{"path":"x"}' }],
    },
    { role: "tool", toolCallId: id, name: "read_file", content: toolOut },
  ];
}

describe("HeuristicContextManager.estimateTokens", () => {
  it("大致随长度单调递增", () => {
    const short = cm.estimateTokens([{ role: "user", content: "hi" }]);
    const long = cm.estimateTokens([
      { role: "user", content: "x".repeat(400) },
    ]);
    expect(long).toBeGreaterThan(short);
  });

  it("计入工具调用参数", () => {
    const withCall = cm.estimateTokens([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "grep", arguments: '{"pattern":"foo"}' }],
      },
    ]);
    expect(withCall).toBeGreaterThan(0);
  });
});

describe("HeuristicContextManager.compact", () => {
  it("未超预算时原样返回", () => {
    const msgs: Message[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const out = cm.compact(msgs, 10000);
    expect(out).toEqual(msgs);
  });

  it("超预算时恒保留 system 与最新 turn", () => {
    const msgs: Message[] = [
      { role: "system", content: "SYS PROMPT" },
      ...toolRound("a", "old request one", "A".repeat(2000)),
      ...toolRound("b", "old request two", "B".repeat(2000)),
      ...toolRound("c", "latest request three", "C".repeat(200)),
    ];
    const out = cm.compact(msgs, 400);

    expect(out[0]).toEqual({ role: "system", content: "SYS PROMPT" });
    // 最新 turn 的 user 必须还在
    expect(out.some((m) => m.role === "user" && m.content.includes("three"))).toBe(true);
    // 最旧 turn 被折叠（不再原样出现）
    expect(out.some((m) => m.role === "user" && m.content === "old request one")).toBe(false);
  });

  it("折叠会插入一条摘要消息", () => {
    const msgs: Message[] = [
      { role: "system", content: "SYS" },
      ...toolRound("a", "request alpha", "A".repeat(3000)),
      ...toolRound("b", "request beta latest", "B".repeat(50)),
    ];
    const out = cm.compact(msgs, 200);
    const summary = out.find(
      (m) => m.role === "system" && m.content.includes("折叠")
    );
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("request alpha");
  });

  it("压缩结果不超过预算（兜底裁剪生效）", () => {
    const budget = 500;
    const msgs: Message[] = [
      { role: "system", content: "S".repeat(100) },
      ...toolRound("a", "r1", "A".repeat(5000)),
      ...toolRound("b", "r2", "B".repeat(5000)),
      ...toolRound("c", "latest", "C".repeat(5000)),
    ];
    const out = cm.compact(msgs, budget);
    expect(cm.estimateTokens(out)).toBeLessThanOrEqual(budget);
  });

  it("协议完整性：每条 tool 都有前序匹配的 assistant toolCall", () => {
    const msgs: Message[] = [
      { role: "system", content: "SYS" },
      ...toolRound("a", "r1", "A".repeat(4000)),
      ...toolRound("b", "r2", "B".repeat(4000)),
      ...toolRound("c", "latest", "C".repeat(4000)),
    ];
    const out = cm.compact(msgs, 600);

    const seenCallIds = new Set<string>();
    for (const m of out) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const c of m.toolCalls) seenCallIds.add(c.id);
      }
      if (m.role === "tool") {
        expect(m.toolCallId).toBeDefined();
        expect(seenCallIds.has(m.toolCallId!)).toBe(true);
      }
    }
    // 反向：保留的 assistant.toolCalls 都应有对应 tool 结果
    const toolResultIds = new Set(
      out.filter((m) => m.role === "tool").map((m) => m.toolCallId)
    );
    for (const m of out) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const c of m.toolCalls) {
          expect(toolResultIds.has(c.id)).toBe(true);
        }
      }
    }
  });

  it("超大工具结果被头尾裁剪且保留首尾片段", () => {
    const big = "HEAD" + "x".repeat(8000) + "TAIL";
    const msgs: Message[] = [
      { role: "system", content: "SYS" },
      ...toolRound("a", "only request", big),
    ];
    const out = cm.compact(msgs, 300);
    const toolMsg = out.find((m) => m.role === "tool")!;
    expect(toolMsg.content.length).toBeLessThan(big.length);
    expect(toolMsg.content).toContain("已折叠");
    expect(toolMsg.content.startsWith("HEAD")).toBe(true);
    expect(toolMsg.content.endsWith("TAIL")).toBe(true);
  });
});

describe("defaultSummarizer", () => {
  it("列出被折叠的用户请求与工具名", () => {
    const dropped: Message[] = [
      { role: "user", content: "do something with files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "grep", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "1", name: "grep", content: "..." },
    ];
    const s = defaultSummarizer(dropped);
    expect(s).toContain("3 条消息");
    expect(s).toContain("do something with files");
    expect(s).toContain("grep");
  });
});
