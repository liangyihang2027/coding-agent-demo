import React from "react";
import { Box, Text } from "ink";
import type { AppConfig } from "../config.js";
import type { PermissionRequest } from "../../permission/types.js";
import type { Entry } from "./entries.js";
import { MarkdownText } from "./markdown.js";
import { describeConfig, formatToolArgs, truncate } from "./format.js";

/**
 * 展示型组件集合（无状态、纯渲染）。
 *
 * 这些组件只接收 props 并画出界面，不持有任何会话状态，也不发起副作用。
 * 把它们从主编排组件里分出来，既让 CodexLikeApp 专注于"状态怎么流转"，
 * 也让每个视图单元都能被单独阅读、调整样式而互不影响。
 */

const h = React.createElement;

export function ApprovalPrompt({
  request,
}: {
  request: PermissionRequest;
}): React.ReactElement {
  const color =
    request.risk === "high" ? "red" : request.risk === "medium" ? "yellow" : "blue";
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "double",
      borderColor: color,
      paddingX: 1,
      marginX: 1,
      marginBottom: 1,
    },
    h(Text, { color, bold: true }, `权限确认 · ${request.risk}`),
    h(Text, null, request.summary),
    h(Text, { dimColor: true }, "按 y 允许，n / Esc / Ctrl+C 拒绝")
  );
}

export function Header({
  config,
  cwd,
  running,
}: {
  config: AppConfig;
  cwd: string;
  running: boolean;
}): React.ReactElement {
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "single",
      borderColor: running ? "yellow" : "green",
      paddingX: 1,
    },
    h(Text, { color: "greenBright", bold: true }, "欢迎奕航大神!"),
    h(Text, { dimColor: true }, `${describeConfig(config)}  ·  ${cwd}`)
  );
}

export function MessageList({
  entries,
  height,
}: {
  entries: Entry[];
  height: number;
}): React.ReactElement {
  return h(
    Box,
    { flexDirection: "column", minHeight: height, paddingX: 1, paddingY: 1 },
    entries.map((entry) => h(EntryView, { key: entry.id, entry }))
  );
}

function EntryView({ entry }: { entry: Entry }) {
  if (entry.kind === "welcome") return null;
  if (entry.kind === "user") {
    return h(
      Box,
      { marginBottom: 1, flexDirection: "column" },
      h(Text, { color: "cyan", bold: true }, "› yhgg"),
      h(Text, null, entry.text)
    );
  }
  if (entry.kind === "assistant") {
    return h(
      Box,
      { marginBottom: 1, flexDirection: "column" },
      h(Text, { color: "green", bold: true }, "yihang cc"),
      h(MarkdownText, { content: entry.text || "…" })
    );
  }
  if (entry.kind === "tool") return h(ToolCard, { tool: entry });

  const color =
    entry.tone === "error" ? "red" : entry.tone === "warning" ? "yellow" : "blue";
  return h(Box, { marginBottom: 1 }, h(Text, { color }, entry.text));
}

function ToolCard({ tool }: { tool: Extract<Entry, { kind: "tool" }> }) {
  const color =
    tool.status === "error" ? "red" : tool.status === "success" ? "green" : "yellow";
  const icon =
    tool.status === "running" ? "…" : tool.status === "success" ? "✓" : "✗";
  const output = tool.result || tool.chunks;
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: color,
      paddingX: 1,
      marginBottom: 1,
    },
    h(
      Text,
      { color, bold: true },
      `${icon} ${tool.name}${tool.status === "running" ? " running" : ""}`
    ),
    tool.args ? h(Text, { dimColor: true }, formatToolArgs(tool.args)) : null,
    output
      ? h(
          Text,
          {
            dimColor: tool.status !== "error",
            color: tool.status === "error" ? "red" : undefined,
          },
          truncate(output, 500)
        )
      : null
  );
}

export function StatusBar({
  status,
  running,
  ready,
}: {
  status: string;
  running: boolean;
  ready: boolean;
}): React.ReactElement {
  const idleColor = ready ? "gray" : "yellow";
  return h(
    Box,
    { paddingX: 1 },
    h(
      Text,
      { color: running ? "yellow" : idleColor },
      running ? `● ${status}` : `○ ${status}`
    ),
    h(
      Text,
      { dimColor: true },
      "   Enter 发送 · Shift+Enter 换行 · ↑/↓ 历史 · Ctrl+C 退出"
    )
  );
}
