import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/index.js";
import { ConversationState } from "../src/agent/state.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "store-"));
}

describe("SessionRepo", () => {
  it("落库并按 seq 恢复消息（含 tool_calls）", async () => {
    const cwd = await tmpDir();
    const store = new Store(cwd);
    store.sessions.createSession({ id: "s1", cwd });

    store.sessions.appendMessage("s1", 0, null, {
      role: "system",
      content: "你是助手",
    });
    store.sessions.appendMessage("s1", 1, null, {
      role: "user",
      content: "帮我读文件",
    });
    store.sessions.appendMessage("s1", 2, 0, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"a"}' }],
    });
    store.sessions.appendMessage("s1", 3, 0, {
      role: "tool",
      content: "文件内容",
      toolCallId: "t1",
      name: "read_file",
    });

    const msgs = store.sessions.loadMessages("s1");
    expect(msgs).toHaveLength(4);
    expect(msgs[2]!.toolCalls?.[0]?.name).toBe("read_file");
    expect(msgs[3]!.toolCallId).toBe("t1");
    store.close();
  });

  it("listSessions 带消息数，latestSessionId 取最近活跃", async () => {
    const cwd = await tmpDir();
    const store = new Store(cwd);
    store.sessions.createSession({ id: "a", cwd });
    store.sessions.appendMessage("a", 0, null, { role: "user", content: "hi" });
    store.sessions.createSession({ id: "b", cwd });

    const list = store.sessions.listSessions();
    expect(list.length).toBe(2);
    // b 最后创建/活跃，应排在最前
    expect(store.sessions.latestSessionId(cwd)).toBe("b");
    const a = list.find((r) => r.id === "a");
    expect(a?.message_count).toBe(1);
    store.close();
  });
});

describe("ConversationState 持久化", () => {
  it("绑定后新消息落库，可被另一实例恢复", async () => {
    const cwd = await tmpDir();
    const store = new Store(cwd);
    store.sessions.createSession({ id: "s1", cwd });

    const state = new ConversationState("系统提示");
    state.bindStore(store.sessions, "s1", { persistExisting: true });
    expect(state.sessionId).toBe("s1");
    state.addUser("第一句");
    state.setStep(0);
    state.addAssistant("回复");

    const restored = new ConversationState();
    restored.loadFrom(store.sessions.loadMessages("s1"));
    const all = restored.all();
    expect(all.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(all[1]!.content).toBe("第一句");
    store.close();
  });
});

describe("PermissionRepo & SummaryRepo", () => {
  it("权限规则可写入并按 scope 查询", async () => {
    const cwd = await tmpDir();
    const store = new Store(cwd);
    store.permissions.addRule({
      scope: "global",
      toolName: "run_command",
      pattern: "npm test",
      decision: "allow",
    });
    const rules = store.permissions.findRules("run_command", ["global"]);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.decision).toBe("allow");
    store.close();
  });

  it("摘要可写入并按会话查询", async () => {
    const cwd = await tmpDir();
    const store = new Store(cwd);
    store.sessions.createSession({ id: "s1", cwd });
    store.summaries.addSummary({
      sessionId: "s1",
      coversSeqStart: 0,
      coversSeqEnd: 9,
      content: "前 10 条摘要",
      tokenEstimate: 123,
    });
    const list = store.summaries.listSummaries("s1");
    expect(list).toHaveLength(1);
    expect(list[0]!.token_estimate).toBe(123);
    store.close();
  });
});
