import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createRunner } from "./create-runner.js";
import { Store } from "../storage/index.js";
import { ConversationState } from "../agent/state.js";
import { loadSystemPrompt } from "../prompts/load-system-prompt.js";
import { formatAgentPhase } from "../agent/phases.js";
import type { AgentPhase } from "../agent/phases.js";

interface BenchOptions {
  noWarmup: boolean;
  skipRun: boolean;
  prompt: string;
}

interface BenchRow {
  label: string;
  ms: number;
}

function parseBenchArgs(args: string[]): BenchOptions {
  const promptIdx = args.indexOf("--prompt");
  const prompt =
    promptIdx >= 0 && args[promptIdx + 1] ?
      args[promptIdx + 1]!
    : "Reply with exactly: pong";

  return {
    noWarmup: args.includes("--no-warmup"),
    skipRun: args.includes("--skip-run"),
    prompt,
  };
}

function padLabel(label: string, width: number): string {
  return label.padEnd(width, " ");
}

export async function runBenchFirstMessage(
  cwd: string,
  args: string[] = []
): Promise<void> {
  const opts = parseBenchArgs(args);
  const config = loadConfig();
  const rows: BenchRow[] = [];

  const mark = (label: string, fn: () => void): void => {
    const t0 = performance.now();
    fn();
    rows.push({ label, ms: performance.now() - t0 });
  };

  const amark = async (label: string, fn: () => Promise<void>): Promise<void> => {
    const t0 = performance.now();
    await fn();
    rows.push({ label, ms: performance.now() - t0 });
  };

  mark("loadConfig", () => loadConfig());

  const storeOpenT0 = performance.now();
  const store = new Store(cwd);
  rows.push({ label: "store(open+migrate)", ms: performance.now() - storeOpenT0 });

  const runner = await createRunner(config, cwd);

  mark("prepareSession(new)", () => {
    const id = randomUUID();
    store.sessions.createSession({ id, cwd });
    const state = new ConversationState(loadSystemPrompt());
    state.bindStore(store.sessions, id, { persistExisting: true });
  });

  if (runner.warmup && !opts.noWarmup) {
    await amark("runner.warmup(connecting)", () => runner.warmup!());
  }

  if (!opts.skipRun) {
    const state = new ConversationState(loadSystemPrompt());
    const phases: Array<{ phase: AgentPhase; ms: number }> = [];
    const t0 = performance.now();
    let firstTokenMs: number | null = null;

    try {
      await runner.run(state, opts.prompt, {
        onPhase: (phase) => {
          phases.push({ phase, ms: performance.now() - t0 });
        },
        onText: (delta) => {
          if (firstTokenMs == null && delta) {
            firstTokenMs = performance.now() - t0;
          }
        },
      });
    } catch (err) {
      console.error(`firstMessage ERROR: ${(err as Error).message}`);
    } finally {
      await runner.close?.();
    }

    for (const { phase, ms } of phases) {
      rows.push({ label: `phase:${phase}`, ms });
    }
    if (firstTokenMs != null) {
      rows.push({ label: "firstMessage(TTFT)", ms: firstTokenMs });
    }
  } else {
    await runner.close?.();
  }

  store.close();

  console.log(`provider: ${config.provider}  model: ${config.model}`);
  if (opts.noWarmup) console.log("mode: no-warmup");
  if (opts.skipRun) console.log("mode: skip-run (startup only, no API call)");
  console.log("");

  const labelWidth = Math.max(...rows.map((r) => r.label.length), 8);
  console.log(`${padLabel("phase", labelWidth)}  ms`);
  console.log(`${"-".repeat(labelWidth + 6)}`);
  for (const row of rows) {
    const display =
      row.label.startsWith("phase:") ?
        `  ${formatAgentPhase(row.label.slice("phase:".length) as AgentPhase)}`
      : row.label;
    console.log(`${padLabel(display, labelWidth)}  ${row.ms.toFixed(1)}`);
  }
}
