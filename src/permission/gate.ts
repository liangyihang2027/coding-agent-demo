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
  confirm: PermissionConfirmHandler;
  /** 覆盖默认工具风险表 */
  toolRisk?: Record<string, RiskLevel>;
  /** 低风险是否免确认，默认 true */
  autoApproveLow?: boolean;
  /** 中风险是否免确认，默认 false */
  autoApproveMedium?: boolean;
}

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

export class DefaultPermissionGate implements PermissionGate {
  private confirmHandler: PermissionConfirmHandler;
  private toolRisk: Record<string, RiskLevel>;
  private autoApproveLow: boolean;
  private autoApproveMedium: boolean;

  constructor(opts: DefaultPermissionGateOptions) {
    this.confirmHandler = opts.confirm;
    this.toolRisk = opts.toolRisk ?? { ...DEFAULT_TOOL_RISK };
    this.autoApproveLow = opts.autoApproveLow ?? true;
    this.autoApproveMedium = opts.autoApproveMedium ?? false;
  }

  assess(call: ToolCall): RiskLevel {
    return assessToolRisk(call, this.toolRisk);
  }

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
