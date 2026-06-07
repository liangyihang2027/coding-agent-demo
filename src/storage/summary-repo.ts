import type { DB } from "./sqlite.js";

/**
 * 上下文摘要仓储（为阶段 5「上下文管理」预留）。
 *
 * ContextManager 压缩历史时产出的摘要在这里持久化，避免每次恢复会话都重新压缩
 * （省 token、保证一致）。先把存取能力建好，压缩算法在阶段 5 接入。
 */

export interface SummaryRow {
  id: number;
  session_id: string;
  covers_seq_start: number;
  covers_seq_end: number;
  content: string;
  token_estimate: number | null;
  created_at: string;
}

export class SummaryRepo {
  constructor(private db: DB) {}

  /** 记录一段历史摘要，covers_seq_* 标记它替代了哪段消息区间。 */
  addSummary(input: {
    sessionId: string;
    coversSeqStart: number;
    coversSeqEnd: number;
    content: string;
    tokenEstimate?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO summaries
           (session_id, covers_seq_start, covers_seq_end, content, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.coversSeqStart,
        input.coversSeqEnd,
        input.content,
        input.tokenEstimate ?? null,
        new Date().toISOString()
      );
  }

  /** 取某会话的所有摘要，按覆盖区间升序。 */
  listSummaries(sessionId: string): SummaryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM summaries WHERE session_id = ? ORDER BY covers_seq_start ASC`
      )
      .all(sessionId) as SummaryRow[];
  }
}
