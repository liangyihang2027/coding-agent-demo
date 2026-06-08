import type { AppConfig } from "../config.js";

/**
 * UI 纯格式化函数集合。
 *
 * 这些函数不依赖 React / ink，只做字符串到字符串的转换。
 * 单独成文件是为了让它们可以被任意组件复用，也方便独立测试，
 * 不必为了一个截断逻辑去触碰渲染层。
 */

/** 折叠多余换行并裁断到上限，避免单条输出撑爆终端行宽。 */
export function truncate(value: string, max: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max) + " …";
}

/**
 * 把工具调用的原始 JSON 参数渲染成一行紧凑的 key=value 摘要。
 *
 * 工具卡片上只需让用户快速看清"调了什么"，完整 JSON 既占地方又难读；
 * 解析失败时回退为截断原文，保证再脏的参数也能展示而不抛错。
 */
export function formatToolArgs(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.entries(obj)
      .map(([key, value]) => {
        const rendered = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}=${truncate(rendered ?? "", 80)}`;
      })
      .join("  ");
  } catch {
    return truncate(trimmed, 120);
  }
}

/** 把当前 provider 配置压成一行展示在标题栏，让用户随时确认在用哪个后端。 */
export function describeConfig(config: AppConfig): string {
  if (config.provider === "cursor") {
    const runtime =
      config.runtime === "cloud"
        ? `cloud · ${config.repoUrl ?? "未配置仓库"}`
        : "local";
    return `cursor · ${config.model} · ${runtime}`;
  }
  return `openai · ${config.model}`;
}
