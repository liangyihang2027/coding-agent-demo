import React, { useCallback, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

/**
 * 多行输入编辑器。
 *
 * 自己实现一个带光标 / 历史 / 多行的输入框，而不用现成的 ink 输入组件，
 * 是因为需要精确控制按键语义（Shift+Enter 换行、Enter 提交、↑/↓ 翻历史、
 * Ctrl+C 两段式退出）。这部分按键状态机自成一体，与聊天编排无关，
 * 单独成文件可以让主组件不被一长串 useInput 分支占据。
 */

const h = React.createElement;

export interface ComposerProps {
  disabled: boolean;
  history: string[];
  status: string;
  onSubmit: (value: string) => void;
  onExit: () => void;
  onInterrupt: () => void;
}

export function Composer({
  disabled,
  history,
  status,
  onSubmit,
  onExit,
  onInterrupt,
}: ComposerProps): React.ReactElement {
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
      const nextIndex =
        historyIndex == null ? history.length - 1 : Math.max(0, historyIndex - 1);
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
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: disabled ? "gray" : "cyan",
      paddingX: 1,
    },
    h(
      Text,
      { dimColor: true },
      disabled
        ? status === "初始化中"
          ? "正在初始化，请稍候…"
          : `正在运行：${status}`
        : "和 yihang cc 说下骚话～"
    ),
    h(RenderInput, { value, cursor, disabled })
  );
}

/** 把输入文本按行渲染，并在光标所在行画出反显光标。 */
function RenderInput({
  value,
  cursor,
  disabled,
}: {
  value: string;
  cursor: number;
  disabled: boolean;
}) {
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
  return [before, h(Text, { key: "cursor", inverse: !disabled }, at), after];
}
