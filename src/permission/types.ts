import type { ToolCall } from "../types/index.js";

export type RiskLevel = "low" | "medium" | "high";

/** 交给 UI / CLI 的审批上下文（后续 overlay 直接消费） */
export interface PermissionRequest {
  /** 原始工具调用必须保留，确认通过后 AgentLoop 还要执行同一个 call。 */
  call: ToolCall;
  /** 风险等级用于决定 UI 语气和默认策略，不把策略硬编码在组件里。 */
  risk: RiskLevel;
  /** 人类可读的说明，用于提示或日志 */
  summary: string;
}

/** 将“如何向人确认”抽象出来，使 stdio、Ink overlay 和测试桩可以共用同一闸门。 */
export type PermissionConfirmHandler = (
  request: PermissionRequest
) => Promise<boolean>;

/** AgentLoop 只依赖这个接口，因此风险评估策略可以独立演进。 */
export interface PermissionGate {
  assess(call: ToolCall): RiskLevel;
  /** 返回 true 表示允许执行 */
  confirm(call: ToolCall, risk: RiskLevel): Promise<boolean>;
}
