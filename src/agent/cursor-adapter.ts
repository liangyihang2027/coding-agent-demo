import * as path from "node:path";
import {
  Agent,
  CursorAgentError,
  JsonlLocalAgentStore,
  type SDKAgent,
  type SDKMessage,
} from "@cursor/sdk";
import type { CursorConfig } from "../cli/config.js";
import type { AgentEvents } from "./loop.js";
import type { ConversationState } from "./state.js";
import type { AgentRunner } from "./runner.js";

/**
 * Cursor Cloud Agents SDK 适配器。
 *
 * 通过 @cursor/sdk 接入 Cursor API Key，在本地 cwd 或云端 GitHub 仓库上运行 Agent。
 * 对外暴露与 AgentLoop 相同的 run() 接口，CLI 可无缝切换 provider。
 */
export class CursorAgentAdapter implements AgentRunner {
  private config: CursorConfig;
  private cwd: string;
  private agent: SDKAgent | null = null;
  private primed = false;

  constructor(opts: { config: CursorConfig; cwd: string }) {
    this.config = opts.config;
    this.cwd = opts.cwd;
  }

  async run(
    state: ConversationState,
    userInput: string,
    events: AgentEvents = {}
  ): Promise<string> {
    const agent = await this.ensureAgent();
    const prompt = this.buildPrompt(state, userInput);

    try {
      const run = await agent.send(prompt);
      let streamedText = "";

      for await (const msg of run.stream()) {
        streamedText += this.handleMessage(msg, events);
      }

      const result = await run.wait();
      if (result.status === "error") {
        throw new Error(result.result ?? "Cursor Agent 运行失败");
      }
      if (result.status === "cancelled") {
        throw new Error("Cursor Agent 运行已取消");
      }

      return result.result ?? streamedText;
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(`Cursor API 错误: ${err.message}`);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (!this.agent) return;
    await this.agent[Symbol.asyncDispose]();
    this.agent = null;
    this.primed = false;
  }

  private async ensureAgent(): Promise<SDKAgent> {
    if (this.agent) return this.agent;

    const options: Parameters<typeof Agent.create>[0] = {
      apiKey: this.config.apiKey,
      model: { id: this.config.model },
      name: "claude-mini",
      mode: "agent",
    };

    if (this.config.runtime === "cloud") {
      if (!this.config.repoUrl) {
        throw new Error(
          "Cursor 云端模式需要 CURSOR_REPO_URL（GitHub 仓库 URL）。"
        );
      }
      options.cloud = {
        repos: [
          {
            url: this.config.repoUrl,
            startingRef: this.config.startingRef,
          },
        ],
        autoCreatePR: this.config.autoCreatePR,
      };
    } else {
      const storeDir = path.join(this.cwd, ".cursor", "claude-mini-agent");
      options.local = {
        cwd: this.cwd,
        settingSources: [],
        store: new JsonlLocalAgentStore(storeDir),
      };
    }

    this.agent = await Agent.create(options);
    return this.agent;
  }

  /** 首次对话注入 system prompt，后续 turn 只发用户输入 */
  private buildPrompt(state: ConversationState, userInput: string): string {
    if (this.primed) return userInput;
    this.primed = true;

    const system = state.all().find((m) => m.role === "system");
    if (!system?.content.trim()) return userInput;
    return `${system.content.trim()}\n\n---\n\n${userInput}`;
  }

  private handleMessage(msg: SDKMessage, events: AgentEvents): string {
    switch (msg.type) {
      case "assistant":
        return this.handleAssistant(msg, events);
      case "tool_call":
        this.handleToolCall(msg, events);
        return "";
      default:
        return "";
    }
  }

  private handleAssistant(
    msg: Extract<SDKMessage, { type: "assistant" }>,
    events: AgentEvents
  ): string {
    let text = "";
    for (const block of msg.message.content) {
      if (block.type === "text") {
        text += block.text;
        events.onText?.(block.text);
      }
    }
    return text;
  }

  private handleToolCall(
    msg: Extract<SDKMessage, { type: "tool_call" }>,
    events: AgentEvents
  ): void {
    const args =
      msg.args != null
        ? typeof msg.args === "string"
          ? msg.args
          : JSON.stringify(msg.args)
        : "{}";

    const call = { id: msg.call_id, name: msg.name, arguments: args };

    if (msg.status === "running") {
      events.onToolCall?.(call);
      return;
    }

    const content =
      msg.result != null
        ? typeof msg.result === "string"
          ? msg.result
          : JSON.stringify(msg.result)
        : "";

    events.onToolResult?.(call, content, msg.status === "error");
  }
}
