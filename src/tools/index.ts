import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { runCommandTool } from "./run-command.js";

/** 创建并注册阶段 1 的基础工具集 */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(writeFileTool)
    .register(runCommandTool);
}

export { ToolRegistry };
