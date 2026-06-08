import React from "react";
import { Box, Text } from "ink";

/**
 * 极简 Markdown 渲染（终端版）。
 *
 * 模型回复常带 Markdown，但终端没有富文本；这里手写一个够用的子集解析器，
 * 把内容拆成块（标题 / 引用 / 列表 / 代码块 / 段落）再用 ink 的 Text 着色。
 * 单独成文件是因为解析与渲染逻辑自成体系，与聊天编排无关，
 * 放在一起会让主组件被大量正则和分支淹没。
 */

const h = React.createElement;

type MarkdownBlock =
  | { type: "blank" }
  | { type: "heading"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; text: string }
  | { type: "hr" }
  | { type: "code"; lang: string; lines: string[] }
  | { type: "paragraph"; text: string };

export function MarkdownText({
  content,
}: {
  content: string;
}): React.ReactElement {
  const blocks = parseMarkdownBlocks(content);
  return h(
    Box,
    { flexDirection: "column" },
    blocks.map((block, index) => {
      if (block.type === "blank") return h(Text, { key: index }, "");
      if (block.type === "heading") {
        return h(
          Text,
          { key: index, color: block.level <= 2 ? "green" : "yellow", bold: true },
          renderInline(block.text)
        );
      }
      if (block.type === "quote") {
        return h(Text, { key: index, dimColor: true }, `│ ${block.text}`);
      }
      if (block.type === "list") {
        return h(
          Text,
          { key: index },
          h(Text, { dimColor: true }, "• "),
          renderInline(block.text)
        );
      }
      if (block.type === "hr") {
        return h(Text, { key: index, dimColor: true }, "─".repeat(48));
      }
      if (block.type === "code") {
        return h(
          Box,
          {
            key: index,
            flexDirection: "column",
            borderStyle: "single",
            borderColor: "gray",
            paddingX: 1,
          },
          block.lang ? h(Text, { dimColor: true }, block.lang) : null,
          ...block.lines.map((line, lineIndex) =>
            h(Text, { key: lineIndex }, line || " ")
          )
        );
      }
      return h(Text, { key: index }, renderInline(block.text));
    })
  );
}

/**
 * 把 Markdown 文本切成块。
 *
 * 采用逐行扫描而非完整 AST：终端展示对结构精度要求不高，
 * 逐行状态机足够覆盖代码围栏、标题、列表等常见块，且实现成本极低。
 */
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
      blocks.push({
        type: "heading",
        level: heading[1]?.length ?? 1,
        text: heading[2] ?? "",
      });
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

/**
 * 渲染行内强调（代码 / 粗体 / 斜体）。
 *
 * 用单个正则一次切出所有强调标记，再按标记类型着色；
 * 比逐字符解析简单，也避免嵌套强调带来的状态机复杂度。
 */
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
