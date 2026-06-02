import type { z } from "zod";

/**
 * 共享类型 / 契约层。
 *
 * 设计原则（蓝图 §2）：上层只依赖这里的接口，内核模块互相解耦，方便单测。
 * 阶段 2~5 的 ⭐ 模块在实现时，请遵守这里定义的接口契约。
 */

// ----------------------------- 对话消息 -----------------------------

export type Role = "system" | "user" | "assistant" | "tool";

/** 一次工具调用（assistant 决定要调的工具） */
export interface ToolCall {
  /** provider 返回的调用 id，用于把 tool 结果回填到正确的调用上 */
  id: string;
  name: string;
  /** 原始 JSON 字符串参数（流式拼接完成后的最终结果） */
  arguments: string;
}

export interface Message {
  role: Role;
  /** 文本内容；assistant 在只调工具时可能为空 */
  content: string;
  /** assistant 消息携带的工具调用 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时，标记这条结果对应哪个 toolCall.id */
  toolCallId?: string;
  /** role === "tool" 时，被调用工具的名字（便于阅读/调试） */
  name?: string;
}

// ----------------------------- 工具协议 -----------------------------

export interface ToolContext {
  /** 工具执行的工作目录（后续沙箱阶段会强化隔离） */
  cwd: string;
  /** 流式输出回调（如命令实时 stdout），可选 */
  onChunk?: (chunk: string) => void;
}

export interface ToolResult {
  /** 给模型看的文本结果 */
  content: string;
  /** 是否为错误结果（错误也要回填给模型，让它自我纠正） */
  isError?: boolean;
}

/**
 * 工具定义。参数 schema 用 zod 描述，既能在运行时校验，
 * 又能转换成 provider 需要的 JSON Schema。
 */
export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: S;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

// ----------------------------- LLM 客户端 -----------------------------

/** LLM 流式输出的增量事件 */
export type LLMStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] }
  | { type: "done"; finishReason: string | null };

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface LLMClient {
  /**
   * 发起一次流式补全。yield 文本增量，最终汇总 tool_calls 与结束原因。
   */
  stream(
    messages: Message[],
    tools: LLMTool[]
  ): AsyncGenerator<LLMStreamEvent, void, unknown>;
}
