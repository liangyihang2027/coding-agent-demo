import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { AppConfig } from "./config.js";
import type { AgentRunner } from "../agent/runner.js";
import type { ConversationState } from "../agent/state.js";
import type { PermissionRequest } from "../permission/types.js";
import { formatAgentPhase } from "../agent/phases.js";

type Entry =
  | { id: string; kind: "welcome"; text: string }
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | {
      id: string;
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      status: "running" | "success" | "error";
      chunks: string;
      result: string;
    }
  | { id: string; kind: "notice"; text: string; tone: "info" | "warning" | "error" };

interface CodexLikeAppProps {
  runner: AgentRunner;
  state: ConversationState;
  config: AppConfig;
  cwd: string;
  /** CLI 入口已发起的预热；UI 挂载后继续等待，就绪后才允许提交。 */
  warmupPromise?: Promise<void>;
}

interface ComposerProps {
  disabled: boolean;
  history: string[];
  status: string;
  onSubmit: (value: string) => void;
  onExit: () => void;
  onInterrupt: () => void;
}

interface PendingApproval {
  request: PermissionRequest;
  resolve: (allowed: boolean) => void;
}

const h = React.createElement;

export function CodexLikeApp({
  runner,
  state,
  config,
  cwd,
  warmupPromise,
}: CodexLikeAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [entries, setEntries] = useState<Entry[]>([
    { id: "welcome", kind: "welcome", text: "欢迎奕航大神！" },
  ]);
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(warmupPromise == null);
  const warmupStatus =
    warmupPromise ?
      config.provider === "cursor" ?
        "连接 Agent 中"
      : "初始化中"
    : "准备就绪";
  const [status, setStatus] = useState(warmupStatus);
  const [history, setHistory] = useState<string[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const seq = useRef(0);
  const turnSeq = useRef(0);
  const exitArmedUntil = useRef(0);

  useEffect(() => {
    return () => {
      void runner.close?.();
    };
  }, [runner]);

  useEffect(() => {
    if (!warmupPromise) return;
    let cancelled = false;
    void warmupPromise
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setStatus("准备就绪");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReady(true);
        setStatus("初始化失败");
        setEntries((prev) => [
          ...prev,
          {
            id: `notice-warmup-${Date.now()}`,
            kind: "notice",
            text: `初始化失败: ${(err as Error).message}`,
            tone: "error",
          },
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, [warmupPromise]);

  const nextId = useCallback((prefix: string) => {
    seq.current += 1;
    return `${prefix}-${seq.current}`;
  }, []);

  const closeApp = useCallback(() => {
    void runner.close?.().finally(() => exit());
  }, [exit, runner]);

  const addNotice = useCallback(
    (text: string, tone: "info" | "warning" | "error" = "info") => {
      setEntries((prev) => [...prev, { id: nextId("notice"), kind: "notice", text, tone }]);
    },
    [nextId]
  );

  const resolveApproval = useCallback(
    (allowed: boolean) => {
      if (!approval) return;
      const { request, resolve } = approval;
      setApproval(null);
      setStatus(allowed ? `已允许 ${request.call.name}` : `已拒绝 ${request.call.name}`);
      resolve(allowed);
    },
    [approval]
  );

  useInput(
    (input, key) => {
      if (!approval) return;
      const normalized = input.toLowerCase();
      if (normalized === "y") {
        resolveApproval(true);
        return;
      }
      if (normalized === "n" || key.escape || (key.ctrl && normalized === "c")) {
        resolveApproval(false);
      }
    },
    { isActive: approval != null }
  );

  const submit = useCallback(
    (raw: string) => {
      const input = raw.trim();
      if (!input || running || !ready) return;
      if (input === "/exit" || input === "/quit") {
        closeApp();
        return;
      }

      const turn = ++turnSeq.current;
      let currentAssistantId: string | null = null;
      setHistory((prev) => [...prev, input]);
      setEntries((prev) => [
        ...prev,
        { id: nextId("user"), kind: "user", text: input },
      ]);
      setRunning(true);
      setStatus("发送请求");

      void runner
        .run(state, input, {
          onPhase: (phase) => {
            if (turn !== turnSeq.current) return;
            setStatus(formatAgentPhase(phase));
          },
          onPermissionPrompt: (request) =>
            new Promise<boolean>((resolve) => {
              currentAssistantId = null;
              setStatus(`等待确认 ${request.call.name}`);
              setApproval({ request, resolve });
            }),
          onText: (delta) => {
            if (turn !== turnSeq.current || !delta) return;
            setStatus("生成回复中");
            if (currentAssistantId == null) currentAssistantId = nextId("assistant");
            const assistantId = currentAssistantId;
            setEntries((prev) => {
              const hasAssistant = prev.some(
                (entry) => entry.id === assistantId && entry.kind === "assistant"
              );
              if (!hasAssistant) {
                return [...prev, { id: assistantId, kind: "assistant", text: delta }];
              }
              return prev.map((entry) =>
                entry.id === assistantId && entry.kind === "assistant"
                  ? { ...entry, text: entry.text + delta }
                  : entry
              );
            });
          },
          onToolCall: (call) => {
            if (turn !== turnSeq.current) return;
            currentAssistantId = null;
            setStatus(`运行工具 ${call.name}`);
            setEntries((prev) => [
              ...prev,
              {
                id: nextId("tool"),
                kind: "tool",
                callId: call.id,
                name: call.name,
                args: call.arguments,
                status: "running",
                chunks: "",
                result: "",
              },
            ]);
          },
          onToolChunk: (chunk) => {
            if (turn !== turnSeq.current || !chunk) return;
            setEntries((prev) => updateLastRunningTool(prev, (tool) => ({
              ...tool,
              chunks: tool.chunks + chunk,
            })));
          },
          onToolDenied: (call, reason) => {
            if (turn !== turnSeq.current) return;
            currentAssistantId = null;
            setStatus(`已拒绝 ${call.name}`);
            setEntries((prev) => [
              ...prev,
              {
                id: nextId("tool"),
                kind: "tool",
                callId: call.id,
                name: call.name,
                args: call.arguments,
                status: "error",
                chunks: "",
                result: reason,
              },
            ]);
          },
          onToolResult: (call, content, isError) => {
            if (turn !== turnSeq.current) return;
            currentAssistantId = null;
            setStatus(isError ? `工具失败 ${call.name}` : `工具完成 ${call.name}`);
            setEntries((prev) =>
              prev.map((entry) =>
                entry.kind === "tool" && entry.callId === call.id
                  ? {
                      ...entry,
                      status: isError ? "error" : "success",
                      result: content,
                    }
                  : entry
              )
            );
          },
          onMaxSteps: (max) => {
            if (turn !== turnSeq.current) return;
            addNotice(`已达到 step 上限 ${max}，强制停止`, "warning");
          },
        })
        .catch((err: unknown) => {
          if (turn !== turnSeq.current) return;
          addNotice(`出错: ${(err as Error).message}`, "error");
        })
        .finally(() => {
          if (turn !== turnSeq.current) return;
          setRunning(false);
          setStatus("准备就绪");
        });
    },
    [addNotice, closeApp, nextId, ready, runner, running, state]
  );

  const handleExit = useCallback(() => {
    const now = Date.now();
    if (now < exitArmedUntil.current) {
      closeApp();
      return;
    }
    exitArmedUntil.current = now + 1500;
    addNotice("再次按 Ctrl+C 退出", "warning");
  }, [addNotice, closeApp]);

  const handleInterrupt = useCallback(() => {
    addNotice("已请求中断。当前 runner 暂不支持硬中断，会在本轮完成后恢复输入。", "warning");
  }, [addNotice]);

  const visibleEntries = useMemo(() => entries.slice(-16), [entries]);
  const height = stdout.rows ?? 32;
  const transcriptHeight = Math.max(10, height - 8);

  return h(
    Box,
    { flexDirection: "column", minHeight: height },
    h(Header, { config, cwd, running }),
    h(MessageList, { entries: visibleEntries, height: transcriptHeight }),
    approval ? h(ApprovalPrompt, { request: approval.request }) : null,
    h(StatusBar, { status, running, ready }),
    h(Composer, {
      disabled: running || !ready,
      history,
      status,
      onSubmit: submit,
      onExit: handleExit,
      onInterrupt: handleInterrupt,
    })
  );
}

function ApprovalPrompt({ request }: { request: PermissionRequest }) {
  const color = request.risk === "high" ? "red" : request.risk === "medium" ? "yellow" : "blue";
  return h(
    Box,
    { flexDirection: "column", borderStyle: "double", borderColor: color, paddingX: 1, marginX: 1, marginBottom: 1 },
    h(Text, { color, bold: true }, `权限确认 · ${request.risk}`),
    h(Text, null, request.summary),
    h(Text, { dimColor: true }, "按 y 允许，n / Esc / Ctrl+C 拒绝")
  );
}

function Header({ config, cwd, running }: { config: AppConfig; cwd: string; running: boolean }) {
  return h(
    Box,
    { flexDirection: "column", borderStyle: "single", borderColor: running ? "yellow" : "green", paddingX: 1 },
    h(Text, { color: "greenBright", bold: true }, "欢迎奕航大神!"),
    h(Text, { dimColor: true }, `${describeConfig(config)}  ·  ${cwd}`)
  );
}

function MessageList({ entries, height }: { entries: Entry[]; height: number }) {
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

  const color = entry.tone === "error" ? "red" : entry.tone === "warning" ? "yellow" : "blue";
  return h(
    Box,
    { marginBottom: 1 },
    h(Text, { color }, entry.text)
  );
}

function ToolCard({ tool }: { tool: Extract<Entry, { kind: "tool" }> }) {
  const color = tool.status === "error" ? "red" : tool.status === "success" ? "green" : "yellow";
  const icon = tool.status === "running" ? "…" : tool.status === "success" ? "✓" : "✗";
  const output = tool.result || tool.chunks;
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: color, paddingX: 1, marginBottom: 1 },
    h(
      Text,
      { color, bold: true },
      `${icon} ${tool.name}${tool.status === "running" ? " running" : ""}`
    ),
    tool.args ? h(Text, { dimColor: true }, formatToolArgs(tool.args)) : null,
    output ? h(Text, { dimColor: tool.status !== "error", color: tool.status === "error" ? "red" : undefined }, truncate(output, 500)) : null
  );
}

function StatusBar({
  status,
  running,
  ready,
}: {
  status: string;
  running: boolean;
  ready: boolean;
}) {
  const idleColor = ready ? "gray" : "yellow";
  return h(
    Box,
    { paddingX: 1 },
    h(Text, { color: running ? "yellow" : idleColor }, running ? `● ${status}` : `○ ${status}`),
    h(Text, { dimColor: true }, "   Enter 发送 · Shift+Enter 换行 · ↑/↓ 历史 · Ctrl+C 退出")
  );
}

function Composer({ disabled, history, status, onSubmit, onExit, onInterrupt }: ComposerProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftBeforeHistory = useRef("");

  const setDraft = useCallback((next: string) => {
    setValue(next);
    setCursor(next.length);
  }, []);

  useInput((input, key) => {
    if (disabled) {
      if (key.ctrl && input === "c") onInterrupt();
      return;
    }

    if (key.ctrl && input === "c") {
      if (value) {
        setDraft("");
        setHistoryIndex(null);
      } else {
        onExit();
      }
      return;
    }

    if (key.ctrl && input === "d" && !value) {
      onExit();
      return;
    }

    if (key.return) {
      if (key.shift) {
        const next = value.slice(0, cursor) + "\n" + value.slice(cursor);
        setValue(next);
        setCursor(cursor + 1);
        return;
      }
      if (value.trim()) {
        onSubmit(value);
        setDraft("");
        setHistoryIndex(null);
      }
      return;
    }

    if (key.backspace) {
      if (cursor === 0) return;
      setValue(value.slice(0, cursor - 1) + value.slice(cursor));
      setCursor(cursor - 1);
      return;
    }

    if (key.delete) {
      if (cursor >= value.length) return;
      setValue(value.slice(0, cursor) + value.slice(cursor + 1));
      return;
    }

    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1));
      return;
    }

    if (key.home) {
      setCursor(0);
      return;
    }

    if (key.end) {
      setCursor(value.length);
      return;
    }

    if (key.upArrow) {
      if (history.length === 0) return;
      const nextIndex = historyIndex == null ? history.length - 1 : Math.max(0, historyIndex - 1);
      if (historyIndex == null) draftBeforeHistory.current = value;
      setHistoryIndex(nextIndex);
      setDraft(history[nextIndex] ?? "");
      return;
    }

    if (key.downArrow) {
      if (historyIndex == null) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(null);
        setDraft(draftBeforeHistory.current);
      } else {
        setHistoryIndex(nextIndex);
        setDraft(history[nextIndex] ?? "");
      }
      return;
    }

    if (key.escape) {
      setDraft("");
      setHistoryIndex(null);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const next = value.slice(0, cursor) + input + value.slice(cursor);
      setValue(next);
      setCursor(cursor + input.length);
      setHistoryIndex(null);
    }
  });

  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: disabled ? "gray" : "cyan", paddingX: 1 },
    h(Text, { dimColor: true }, disabled ? (status === "初始化中" ? "正在初始化，请稍候…" : `正在运行：${status}`) : "和 yihang cc 说下骚话～"),
    h(RenderInput, { value, cursor, disabled })
  );
}

