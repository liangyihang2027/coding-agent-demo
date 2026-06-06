import { z } from "zod";
import type {
  LLMTool,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types/index.js";

/**
 * 工具注册表（阶段 1）。
 *
 * 职责：
 *  - 注册工具（名字唯一）
 *  - 把 zod schema 转成 provider 需要的 JSON Schema（喂给模型）
 *  - 在执行前用 zod 校验模型给的参数（防止脏数据进入内核）
 */
// 注册表内部对具体 zod 类型不敏感，用 any 抹平不变性差异。
type AnyToolDefinition = ToolDefinition<z.ZodTypeAny>;

export class ToolRegistry {
  /** 工具名到定义的映射；模型调用工具时只给名字，所以这里必须保证名字唯一。 */
  private tools = new Map<string, AnyToolDefinition>();

  /** 注册阶段集中校验唯一性，比运行时发现工具覆盖更容易定位配置错误。 */
  register<S extends z.ZodTypeAny>(tool: ToolDefinition<S>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重复注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as AnyToolDefinition);
    return this;
  }

  /** 供权限层或调试代码判断某个模型请求的工具是否在本地能力集合内。 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 转成模型可见的工具列表（JSON Schema 形式） */
  toLLMTools(): LLMTool[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.parameters),
      },
    }));
  }

  /**
   * 解析参数 + 校验 + 执行。
   *
   * 这里集中处理 JSON parse、zod safeParse 和异常包装，是为了让具体工具只关心业务动作。
   * 对 AgentLoop 来说，无论失败发生在参数、校验还是执行阶段，都应该变成可回填给模型的 ToolResult。
   *
   * 任何失败都包装成 isError 的 ToolResult 回填给模型，让它自我纠正，
   * 而不是直接抛异常中断整个 agent loop。
   */
  async run(
    name: string,
    rawArgs: string,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `未知工具: ${name}`, isError: true };
    }

    let parsed: unknown;
    try {
      parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return {
        content: `工具 ${name} 的参数不是合法 JSON: ${rawArgs}`,
        isError: true,
      };
    }

    const result = tool.parameters.safeParse(parsed);
    if (!result.success) {
      return {
        content: `工具 ${name} 参数校验失败:\n${formatZodError(result.error)}`,
        isError: true,
      };
    }

    try {
      return await tool.execute(result.data, ctx);
    } catch (err) {
      return {
        content: `工具 ${name} 执行异常: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

/**
 * 极简 zod -> JSON Schema 转换（只覆盖工具参数常用的类型）。
 *
 * 这是「业务胶水」而非内核，所以手写一个够用的最小版本，
 * 避免引入额外依赖。如需更全可换 zod-to-json-schema 库。
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };
  }

  if (schema instanceof z.ZodString) {
    return withDescription(schema, { type: "string" });
  }
  if (schema instanceof z.ZodNumber) {
    return withDescription(schema, { type: "number" });
  }
  if (schema instanceof z.ZodBoolean) {
    return withDescription(schema, { type: "boolean" });
  }
  if (schema instanceof z.ZodArray) {
    return withDescription(schema, {
      type: "array",
      items: zodToJsonSchema(def.type),
    });
  }
  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, { type: "string", enum: def.values });
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    // required 列表已经由父级 object 决定，这里只暴露内部真实类型给模型。
    return zodToJsonSchema(def.innerType);
  }

  return { type: "string" };
}

function withDescription(
  schema: z.ZodTypeAny,
  base: Record<string, unknown>
): Record<string, unknown> {
  const desc = schema.description;
  return desc ? { ...base, description: desc } : base;
}
