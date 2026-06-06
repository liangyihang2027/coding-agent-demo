import type { AgentEvents } from "./loop.js";
import type { ConversationState } from "./state.js";

/**
 * Agent 运行器统一接口。
 *
 * CLI 不应该关心底层是自研 AgentLoop 还是 Cursor SDK；它只需要把用户输入、
 * 会话状态和 UI 事件交给 runner。这个接口把“交互外壳”和“执行内核”解耦，
 * 方便阶段一先跑 OpenAI 本地闭环，后续也能切到其他 provider。
 */
export interface AgentRunner {
  /** 执行一轮用户请求；同一轮内部可以多次调用模型和工具，直到得到最终回答。 */
  run(
    state: ConversationState,
    userInput: string,
    events?: AgentEvents
  ): Promise<string>;
  /** 可选生命周期钩子，用于释放 SDK agent、文件句柄或后台连接。 */
  close?(): Promise<void>;
}
