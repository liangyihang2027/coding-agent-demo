import React from "react";
import { randomUUID } from "node:crypto";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { createRunner } from "./create-runner.js";
import { runBenchFirstMessage } from "./bench-first-message.js";
import { openAuditDb, pruneAuditEvents } from "../audit/index.js";
import { ConversationState } from "../agent/state.js";
import { Store } from "../storage/index.js";
import { loadSystemPrompt } from "../prompts/load-system-prompt.js";
import { installGlobalErrorGuards } from "./error-guards.js";
import { CodexLikeApp } from "./codex-ui.js";

/**
 * 准备本轮会话的 ConversationState，并绑定持久化。
 *
 * --session <id> 指定会话；--continue / -c 恢复该 cwd 下最近一次会话；
 * 命中已存在会话则从历史恢复，否则新建并把 system prompt 落库。
 */
function prepareSession(store: Store, cwd: string, argv: string[]): ConversationState {
  const sessionFlagIdx = argv.indexOf("--session");
  const explicitId =
    sessionFlagIdx >= 0 ? argv[sessionFlagIdx + 1] : undefined;
  const wantContinue = argv.includes("--continue") || argv.includes("-c");

  let sessionId = explicitId;
  if (!sessionId && wantContinue) {
    sessionId = store.sessions.latestSessionId(cwd);
  }

  if (sessionId && store.sessions.getSession(sessionId)) {
    const state = new ConversationState();
    state.loadFrom(store.sessions.loadMessages(sessionId));
    state.bindStore(store.sessions, sessionId);
    return state;
  }

  const id = sessionId ?? randomUUID();
  store.sessions.createSession({ id, cwd });
  const state = new ConversationState(loadSystemPrompt());
  state.bindStore(store.sessions, id, { persistExisting: true });
  return state;
}

/** `list-sessions`：列出历史会话，供 --continue / --session 选择。 */
function runListSessions(cwd: string): void {
  const store = new Store(cwd);
  const rows = store.sessions.listSessions(50);
  if (rows.length === 0) {
    console.log("暂无会话历史。");
  } else {
    for (const r of rows) {
      console.log(
        `${r.id}  ${r.updated_at}  msgs=${r.message_count}  ${r.title ?? "(未命名)"}`
      );
    }
  }
  store.close();
}

/** `audit prune [--days N]`：手动清理早于保留期的审计记录（默认 90 天）。 */
function runAuditPrune(cwd: string, args: string[]): void {
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 90;
  if (!Number.isFinite(days) || days < 0) {
    console.error("--days 需为非负数字");
    process.exit(1);
  }
  const db = openAuditDb(cwd);
  const removed = pruneAuditEvents(db, days);
  db.close();
  console.log(`已清理 ${removed} 条早于 ${days} 天的审计记录。`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  // 不进入交互 UI 的一次性子命令
  if (argv[0] === "list-sessions") {
    runListSessions(cwd);
    return;
  }
  if (argv[0] === "audit" && argv[1] === "prune") {
    runAuditPrune(cwd, argv.slice(2));
    return;
  }
  if (argv[0] === "bench-first-message") {
    await runBenchFirstMessage(cwd, argv.slice(1));
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // 进入交互 UI 前装好全局守卫：网络抖动（如 Cursor SDK 的 ECONNRESET）只记录不退出。
  installGlobalErrorGuards(cwd);

  const store = new Store(cwd);
  // 一个 CLI 会话共享同一个 runner 和 ConversationState，保证多轮对话能累积上下文。
  const runner = await createRunner(config, cwd);
  const state = prepareSession(store, cwd, argv);
  // 命令启动后立即预热 runner（如 Cursor SDK），不等用户发第一条消息。
  const warmupPromise = runner.warmup?.();
  // 预热失败（常见为瞬时网络错误）不应变成 unhandledRejection；真实错误会在首条消息时再次暴露。
  void warmupPromise?.catch(() => {});

  render(
    React.createElement(CodexLikeApp, {
      runner,
      state,
      config,
      cwd,
      warmupPromise,
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
