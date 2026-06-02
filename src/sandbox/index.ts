import { spawn } from "node:child_process";

/**
 * ⭐⭐⭐ 阶段 3「沙箱 / 命令执行」内核入口 —— 这是你要亲手实现的灵魂模块之一。⭐⭐⭐
 *
 * 下面是一个【故意写得很naive】的最小可跑版本，只为让阶段 1 的闭环能跑起来。
 * 它几乎没有任何安全/健壮性保证。阶段 3 你需要在这里亲手补齐（蓝图 §阶段3）：
 *
 *   [ ] 超时控制：到时 kill，并正确处理「子进程树」（spawn 一个 shell 会派生孙子进程，
 *       直接 kill 父进程会留下僵尸/孤儿进程）。研究 detached + process.kill(-pid)。
 *   [ ] stdout/stderr 真·流式捕获（边执行边通过 onChunk 吐出，而不是攒到最后）。
 *   [ ] 危险命令检测与拦截（rm -rf、sudo、curl|sh、:(){ :|:& };: 等）。
 *   [ ] 输出截断（超长输出不能撑爆上下文，保留头尾 + 标注省略）。
 *   [ ] 工作目录隔离、环境变量白名单控制。
 *   [ ] 区分 SIGTERM（优雅）与 SIGKILL（强杀）的升级策略。
 *
 * 面试得分点：进程 vs 线程、fork/exec、信号、僵尸/孤儿进程、阻塞 vs 非阻塞 IO、
 * Node 事件循环与子进程的关系。实现时把这些「为什么」记进 README。
 */

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  onChunk?: (chunk: string) => void;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** 极简实现（阶段 1 占位）。阶段 3 请重写这里。 */
export function runCommand(
  command: string,
  opts: RunCommandOptions
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL"); // TODO 阶段3：先 SIGTERM 再升级 SIGKILL，并处理进程树
    }, opts.timeoutMs);

    child.stdout?.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stdout += s;
      opts.onChunk?.(s);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stderr += s;
      opts.onChunk?.(s);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exitCode: -1, timedOut });
    });
  });
}
