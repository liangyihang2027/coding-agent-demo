import type { Message } from "../types/index.js";
import type { ContextManager } from "./index.js";

/**
 * ⭐ 阶段 5 上下文管理：启发式确定性压缩。
 *
 * 核心难题（蓝图 §阶段5）：对话越长，历史越可能撑爆上下文窗口。这里在「发给模型前」
 * 按 token 预算压缩，权衡「省 token」与「保信息」：
 *   - 恒保留 system 提示（人格/工具说明，丢了模型会失忆）。
 *   - 优先保留近期对话（当前任务最相关）。
 *   - 久远历史按「整轮」折叠成一条摘要；超大工具结果做头尾裁剪。
 *
 * 关键正确性约束：OpenAI 工具协议要求 assistant(含 toolCalls) 后必须紧跟对应的 tool 结果。
 * 所以丢弃以「整轮(turn)」为单位（一个 user 到下一个 user 之前的所有消息），
 * 永远不会拆散 assistant 与它的 tool 结果。
 *
 * 设计成确定性（不调模型）：便于单测，也符合「补算法/启发式短板」的项目目标；
 * 同时预留可注入的 summarizer，日后可无痛换成 LLM 摘要。
 */

const CHARS_PER_TOKEN = 4;
/** 每条消息的固定结构开销（role / 协议包装），按经验给个小常数。 */
const PER_MSG_OVERHEAD = 4;
/** 单条工具结果裁剪后的字符下限，避免裁到完全无信息。 */
const MIN_TOOL_CHARS = 200;

/** 把久远历史折叠成一段摘要文本。可替换为 LLM 版本。 */
export type Summarizer = (dropped: readonly Message[]) => string;

export interface HeuristicContextManagerOptions {
  summarizer?: Summarizer;
}

/** 粗略 token 估算：代码/英文约 4 字符 1 token，够做预算决策。 */
function estimateText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 估算单条消息的 token（含文本、工具调用参数与固定开销）。 */
function estimateMessage(m: Message): number {
  let tokens = PER_MSG_OVERHEAD + estimateText(m.content ?? "");
  if (m.name) tokens += estimateText(m.name);
  if (m.toolCalls) {
    for (const c of m.toolCalls) {
      tokens += PER_MSG_OVERHEAD + estimateText(c.name) + estimateText(c.arguments);
    }
  }
  return tokens;
}

/** 头尾保留式裁剪：超长内容保留首尾，中间用标记折叠。 */
function trimContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const keep = Math.max(MIN_TOOL_CHARS, maxChars);
  const headLen = Math.floor(keep * 0.6);
  const tailLen = Math.floor(keep * 0.4);
  const head = content.slice(0, headLen);
  const tail = content.slice(content.length - tailLen);
  const folded = content.length - head.length - tail.length;
  return `${head}\n...[已折叠 ${folded} 字符]...\n${tail}`;
}

/** 默认摘要器：列出被折叠的用户请求与调用过的工具，确定性、可单测。 */
export const defaultSummarizer: Summarizer = (dropped) => {
  const userReqs: string[] = [];
  const toolNames = new Set<string>();
  for (const m of dropped) {
    if (m.role === "user") {
      userReqs.push(m.content.replace(/\s+/g, " ").trim().slice(0, 80));
    }
    if (m.role === "tool" && m.name) toolNames.add(m.name);
    if (m.toolCalls) for (const c of m.toolCalls) toolNames.add(c.name);
  }
  const parts = [`[早期对话已折叠：${dropped.length} 条消息]`];
  if (userReqs.length) parts.push(`用户曾请求：${userReqs.join("；")}`);
  if (toolNames.size) parts.push(`调用过工具：${[...toolNames].join(", ")}`);
  return parts.join(" ");
};

export class HeuristicContextManager implements ContextManager {
  private summarizer: Summarizer;

  constructor(opts: HeuristicContextManagerOptions = {}) {
    this.summarizer = opts.summarizer ?? defaultSummarizer;
  }

