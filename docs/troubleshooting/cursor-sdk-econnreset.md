# Cursor SDK 流式连接 ECONNRESET 导致 CLI 整体崩溃

- 日期：2026-06-07
- 影响范围：`LLM_PROVIDER=cursor` 路径（`CursorAgentAdapter`）
- 严重级别：高（整个 CLI 进程退出，会话中断）
- 状态：已加进程级兜底（见下文「修复」）

## 现象

在 CLI 中正常对话（已触发若干工具调用，如 `git status` / `git diff`）后，进程突然退出，终端打印：

```
ConnectError: [aborted] read ECONNRESET
    at ConnectError.from (.../@connectrpc/connect/.../connect-error.js:71:20)
    at connectErrorFromNodeReason (.../@connectrpc/connect-node/.../node-error.js:52:29)
    at ClientHttp2Stream.h2StreamError (.../@connectrpc/connect-node/.../node-universal-client.js:182:22)
    ...
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
  rawMessage: 'read ECONNRESET',
  code: 10,
  cause: Error: read ECONNRESET { errno: -54, code: 'ECONNRESET', syscall: 'read' }
}
Node.js v22.21.1
 ELIFECYCLE  Command failed with exit code 1.
```

## 根因分析

分两层：

### 1) 为什么会出错：网络层连接被重置

`ECONNRESET` 表示在**读取数据时对端突然重置了 TCP 连接**。Cursor SDK（`@cursor/sdk`）与云端之间是一条 **gRPC over HTTP/2 的长流式连接**（`@connectrpc/connect-node`）。流式接收 agent 输出期间，这条 TLS 连接被中途断开。

常见诱因（均为传输层偶发故障，非业务逻辑 bug）：

- 网络抖动 / Wi-Fi 切换
- VPN、代理、公司防火墙中断长连接
- 后端回收空闲 / 长连接

### 2) 为什么会“整个 CLI 崩溃”而非“仅本轮失败”

关键证据：堆栈里**没有任何本项目代码帧**（`cursor-adapter.ts` / `loop.ts` 均未出现），结尾是 `process.processTicksAndRejections`——这是典型的**未捕获 Promise 拒绝（unhandledRejection）**。Node 22 默认对未捕获拒绝直接终止进程。

为什么没被 `CursorAgentAdapter.run()` 的 `try/catch` 接住？因为该 `try/catch` 只覆盖**被 await 的主链路**（`agent.send` → `for await run.stream()` → `run.wait()`）。而这条流是**双向（duplex）**的，SDK 内部还有写入侧 / keepalive 等**后台 promise**；ECONNRESET 触发的是后台 promise 的 reject，不在我们 await 的路径上，于是绕过 `try/catch` 成为全局未捕获异常。

附带隐患：`src/cli/index.ts` 中 `runner.warmup?.()` 创建的 promise 此前没有 `.catch`，预热期发生同类错误也会以相同方式崩溃。

## 修复

采用「只兜瞬时网络错误、其余保持 fail-fast」的策略，避免掩盖真正的 bug。

1. 新增 `src/cli/error-guards.ts`：`installGlobalErrorGuards(cwd)` 注册 `unhandledRejection` / `uncaughtException`：
   - 命中瞬时网络错误（`ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `EPIPE` / `socket hang up` 等）→ 追加写入 `<cwd>/.claude-mini/cli-errors.log`，**不退出**；
   - 其它错误 → 打印并 `exit(1)`，保持原有 fail-fast。
2. `src/cli/index.ts`：进入交互 UI 前调用 `installGlobalErrorGuards(cwd)`；并对 `warmupPromise` 追加 `void warmupPromise?.catch(() => {})`，消除预热期未捕获拒绝。

效果：网络抖动时 CLI 不再整体退出，错误被记录到日志，用户可回到输入框重试。

## 排查与缓解

- 查看记录：`cat .claude-mini/cli-errors.log`
- 临时规避网络路径：改用本地自研内核 `LLM_PROVIDER=openai`
- 网络侧：检查 VPN / 代理 / 防火墙对长连接的影响

## 后续可选增强（未做）

- 在 `CursorAgentAdapter` 内对 `send` / `stream` 做**瞬时错误重试 / 优雅降级**；
- 流连接中断时主动结束在途 `run()`，避免 UI 停留在“运行中”状态；
- 把瞬时错误以 UI notice 形式提示，而不仅写日志。
