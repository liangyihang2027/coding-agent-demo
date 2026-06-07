import path from "node:path";
import { migrate, openSqlite, resolveDataDir, type DB } from "./sqlite.js";
import { STORE_SCHEMA_DDL, STORE_SCHEMA_VERSION } from "./schema.js";
import { SessionRepo } from "./session-repo.js";
import { PermissionRepo } from "./permission-repo.js";
import { SummaryRepo } from "./summary-repo.js";

export { SessionRepo } from "./session-repo.js";
export type {
  SessionRow,
  SessionSummaryRow,
} from "./session-repo.js";
export { PermissionRepo } from "./permission-repo.js";
export type { PermissionDecision, PermissionRuleRow } from "./permission-repo.js";
export { SummaryRepo } from "./summary-repo.js";
export type { SummaryRow } from "./summary-repo.js";
export { resolveDataDir, type DB } from "./sqlite.js";

/** 业务库默认文件路径：<cwd>/.claude-mini/store.db。 */
export function resolveStorePath(cwd: string): string {
  return path.join(resolveDataDir(cwd), "store.db");
}

/**
 * 业务数据存储门面。
 *
 * 统一持有 store.db 连接并下挂各仓储（会话/权限/摘要），让上层只依赖一个 Store，
 * 不必各自开库。审计走独立的 audit.db（见 src/audit），与此处分库存放。
 */
export class Store {
  readonly db: DB;
  readonly sessions: SessionRepo;
  readonly permissions: PermissionRepo;
  readonly summaries: SummaryRepo;

  constructor(cwd: string) {
    this.db = openSqlite(resolveStorePath(cwd), { foreignKeys: true });
    migrate(this.db, STORE_SCHEMA_VERSION, STORE_SCHEMA_DDL);
    this.sessions = new SessionRepo(this.db);
    this.permissions = new PermissionRepo(this.db);
    this.summaries = new SummaryRepo(this.db);
  }

  close(): void {
    this.db.close();
  }
}
