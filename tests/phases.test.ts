import { describe, it, expect } from "vitest";
import { AGENT_PHASE_LABELS, formatAgentPhase } from "../src/agent/phases.js";

describe("formatAgentPhase", () => {
  it("maps each phase to a human-readable label", () => {
    expect(formatAgentPhase("connecting")).toBe(AGENT_PHASE_LABELS.connecting);
    expect(formatAgentPhase("requesting")).toBe(AGENT_PHASE_LABELS.requesting);
    expect(formatAgentPhase("waiting_model")).toBe(AGENT_PHASE_LABELS.waiting_model);
  });
});
