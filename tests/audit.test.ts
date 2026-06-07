import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAuditEvent,
  classifyToolSideEffect,
  createDefaultAuditRecorder,
  JsonlAuditRecorder,
  NullAuditRecorder,
} from "../src/audit/index.js";

describe("classifyToolSideEffect", () => {
  it("只读工具归类为 read", () => {
    expect(classifyToolSideEffect("read_file")).toBe("read");
    expect(classifyToolSideEffect("grep")).toBe("read");
  });

  it("写与删归类为对应副作用等级", () => {
    expect(classifyToolSideEffect("write_file")).toBe("idempotent_write");
    expect(classifyToolSideEffect("edit_file")).toBe("non_idempotent_write");
    expect(classifyToolSideEffect("delete_file")).toBe("non_idempotent_write");
  });

  it("命令归类为 command，未知工具归类为 unknown", () => {
    expect(classifyToolSideEffect("run_command")).toBe("command");
    expect(classifyToolSideEffect("mystery")).toBe("unknown");
  });
});

describe("buildAuditEvent", () => {
  it("组装结构化事件并计算耗时", () => {
    const event = buildAuditEvent({
      call: { id: "call-1", name: "delete_file", arguments: '{"path":"a.txt"}' },
      riskLevel: "high",
      approved: false,
      status: "denied",
      startedAt: 1000,
      endedAt: 1200,
      outputSummary: "用户拒绝",
    });
    expect(event.toolCallId).toBe("call-1");
    expect(event.sideEffectType).toBe("non_idempotent_write");
    expect(event.approved).toBe(false);
    expect(event.status).toBe("denied");
    expect(event.durationMs).toBe(200);
  });
});

describe("JsonlAuditRecorder", () => {
  it("以 JSONL 追加写入事件", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-"));
    const file = path.join(dir, "nested", "audit.jsonl");
    const recorder = new JsonlAuditRecorder(file);

    const event = buildAuditEvent({
      call: { id: "c1", name: "run_command", arguments: '{"command":"ls"}' },
      riskLevel: "high",
      approved: true,
      status: "succeeded",
      startedAt: 0,
      endedAt: 5,
      outputSummary: "ok",
    });
    await recorder.record(event);
    await recorder.record({ ...event, id: "audit_2" });

    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).toolName).toBe("run_command");
  });
});

describe("createDefaultAuditRecorder", () => {
  it("off 时返回 NullAuditRecorder", () => {
    expect(createDefaultAuditRecorder("/tmp", "off")).toBeInstanceOf(
      NullAuditRecorder
    );
  });

  it("默认返回 JsonlAuditRecorder", () => {
    expect(createDefaultAuditRecorder("/tmp", undefined)).toBeInstanceOf(
      JsonlAuditRecorder
    );
  });
});
