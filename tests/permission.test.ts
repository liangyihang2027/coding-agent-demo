import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent/loop.js";
import { ConversationState } from "../src/agent/state.js";
import {
  assessToolRisk,
  createAlwaysAllowConfirm,
  createAlwaysDenyConfirm,
  DefaultPermissionGate,
  isDangerousCommand,
} from "../src/permission/index.js";
import { ToolRegistry } from "../src/tools/index.js";
import type { LLMClient, LLMStreamEvent } from "../src/types/index.js";

describe("permission risk", () => {
  it("read_file 为低风险", () => {
    expect(
      assessToolRisk({
        id: "1",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      })
    ).toBe("low");
  });

  it("write_file 为中风险", () => {
    expect(
      assessToolRisk({
        id: "1",
        name: "write_file",
        arguments: "{}",
      })
    ).toBe("medium");
  });

  it("危险 run_command 保持高风险", () => {
    expect(isDangerousCommand("rm -rf /tmp/x")).toBe(true);
    expect(
      assessToolRisk({
        id: "1",
        name: "run_command",
        arguments: '{"command":"rm -rf /tmp/x"}',
      })
    ).toBe("high");
  });

  it("未知工具按高风险", () => {
    expect(
      assessToolRisk({
        id: "1",
        name: "unknown_tool",
        arguments: "{}",
      })
    ).toBe("high");
  });
});

describe("DefaultPermissionGate", () => {
  it("低风险自动放行", async () => {
    const gate = new DefaultPermissionGate({
      confirm: createAlwaysDenyConfirm(),
    });
    const ok = await gate.confirm(
      { id: "1", name: "read_file", arguments: "{}" },
      "low"
    );
    expect(ok).toBe(true);
  });

  it("高风险需 confirm 同意", async () => {
    const gate = new DefaultPermissionGate({
      confirm: createAlwaysAllowConfirm(),
    });
    const ok = await gate.confirm(
      { id: "1", name: "delete_file", arguments: '{"path":"x"}' },
      "high"
    );
    expect(ok).toBe(true);
  });

  it("高风险 confirm 拒绝则拦截", async () => {
    const gate = new DefaultPermissionGate({
      confirm: createAlwaysDenyConfirm(),
    });
    const ok = await gate.confirm(
      { id: "1", name: "run_command", arguments: '{"command":"echo hi"}' },
      "high"
    );
    expect(ok).toBe(false);
  });
});

describe("AgentLoop permission integration", () => {
  it("拒绝高风险工具时不执行工具，但回填拒绝结果给模型", async () => {
    let executed = false;
    let streamCalls = 0;
    const llm: LLMClient = {
      async *stream(): AsyncGenerator<LLMStreamEvent> {
        streamCalls += 1;
        if (streamCalls === 1) {
          yield {
            type: "tool_calls",
            toolCalls: [
              {
                id: "call-1",
                name: "delete_file",
                arguments: '{"path":"danger.txt"}',
              },
            ],
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text", delta: "已跳过危险操作" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const tools = new ToolRegistry().register({
      name: "delete_file",
      description: "delete a file",
      parameters: z.object({ path: z.string() }),
      execute: async () => {
        executed = true;
        return { content: "deleted" };
      },
    });
    const loop = new AgentLoop({
      llm,
      tools,
      cwd: process.cwd(),
      permission: new DefaultPermissionGate({
        confirm: createAlwaysDenyConfirm(),
      }),
    });
    const state = new ConversationState();
    const denied: string[] = [];
    const toolResults: string[] = [];

    const final = await loop.run(state, "delete it", {
      onToolDenied: (_call, reason) => denied.push(reason),
      onToolResult: (_call, content) => toolResults.push(content),
    });

    expect(final).toBe("已跳过危险操作");
    expect(executed).toBe(false);
    expect(denied).toHaveLength(1);
    expect(toolResults).toHaveLength(0);
    expect(state.all()).toContainEqual({
      role: "tool",
      toolCallId: "call-1",
      name: "delete_file",
      content: denied[0],
    });
  });
});
