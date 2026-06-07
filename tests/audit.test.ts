import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAuditEvent,
  classifyToolSideEffect,
  createDefaultAuditRecorder,
  NullAuditRecorder,
  openAuditDb,
  pruneAuditEvents,
  SqliteAuditRecorder,
} from "../src/audit/index.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "audit-"));
}

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
  it("denied 事件：记录等待耗时，execMs 为 null", () => {
    const event = buildAuditEvent({
      call: { id: "call-1", name: "delete_file", arguments: '{"path":"a.txt"}' },
      sessionId: "s1",
      step: 2,
      callIndex: 0,
      riskLevel: "high",
      approved: false,
      status: "denied",
      requestedAt: 1000,
      approvedAt: 1200,
      endedAt: 1200,
      outputSummary: "用户拒绝",
    });
    expect(event.toolCallId).toBe("call-1");
    expect(event.sideEffectType).toBe("non_idempotent_write");
    expect(event.sessionId).toBe("s1");
    expect(event.step).toBe(2);
    expect(event.callIndex).toBe(0);
    expect(event.approved).toBe(false);
    expect(event.status).toBe("denied");
    expect(event.waitMs).toBe(200);
    expect(event.execMs).toBeNull();
  });

  it("succeeded 事件：拆分审批等待与执行耗时", () => {
    const event = buildAuditEvent({
      call: { id: "c2", name: "run_command", arguments: '{"command":"ls"}' },
      riskLevel: "high",
      approved: true,
      status: "succeeded",
      requestedAt: 0,
      approvedAt: 5,
      endedAt: 25,
      outputSummary: "ok",
    });
    expect(event.waitMs).toBe(5);
    expect(event.execMs).toBe(20);
    expect(event.sessionId).toBeNull();
  });
});

describe("SqliteAuditRecorder", () => {
  it("把事件写入 audit.db 并可查询", async () => {
    const dir = await tmpDir();
    const db = openAuditDb(dir);
    const recorder = new SqliteAuditRecorder(db);

    await recorder.record(
      buildAuditEvent({
        call: { id: "c1", name: "run_command", arguments: '{"command":"ls"}' },
        sessionId: "sess-1",
        step: 0,
        callIndex: 0,
        riskLevel: "high",
        approved: true,
        status: "succeeded",
        requestedAt: 0,
        approvedAt: 5,
        endedAt: 25,
        outputSummary: "ok",
      })
    );

    const rows = db
      .prepare(`SELECT * FROM audit_events`)
      .all() as Array<{ tool_name: string; approved: number; exec_ms: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("run_command");
    expect(rows[0]!.approved).toBe(1);
    expect(rows[0]!.exec_ms).toBe(20);
    db.close();
  });
});

describe("pruneAuditEvents", () => {
  it("删除早于保留期的记录", async () => {
    const dir = await tmpDir();
    const db = openAuditDb(dir);
    const oldIso = new Date(Date.now() - 100 * 86400_000).toISOString();
    db.prepare(
      `INSERT INTO audit_events
         (id, tool_name, actor, risk_level, side_effect, approved, status,
          requested_at, ended_at, wait_ms, exec_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("old", "run_command", "agent", "low", "command", 1, "succeeded", "x", "y", 0, 1, oldIso);

    const removed = pruneAuditEvents(db, 90);
    expect(removed).toBe(1);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get() as { n: number }).n
    ).toBe(0);
    db.close();
  });
});

describe("createDefaultAuditRecorder", () => {
  it("off 时返回 NullAuditRecorder", async () => {
    const dir = await tmpDir();
    expect(createDefaultAuditRecorder(dir, "off")).toBeInstanceOf(NullAuditRecorder);
  });

  it("默认返回 SqliteAuditRecorder", async () => {
    const dir = await tmpDir();
    const recorder = createDefaultAuditRecorder(dir, undefined);
    expect(recorder).toBeInstanceOf(SqliteAuditRecorder);
    (recorder as SqliteAuditRecorder).close();
  });
});
