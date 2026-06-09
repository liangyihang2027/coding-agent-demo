import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodebaseIndex } from "../src/search/index.js";
import { collectFiles } from "../src/search/walk.js";

/**
 * ⭐ 阶段 4 端到端检索用例：在临时仓库上建索引 + 召回。
 * 覆盖：.gitignore 过滤、BM25 召回正确文件、符号加权、token 预算裁剪。
 */
describe("CodebaseIndex (e2e)", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-mini-search-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "junk"), { recursive: true });

    await fs.writeFile(
      path.join(root, "src", "auth.ts"),
      [
        "export function authenticateUser(token: string) {",
        "  return verifyToken(token);",
        "}",
        "function verifyToken(t: string) { return t.length > 0; }",
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "src", "db.ts"),
      [
        "export function openConnection(url: string) {",
        "  return connectPool(url);",
        "}",
      ].join("\n")
    );
    await fs.writeFile(
      path.join(root, "README.md"),
      "# demo project\nsome unrelated prose about widgets"
    );
    // 应被 .gitignore 排除
    await fs.writeFile(path.join(root, "secret.env"), "authenticateUser=should-not-index");
    await fs.writeFile(path.join(root, ".gitignore"), "*.env\n");
    // 应被默认忽略
    await fs.writeFile(
      path.join(root, "node_modules", "junk", "index.js"),
      "function authenticateUser() {}"
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("遍历遵守 .gitignore 与默认忽略", async () => {
    const { files } = await collectFiles(root);
    expect(files).toContain("src/auth.ts");
    expect(files).toContain("src/db.ts");
    expect(files).toContain("README.md");
    expect(files).not.toContain("secret.env");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("按意图召回最相关的文件", async () => {
    const idx = await CodebaseIndex.build(root);
    const hits = await idx.query("authenticate user token");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.file).toBe("src/auth.ts");
    // 命中行应指向定义/使用 token 的行，片段含标记
    expect(hits[0]!.snippet).toContain("authenticateUser");
  });

  it("不同意图召回不同文件（符号加权生效）", async () => {
    const idx = await CodebaseIndex.build(root);
    const hits = await idx.query("open database connection");
    expect(hits[0]!.file).toBe("src/db.ts");
  });

  it("token 预算裁剪：极小预算下只返回最相关的一条", async () => {
    const idx = await CodebaseIndex.build(root);
    const hits = await idx.queryWith("function", {
      limit: 10,
      tokenBudget: 1,
    });
    expect(hits.length).toBe(1);
  });

  it("被忽略文件的内容不进索引（搜不到 secret.env 里的符号）", async () => {
    const idx = await CodebaseIndex.build(root);
    const stats = idx.getStats();
    expect(stats.files).toBe(4); // auth.ts, db.ts, README.md, .gitignore（secret.env 与 node_modules 被排除）
    const hits = await idx.query("authenticateUser");
    expect(hits.every((h) => h.file !== "secret.env")).toBe(true);
  });
});
