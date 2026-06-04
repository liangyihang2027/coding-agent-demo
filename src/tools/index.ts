import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { runCommandTool } from "./run-command.js";
import { listDirectoryTool } from "./list-directory.js";
import { globFilesTool } from "./glob-files.js";
import { grepTool } from "./grep.js";
import { deleteFileTool } from "./delete-file.js";
import { editFileTool } from "./edit-file.js";

/** 创建并注册默认工具集 */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listDirectoryTool)
    .register(globFilesTool)
    .register(grepTool)
    .register(deleteFileTool)
    .register(runCommandTool);
}

export { ToolRegistry };
