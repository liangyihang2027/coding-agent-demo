/**
 * 文件遍历（检索的「数据来源」）。
 *
 * 职责：从仓库根递归收集「值得进索引」的文本文件路径，沿途用 IgnoreMatcher 过滤。
 * 设计取向：
 *   - 逐目录读取 .gitignore，深层规则覆盖浅层（IgnoreMatcher 的不可变 add 实现分叉）。
 *   - 默认硬忽略 .git；二进制后缀与超大文件直接跳过，避免污染倒排索引、撑爆内存。
 *   - 用 maxFiles 兜底，防止误指向 home 目录这种极端情况把进程拖死。
 */

import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { IgnoreMatcher } from "./gitignore.js";

/** 常见二进制 / 不可读后缀，直接跳过（小写，带点）。 */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".flac", ".ogg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".wasm",
  ".lock", ".bin", ".dat", ".db", ".sqlite",
]);

/** 默认忽略：始终跳过 .git 内部；node_modules 多数仓库已在 .gitignore，这里兜底。 */
const DEFAULT_IGNORE = [".git/", "node_modules/"];

export interface WalkOptions {
  /** 最多收集多少文件，超出即截断（默认 5000） */
  maxFiles?: number;
  /** 单文件最大字节数，超出跳过（默认 512KB） */
  maxFileBytes?: number;
  /** 追加的忽略模式（相对根锚定） */
  extraIgnore?: string[];
}

export interface WalkResult {
  /** 相对仓库根、用 / 分隔的文件路径，已排序 */
  files: string[];
  /** 是否因 maxFiles 截断 */
  truncated: boolean;
}

/** 递归收集仓库内的文本文件路径。 */
export async function collectFiles(
  root: string,
  opts: WalkOptions = {}
): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxFileBytes = opts.maxFileBytes ?? 512 * 1024;

  const baseIgnore = new IgnoreMatcher()
    .addPatterns(DEFAULT_IGNORE)
    .addPatterns(opts.extraIgnore ?? []);

  const files: string[] = [];
  let truncated = false;

  const walk = async (dir: string, ignore: IgnoreMatcher): Promise<void> => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }

    // 进入目录时叠加本目录的 .gitignore（深层覆盖浅层）。
    const relDir = toRel(root, dir);
    const gitignore = await readGitignore(path.join(dir, ".gitignore"));
    const localIgnore = gitignore ? ignore.add(gitignore, relDir) : ignore;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, ent.name);
      const rel = toRel(root, full);

      if (ent.isDirectory()) {
        if (localIgnore.ignores(rel, true)) continue;
        await walk(full, localIgnore);
      } else if (ent.isFile()) {
        if (BINARY_EXT.has(path.extname(ent.name).toLowerCase())) continue;
        if (localIgnore.ignores(rel, false)) continue;
        try {
          const st = await fs.stat(full);
          if (st.size > maxFileBytes || st.size === 0) continue;
        } catch {
          continue;
        }
        files.push(rel);
      }
    }
  };

  await walk(root, baseIgnore);
  files.sort();
  return { files, truncated };
}

/** 读取 .gitignore 内容；不存在返回 null。 */
async function readGitignore(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** 绝对路径转成相对根、用 / 分隔的形式。 */
function toRel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join("/");
}