  estimateTokens(messages: readonly Message[]): number {
    let total = 0;
    for (const m of messages) total += estimateMessage(m);
    return total;
  }

  /**
   * 在预算内压缩历史，返回可安全发送给模型的消息序列。
   * 流程：恒留 system → 近期 turn 优先保留（超大则裁剪工具结果）→ 久远 turn 折叠成摘要 → 兜底裁剪。
   */
  compact(messages: readonly Message[], budgetTokens: number): Message[] {
    if (this.estimateTokens(messages) <= budgetTokens) {
      return [...messages];
    }

    const systems = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    const turns = splitTurns(rest);

    const systemTokens = this.estimateTokens(systems);
    let used = systemTokens;
    const kept: Message[][] = [];

    // 从最新 turn 往旧贪心保留；放不下时裁剪工具结果，仍放不下且已有保留 turn 则停。
    for (let i = turns.length - 1; i >= 0; i--) {
      let turn = turns[i]!;
      let cost = this.estimateTokens(turn);

      if (used + cost > budgetTokens) {
        const avail = Math.max(0, budgetTokens - used);
        turn = trimTurnTools(turn, avail);
        cost = this.estimateTokens(turn);
      }

      if (used + cost > budgetTokens && kept.length > 0) {
        break; // 当前及更旧的 turn 都丢弃（至少已保留最新一个 turn）
      }

      kept.unshift(turn);
      used += cost;
    }

    const droppedTurns = turns.slice(0, turns.length - kept.length);
    const dropped = droppedTurns.flat();

    const result: Message[] = [...systems];
    if (dropped.length > 0) {
      result.push({ role: "system", content: this.summarizer(dropped) });
    }
    for (const turn of kept) result.push(...turn);

    return this.enforceBudget(result, budgetTokens);
  }

  /**
   * 兜底：若 system + 摘要 + 最新 turn 仍超预算（极端长输入/巨型工具结果），
   * 逐步裁剪最大的工具结果，再不行则截断最大的非 system 文本，尽力贴近预算。
   */
  private enforceBudget(messages: Message[], budget: number): Message[] {
    const out = messages.map((m) => ({ ...m }));
    let guard = 0;
    while (this.estimateTokens(out) > budget && guard < 100) {
      guard += 1;
      const idx = largestTrimmableIndex(out);
      if (idx < 0) break;
      const m = out[idx]!;
      const target = Math.floor(m.content.length / 2);
      const trimmed = trimContent(m.content, target);
      if (trimmed.length >= m.content.length) break; // 无法再缩小
      m.content = trimmed;
    }
    return out;
  }
}

/** 以 user 为边界把消息切成 turns（每个 turn = 一条 user + 其后续 assistant/tool）。 */
function splitTurns(messages: readonly Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const m of messages) {
    if (m.role === "user" && current.length > 0) {
      turns.push(current);
      current = [m];
    } else {
      current.push(m);
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/** 在一个 turn 内裁剪 tool 结果以贴近可用预算（粗粒度均分到各 tool 消息）。 */
function trimTurnTools(turn: Message[], availTokens: number): Message[] {
  const toolMsgs = turn.filter((m) => m.role === "tool");
  if (toolMsgs.length === 0) return turn;
  const perToolChars = Math.max(
    MIN_TOOL_CHARS,
    Math.floor((availTokens * CHARS_PER_TOKEN) / toolMsgs.length)
  );
  return turn.map((m) =>
    m.role === "tool"
      ? { ...m, content: trimContent(m.content, perToolChars) }
      : m
  );
}

/** 找可裁剪的最大消息（优先 tool，其次普通文本；不动 system）。 */
function largestTrimmableIndex(messages: Message[]): number {
  let best = -1;
  let bestLen = MIN_TOOL_CHARS;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system") continue;
    if (m.content.length > bestLen) {
      bestLen = m.content.length;
      best = i;
    }
  }
  return best;
}
