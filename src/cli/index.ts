import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { OpenAIClient } from "../llm/client.js";
import { createDefaultRegistry } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/state.js";
import type { AgentRunner } from "../agent/runner.js";
import { loadSystemPrompt } from "../prompts/load-system-prompt.js";
import { CodexLikeApp } from "./codex-ui.js";

async function createRunner(config: ReturnType<typeof loadConfig>, cwd: string): Promise<AgentRunner> {
  if (config.provider === "cursor") {
    const { bootstrapCursorSdkEnv } = await import("../cursor/bootstrap.js");
    bootstrapCursorSdkEnv();
    const { CursorAgentAdapter } = await import("../agent/cursor-adapter.js");
    return new CursorAgentAdapter({ config, cwd });
  }

  const llm = new OpenAIClient(config);
  const tools = createDefaultRegistry();
  return new AgentLoop({ llm, tools, cwd });
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
