import { spawn } from "node:child_process";
import { isDangerousCommand } from "../permission/risk.js";

/**
 * 沙箱 / 命令执行内核（阶段 3）。
 *
 * 职责：在受控环境下执行 shell 命令，保证安全性和健壮性。
 *
 * 核心能力：
 *  1. 进程树管理 —— detached 进程组 + 负 PID kill，避免孤儿进程
 *  2. 信号升级策略 —— SIGTERM（优雅停止）→ 宽限期 → SIGKILL（强杀）
 *  3. 危险命令拦截 —— 复用 permission/risk 的模式列表，sandbox 层做硬拦截
 *  4. 输出截断 —— 超长输出保留头尾，防止撑爆上下文窗口
 *  5. 环境变量白名单 —— 只透传安全变量，防止模型通过 echo 偷读密钥
 */

// ----------------------------- 接口 -----------------------------

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  onChunk?: (chunk: string) => void;
  /** SIGTERM 后等待宽限期（ms），默认 3000 */
  gracePeriodMs?: number;
  /** 输出截断阈值（字节），默认 100KB */
  maxOutputBytes?: number;
  /** 覆盖默认环境变量白名单 */
  envAllowlist?: string[];
  /** 额外注入的环境变量 */
  extraEnv?: Record<string, string>;
  /** 是否启用危险命令拦截，默认 true */
  dangerCheck?: boolean;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** 输出是否被截断 */
  truncated: boolean;
  /** 进程被哪个信号终止 */
  killedBySignal?: string;
  /** 是否被危险命令拦截（未实际 spawn） */
  blocked: boolean;
}

// ----------------------------- 常量 -----------------------------

/**
 * 环境变量白名单。
 *
 * 用白名单而非黑名单：黑名单无法穷举所有敏感变量名（API_KEY、TOKEN、SECRET……各框架命名不同），
 * 白名单只放行命令执行必须的变量，从根源上阻止信息泄露。
 */
const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "NODE_ENV",
  "EDITOR",
];

const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024; // 100KB
const DEFAULT_GRACE_PERIOD_MS = 3_000;

// ----------------------------- 环境变量构建 -----------------------------

/** 从 process.env 中只保留白名单内的变量，再叠加 extraEnv。 */
export function buildSafeEnv(
  allowlist: string[] = DEFAULT_ENV_ALLOWLIST,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    if (process.env[key] != null) {
      env[key] = process.env[key]!;
    }
  }
  return { ...env, ...extra };
}

// ----------------------------- 输出截断 -----------------------------

/**
 * 超长输出保留头部和尾部，中间插入省略标记。
 *
 * 保留头尾而非只保留头部：尾部通常包含最终结果、错误信息或 exit summary，
 * 对模型理解命令执行结果至关重要。头部则包含初始日志和早期错误。
 * 各占 40% 是实践中的平衡点，中间 20% 留给省略标记。
 */
export function truncateOutput(
  raw: string,
  maxBytes: number
): { text: string; wasTruncated: boolean } {
  const bytes = Buffer.byteLength(raw, "utf-8");
  if (bytes <= maxBytes) {
    return { text: raw, wasTruncated: false };
  }

  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = Math.floor(maxBytes * 0.4);

  const head = safeSliceBytes(raw, 0, headBytes);
  const tail = safeSliceBytes(raw, bytes - tailBytes, bytes);

  const marker = `\n\n... [截断：原始输出 ${bytes.toLocaleString()} 字节，已保留头尾各 ~${formatBytes(headBytes)}] ...\n\n`;

  return { text: head + marker + tail, wasTruncated: true };
}

