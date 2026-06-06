import "dotenv/config";

export type LLMProvider = "openai" | "cursor";

export interface OpenAIConfig {
  /** 显式 discriminant，便于 CLI 入口安全选择本地 AgentLoop。 */
  provider: "openai";
  apiKey: string;
  /** baseURL 可选，是为了兼容 OpenAI-compatible provider。 */
  baseURL: string | undefined;
  model: string;
}

export interface CursorConfig {
  /** Cursor provider 走 SDK adapter，不经过本地 ToolRegistry/Sandbox。 */
  provider: "cursor";
  apiKey: string;
  model: string;
  /** local 用当前工作区，cloud 需要远端 GitHub 仓库作为执行环境。 */
  runtime: "local" | "cloud";
  repoUrl?: string;
  startingRef?: string;
  autoCreatePR?: boolean;
}

export type AppConfig = OpenAIConfig | CursorConfig;

/** 识别误填到 LLM_API_KEY 的 Cursor key，给出更明确的配置错误。 */
function isCursorKey(key: string): boolean {
  return key.startsWith("crsr_") || key.startsWith("cursor_");
}

/**
 * 自动选择 provider。
 *
 * 显式 LLM_PROVIDER 优先；没有显式配置时根据 key 类型兜底推断，
 * 这样新手快速启动更顺滑，同时仍能通过 env 固定学习主线。
 */
function resolveProvider(): LLMProvider {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === "openai" || explicit === "cursor") {
    return explicit;
  }

  if (process.env.CURSOR_API_KEY?.trim()) return "cursor";
  if (process.env.LLM_API_KEY?.trim() && isCursorKey(process.env.LLM_API_KEY)) {
    return "cursor";
  }
  return "openai";
}

/** Cursor API Key 允许从专用变量读取，也兼容早期误放在 LLM_API_KEY 的配置。 */
function resolveCursorApiKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (key) return key;

  const legacy = process.env.LLM_API_KEY?.trim();
  if (legacy && isCursorKey(legacy)) return legacy;

  throw new Error(
    "缺少 CURSOR_API_KEY。请在 .env 中配置 Cursor API Key（Dashboard → API Keys）。"
  );
}

/** 加载 OpenAI 兼容配置；这是自研 AgentLoop 的阶段一学习主线。 */
function loadOpenAIConfig(): OpenAIConfig {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "缺少 LLM_API_KEY。请复制 .env.example 为 .env 并填入 OpenAI 兼容 provider 的配置。"
    );
  }
  if (isCursorKey(apiKey)) {
    throw new Error(
      "检测到 Cursor API Key 填在 LLM_API_KEY 中。请改用 CURSOR_API_KEY，并设置 LLM_PROVIDER=cursor。"
    );
  }

  return {
    provider: "openai",
    apiKey,
    baseURL: process.env.LLM_BASE_URL?.trim() || undefined,
    model: process.env.LLM_MODEL?.trim() || "gpt-4o-mini",
  };
}

/** 加载 Cursor SDK 配置；这是 provider 适配演示路径，不代表本地内核能力。 */
function loadCursorConfig(): CursorConfig {
  const runtime = process.env.CURSOR_RUNTIME?.trim().toLowerCase();
  const resolvedRuntime = runtime === "cloud" ? "cloud" : "local";

  return {
    provider: "cursor",
    apiKey: resolveCursorApiKey(),
    model: process.env.CURSOR_MODEL?.trim() || "composer-2",
    runtime: resolvedRuntime,
    repoUrl: process.env.CURSOR_REPO_URL?.trim() || undefined,
    startingRef: process.env.CURSOR_STARTING_REF?.trim() || "main",
    autoCreatePR: process.env.CURSOR_AUTO_CREATE_PR === "true",
  };
}

/** 从环境变量加载配置（见 .env.example） */
export function loadConfig(): AppConfig {
  return resolveProvider() === "cursor"
    ? loadCursorConfig()
    : loadOpenAIConfig();
}
