import type { DB } from "./sqlite.js";

/**
 * 权限规则仓储（为「记住放行选择 / allowlist」预留）。
 *
 * 当前权限闸门只在内存里判定，不记忆用户决策；这张表让未来的
 * 「始终允许某命令」成为可能。先把存取能力建好，消费逻辑在权限阶段接入。
 */

export type PermissionDecision = "allow" | "deny";

export interface PermissionRuleRow {
  id: number;
  scope: string;
  tool_name: string;
  pattern: string | null;
  decision: PermissionDecision;
  created_at: string;
}

export class PermissionRepo {
  constructor(private db: DB) {}

  /** 记录一条放行/拒绝规则。scope 形如 global / session:<id> / cwd:<path>。 */
  addRule(input: {
    scope: string;
    toolName: string;
    pattern?: string;
    decision: PermissionDecision;
  }): void {
    this.db
      .prepare(
        `INSERT INTO permission_rules (scope, tool_name, pattern, decision, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.scope,
        input.toolName,
        input.pattern ?? null,
        input.decision,
        new Date().toISOString()
      );
  }

  /** 查某工具在给定 scope 集合下的规则，最近写入的优先。 */
  findRules(toolName: string, scopes: string[]): PermissionRuleRow[] {
    if (scopes.length === 0) return [];
    const placeholders = scopes.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM permission_rules
         WHERE tool_name = ? AND scope IN (${placeholders})
         ORDER BY created_at DESC`
      )
      .all(toolName, ...scopes) as PermissionRuleRow[];
  }

  /** 清空某 scope 下的规则（例如用户撤销会话级 allowlist）。 */
  clearScope(scope: string): void {
    this.db.prepare(`DELETE FROM permission_rules WHERE scope = ?`).run(scope);
  }
}
