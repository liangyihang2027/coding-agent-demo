import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Upstream: openai/codex `codex-rs/core/gpt-5.2-codex_prompt.md` */
export const CODEX_SYSTEM_PROMPT_SOURCE =
  "https://github.com/openai/codex/blob/main/codex-rs/core/gpt-5.2-codex_prompt.md";

function readPromptFile(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf8").trim();
}

/** Codex 官方 system prompt + claude-mini 工具映射 */
export function loadSystemPrompt(): string {
  const codex = readPromptFile("codex-system-prompt.md");
  const overlay = readPromptFile("claude-mini-overlay.md");
  return `${codex}\n\n${overlay}`;
}
