import type { ToolCall } from "../types/index.js";
import {
  assessToolRisk,
  DEFAULT_TOOL_RISK,
  parseRunCommandArg,
  riskRequiresConfirmation,
} from "./risk.js";
import type {
  PermissionConfirmHandler,
  PermissionGate,
  PermissionRequest,
  RiskLevel,
} from "./types.js";

export interface DefaultPermissionGateOptions {
  /** 确认动作由外部注入，使 gate 不绑定 stdio、Ink 或测试环境。 */
  confirm: PermissionConfirmHandler;
  /** 覆盖默认工具风险表 */
  toolRisk?: Record<string, RiskLevel>;
  /** 低风险是否免确认，默认 true */
  autoApproveLow?: boolean;
  /** 中风险是否免确认，默认 false */
  autoApproveMedium?: boolean;
}

/** 构造给人看的确认摘要；摘要越清晰，用户越能判断是否应该放行。 */
function buildSummary(call: ToolCall, risk: RiskLevel): string {
  if (call.name === "run_command") {
    const cmd = parseRunCommandArg(call.arguments);
    return cmd
      ? `[${risk}] run_command: ${cmd}`
      : `[${risk}] run_command (无法解析 command 参数)`;
  }

  const argsPreview =
    call.arguments.length > 120
      ? `${call.arguments.slice(0, 120)}...`
      : call.arguments;
  return `[${risk}] ${call.name}: ${argsPreview || "(无参数)"}`;
}

/**
 * 默认权限闸门。
 *
 * 它负责把工具调用分成“自动放行”和“需要确认”两类。
 * 这层防线位于 AgentLoop 内，目标是阻止模型在用户不知情时执行高风险动作。
 */
export class DefaultPermissionGate implements PermissionGate {
  /** 实际询问用户的方式由 CLI 或测试注入，保持策略与展示解耦。 */
  private confirmHandler: PermissionConfirmHandler;
  /** 风险表保存在实例上，方便不同运行模式覆盖默认策略。 */
  private toolRisk: Record<string, RiskLevel>;
  /** 低风险默认放行，避免每次读文件/搜索都打断最小闭环。 */
  private autoApproveLow: boolean;
  /** 中风险默认确认，因为写文件会改变工作区状态。 */
  private autoApproveMedium: boolean;

  constructor(opts: DefaultPermissionGateOptions) {
    this.confirmHandler = opts.confirm;
    this.toolRisk = opts.toolRisk ?? { ...DEFAULT_TOOL_RISK };
    this.autoApproveLow = opts.autoApproveLow ?? true;
    this.autoApproveMedium = opts.autoApproveMedium ?? false;
  }

  /** 单独暴露风险评估，便于 AgentLoop 在执行前先通知 UI 当前风险。 */
  assess(call: ToolCall): RiskLevel {
    return assessToolRisk(call, this.toolRisk);
  }

  /** 确认阶段只回答“能不能执行”，不直接运行工具，保持安全判断和动作执行分离。 */
  async confirm(call: ToolCall, risk: RiskLevel): Promise<boolean> {
    const needsPrompt = riskRequiresConfirmation(risk, {
      autoApproveLow: this.autoApproveLow,
      autoApproveMedium: this.autoApproveMedium,
    });
    if (!needsPrompt) {
      return true;
    }

    const request: PermissionRequest = {
      call,
      risk,
      summary: buildSummary(call, risk),
    };
    return this.confirmHandler(request);
  }
}

/** 测试或无交互场景：全部放行 */
export class AllowAllPermissionGate implements PermissionGate {
  assess(): RiskLevel {
    return "low";
  }

  async confirm(): Promise<boolean> {
    return true;
  }
}
