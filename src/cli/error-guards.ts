import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../storage/index.js";

/**
 * 进程级错误兜底。
 *
 * 背景：Cursor SDK 走 gRPC over HTTP/2 的长流式连接，网络抖动时底层 socket 会
 * 抛出 ECONNRESET。这类拒绝可能发生在 SDK 后台流上，绕过 adapter 的 try/catch，
 * 在 Node 22 下变成 unhandledRejection 直接终止整个 CLI（详见
 * docs/troubleshooting/cursor-sdk-econnreset.md）。
 *
 * 策略：只“兜住”可恢复的瞬时网络错误——记录到日志、不退出，让用户回到输入框重试；
 * 其余非预期错误保持 fail-fast（打印并退出 1），避免掩盖真正的 bug。
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/** 提取错误链上的 code（SDK 常把底层 code 放在 cause 上）。 */
function extractCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.code === "string") return e.code;
  if (typeof e?.cause?.code === "string") return e.cause.code;
  return undefined;
}

/** 判断是否为可恢复的瞬时网络错误。 */
export function isTransientNetworkError(err: unknown): boolean {
  const code = extractCode(err);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|socket hang up|aborted|read ECONNRESET/i.test(msg);
}

/** 把瞬时错误追加到 <cwd>/.claude-mini/cli-errors.log，避免污染 Ink 全屏 UI。 */
function logTransient(cwd: string, source: string, err: unknown): void {
  try {
    const dir = resolveDataDir(cwd);
    mkdirSync(dir, { recursive: true });
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(
      path.join(dir, "cli-errors.log"),
      `[${new Date().toISOString()}] ${source}: ${detail}\n`,
      "utf8"
    );
  } catch {
    // 记录失败不应再次引发崩溃。
  }
}

/**
 * 安装全局错误守卫。返回前需在进入交互 UI 之前调用。
 *
 * 对瞬时网络错误：记录后继续运行；对其它错误：打印并退出。
 */
export function installGlobalErrorGuards(cwd: string): void {
  process.on("unhandledRejection", (reason) => {
    if (isTransientNetworkError(reason)) {
      logTransient(cwd, "unhandledRejection", reason);
      return;
    }
    console.error(reason);
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    if (isTransientNetworkError(err)) {
      logTransient(cwd, "uncaughtException", err);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}