/** 按字节偏移安全切割 UTF-8 字符串，不切断多字节字符。 */
function safeSliceBytes(
  str: string,
  startByte: number,
  endByte: number
): string {
  const buf = Buffer.from(str, "utf-8");
  const sliced = buf.subarray(startByte, endByte);
  return sliced.toString("utf-8").replace(/\uFFFD/g, "");
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

// ----------------------------- 进程树 kill -----------------------------

/**
 * 向进程组发送信号。
 *
 * 使用负 PID（`-pid`）：当 spawn 设置 `detached: true` 时，子进程成为新进程组的 leader，
 * 其 PID 就是进程组 ID（PGID）。`kill(-pid)` 向整个进程组发信号，
 * 确保 shell 派生的所有子进程（孙子进程）都能收到信号，不留孤儿。
 *
 * 对比直接 `child.kill()`：只发给直接子进程（shell），shell 内的 `node server.js &` 等
 * 后台任务不会收到信号，变成孤儿进程继续占用端口和资源。
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // 进程已退出或无权限，忽略
    return false;
  }
}

// ----------------------------- 核心执行 -----------------------------

export function runCommand(
  command: string,
  opts: RunCommandOptions
): Promise<RunCommandResult> {
  const dangerCheck = opts.dangerCheck ?? true;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;

  // ---- 危险命令拦截（纵深防御）----
  // permission 层的检测用于"提醒用户"，可被 allow-all 跳过；
  // sandbox 层是硬拦截，即使 permission 放行了，这里仍然阻止执行。
  if (dangerCheck && isDangerousCommand(command)) {
    return Promise.resolve({
      stdout: "",
      stderr: `命令被沙箱拦截：匹配危险模式，拒绝执行。\n命令: ${command}`,
      exitCode: -1,
      timedOut: false,
      truncated: false,
      killedBySignal: undefined,
      blocked: true,
    });
  }

  return new Promise((resolve) => {
    const safeEnv = buildSafeEnv(opts.envAllowlist, opts.extraEnv);

    /**
     * detached: true 让子进程创建新的进程组。
     *
     * 为什么需要新进程组：`shell: true` 会先 fork 一个 shell 进程，shell 再 fork/exec 实际命令。
     * 如果不用 detached，这些进程共享父进程的进程组，超时 kill 时只能杀到直接子进程（shell），
     * shell 内启动的子命令（如 `npm run dev` 启动的 webpack-dev-server）会变成孤儿。
     * detached 让整棵进程树在同一个新进程组内，`kill(-pid)` 一次清理干净。
     */
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      detached: true,
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // detached 子进程默认会阻止父进程退出，unref 解除这个绑定。
    // Agent 进程退出时不需要等待命令完成。
    child.unref();

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedBySignal: string | undefined;
    let settled = false;

    function settle(exitCode: number) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);

      const stdoutResult = truncateOutput(stdout, maxOutputBytes);
      const stderrResult = truncateOutput(stderr, maxOutputBytes);

      resolve({
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        exitCode,
        timedOut,
        truncated: stdoutResult.wasTruncated || stderrResult.wasTruncated,
        killedBySignal,
        blocked: false,
      });
    }

    // ---- 流式输出捕获 ----
    // onChunk 始终实时推送，不受截断影响（CLI 流式渲染需要即时数据）；
    // stdout/stderr 字符串用于最终回填给模型，结束时统一截断。
    child.stdout!.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stdout += s;
      opts.onChunk?.(s);
    });
    child.stderr!.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stderr += s;
      opts.onChunk?.(s);
    });

    child.on("close", (code) => settle(code ?? -1));
    child.on("error", (err) => {
      stderr += err.message;
      settle(-1);
    });

    // ---- 超时：SIGTERM → 宽限期 → SIGKILL 两阶段升级 ----
    // 阶段一：SIGTERM 让进程有机会优雅退出（关闭数据库连接、删临时文件、释放端口）。
    // 如果直接 SIGKILL，进程没有任何清理机会，可能留下脏状态。
    let escalationTimer: ReturnType<typeof setTimeout>;
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const pid = child.pid;
      if (pid == null) return;

      killedBySignal = "SIGTERM";
      killProcessGroup(pid, "SIGTERM");

      // 阶段二：宽限期后仍未退出，升级为 SIGKILL（不可被捕获/忽略的终极信号）。
      escalationTimer = setTimeout(() => {
        if (settled) return;
        killedBySignal = "SIGKILL";
        killProcessGroup(pid, "SIGKILL");
      }, gracePeriodMs);
    }, opts.timeoutMs);
  });
}
