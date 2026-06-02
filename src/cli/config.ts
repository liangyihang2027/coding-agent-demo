import "dotenv/config";

export interface AppConfig {
  apiKey: string;
  baseURL: string | undefined;
  model: string;
}

/** 从环境变量加载配置（见 .env.example） */
export function loadConfig(): AppConfig {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "缺少 LLM_API_KEY。请复制 .env.example 为 .env 并填入你的配置。"
    );
  }
  return {
    apiKey,
    baseURL: process.env.LLM_BASE_URL || undefined,
    model: process.env.LLM_MODEL || "gpt-4o-mini",
  };
}
