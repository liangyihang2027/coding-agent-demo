/**
 * 阶段 6「权限 / 审批闸门」——最小可扩展版本。
 *
 * 已实现：
 *   - 工具风险分级（assessToolRisk / DefaultPermissionGate）
 *   - 高风险（及默认中风险）执行前 confirm
 *   - run_command 危险命令模式检测（与 sandbox 阶段 3 可共享 DANGEROUS_COMMAND_PATTERNS）
 *   - AgentLoop 工具执行前 gating
 *
 * 后续扩展点：
 *   - CLI approval overlay（消费 PermissionRequest + AgentEvents.onPermissionPrompt）
 *   - 会话级「记住此次选择」、按路径/命令白名单
 *   - 与 sandbox 拦截双层防御
 *   - CursorAgentAdapter 侧工具审批（当前仅 OpenAI AgentLoop）
 */

export type {
  PermissionConfirmHandler,
  PermissionGate,
  PermissionRequest,
  RiskLevel,
} from "./types.js";

export {
  DANGEROUS_COMMAND_PATTERNS,
  DEFAULT_TOOL_RISK,
  assessToolRisk,
  isDangerousCommand,
  parseRunCommandArg,
  riskRequiresConfirmation,
} from "./risk.js";

export {
  AllowAllPermissionGate,
  DefaultPermissionGate,
  type DefaultPermissionGateOptions,
} from "./gate.js";

export {
  createAlwaysAllowConfirm,
  createAlwaysDenyConfirm,
  createStdioConfirm,
  type StdioConfirmOptions,
} from "./confirm.js";

import {
  createAlwaysAllowConfirm,
  createStdioConfirm,
} from "./confirm.js";
import { AllowAllPermissionGate, DefaultPermissionGate } from "./gate.js";
import type { PermissionConfirmHandler } from "./types.js";

export type PermissionMode = "off" | "ask" | "allow";

/**
 * 从环境变量解析权限模式。
 *
 * 这让同一套 AgentLoop 可以在交互开发、演示和自动化测试里使用不同安全策略，
 * 而不需要修改代码或重新组装 runner。
 */
export function resolvePermissionMode(
  env = process.env.CLAUDE_MINI_PERMISSION
): PermissionMode {
  const v = env?.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "allow" || v === "yes") return "allow";
  return "ask";
}

/**
 * CLI 入口用的默认闸门。
 *
 * 默认 ask 模式保守：低风险自动通过，中高风险确认。
 * off/allow 主要服务本地实验或测试，不应该被当成 sandbox 的替代品。
 */
export function createDefaultPermissionGate(
  mode: PermissionMode = resolvePermissionMode()
) {
  if (mode === "off") {
    return new AllowAllPermissionGate();
  }

  const confirm: PermissionConfirmHandler =
    mode === "allow" ? createAlwaysAllowConfirm() : createStdioConfirm();

  return new DefaultPermissionGate({ confirm });
}
