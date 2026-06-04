import type { ToolCall } from "../types/index.js";

export type RiskLevel = "low" | "medium" | "high";

/** 交给 UI / CLI 的审批上下文（后续 overlay 直接消费） */
export interface PermissionRequest {
  call: ToolCall;
  risk: RiskLevel;
  /** 人类可读的说明，用于提示或日志 */
  summary: string;
}

export type PermissionConfirmHandler = (
  request: PermissionRequest
) => Promise<boolean>;

export interface PermissionGate {
  assess(call: ToolCall): RiskLevel;
  /** 返回 true 表示允许执行 */
  confirm(call: ToolCall, risk: RiskLevel): Promise<boolean>;
}
