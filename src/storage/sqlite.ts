import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite 底层连接帮助。
 *
 * 这里只放“怎么开一个健壮的本地库 + 怎么做版本化迁移”这种与业务无关的胶水，
 * 让 storage（业务库）和 audit（审计库）共用同一套打开/迁移约定。
 */

export type DB = Database.Database;

/** 项目所有持久化数据统一放在 <cwd>/.claude-mini 下，便于 .gitignore 与清理。 */
export function resolveDataDir(cwd: string): string {
  return path.join(cwd, ".claude-mini");
}

/**
 * 打开（或创建）一个 SQLite 文件。
 *
 * - 自动建好父目录，否则 better-sqlite3 会因目录不存在而抛错。
 * - WAL 模式让“读不阻塞写”，CLI 在写历史的同时仍可被其它进程读取。
 * - foreignKeys 默认开启，保证 messages → sessions 这类引用约束生效。
 */
export function openSqlite(
  filePath: string,
  opts: { foreignKeys?: boolean } = {}
): DB {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  if (opts.foreignKeys !== false) db.pragma("foreign_keys = ON");
  return db;
}

/**
 * 极简版本化迁移：用 SQLite 内置的 user_version 记录已应用到的版本。
 *
 * 当前库版本 < 目标版本时才执行 DDL，执行后把 user_version 抬到目标版本。
 * 所有 DDL 都用 IF NOT EXISTS，保证重复运行幂等，给后续 schema 演进留空间。
 */
export function migrate(db: DB, targetVersion: number, ddl: string): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= targetVersion) return;
  db.exec(ddl);
  db.pragma(`user_version = ${targetVersion}`);
}
