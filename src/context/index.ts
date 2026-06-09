import type { Message } from "../types/index.js";

/**
 * ⭐⭐⭐ 阶段 5「上下文管理」—— 你要亲手实现的灵魂模块。⭐⭐⭐
 *
 * 目标（蓝图 §阶段5）：上下文窗口超限时的智能处理。
 *
 * 已实现（见 manager.ts 的 HeuristicContextManager）：
 *   [x] token 计量（启发式：字符数/4 + 每条固定开销 + 工具调用参数）
 *   [x] 超限策略：久远历史按整轮折叠成摘要、工具结果头尾裁剪、恒保留 system + 近期对话
 *   [x] 历史合并 / 折叠（splitTurns + summarizer）
 *   [x] 接入 AgentLoop.callModel（发模型前压缩；ConversationState 仍保留完整历史）
 *
 * 设计取向：在「压缩历史省 token」与「保留信息不失真」之间做取舍，
 * 优先保住系统提示和近期对话，对久远历史做摘要折叠。压缩是确定性的，便于单测。
 */

export interface ContextManager {
  estimateTokens(messages: readonly Message[]): number;
  /** 在预算内压缩/截断历史，返回可安全发送给模型的消息序列 */
  compact(messages: readonly Message[], budgetTokens: number): Message[];
}

export {
  HeuristicContextManager,
  defaultSummarizer,
  type Summarizer,
  type HeuristicContextManagerOptions,
} from "./manager.js";
