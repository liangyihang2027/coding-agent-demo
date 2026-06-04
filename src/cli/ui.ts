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
    yellow: wrap("\x1b[33m"),
    red: wrap("\x1b[31m"),
  };
}

export type Styles = ReturnType<typeof makeStyles>;

/** 输入行底色：尽量贴近终端默认背景，仅轻微区分 */
const INPUT_BG = "\x1b[48;5;254m";
const INPUT_FG = "\x1b[39m";
const RESET = "\x1b[0m";

/** 单轮对话的终端渲染 */
export class TurnUI {
  readonly s: Styles;
  private readonly color: boolean;
  private toolStreamOpen = false;

  constructor(enabled = supportsColor()) {
    this.color = enabled;
    this.s = makeStyles(enabled);
  }

  printWelcome(meta: string[], hint: string): void {
    const { s } = this;
    stdout.write("\n");
    for (const line of meta) {
      stdout.write(s.dim(line) + "\n");
    }
    stdout.write(s.dim(hint) + "\n\n");
  }

  inputPrompt(): string {
    return this.s.dim("› ");
  }

  /** 读取用户输入；TTY 下整行保持浅灰底，回车后不重绘已输入内容 */
  async readUserInput(): Promise<string> {
    if (stdin.isTTY && this.color) {
      return readStyledLine(INPUT_BG, INPUT_FG, RESET);
    }
    return readPlainLine(this.inputPrompt());
  }

  /** 助手正文：原样输出，不加标题、不缩进 */
  writeAssistant(delta: string): void {
    if (delta) stdout.write(delta);
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
    stdout.write("\n");
  }

  farewell(): void {
    stdout.write(this.s.dim("\n再见。\n"));
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

function readStyledLine(bg: string, fg: string, reset: string): Promise<string> {
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
      const line = ` › ${value}`;
      const clipped = line.length > width ? line.slice(0, width) : line;
      stdout.write(`\r\x1b[2K${bg}${fg}${clipped}${reset}`);
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
