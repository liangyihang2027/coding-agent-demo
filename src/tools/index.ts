import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { runCommandTool } from "./run-command.js";
import { listDirectoryTool } from "./list-directory.js";
import { globFilesTool } from "./glob-files.js";
import { grepTool } from "./grep.js";
import { codebaseSearchTool } from "./codebase-search.js";
import { deleteFileTool } from "./delete-file.js";
import { editFileTool } from "./edit-file.js";

/**
 * 创建并注册默认工具集。
 *
 * 阶段一需要的是“能形成闭环”的最小能力：读、写、局部编辑、目录/搜索、删除和命令执行。
 * 更复杂的 Diff、Sandbox、Search 内核会藏在各工具背后的模块里升级，而不是改变 AgentLoop。
 */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listDirectoryTool)
    .register(globFilesTool)
    .register(grepTool)
    .register(codebaseSearchTool)
    .register(deleteFileTool)
    .register(runCommandTool);
}

export { ToolRegistry };
