import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 在 dynamic import @cursor/sdk 之前调用。
 * SDK 在模块加载时读取 CURSOR_RIPGREP_PATH（必须是绝对路径），
 * 用于解析 .gitignore / .cursorignore。
 */
export function bootstrapCursorSdkEnv(): void {
  const existing = process.env.CURSOR_RIPGREP_PATH?.trim();
  if (existing && path.isAbsolute(existing)) return;

  const rgPath = findOnPath() ?? findBundledRg();
  if (!rgPath) {
    console.warn(
      "[claude-mini] 未找到 ripgrep (rg)。可执行 brew install ripgrep，" +
        "或在 .env 中设置 CURSOR_RIPGREP_PATH=/绝对路径/rg"
    );
    return;
  }

  process.env.CURSOR_RIPGREP_PATH = rgPath;
}

function findOnPath(): string | undefined {
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.resolve(dir, exe);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function findBundledRg(): string | undefined {
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPkg = `@cursor/sdk-${process.platform}-${process.arch}`;
  const pnpmPrefix = `@cursor+sdk-${process.platform}-${process.arch}@`;

  for (const root of collectSearchRoots()) {
    const flat = path.join(root, "node_modules", platformPkg, "bin", exe);
    if (isExecutable(flat)) return path.resolve(flat);

    const pnpmDir = path.join(root, "node_modules", ".pnpm");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(pnpmDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith(pnpmPrefix)) continue;
      const candidate = path.join(
        pnpmDir,
        entry,
        "node_modules",
        platformPkg,
        "bin",
        exe
      );
      if (isExecutable(candidate)) return path.resolve(candidate);
    }
  }

  return undefined;
}

function collectSearchRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  const startDirs = [
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
    path.dirname(process.argv[1] ?? ""),
  ];

  for (const start of startDirs) {
    if (!start) continue;
    let dir = path.resolve(start);
    while (!seen.has(dir)) {
      seen.add(dir);
      roots.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return roots;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
