/** Agent 运行阶段；供 CLI 展示细粒度状态，区分本地初始化与模型等待。 */
export type AgentPhase = "connecting" | "requesting" | "waiting_model";

export const AGENT_PHASE_LABELS: Record<AgentPhase, string> = {
  connecting: "连接 Agent",
  requesting: "发送请求",
  waiting_model: "等待模型",
};

export function formatAgentPhase(phase: AgentPhase): string {
  return AGENT_PHASE_LABELS[phase];
}
