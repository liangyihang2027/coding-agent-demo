import type { AgentEvents } from "./loop.js";
import type { ConversationState } from "./state.js";

/** Agent 运行器统一接口（OpenAI 本地循环 / Cursor SDK 均可实现） */
export interface AgentRunner {
  run(
    state: ConversationState,
    userInput: string,
    events?: AgentEvents
  ): Promise<string>;
  close?(): Promise<void>;
}
