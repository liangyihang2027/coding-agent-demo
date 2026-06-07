import { OpenAIClient } from "../llm/client.js";
import { createDefaultRegistry } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";
import { createDefaultPermissionGate } from "../permission/index.js";
import { createDefaultAuditRecorder } from "../audit/index.js";
import type { AgentRunner } from "../agent/runner.js";
import type { AppConfig } from "./config.js";

/**
 * 根据 provider 组装 AgentRunner。
 *
 * CLI 与 bench 子命令共用，避免两处各自维护 provider 分支。
 */
export async function createRunner(
  config: AppConfig,
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
    audit: createDefaultAuditRecorder(cwd),
  });
}
