import path from "node:path";

/** 将用户路径解析为绝对路径，并确保落在工作目录内（防 ../ 逃逸） */
export function resolvePathInCwd(cwd: string, userPath: string): string {
  const base = path.resolve(cwd);
  const abs = path.resolve(base, userPath || ".");
  const rel = path.relative(base, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界工作目录: ${userPath}`);
  }
  return abs;
}
