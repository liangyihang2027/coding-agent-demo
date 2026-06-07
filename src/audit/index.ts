import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolCall } from "../types/index.js";
import type { RiskLevel } from "../permission/types.js";

/**
 * 审计（Audit）模块。
 *
 * 审计与普通日志不同：日志服务于工程师排查问题，可碎可丢；
 * 审计服务于事后追责，关注“谁在什么时间、批准了什么、执行了什么、产生了什么结果”，
 * 因此只覆盖有副作用的关键动作，并以结构化、可追加、不可静默丢失的形式落盘。
 *
 * 这里实现最小可用版本：每次工具调用产出一条结构化事件，写入 JSONL 文件。
 */

/** 工具的副作用分级，决定重试与审批策略，也是审计里最关键的风险维度。 */
export type SideEffectType =
  | "read"
  | "idempotent_write"
  | "non_idempotent_write"
  | "command"
  | "unknown";

/** 一次工具调用的最终状态。拒绝、失败、成功都属于必须留痕的结果。 */
export type AuditStatus = "denied" | "succeeded" | "failed";

export interface AuditEvent {
  /** 事件唯一 id，便于跨日志检索单次动作。 */
  id: string;
  /** 对应的工具调用 id，可与会话历史里的 tool 消息对齐。 */
  toolCallId: string;
  toolName: string;
  /** 触发者：当前都是模型决策，保留字段以便未来区分 user/system。 */
  actor: "agent";
  riskLevel: RiskLevel;
  sideEffectType: SideEffectType;
  /** 是否经过用户确认放行；被拒绝时为 false。 */
  approved: boolean;
  status: AuditStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** 模型给的原始参数摘要（截断，避免泄露与膨胀）。 */
  inputSummary: string;
  /** 执行结果摘要或拒绝原因（截断）。 */
  outputSummary: string;
}

/** AgentLoop 只依赖这个接口，方便在测试或无审计场景注入空实现。 */
export interface AuditRecorder {
  record(event: AuditEvent): Promise<void>;
}

/** 按工具名归类副作用等级；未知工具按 unknown，调用方可据此采取保守策略。 */
export function classifyToolSideEffect(name: string): SideEffectType {
  switch (name) {
    case "read_file":
    case "list_directory":
    case "glob_files":
    case "grep":
      return "read";
    case "write_file":
      return "idempotent_write";
    case "edit_file":
    case "delete_file":
      return "non_idempotent_write";
    case "run_command":
      return "command";
    default:
      return "unknown";
  }
}

function truncate(text: string, max = 500): string {
  const t = text ?? "";
  return t.length > max ? `${t.slice(0, max)}…(${t.length - max} more)` : t;
}

let counter = 0;
/** 生成进程内单调递增、带时间戳的事件 id，避免高频调用碰撞。 */
function nextId(): string {
  counter += 1;
  return `audit_${Date.now()}_${counter}`;
}

export interface BuildAuditEventInput {
  call: ToolCall;
  riskLevel: RiskLevel;
  approved: boolean;
  status: AuditStatus;
  startedAt: number;
  endedAt: number;
  outputSummary: string;
}

/** 把一次工具调用的上下文组装成结构化审计事件，集中处理截断和分类。 */
export function buildAuditEvent(input: BuildAuditEventInput): AuditEvent {
  return {
    id: nextId(),
    toolCallId: input.call.id,
    toolName: input.call.name,
    actor: "agent",
    riskLevel: input.riskLevel,
    sideEffectType: classifyToolSideEffect(input.call.name),
    approved: input.approved,
    status: input.status,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    durationMs: input.endedAt - input.startedAt,
    inputSummary: truncate(input.call.arguments),
    outputSummary: truncate(input.outputSummary),
  };
}

/** 无审计场景（测试 / off 模式）：不记录任何事件。 */
export class NullAuditRecorder implements AuditRecorder {
  async record(): Promise<void> {
    // intentionally no-op
  }
}

/**
 * 把审计事件以 JSONL 追加写入文件。
 *
 * 选 JSONL 而非单个 JSON 数组，是因为追加写不需要读改写整个文件，
 * 且单行损坏不影响其它记录，更适合“只追加、不可篡改”的审计语义。
 */
export class JsonlAuditRecorder implements AuditRecorder {
  private filePath: string;
  private dirEnsured = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.dirEnsured = true;
  }

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.ensureDir();
      await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // 审计写入失败不应中断 Agent 主流程；此处吞掉异常，避免影响用户任务。
    }
  }
}

/**
 * 根据环境变量构造默认审计记录器。
 *
 * CLAUDE_MINI_AUDIT=off 关闭；否则写入 <cwd>/.claude-mini/audit.jsonl，
 * 或 CLAUDE_MINI_AUDIT 指定的自定义路径。
 */
export function createDefaultAuditRecorder(
  cwd: string,
  env = process.env.CLAUDE_MINI_AUDIT
): AuditRecorder {
  const v = env?.trim();
  if (v && (v.toLowerCase() === "off" || v === "0" || v.toLowerCase() === "false")) {
    return new NullAuditRecorder();
  }
  const filePath =
    v && v.toLowerCase() !== "on" && v.toLowerCase() !== "true"
      ? path.resolve(cwd, v)
      : path.join(cwd, ".claude-mini", "audit.jsonl");
  return new JsonlAuditRecorder(filePath);
}
