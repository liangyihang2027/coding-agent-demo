import type { ToolCall } from "../types/index.js";

/**
 * 流式 tool_calls 拼接器（阶段 1 得分点：状态机 + 流式协议处理）。
 *
 * 背景：OpenAI 兼容接口在流式模式下，会把每个 tool_call 拆成很多分片
 * 逐个 chunk 推送，形如：
 *   delta.tool_calls = [{ index: 0, id?: "call_x", function: { name?: "...", arguments?: "{\"pa" } }]
 * 同一个 tool_call 的分片靠 `index` 关联；`id` / `name` 通常只在第一个分片出现，
 * 后续分片只追加 `arguments` 字符串片段。
 *
 * 因此需要用 index 做主键、增量累加 arguments，最后一次性拿到完整调用。
 * 这里同时保留 id 兜底，应对个别 provider 不给 index 只给 id 的情况。
 */

interface RawToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface PartialToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export class ToolCallAssembler {
  /** index -> 累积中的 tool_call；index 是流式协议里最稳定的分片关联键。 */
  private byIndex = new Map<number, PartialToolCall>();
  /** 用于在缺失 index 时按 id 兜底定位，兼容部分 provider 的非标准分片。 */
  private idToIndex = new Map<string, number>();
  /** 当 delta 既无 index 又无 id 时，落到的“当前游标”，避免参数续片丢失。 */
  private cursor = 0;

  /**
   * 处理一个 chunk 里的 tool_calls 分片数组。
   *
   * name 和 arguments 都采用追加而不是覆盖，因为 provider 可能把函数名或 JSON 参数
   * 拆成多个 delta；只有 finalize 后的结果才适合交给 ToolRegistry 执行。
   */
  push(deltas: RawToolCallDelta[] | undefined): void {
    if (!deltas) return;
    for (const delta of deltas) {
      const index = this.resolveIndex(delta);
      const existing =
        this.byIndex.get(index) ??
        ({ index, id: "", name: "", arguments: "" } satisfies PartialToolCall);

      if (delta.id) {
        existing.id = delta.id;
        this.idToIndex.set(delta.id, index);
      }
      if (delta.function?.name) existing.name += delta.function.name;
      if (delta.function?.arguments)
        existing.arguments += delta.function.arguments;

      this.byIndex.set(index, existing);
      this.cursor = index;
    }
  }

  /** 将 provider 的不完整定位信息归一成内部 index，隔离协议差异。 */
  private resolveIndex(delta: RawToolCallDelta): number {
    if (typeof delta.index === "number") return delta.index;
    if (delta.id && this.idToIndex.has(delta.id))
      return this.idToIndex.get(delta.id)!;
    if (delta.id) return this.cursor + (this.byIndex.size === 0 ? 0 : 1);
    return this.cursor;
  }

  /** 是否拼到了任何工具调用 */
  hasAny(): boolean {
    return this.byIndex.size > 0;
  }

  /** 汇总成最终的 ToolCall[]，按 index 升序，并为缺失 id 的调用兜底生成 id */
  finalize(): ToolCall[] {
    return [...this.byIndex.values()]
      .sort((a, b) => a.index - b.index)
      .map((p) => ({
        id: p.id || `call_${p.index}`,
        name: p.name,
        arguments: p.arguments || "{}",
      }));
  }
}
