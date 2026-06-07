import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolCall } from "../types/index.js";
import type { RiskLevel } from "../permission/types.js";
import {
  migrate,
  openSqlite,
  resolveDataDir,
  type DB,
} from "../storage/sqlite.js";

/**
 * 审计（Audit）模块。
 *
 * 审计与普通日志不同：日志服务于工程师排查问题；审计关注“谁在什么时间、
 * 批准了什么、执行了什么、产生了什么结果”，因此只覆盖有副作用的关键动作。
 *
 * 本项目审计定位为「运维 / 调试」：核心诉求是可查询、可关联（按会话 / 工具 /
 * 时间 / 状态过滤），而非合规级防篡改。因此默认写入独立的 audit.db（SQLite），
 * 与业务库 store.db 分开存放，并支持按保留天数清理。
 */

/** 工具的副作用分级，决定重试与审批策略，也是审计里最关键的风险维度。 */
export type SideEffectType =
  | "read"
  | "idempotent_write"
  | "non_idempotent_write"
  | "command"
  | "unknown";

/** 一次工具调用的最终状态。拒绝、失败、成功都属于必须留痕的结果。 */
export type AuditStatus = "denied" | "succeeded" | "failed";

export interface AuditEvent {
  /** 事件唯一 id，便于跨日志检索单次动作。 */
  id: string;
  /** 所属会话 id（跨库关联到 store.db 的 sessions，不做 SQL 外键）。 */
  sessionId: string | null;
  /** 第几轮 ReAct 迭代（细粒度定位）。 */
  step: number | null;
  /** 该轮内第几个工具调用（细粒度定位）。 */
  callIndex: number | null;
  /** 对应的工具调用 id，可与会话历史里的 tool 消息对齐。 */
  toolCallId: string;
  toolName: string;
  /** 触发者：当前都是模型决策，保留字段以便未来区分 user/system。 */
  actor: "agent";
  riskLevel: RiskLevel;
  sideEffectType: SideEffectType;
  /** 是否经过用户确认放行；被拒绝时为 false。 */
  approved: boolean;
  status: AuditStatus;
  /** 收到工具调用、尚未询问用户的时刻。 */
  requestedAt: string;
  /** 事件最终落定的时刻。 */
  endedAt: string;
  /** 等待用户审批耗时（与真正执行耗时分离，避免混淆）。 */
  waitMs: number;
  /** 工具真正执行耗时；被拒绝时为 null。 */
  execMs: number | null;
  /** 模型给的原始参数摘要（仅防膨胀截断，不脱敏）。 */
  inputSummary: string;
  /** 执行结果摘要或拒绝原因（仅防膨胀截断，不脱敏）。 */
  outputSummary: string;
}

/** AgentLoop 只依赖这个接口，方便在测试或无审计场景注入空实现。 */
export interface AuditRecorder {
  record(event: AuditEvent): Promise<void>;
  /** 可选：释放底层资源（如关闭 SQLite 连接）。 */
  close?(): void;
}

/** 按工具名归类副作用等级；未知工具按 unknown，调用方可据此采取保守策略。 */
export function classifyToolSideEffect(name: string): SideEffectType {
  switch (name) {
    case "read_file":
    case "list_directory":
    case "glob_files":
    case "grep":
      return "read";
    case "write_file":
      return "idempotent_write";
    case "edit_file":
    case "delete_file":
      return "non_idempotent_write";
    case "run_command":
      return "command";
    default:
      return "unknown";
  }
}

/** 仅为防止单行/单字段过大而截断，不做脱敏（运维定位下保留原文更利于排查）。 */
function truncate(text: string, max = 2000): string {
  const t = text ?? "";
  return t.length > max ? `${t.slice(0, max)}…(${t.length - max} more)` : t;
}

let counter = 0;
/** 生成进程内单调递增、带时间戳的事件 id，避免高频调用碰撞。 */
function nextId(): string {
  counter += 1;
  return `audit_${Date.now()}_${counter}`;
}

export interface BuildAuditEventInput {
  call: ToolCall;
  sessionId?: string | null;
  step?: number | null;
  callIndex?: number | null;
  riskLevel: RiskLevel;
  approved: boolean;
  status: AuditStatus;
  /** 收到工具调用的毫秒时间戳（询问用户之前）。 */
  requestedAt: number;
  /** 审批决议的毫秒时间戳（confirm 返回时）。 */
  approvedAt: number;
  /** 事件最终落定的毫秒时间戳。 */
  endedAt: number;
  outputSummary: string;
}

