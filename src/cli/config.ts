import "dotenv/config";

export type LLMProvider = "openai" | "cursor";

export interface OpenAIConfig {
  provider: "openai";
  apiKey: string;
  baseURL: string | undefined;
  model: string;
}

export interface CursorConfig {
  provider: "cursor";
  apiKey: string;
  model: string;
  runtime: "local" | "cloud";
  repoUrl?: string;
  startingRef?: string;
  autoCreatePR?: boolean;
}

export type AppConfig = OpenAIConfig | CursorConfig;

function isCursorKey(key: string): boolean {
  return key.startsWith("crsr_") || key.startsWith("cursor_");
}

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

function resolveCursorApiKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (key) return key;

  const legacy = process.env.LLM_API_KEY?.trim();
  if (legacy && isCursorKey(legacy)) return legacy;

  throw new Error(
    "缺少 CURSOR_API_KEY。请在 .env 中配置 Cursor API Key（Dashboard → API Keys）。"
  );
}

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
