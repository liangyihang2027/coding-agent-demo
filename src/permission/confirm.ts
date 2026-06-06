import * as readline from "node:readline";
import type { PermissionConfirmHandler } from "./types.js";

export interface StdioConfirmOptions {
  /** 默认拒绝（超时或未输入 y），避免无人值守时误执行 */
  defaultAllow?: boolean;
}

/**
 * 终端 y/n 确认（最小版）。
 * Ink TUI 占用 stdin 时可能不稳定；后续用 AgentEvents.onPermissionPrompt + overlay 替换。
 */
export function createStdioConfirm(
  opts: StdioConfirmOptions = {}
): PermissionConfirmHandler {
  // 默认不放行是安全默认值：用户没有明确同意时，不执行会修改环境的动作。
  const defaultAllow = opts.defaultAllow ?? false;

  return async (request) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const hint = defaultAllow ? "Y/n" : "y/N";
    const question = `\n[权限] 需要确认: ${request.summary}\n允许执行? (${hint}) `;

    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question(question, resolve);
      });
      const normalized = answer.trim().toLowerCase();
      if (!normalized) return defaultAllow;
      return normalized === "y" || normalized === "yes";
    } finally {
      rl.close();
    }
  };
}

/** 始终允许（本地开发 / 自动化测试），用于验证主流程而不阻塞在人工输入。 */
export function createAlwaysAllowConfirm(): PermissionConfirmHandler {
  return async () => true;
}

/** 始终拒绝，用于测试“拒绝也能回填给模型”的闭环。 */
export function createAlwaysDenyConfirm(): PermissionConfirmHandler {
  return async () => false;
}
