import OpenAI from "openai";
import type {
  LLMClient,
  LLMStreamEvent,
  LLMTool,
  Message,
} from "../types/index.js";
import { ToolCallAssembler } from "./tool-call-assembler.js";

export interface OpenAIClientOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
}

/**
 * OpenAI 兼容的流式 LLM 客户端。
 *
 * 职责：
 *  - 把内部 Message[] 翻译成 provider 的 messages 格式
 *  - 发起 stream 请求，逐 chunk 解析
 *  - 文本增量即时 yield；tool_calls 用 assembler 拼接，结束时一次性 yield
 */
export class OpenAIClient implements LLMClient {
  /** 原始 SDK 客户端只封装在这里，避免 AgentLoop 依赖 provider 的具体 API。 */
  private client: OpenAI;
  /** 模型名属于 provider 配置，不应该散落到每次 AgentLoop 调用里。 */
  private model: string;

  constructor(opts: OpenAIClientOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
    this.model = opts.model;
  }

  async *stream(
    messages: Message[],
    tools: LLMTool[]
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      tools: tools.length ? tools : undefined,
      stream: true,
    });

    // 每次模型调用都新建 assembler，避免上一轮未完成的 tool_call 状态污染当前请求。
    const assembler = new ToolCallAssembler();
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta?.content) {
        yield { type: "text", delta: delta.content };
      }
      if (delta?.tool_calls) {
        assembler.push(delta.tool_calls);
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    if (assembler.hasAny()) {
      // tool_calls 只有在流结束后才完整；统一在末尾 yield，简化 AgentLoop 的状态机。
      yield { type: "tool_calls", toolCalls: assembler.finalize() };
    }
    yield { type: "done", finishReason };
  }
}

/**
 * 内部 Message -> OpenAI chat message。
 *
 * 这个转换函数是 provider 边界：项目内部保留自己的 Message 契约，
 * 只有出站到 OpenAI 兼容接口时才处理 role、tool_call_id、tool_calls 等字段差异。
 */
function toOpenAIMessage(
  m: Message
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "tool":
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      };
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
  }
}
