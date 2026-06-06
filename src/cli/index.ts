import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { OpenAIClient } from "../llm/client.js";
import { createDefaultRegistry } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";
import { createDefaultPermissionGate } from "../permission/index.js";
import { ConversationState } from "../agent/state.js";
import type { AgentRunner } from "../agent/runner.js";
import { loadSystemPrompt } from "../prompts/load-system-prompt.js";
import { CodexLikeApp } from "./codex-ui.js";

/**
 * 根据 provider 组装 AgentRunner。
 *
 * 这里是 CLI 和执行内核的唯一连接点：OpenAI 路径使用自研 AgentLoop，
 * Cursor 路径使用 SDK adapter。UI 只拿到统一的 AgentRunner 接口。
 */
async function createRunner(
  config: ReturnType<typeof loadConfig>,
  cwd: string
): Promise<AgentRunner> {
  if (config.provider === "cursor") {
    const { bootstrapCursorSdkEnv } = await import("../cursor/bootstrap.js");
    bootstrapCursorSdkEnv();
    const { CursorAgentAdapter } = await import("../agent/cursor-adapter.js");
    return new CursorAgentAdapter({ config, cwd });
  }

  const llm = new OpenAIClient(config);
  const tools = createDefaultRegistry();
  return new AgentLoop({
    llm,
    tools,
    cwd,
    permission: createDefaultPermissionGate(),
  });
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const cwd = process.cwd();
  // 一个 CLI 会话共享同一个 runner 和 ConversationState，保证多轮对话能累积上下文。
  const runner = await createRunner(config, cwd);
  const state = new ConversationState(loadSystemPrompt());

  render(
    React.createElement(CodexLikeApp, {
      runner,
      state,
      config,
      cwd,
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
