import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { OpenAIClient } from "../llm/client.js";
import { createDefaultRegistry } from "../tools/index.js";
import { AgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/state.js";

const SYSTEM_PROMPT = `你是 claude-mini，一个运行在用户终端里的编码助手。
你可以通过工具读写文件、执行命令来完成用户的编程任务。
原则：
- 需要了解文件内容时先用 read_file，不要凭空猜测。
- 修改文件用 write_file；执行命令用 run_command。
- 完成任务后用简洁的自然语言总结你做了什么。
- 当前工作目录就是用户启动 CLI 的目录。`;

// 简易 ANSI 颜色
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(c.red((err as Error).message));
    process.exit(1);
  }

  const llm = new OpenAIClient(config);
  const tools = createDefaultRegistry();
  const cwd = process.cwd();
  const agent = new AgentLoop({ llm, tools, cwd });
  const state = new ConversationState(SYSTEM_PROMPT);

  console.log(c.cyan("claude-mini") + c.dim(`  (model: ${config.model})`));
  console.log(c.dim(`cwd: ${cwd}`));
  console.log(c.dim("输入你的需求，/exit 退出。\n"));

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    const input = (await rl.question(c.green("› "))).trim();
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;

    try {
      await agent.run(state, input, {
        onText: (delta) => stdout.write(delta),
        onToolCall: (call) =>
          console.log(
            "\n" + c.yellow(`⚙ ${call.name}`) + c.dim(` ${call.arguments}`)
          ),
        onToolResult: (_call, content, isError) => {
          const preview =
            content.length > 500 ? content.slice(0, 500) + " …" : content;
          console.log(
            (isError ? c.red("  ✗ ") : c.dim("  ✓ ")) +
              c.dim(preview.replace(/\n/g, "\n    "))
          );
        },
        onMaxSteps: (max) =>
          console.log(c.red(`\n[已达到 step 上限 ${max}，强制停止]`)),
      });
      stdout.write("\n\n");
    } catch (err) {
      console.error(c.red(`\n出错: ${(err as Error).message}\n`));
    }
  }

  rl.close();
  console.log(c.dim("再见。"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