/** 把一次工具调用的上下文组装成结构化审计事件，集中处理耗时拆分与截断。 */
export function buildAuditEvent(input: BuildAuditEventInput): AuditEvent {
  const waitMs = Math.max(0, input.approvedAt - input.requestedAt);
  const execMs = input.approved
    ? Math.max(0, input.endedAt - input.approvedAt)
    : null;
  return {
    id: nextId(),
    sessionId: input.sessionId ?? null,
    step: input.step ?? null,
    callIndex: input.callIndex ?? null,
    toolCallId: input.call.id,
    toolName: input.call.name,
    actor: "agent",
    riskLevel: input.riskLevel,
    sideEffectType: classifyToolSideEffect(input.call.name),
    approved: input.approved,
    status: input.status,
    requestedAt: new Date(input.requestedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    waitMs,
    execMs,
    inputSummary: truncate(input.call.arguments),
    outputSummary: truncate(input.outputSummary),
  };
}

/** 无审计场景（测试 / off 模式）：不记录任何事件。 */
export class NullAuditRecorder implements AuditRecorder {
  async record(): Promise<void> {
    // intentionally no-op
  }
}

// ----------------------------- 审计库（audit.db） -----------------------------

export const AUDIT_SCHEMA_VERSION = 1;

const AUDIT_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT,
  step          INTEGER,
  call_index    INTEGER,
  tool_call_id  TEXT,
  tool_name     TEXT NOT NULL,
  actor         TEXT NOT NULL,
  risk_level    TEXT NOT NULL,
  side_effect   TEXT NOT NULL,
  approved      INTEGER NOT NULL,
  status        TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  ended_at      TEXT NOT NULL,
  wait_ms       INTEGER NOT NULL,
  exec_ms       INTEGER,
  input_summary TEXT,
  output_summary TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, step, call_index);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
`;

/** 审计库默认文件路径：<cwd>/.claude-mini/audit.db。 */
export function resolveAuditPath(cwd: string): string {
  return path.join(resolveDataDir(cwd), "audit.db");
}

/** 打开并迁移审计库；审计与业务分库，故单独打开。 */
export function openAuditDb(cwd: string): DB {
  const db = openSqlite(resolveAuditPath(cwd), { foreignKeys: false });
  migrate(db, AUDIT_SCHEMA_VERSION, AUDIT_SCHEMA_DDL);
  return db;
}

/**
 * 把审计事件写入 audit.db。
 *
 * 运维定位下采用 SQLite 单写，换取按会话 / 工具 / 时间的可查询性。
 * 写入失败被吞掉，避免审计问题中断用户的主任务。
 */
export class SqliteAuditRecorder implements AuditRecorder {
  private insert: ReturnType<DB["prepare"]>;

  constructor(private db: DB) {
    this.insert = db.prepare(
      `INSERT INTO audit_events
         (id, session_id, step, call_index, tool_call_id, tool_name, actor,
          risk_level, side_effect, approved, status, requested_at, ended_at,
          wait_ms, exec_ms, input_summary, output_summary, created_at)
       VALUES
         (@id, @sessionId, @step, @callIndex, @toolCallId, @toolName, @actor,
          @riskLevel, @sideEffect, @approved, @status, @requestedAt, @endedAt,
          @waitMs, @execMs, @inputSummary, @outputSummary, @createdAt)`
    );
  }

  async record(event: AuditEvent): Promise<void> {
    try {
      this.insert.run({
        id: event.id,
        sessionId: event.sessionId,
        step: event.step,
        callIndex: event.callIndex,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        actor: event.actor,
        riskLevel: event.riskLevel,
        sideEffect: event.sideEffectType,
        approved: event.approved ? 1 : 0,
        status: event.status,
        requestedAt: event.requestedAt,
        endedAt: event.endedAt,
        waitMs: event.waitMs,
        execMs: event.execMs,
        inputSummary: event.inputSummary,
        outputSummary: event.outputSummary,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // 审计写入失败不应中断 Agent 主流程。
    }
  }

  close(): void {
    this.db.close();
  }
}

/** 删除早于保留期的审计记录，返回删除条数。供 `audit prune` 手动调用。 */
export function pruneAuditEvents(db: DB, retentionDays: number): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const info = db
    .prepare(`DELETE FROM audit_events WHERE created_at < ?`)
    .run(cutoff);
  return info.changes;
}

/**
 * 把审计事件以 JSONL 追加写入文件（可选实现，便于导出 / 外部同步）。
 *
 * 默认路径不再使用它；保留是因为 AuditRecorder 已是接口，
 * 需要纯文本权威留痕时可切换到这个实现。
 */
export class JsonlAuditRecorder implements AuditRecorder {
  private filePath: string;
  private dirEnsured = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.dirEnsured = true;
  }

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.ensureDir();
      await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // 审计写入失败不应中断 Agent 主流程。
    }
  }
}

/**
 * 构造默认审计记录器：默认写入 audit.db（SQLite）。
 *
 * CLAUDE_MINI_AUDIT=off / 0 / false 关闭审计（返回 Null 实现）。
 */
export function createDefaultAuditRecorder(
  cwd: string,
  env = process.env.CLAUDE_MINI_AUDIT
): AuditRecorder {
  const v = env?.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") {
    return new NullAuditRecorder();
  }
  return new SqliteAuditRecorder(openAuditDb(cwd));
}
