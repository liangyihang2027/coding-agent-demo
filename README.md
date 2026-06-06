# claude-mini

从零复刻 Claude Code 单 Agent 的**工程内核**（TypeScript 学习项目）。

> 目标不是"再做一个能跑的 Agent"，而是把 coding agent 的工程内核亲手实现一遍——
> 模型只是其中一环。详见 `Claude-Code-复刻-项目蓝图.md`。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
pnpm dev               # 启动 CLI
```

CLI 内输入需求即可，`/exit` 退出。

```bash
pnpm typecheck   # 类型检查
pnpm test        # 跑单测（vitest）
```

## 架构

```
CLI 入口 → Agent Loop(ReAct) → { LLM客户端 / 上下文管理⭐ / 工具注册表 / 权限闸门 }
                                          └ 工具 → { Diff⭐ / 沙箱⭐ / 检索⭐ }
```

## 模块状态

| 模块 | 路径 | 阶段 | 状态 |
|---|---|---|---|
| LLM 流式客户端 + tool_calls 拼接 | `src/llm/` | 1 | ✅ 已实现 |
| 工具注册表 + zod 校验 | `src/tools/registry.ts` | 1 | ✅ 已实现 |
| 基础工具 read/write/edit/list/glob/grep/delete/run | `src/tools/*.ts` | 1 | ✅ 已实现 |
| Agent Loop / 会话状态 | `src/agent/` | 1 | ✅ 已实现 |
| CLI 入口 | `src/cli/` | 1 | ✅ 已实现 |
| **Diff / Patch 引擎** ⭐ | `src/diff/` | 2 | 🟨 基础可靠版（唯一匹配 + 行尾/空白容忍） |
| **沙箱 / 命令执行** ⭐ | `src/sandbox/` | 3 | ⬜ 仅占位（naive 版） |
| **代码库检索** ⭐ | `src/search/` | 4 | ⬜ 待你实现 |
| **上下文管理** ⭐ | `src/context/` | 5 | ⬜ 待你实现 |
| 权限 / 审批闸门 | `src/permission/` | 6 | ✅ 最小版（分级 + y/n + AgentLoop 接入） |

⭐ = 必须亲手实现、禁止调库的灵魂模块。

## 设计取舍 / 踩坑复盘

> 在这里持续记录每个模块"为什么这么设计"以及踩过的坑——这是面试时的弹药。

- （示例）流式 tool_calls 为何用 index 做主键而非 id：见 `src/llm/tool-call-assembler.ts` 注释。
- Diff 阶段先围绕 `old_string -> new_string` 做可靠局部编辑：精确匹配优先，失败后才尝试行尾归一化和轻量空白容忍；任何非唯一命中都返回 ambiguous，不让模型猜位置。
- `edit_file` 写入前保留原内容，写入失败时尝试回滚。完整 unified diff / Myers diff 与通用行级 patch parser 仍留作阶段 2 后续扩展。
