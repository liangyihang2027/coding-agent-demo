import type { Message } from "../types/index.js";

/**
 * ⭐⭐⭐ 阶段 5「上下文管理」—— 你要亲手实现的灵魂模块。⭐⭐⭐
 *
 * 目标（蓝图 §阶段5）：上下文窗口超限时的智能处理。
 *
 * 待你实现：
 *   [ ] token 计量（估算每条消息的 token，可先用粗略启发式：字符数/4 之类）
 *   [ ] 超限策略：旧消息摘要压缩、工具结果裁剪、保留关键信息（system + 近期对话）
 *   [ ] 历史合并 / 折叠
 *   [ ] 接入 ConversationState（见 src/agent/state.ts）
 *
 * 面试得分点：算法 + 启发式设计、压缩 vs 信息损失的取舍。
 */

export interface ContextManager {
  estimateTokens(messages: readonly Message[]): number;
  /** 在预算内压缩/截断历史，返回可安全发送给模型的消息序列 */
  compact(messages: readonly Message[], budgetTokens: number): Message[];
}

// TODO 阶段5：实现 token 计量与压缩策略。
