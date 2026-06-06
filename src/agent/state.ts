import type { Message, ToolCall } from "../types/index.js";

/**
 * 会话状态。阶段 1 只是一个简单的消息数组容器；
 * 阶段 5 ⭐「上下文管理」会在这里接入 token 计量 + 压缩/截断策略。
 */
export class ConversationState {
  /**
   * 阶段一先保留完整消息序列，保证 ReAct 协议最容易观察和调试。
   * 这里暂不做裁剪，是为了把上下文压缩留给阶段五的 ContextManager 专门处理。
   */
  private messages: Message[] = [];

  constructor(systemPrompt?: string) {
    if (systemPrompt) {
      this.messages.push({ role: "system", content: systemPrompt });
    }
  }

  /** 暴露只读视图，避免调用方绕过 addUser/addAssistant/addToolResult 破坏消息顺序。 */
  all(): readonly Message[] {
    return this.messages;
  }

  /** 用户输入必须进入历史，否则模型下一轮看不到当前任务。 */
  addUser(content: string): void {
    this.messages.push({ role: "user", content });
  }

  /**
   * assistant 消息需要同时记录文本和 tool_calls。
   * OpenAI 工具协议要求后续 tool result 能对应到上一条 assistant 的调用决策。
   */
  addAssistant(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({
      role: "assistant",
      content,
      ...(toolCalls && toolCalls.length ? { toolCalls } : {}),
    });
  }

  /** 工具结果以独立消息回填，让模型可以基于真实执行结果继续推理或纠错。 */
  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: "tool", toolCallId, name, content });
  }
}
