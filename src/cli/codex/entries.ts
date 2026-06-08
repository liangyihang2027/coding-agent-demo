import type { PermissionRequest } from "../../permission/types.js";

/**
 * 会话可展示单元（Entry）的数据模型与纯数据操作。
 *
 * Entry 是 UI 的唯一渲染来源：编排层只往里追加 / 更新 Entry，
 * 组件层只负责把 Entry 画出来。把类型和数据操作从渲染中剥离，
 * 让"状态怎么变"和"界面怎么画"可以分别演进与推理。
 */

export type Entry =
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
  | {
      id: string;
      kind: "notice";
      text: string;
      tone: "info" | "warning" | "error";
    };

/** 一次待用户确认的权限请求，连同用于回传结果的 resolve。 */
export interface PendingApproval {
  request: PermissionRequest;
  resolve: (allowed: boolean) => void;
}

/**
 * 把最近一个 running 状态的工具 Entry 就地更新（用于回填流式 chunk）。
 *
 * 工具输出是边执行边来的，只能定位到"最后一个还在运行的工具"。
 * 从尾部向前找而非按 callId 匹配，是因为 chunk 事件不携带 callId，
 * 只能依赖"当前正在运行的就是最后那个"这一时序约束。
 */
export function updateLastRunningTool(
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
