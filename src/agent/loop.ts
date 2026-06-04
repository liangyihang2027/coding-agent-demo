import type { LLMClient, ToolCall, ToolContext } from "../types/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionGate, RiskLevel } from "../permission/index.js";
import { AllowAllPermissionGate, DefaultPermissionGate } from "../permission/index.js";
import type { PermissionConfirmHandler } from "../permission/types.js";
import { ConversationState } from "./state.js";
import type { AgentRunner } from "./runner.js";

/**
 * Agent Loop / Harness（阶段 1 必做，得分点：状态机设计）。
 *
 * ReAct 控制流：思考(LLM) → 决定调工具 → 执行工具 → 回填结果 → 再思考……
 * 直到模型不再调工具（给出最终回答）或触发安全阀。
 *
 * 安全阀（防死循环）：
 *  - maxSteps：单轮用户输入最多迭代次数，超过则强制停下。
 */

export interface AgentEvents {
  /** 模型文本增量（用于 CLI 流式渲染） */
  onText?: (delta: string) => void;
  /** 模型决定调用工具 */
  onToolCall?: (call: ToolCall) => void;
  /**
   * 可选：覆盖 DefaultPermissionGate 的 confirm（例如 Ink approval overlay）。
   * 未提供时使用构造 AgentLoop 时注入的 PermissionGate。
   */
  onPermissionPrompt?: PermissionConfirmHandler;
  /** 用户拒绝或策略拦截，未执行工具 */
  onToolDenied?: (call: ToolCall, reason: string) => void;
  /** 工具执行完毕 */
  onToolResult?: (call: ToolCall, content: string, isError: boolean) => void;
  /** 命令类工具的实时输出 */
  onToolChunk?: (chunk: string) => void;
  /** 达到 step 上限被强制中止 */
  onMaxSteps?: (max: number) => void;
}

export interface AgentLoopOptions {
  llm: LLMClient;
  tools: ToolRegistry;
  cwd: string;
  maxSteps?: number;
  /** 工具执行前审批；默认 AllowAll（不拦截） */
  permission?: PermissionGate;
}

export class AgentLoop implements AgentRunner {
  private llm: LLMClient;
  private tools: ToolRegistry;
  private cwd: string;
  private maxSteps: number;
  private permission: PermissionGate;

  constructor(opts: AgentLoopOptions) {
    this.llm = opts.llm;
    this.tools = opts.tools;
    this.cwd = opts.cwd;
    this.maxSteps = opts.maxSteps ?? 20;
    this.permission = opts.permission ?? new AllowAllPermissionGate();
  }

  /**
   * 跑一轮：给定用户输入，迭代到模型给出最终文本回答。
   * 返回最终的 assistant 文本。
   */
  async run(
    state: ConversationState,
    userInput: string,
    events: AgentEvents = {}
  ): Promise<string> {
    state.addUser(userInput);

    let finalText = "";

    for (let step = 0; step < this.maxSteps; step++) {
      const { text, toolCalls } = await this.callModel(state, events);
      finalText = text;

      // 模型没有再调工具 → 本轮结束
      if (toolCalls.length === 0) {
        state.addAssistant(text);
        return finalText;
      }

      // 先把 assistant（含 tool_calls）记入历史，再逐个执行并回填
      state.addAssistant(text, toolCalls);

      for (const call of toolCalls) {
        const risk = this.permission.assess(call);
        const allowed = await this.confirmTool(call, risk, events);
        if (!allowed) {
          const content = `用户拒绝执行工具 ${call.name}（风险: ${risk}）`;
          events.onToolDenied?.(call, content);
          state.addToolResult(call.id, call.name, content);
          continue;
        }

        events.onToolCall?.(call);
        const ctx: ToolContext = {
          cwd: this.cwd,
          onChunk: events.onToolChunk,
        };
        const result = await this.tools.run(call.name, call.arguments, ctx);
        events.onToolResult?.(call, result.content, result.isError ?? false);
        state.addToolResult(call.id, call.name, result.content);
      }
      // 回到循环顶部，让模型基于工具结果继续思考
    }

    events.onMaxSteps?.(this.maxSteps);
    return finalText;
  }

  /** 调一次模型，消费流式事件，返回本次文本 + 工具调用 */
  private async callModel(
    state: ConversationState,
    events: AgentEvents
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const llmTools = this.tools.toLLMTools();
    let text = "";
    let toolCalls: ToolCall[] = [];

    for await (const ev of this.llm.stream([...state.all()], llmTools)) {
      if (ev.type === "text") {
        text += ev.delta;
        events.onText?.(ev.delta);
      } else if (ev.type === "tool_calls") {
        toolCalls = ev.toolCalls;
      }
    }

    return { text, toolCalls };
  }

  private async confirmTool(
    call: ToolCall,
    risk: RiskLevel,
    events: AgentEvents
  ): Promise<boolean> {
    if (events.onPermissionPrompt) {
      const gate = new DefaultPermissionGate({
        confirm: events.onPermissionPrompt,
      });
      return gate.confirm(call, risk);
    }
    return this.permission.confirm(call, risk);
  }
}
