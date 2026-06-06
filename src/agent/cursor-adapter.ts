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
  /** Cursor SDK 需要的运行配置；保存在 adapter 内，避免 CLI 直接依赖 SDK 参数形状。 */
  private config: CursorConfig;
  /** 本地运行时的项目根目录，也是 SDK local mode 的执行边界。 */
  private cwd: string;
  /** SDKAgent 创建成本较高且带会话状态，因此在 adapter 生命周期内复用。 */
  private agent: SDKAgent | null = null;
  /** Cursor SDK 没有消费本地 ConversationState，首次 prompt 需要手动注入 system prompt。 */
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

  /** 释放 SDK agent，避免本地 store 或后台资源在 CLI 退出后继续占用。 */
  async close(): Promise<void> {
    if (!this.agent) return;
    await this.agent[Symbol.asyncDispose]();
    this.agent = null;
    this.primed = false;
  }

  /**
   * 延迟创建 SDKAgent。
   *
   * 这样 CLI 启动时只完成轻量配置，真正运行请求时再根据 local/cloud 模式准备环境。
   * local mode 使用当前工作区；cloud mode 需要 GitHub 仓库信息。
   */
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

  /**
   * 首次对话注入 system prompt，后续 turn 只发用户输入。
   *
   * 自研 AgentLoop 会把 ConversationState 的完整消息列表传给模型；Cursor SDK 自己维护会话，
   * 因此这里只在第一轮把系统约束拼进 prompt，避免每轮重复灌入同一段系统提示。
   */
  private buildPrompt(state: ConversationState, userInput: string): string {
    if (this.primed) return userInput;
    this.primed = true;

    const system = state.all().find((m) => m.role === "system");
    if (!system?.content.trim()) return userInput;
    return `${system.content.trim()}\n\n---\n\n${userInput}`;
  }

  /** 把 Cursor SDK 的消息事件翻译成 CLI 已经理解的 AgentEvents。 */
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

  /** 只把 assistant 文本块流给 UI；非文本块暂时不是阶段一 CLI 需要的展示内容。 */
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

  /**
   * 将 Cursor SDK 的工具事件适配为本项目的 ToolCall/ToolResult 事件。
   *
   * 注意：这些工具由 Cursor SDK 执行，不经过本地 ToolRegistry、Diff 或 Sandbox。
   * 所以它是 provider 适配路径，不是阶段一自研内核的学习主线。
   */
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
