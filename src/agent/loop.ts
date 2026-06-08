import type { LLMClient, ToolCall, ToolContext } from "../types/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionGate, RiskLevel } from "../permission/index.js";
import { AllowAllPermissionGate, DefaultPermissionGate } from "../permission/index.js";
import type { PermissionConfirmHandler } from "../permission/types.js";
import type { AuditRecorder, AuditStatus } from "../audit/index.js";
import { buildAuditEvent, NullAuditRecorder } from "../audit/index.js";
import type { AgentPhase } from "./phases.js";
import { ConversationState } from "./state.js";
import type { AgentRunner } from "./runner.js";

/**
 * Agent Loop / Harness。
 *
 * ReAct 控制流：思考(LLM) → 决定调工具 → 执行工具 → 回填结果 → 再思考……
 * 直到模型不再调工具（给出最终回答）或触发安全阀。
 *
 * 安全阀（防死循环）：
 *  - maxSteps：单轮用户输入最多迭代次数，超过则强制停下。
 */

export interface AgentEvents {
  /** 运行阶段变化（连接 / 发请求 / 等首 token），便于 CLI 区分卡顿来源 */
  onPhase?: (phase: AgentPhase) => void;
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
  /** 工具调用审计记录；默认 Null（不记录） */
  audit?: AuditRecorder;
}

export class AgentLoop implements AgentRunner {
  /** LLMClient 是 provider 边界，AgentLoop 只消费统一的流式事件，不绑定 OpenAI SDK 细节。 */
  private llm: LLMClient;
  /** 工具注册表集中管理模型可见能力，避免 AgentLoop 直接依赖具体文件/命令工具。 */
  private tools: ToolRegistry;
  /** 所有工具执行的工作目录；阶段三沙箱会在这个边界上继续加强隔离。 */
  private cwd: string;
  /** 单轮最大推理/行动次数，用来防止模型重复调工具造成死循环。 */
  private maxSteps: number;
  /** 工具执行前的安全闸门；默认可放行，CLI 入口会注入真实审批策略。 */
  private permission: PermissionGate;
  /** 工具调用审计记录；默认不记录，CLI 入口会注入落盘的 recorder。 */
  private audit: AuditRecorder;

  constructor(opts: AgentLoopOptions) {
    this.llm = opts.llm;
    this.tools = opts.tools;
    this.cwd = opts.cwd;
    this.maxSteps = opts.maxSteps ?? 20;
    this.permission = opts.permission ?? new AllowAllPermissionGate();
    this.audit = opts.audit ?? new NullAuditRecorder();
  }

  /**
   * 跑一轮：给定用户输入，迭代到模型给出最终文本回答。
   *
   * 这是阶段一最小闭环的核心：把“模型决策”和“本地行动”放进同一个状态机。
   * 每次工具执行后的结果都会写回 ConversationState，再交给模型继续判断下一步。
   * 返回最终的 assistant 文本。
   */
  async run(
    state: ConversationState,
    userInput: string,
    events: AgentEvents = {}
  ): Promise<string> {
    state.setStep(null);
    state.addUser(userInput);
    const sessionId = state.sessionId ?? null;

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
      state.setStep(step);
      state.addAssistant(text, toolCalls);

      let callIndex = 0;
      for (const call of toolCalls) {
        const risk = this.permission.assess(call);
        const requestedAt = Date.now();
        const allowed = await this.confirmTool(call, risk, events);
        const approvedAt = Date.now();
        if (!allowed) {
          const content = `用户拒绝执行工具 ${call.name}（风险: ${risk}）`;
          events.onToolDenied?.(call, content);
          state.addToolResult(call.id, call.name, content);
          await this.recordAudit({
            call,
            sessionId,
            step,
            callIndex,
            risk,
            approved: false,
            status: "denied",
            requestedAt,
            approvedAt,
            endedAt: approvedAt,
            outputSummary: content,
          });
          callIndex += 1;
          continue;
        }

        events.onToolCall?.(call);
        const ctx: ToolContext = {
          cwd: this.cwd,
          onChunk: events.onToolChunk,
        };
        const result = await this.tools.run(call.name, call.arguments, ctx);
        const endedAt = Date.now();
        const isError = result.isError ?? false;
        events.onToolResult?.(call, result.content, isError);
        state.addToolResult(call.id, call.name, result.content);
        await this.recordAudit({
          call,
          sessionId,
          step,
          callIndex,
          risk,
          approved: true,
          status: isError ? "failed" : "succeeded",
          requestedAt,
          approvedAt,
          endedAt,
          outputSummary: result.content,
        });
        callIndex += 1;
      }
      // 回到循环顶部，让模型基于工具结果继续思考
    }

    events.onMaxSteps?.(this.maxSteps);
    return finalText;
  }

  /**
   * 调一次模型，消费流式事件，返回本次文本 + 工具调用。
   *
   * AgentLoop 不解析 provider 原始 chunk；这些差异由 LLMClient 和 ToolCallAssembler 消化。
   * 这里保留的只是 agent 需要关心的两个结果：展示给用户的文本、以及需要执行的工具。
   */
  private async callModel(
    state: ConversationState,
    events: AgentEvents
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const llmTools = this.tools.toLLMTools();
    let text = "";
    let toolCalls: ToolCall[] = [];
    let sawStreamEvent = false;

    events.onPhase?.("requesting");
    for await (const ev of this.llm.stream([...state.all()], llmTools)) {
      if (!sawStreamEvent) {
        events.onPhase?.("waiting_model");
        sawStreamEvent = true;
      }
      if (ev.type === "text") {
        text += ev.delta;
        events.onText?.(ev.delta);
      } else if (ev.type === "tool_calls") {
        toolCalls = ev.toolCalls;
      }
    }

    return { text, toolCalls };
  }

  /** 把一次工具调用的最终结果写入审计；失败不影响主流程（recorder 内部已吞异常）。 */
  private async recordAudit(input: {
    call: ToolCall;
    sessionId: string | null;
    step: number;
    callIndex: number;
    risk: RiskLevel;
    approved: boolean;
    status: AuditStatus;
    requestedAt: number;
    approvedAt: number;
    endedAt: number;
    outputSummary: string;
  }): Promise<void> {
    await this.audit.record(
      buildAuditEvent({
        call: input.call,
        sessionId: input.sessionId,
        step: input.step,
        callIndex: input.callIndex,
        riskLevel: input.risk,
        approved: input.approved,
        status: input.status,
        requestedAt: input.requestedAt,
        approvedAt: input.approvedAt,
        endedAt: input.endedAt,
        outputSummary: input.outputSummary,
      })
    );
  }

  private async confirmTool(
    call: ToolCall,
    risk: RiskLevel,
    events: AgentEvents
  ): Promise<boolean> {
    // UI 事件里的确认器优先级最高，这样 Ink overlay 可以接管默认 stdio confirm。
    if (events.onPermissionPrompt) {
      const gate = new DefaultPermissionGate({
        confirm: events.onPermissionPrompt,
      });
      return gate.confirm(call, risk);
    }
    return this.permission.confirm(call, risk);
  }
}
