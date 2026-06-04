import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

/** 终端是否支持 ANSI（含 NO_COLOR 约定） */
export function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return stdout.isTTY === true;
}

type StyleFn = (s: string) => string;

function makeStyles(enabled: boolean) {
  const wrap =
    (open: string, close = "\x1b[0m"): StyleFn =>
    (s) =>
      enabled ? `${open}${s}${close}` : s;

  return {
    dim: wrap("\x1b[2m\x1b[90m"),
    green: wrap("\x1b[32m"),
    brightGreen: wrap("\x1b[1m\x1b[92m"),
    yellow: wrap("\x1b[33m"),
    red: wrap("\x1b[31m"),
  };
}

export type Styles = ReturnType<typeof makeStyles>;

/** 输入行底色：尽量贴近终端默认背景，仅轻微区分 */
const RESET = "\x1b[0m";

/** 单轮对话的终端渲染 */
export class TurnUI {
  readonly s: Styles;
  private readonly color: boolean;
  private toolStreamOpen = false;
  private assistantBuffer = "";

  constructor(enabled = supportsColor()) {
    this.color = enabled;
    this.s = makeStyles(enabled);
  }

  printWelcome(meta: string[], hint: string): void {
    const { s } = this;
    stdout.write("\n");
    for (const line of meta) {
      stdout.write(s.brightGreen(line) + "\n");
    }
    stdout.write(s.dim(hint) + "\n\n");
  }

  inputPrompt(): string {
    return this.s.dim("› ");
  }

  /** 读取用户输入；TTY 下整行保持浅灰底，回车后不重绘已输入内容 */
  async readUserInput(): Promise<string> {
    if (stdin.isTTY && this.color) {
      return readStyledLine(this.s.dim("› "), RESET);
    }
    return readPlainLine(this.inputPrompt());
  }

  /** 助手正文：先缓冲，turn 结束时统一做 Markdown 终端渲染 */
  writeAssistant(delta: string): void {
    this.assistantBuffer += delta;
  }

  showToolCall(name: string, args: string): void {
    this.closeToolStream();
    const preview = formatToolArgs(args);
    stdout.write(
      "\n" + this.s.dim(`⚙ ${name}${preview ? `  ${preview}` : ""}`) + "\n"
    );
  }

  showToolResult(content: string, isError: boolean): void {
    const icon = isError ? this.s.red("✗") : this.s.green("✓");
    const preview = truncate(content, 600);
    const body = preview.replace(/\n/g, "\n  ");
    stdout.write(`  ${icon} ${this.s.dim(body)}\n`);
  }

  writeToolChunk(chunk: string): void {
    if (!chunk) return;
    if (!this.toolStreamOpen) {
      stdout.write(this.s.dim("  │ "));
      this.toolStreamOpen = true;
    }
    stdout.write(chunk);
  }

  private closeToolStream(): void {
    if (this.toolStreamOpen) {
      stdout.write("\n");
      this.toolStreamOpen = false;
    }
  }

  showMaxSteps(max: number): void {
    this.closeToolStream();
    stdout.write("\n" + this.s.red(`[已达到 step 上限 ${max}，强制停止]`) + "\n");
  }

  showError(message: string): void {
    this.closeToolStream();
    stdout.write("\n" + this.s.red(`出错: ${message}`) + "\n");
  }

  endTurn(): void {
    this.closeToolStream();
    this.flushAssistant();
    stdout.write("\n");
  }

  farewell(): void {
    stdout.write(this.s.dim("\n再见。\n"));
  }

  private flushAssistant(): void {
    if (!this.assistantBuffer) return;
    const rendered = renderMarkdown(this.assistantBuffer, this.s);
    stdout.write(rendered.endsWith("\n") ? rendered : rendered + "\n");
    this.assistantBuffer = "";
  }
}

function readPlainLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function readStyledLine(prompt: string, reset: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      stdin.removeListener("keypress", onKeypress);
      if (stdin.isTTY) stdin.setRawMode(false);
    };

    const render = () => {
      const width = stdout.columns || 80;
      const line = `${prompt}${value}`;
      const clipped = line.length > width ? line.slice(0, width) : line;
      stdout.write(`\r\x1b[2K${clipped}${reset}`);
    };

    const finish = (answer: string) => {
      cleanup();
      stdout.write("\n\n");
      resolve(answer);
    };

    const onKeypress = (
      str: string | undefined,
      key: readline.Key
    ): void => {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        cleanup();
        stdout.write("\n");
        reject(new Error("SIGINT"));
        return;
      }

      if (key.name === "return") {
        finish(value);
        return;
      }

      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
        render();
        return;
      }

      if (str && !key.ctrl && !key.meta) {
        value += str;
        render();
      }
    };

    readline.emitKeypressEvents(stdin);
    if (!stdin.isTTY) {
      reject(new Error("stdin is not a TTY"));
      return;
    }
    stdin.setRawMode(true);
    render();
    stdin.on("keypress", onKeypress);
  });
}

function formatToolArgs(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const val =
        typeof v === "string"
          ? v.length > 48
            ? v.slice(0, 45) + "…"
            : v
          : JSON.stringify(v);
      parts.push(`${k}=${JSON.stringify(val)}`);
    }
    return parts.join("  ");
  } catch {
    return trimmed.length > 72 ? trimmed.slice(0, 69) + "…" : trimmed;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + " …";
}

function renderMarkdown(markdown: string, s: Styles): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const rendered: string[] = [];
  let inCodeFence = false;
  let codeFenceLang = "";

  for (const line of lines) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      inCodeFence = !inCodeFence;
      codeFenceLang = inCodeFence ? fence[1] ?? "" : "";
      rendered.push(
        s.dim(inCodeFence ? `┌─ ${codeFenceLang || "code"}` : "└─")
      );
      continue;
    }

    if (inCodeFence) {
      rendered.push(s.dim("│ ") + line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const title = renderInline(heading[2] ?? "", s);
      rendered.push(level <= 2 ? s.green(title) : s.yellow(title));
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      rendered.push(s.dim("─".repeat(Math.min(stdout.columns || 80, 80))));
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      rendered.push(s.dim("│ ") + renderInline(quote[1] ?? "", s));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      rendered.push(`${bullet[1] ?? ""}${s.dim("•")} ${renderInline(bullet[2] ?? "", s)}`);
      continue;
    }

    const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (ordered) {
      rendered.push(`${ordered[1] ?? ""}${s.dim("•")} ${renderInline(ordered[2] ?? "", s)}`);
      continue;
    }

    rendered.push(renderInline(line, s));
  }

  return rendered.join("\n");
}

function renderInline(text: string, s: Styles): string {
  return text
    .replace(/`([^`]+)`/g, (_match, code: string) => s.yellow(code))
    .replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => s.green(bold))
    .replace(/__([^_]+)__/g, (_match, bold: string) => s.green(bold))
    .replace(/\*([^*]+)\*/g, (_match, emph: string) => s.dim(emph))
    .replace(/_([^_]+)_/g, (_match, emph: string) => s.dim(emph));
}
