import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import type { AppConfig } from "./config.js";
import type { AgentRunner } from "../agent/runner.js";
import type { ConversationState } from "../agent/state.js";
import { formatAgentPhase } from "../agent/phases.js";
import type { Entry, PendingApproval } from "./codex/entries.js";
import { updateLastRunningTool } from "./codex/entries.js";
import {
  ApprovalPrompt,
  Header,
  MessageList,
  StatusBar,
} from "./codex/components.js";
import { Composer } from "./codex/composer.js";

/**
 * Codex 风格聊天主组件。
 *
 * 这里只负责"状态怎么流转"：把一次用户提交驱动的 runner 事件流
 * （文本增量 / 工具调用 / 权限确认 / 结束）翻译成对 Entry 列表的更新，
 * 再交给纯展示组件渲染。视图、输入编辑、Markdown 渲染、格式化都已拆到
 * ./codex/* 下，让这个文件聚焦编排而非细节。
 */

interface CodexLikeAppProps {
  runner: AgentRunner;
  state: ConversationState;
  config: AppConfig;
  cwd: string;
  /** CLI 入口已发起的预热；UI 挂载后继续等待，就绪后才允许提交。 */
  warmupPromise?: Promise<void>;
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