function RenderInput({ value, cursor, disabled }: { value: string; cursor: number; disabled: boolean }) {
  const lines = value.split("\n");
  let seen = 0;
  return h(
    Box,
    { flexDirection: "column" },
    lines.map((line, index) => {
      const lineStart = seen;
      const lineEnd = seen + line.length;
      const cursorInLine = cursor >= lineStart && cursor <= lineEnd;
      const cursorCol = cursorInLine ? cursor - lineStart : -1;
      seen = lineEnd + 1;
      return h(
        Text,
        { key: index },
        h(Text, { color: disabled ? "gray" : "cyan" }, index === 0 ? "› " : "  "),
        cursorInLine ? renderLineWithCursor(line, cursorCol, disabled) : line
      );
    })
  );
}

function renderLineWithCursor(line: string, cursorCol: number, disabled: boolean) {
  const before = line.slice(0, cursorCol);
  const at = line[cursorCol] ?? " ";
  const after = line.slice(cursorCol + (line[cursorCol] ? 1 : 0));
  return [
    before,
    h(Text, { key: "cursor", inverse: !disabled }, at),
    after,
  ];
}

function MarkdownText({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  return h(
    Box,
    { flexDirection: "column" },
    blocks.map((block, index) => {
      if (block.type === "blank") return h(Text, { key: index }, "");
      if (block.type === "heading") {
        return h(Text, { key: index, color: block.level <= 2 ? "green" : "yellow", bold: true }, renderInline(block.text));
      }
      if (block.type === "quote") {
        return h(Text, { key: index, dimColor: true }, `│ ${block.text}`);
      }
      if (block.type === "list") {
        return h(Text, { key: index }, h(Text, { dimColor: true }, "• "), renderInline(block.text));
      }
      if (block.type === "hr") {
        return h(Text, { key: index, dimColor: true }, "─".repeat(48));
      }
      if (block.type === "code") {
        return h(
          Box,
          { key: index, flexDirection: "column", borderStyle: "single", borderColor: "gray", paddingX: 1 },
          block.lang ? h(Text, { dimColor: true }, block.lang) : null,
          ...block.lines.map((line, lineIndex) => h(Text, { key: lineIndex }, line || " "))
        );
      }
      return h(Text, { key: index }, renderInline(block.text));
    })
  );
}

type MarkdownBlock =
  | { type: "blank" }
  | { type: "heading"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; text: string }
  | { type: "hr" }
  | { type: "code"; lang: string; lines: string[] }
  | { type: "paragraph"; text: string };

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push({ type: "code", lang: fence[1] ?? "", lines: codeLines });
      continue;
    }

    if (!line.trim()) {
      blocks.push({ type: "blank" });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: "quote", text: quote[1] ?? "" });
      continue;
    }

    const list = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (list) {
      blocks.push({ type: "list", text: list[1] ?? "" });
      continue;
    }

    blocks.push({ type: "paragraph", text: line });
  }
  return blocks;
}

function renderInline(text: string) {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(h(Text, { key: parts.length, color: "yellow" }, token.slice(1, -1)));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      parts.push(h(Text, { key: parts.length, bold: true }, token.slice(2, -2)));
    } else {
      parts.push(h(Text, { key: parts.length, dimColor: true }, token.slice(1, -1)));
    }
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function updateLastRunningTool(
  entries: Entry[],
  updater: (tool: Extract<Entry, { kind: "tool" }>) => Entry
): Entry[] {
  const next = [...entries];
  for (let i = next.length - 1; i >= 0; i--) {
    const entry = next[i];
    if (entry?.kind === "tool" && entry.status === "running") {
      next[i] = updater(entry) as Entry;
      break;
    }
  }
  return next;
}

function describeConfig(config: AppConfig): string {
  if (config.provider === "cursor") {
    const runtime = config.runtime === "cloud" ? `cloud · ${config.repoUrl ?? "未配置仓库"}` : "local";
    return `cursor · ${config.model} · ${runtime}`;
  }
  return `openai · ${config.model}`;
}

function formatToolArgs(raw: string): string {
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

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max) + " …";
}
