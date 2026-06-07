import type { Message, ToolCall } from "../types/index.js";
import type { SessionRepo } from "../storage/index.js";

/**
 * 会话状态。阶段 1 是一个消息数组容器；
 * 现在可选接入持久化：绑定 SessionRepo 后，每条新消息会按 seq 落库，
 * 支持 --continue 从历史恢复。阶段 5「上下文管理」会在这里接入压缩/截断。
 */

interface Persistence {
  repo: SessionRepo;
  sessionId: string;
}

export class ConversationState {
  /**
   * 保留完整消息序列，保证 ReAct 协议最容易观察和调试。
   * 上下文压缩留给阶段五的 ContextManager 专门处理。
   */
  private messages: Message[] = [];
  /** 绑定后开启落库；未绑定时纯内存（测试 / 无持久化场景）。 */
  private persist?: Persistence;
  /** 已落库的消息数；新消息从这里开始按 seq 追加。 */
  private persistedCount = 0;
  /** 当前 ReAct 迭代序号，由 AgentLoop 设置，落到 messages.step 便于与审计对齐。 */
  private currentStep: number | null = null;

  constructor(systemPrompt?: string) {
    if (systemPrompt) {
      this.messages.push({ role: "system", content: systemPrompt });
    }
  }

  /** 绑定的会话 id；未持久化时为 undefined。 */
  get sessionId(): string | undefined {
    return this.persist?.sessionId;
  }

  /** 暴露只读视图，避免调用方绕过 addUser/addAssistant/addToolResult 破坏消息顺序。 */
  all(): readonly Message[] {
    return this.messages;
  }

  /** AgentLoop 在每轮迭代设置，使后续落库的消息带上所属 step。 */
  setStep(step: number | null): void {
    this.currentStep = step;
  }

  /** 用户输入必须进入历史，否则模型下一轮看不到当前任务。 */
  addUser(content: string): void {
    this.messages.push({ role: "user", content });
    this.flush();
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
    this.flush();
  }

  /** 工具结果以独立消息回填，让模型可以基于真实执行结果继续推理或纠错。 */
  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: "tool", toolCallId, name, content });
    this.flush();
  }

  /**
   * 绑定持久化。
   *
   * persistExisting=true 用于新会话：把当前已在内存里的消息（如 system prompt）补写入库。
   * persistExisting=false 用于 --continue：消息是从库里恢复的，无需重复落库。
   */
  bindStore(
    repo: SessionRepo,
    sessionId: string,
    opts: { persistExisting?: boolean } = {}
  ): void {
    this.persist = { repo, sessionId };
    if (opts.persistExisting) {
      this.flush();
    } else {
      this.persistedCount = this.messages.length;
    }
  }

  /** 用历史消息重建内存状态（恢复会话时调用），并标记为已持久化。 */
  loadFrom(messages: readonly Message[]): void {
    this.messages = [...messages];
    this.persistedCount = this.messages.length;
  }

  /** 把尚未落库的消息按 seq 追加写入。未绑定持久化时为 no-op。 */
  private flush(): void {
    if (!this.persist) return;
    const { repo, sessionId } = this.persist;
    while (this.persistedCount < this.messages.length) {
      const msg = this.messages[this.persistedCount];
      if (!msg) break;
      repo.appendMessage(sessionId, this.persistedCount, this.currentStep, msg);
      this.persistedCount += 1;
    }
  }
}
