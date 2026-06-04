import { loadConfig } from "./config.js";
import { OpenAIClient } from "../llm/client.js";
import { createDefaultRegistry } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/state.js";
import type { AgentRunner } from "../agent/runner.js";
import { TurnUI } from "./ui.js";
import { loadSystemPrompt } from "../prompts/load-system-prompt.js";

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

function describeConfig(config: ReturnType<typeof loadConfig>): string {
  if (config.provider === "cursor") {
    const runtime =
      config.runtime === "cloud"
        ? `cloud · ${config.repoUrl ?? "未配置仓库"}`
        : "local";
    return `cursor · ${config.model} · ${runtime}`;
  }
  return `openai · ${config.model}`;
}

async function main() {
  const ui = new TurnUI();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(ui.s.red((err as Error).message));
    process.exit(1);
  }

  const cwd = process.cwd();
  const runner = await createRunner(config, cwd);
  const state = new ConversationState(loadSystemPrompt());

  ui.printWelcome(
    [`claude-mini  ·  ${describeConfig(config)}`, `cwd: ${cwd}`],
    "输入需求开始对话，/exit 退出"
  );

  try {
    while (true) {
      let raw: string;
      try {
        raw = await ui.readUserInput();
      } catch (err) {
        if ((err as Error).message === "SIGINT") break;
        throw err;
      }

      const input = raw.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;

      try {
        await runner.run(state, input, {
          onText: (delta) => ui.writeAssistant(delta),
          onToolCall: (call) => ui.showToolCall(call.name, call.arguments),
          onToolResult: (_call, content, isError) =>
            ui.showToolResult(content, isError),
          onToolChunk: (chunk) => ui.writeToolChunk(chunk),
          onMaxSteps: (max) => ui.showMaxSteps(max),
        });
        ui.endTurn();
      } catch (err) {
        ui.showError((err as Error).message);
        ui.endTurn();
      }
    }
  } finally {
    await runner.close?.();
    ui.farewell();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
