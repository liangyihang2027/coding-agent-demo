import type { ToolCall } from "../types/index.js";

/**
 * 阶段 6「权限 / 审批闸门」（必做，非 ⭐ 但属系统设计得分点）。
 *
 * 目标（蓝图 §阶段6）：工具调用前做风险分级 + 人工确认闸门。
 *
 * 待你实现：
 *   [ ] 风险分级：read_file(低) / write_file(中) / run_command(高，尤其危险命令)
 *   [ ] gating：高风险调用前要求用户确认（CLI 里 y/n）
 *   [ ] 与 sandbox 的危险命令检测协同
 */

export type RiskLevel = "low" | "medium" | "high";

export interface PermissionGate {
  assess(call: ToolCall): RiskLevel;
  /** 返回 true 表示允许执行 */
  confirm(call: ToolCall, risk: RiskLevel): Promise<boolean>;
}

// TODO 阶段6：实现风险评估与确认闸门，并接入 AgentLoop 工具执行前。
