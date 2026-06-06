import type { ToolCall } from "../types/index.js";
import type { RiskLevel } from "./types.js";

/**
 * 按工具名的默认风险档位（可在 gate 构造时覆盖）。
 *
 * 这里先按“能力类别”做保守分级：读操作默认低风险，写操作中风险，
 * 删除和命令执行高风险。后续可以再叠加路径、命令参数和会话策略。
 */
export const DEFAULT_TOOL_RISK: Record<string, RiskLevel> = {
  read_file: "low",
  list_directory: "low",
  glob_files: "low",
  grep: "low",
  write_file: "medium",
  edit_file: "medium",
  delete_file: "high",
  run_command: "high",
};

/**
 * 危险 shell 片段（阶段 3 sandbox 可复用同一列表）。
 *
 * Permission 层的检测用于“执行前提醒用户”，不是最终安全边界；
 * sandbox 仍需要在真正执行前二次拦截。
 */
export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*\s+-[a-zA-Z]*f|--no-preserve-root)/i,
  /\bsudo\b/i,
  /\bchmod\s+[0-7]{3,4}\b/i,
  /\bchown\b/i,
  /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/i,
  /\bwget\b[^\n|]*\|\s*(ba)?sh\b/i,
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
];

export function isDangerousCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(trimmed));
}

/** run_command 的参数来自模型生成的 JSON 字符串，风险层必须先安全解析再检查命令。 */
export function parseRunCommandArg(argumentsJson: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : null;
  } catch {
    return null;
  }
}

/** 评估工具调用风险；未知工具按 high 处理 */
export function assessToolRisk(
  call: ToolCall,
  toolRisk: Record<string, RiskLevel> = DEFAULT_TOOL_RISK
): RiskLevel {
  const base = toolRisk[call.name] ?? "high";

  if (call.name !== "run_command") {
    return base;
  }

  const command = parseRunCommandArg(call.arguments);
  if (command && isDangerousCommand(command)) {
    return "high";
  }

  return base;
}

/** 把“风险等级”转换成“是否需要人确认”，让默认策略可以被测试和 CLI 模式覆盖。 */
export function riskRequiresConfirmation(
  risk: RiskLevel,
  opts: { autoApproveLow?: boolean; autoApproveMedium?: boolean }
): boolean {
  if (risk === "low") return opts.autoApproveLow === false;
  if (risk === "medium") return opts.autoApproveMedium !== true;
  return true;
}
