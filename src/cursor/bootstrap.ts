import { findRipgrepPath } from "../utils/rg-path.js";

/**
 * 在 dynamic import @cursor/sdk 之前调用。
 * SDK 在模块加载时读取 CURSOR_RIPGREP_PATH（必须是绝对路径），
 * 用于解析 .gitignore / .cursorignore。
 */
export function bootstrapCursorSdkEnv(): void {
  const existing = process.env.CURSOR_RIPGREP_PATH?.trim();
  if (existing) return;

  const rgPath = findRipgrepPath();
  if (!rgPath) {
    console.warn(
      "[claude-mini] 未找到 ripgrep (rg)。可执行 brew install ripgrep，" +
        "或在 .env 中设置 CURSOR_RIPGREP_PATH=/绝对路径/rg"
    );
    return;
  }

  process.env.CURSOR_RIPGREP_PATH = rgPath;
}
