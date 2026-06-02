import type { Message, ToolCall } from "../types/index.js";

/**
 * 会话状态。阶段 1 只是一个简单的消息数组容器；
 * 阶段 5 ⭐「上下文管理」会在这里接入 token 计量 + 压缩/截断策略。
 */
export class ConversationState {
  private messages: Message[] = [];

  constructor(systemPrompt?: string) {
    if (systemPrompt) {
      this.messages.push({ role: "system", content: systemPrompt });
    }
  }

  all(): readonly Message[] {
    return this.messages;
  }

  addUser(content: string): void {
    this.messages.push({ role: "user", content });
  }

  addAssistant(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({
      role: "assistant",
      content,
      ...(toolCalls && toolCalls.length ? { toolCalls } : {}),
    });
  }

  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: "tool", toolCallId, name, content });
  }
}
