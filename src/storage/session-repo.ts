import type { DB } from "./sqlite.js";
import type { Message, Role, ToolCall } from "../types/index.js";

/**
 * 会话与消息仓储。
 *
 * 负责把 ConversationState 的消息序列落到 store.db，并支持按会话恢复历史。
 * 写入按 seq 严格有序，保证 ReAct 协议（assistant.tool_calls → tool 结果）能原样回放。
 */

export interface SessionRow {
  id: string;
  cwd: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionSummaryRow extends SessionRow {
  message_count: number;
}

interface MessageRow {
  seq: number;
  step: number | null;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  name: string | null;
}

export class SessionRepo {
  constructor(private db: DB) {}

  /** 新会话落库；title 可后续由首条用户消息补齐。 */
  createSession(input: { id: string; cwd: string; title?: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, cwd, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.id, input.cwd, input.title ?? null, now, now);
  }

  /** 刷新会话的最近活跃时间，用于 --continue 选最新会话。 */
  touchSession(id: string): void {
    this.db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /** 仅在 title 为空时写入，避免覆盖用户/首条消息已生成的标题。 */
  setTitleIfEmpty(id: string, title: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = '')`
      )
      .run(title, id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
  }

  /** 列出会话（带消息条数），默认按最近活跃倒序，供 list-sessions 使用。 */
  listSessions(limit = 20): SessionSummaryRow[] {
    return this.db
      .prepare(
        `SELECT s.*, COUNT(m.id) AS message_count
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         GROUP BY s.id
         ORDER BY s.updated_at DESC, s.rowid DESC
         LIMIT ?`
      )
      .all(limit) as SessionSummaryRow[];
  }

  /** 取最近活跃的会话 id；给定 cwd 时只在该工作目录下选，支撑 --continue。 */
  latestSessionId(cwd?: string): string | undefined {
    const row = (
      cwd
        ? this.db
            .prepare(
              `SELECT id FROM sessions WHERE cwd = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`
            )
            .get(cwd)
        : this.db
            .prepare(
              `SELECT id FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1`
            )
            .get()
    ) as { id: string } | undefined;
    return row?.id;
  }

  /** 追加一条消息；tool_calls 以 JSON 字符串落库，并顺手刷新会话活跃时间。 */
  appendMessage(
    sessionId: string,
    seq: number,
    step: number | null,
    msg: Message
  ): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (session_id, seq, step, role, content, tool_calls, tool_call_id, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        seq,
        step,
        msg.role,
        msg.content ?? "",
        msg.toolCalls && msg.toolCalls.length
          ? JSON.stringify(msg.toolCalls)
          : null,
        msg.toolCallId ?? null,
        msg.name ?? null,
        new Date().toISOString()
      );
    this.touchSession(sessionId);
  }

  /** 按 seq 顺序加载某会话的全部消息，还原成内存里的 Message[]。 */
  loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as MessageRow[];
    return rows.map((r) => toMessage(r));
  }
}

function toMessage(row: MessageRow): Message {
  const msg: Message = {
    role: row.role as Role,
    content: row.content ?? "",
  };
  if (row.tool_calls) {
    msg.toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
  }
  if (row.tool_call_id) msg.toolCallId = row.tool_call_id;
  if (row.name) msg.name = row.name;
  return msg;
}
