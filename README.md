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
| 语义检索工具 codebase_search | `src/tools/codebase-search.ts` | 4 | ✅ 已实现 |
| Agent Loop / 会话状态 | `src/agent/` | 1 | ✅ 已实现 |
| CLI 入口 | `src/cli/` | 1 | ✅ 已实现 |
| **Diff / Patch 引擎** ⭐ | `src/diff/` | 2 | ✅ 已实现（str_replace 三级匹配 + 手写 Myers diff + unified diff 生成 + 行级 patch apply 原子回滚） |
| **沙箱 / 命令执行** ⭐ | `src/sandbox/` | 3 | ✅ 已实现（进程组 kill / SIGTERM→SIGKILL 升级 / 危险命令硬拦截 / 输出截断 / env 白名单 / 流式捕获） |
| **代码库检索** ⭐ | `src/search/` | 4 | ✅ 已实现（遍历+.gitignore / 倒排索引+BM25 / tree-sitter 符号 / token 预算裁剪） |
| **上下文管理** ⭐ | `src/context/` | 5 | ✅ 已实现（启发式确定性压缩：token 计量 / 整轮折叠摘要 / 工具结果头尾裁剪 / 恒留 system+近期 / 兜底预算约束，已接入 AgentLoop） |
| 权限 / 审批闸门 | `src/permission/` | 6 | ✅ 最小版（分级 + y/n + AgentLoop 接入） |
| 会话持久化 / 工具审计 | `src/storage/` `src/audit/` | 6 | ✅ 加分项（SQLite 落库 + 工具调用审计） |

⭐ = 必须亲手实现、禁止调库的灵魂模块。

## 设计取舍 / 踩坑复盘

> 在这里持续记录每个模块"为什么这么设计"以及踩过的坑——这是面试时的弹药。

- （示例）流式 tool_calls 为何用 index 做主键而非 id：见 `src/llm/tool-call-assembler.ts` 注释。
- Diff 引擎按「掌握多少信息」分三档能力，共享「最小改动 + 可校验 + 失败不留半成品」取舍（详见 `src/diff/` 各文件头注释）：
  - `str_replace`（`src/diff/index.ts`）：已知精确文本时用——精确匹配优先，失败再退行尾归一化、轻量空白容忍；任何非唯一命中返回 ambiguous，不让模型猜位置。
  - 手写 **Myers diff**（`src/diff/myers.ts`）：只有新旧两份文本时，用 O((N+M)·D) 最短编辑脚本算法求最小增删。为什么不用整文件重写 / 不调 jsdiff：整文件重写费 token 又难审；Myers 是 git 默认算法，复杂度只跟差异量 D 相关，相似文件近乎线性，且是蓝图点名「禁止调库」的补算法短板模块。
  - **unified diff 生成**（`src/diff/unified.ts`）：把编辑脚本渲染成业界通用 `@@ -a,b +c,d @@` 格式，只输出变更块+少量上下文（省 token），既给人审阅也能被 patch 反向解析。`edit_file` 成功后回填该 diff，让模型/CLI 看清实际改了哪几行。
  - **行级 patch apply**（`src/diff/patch.ts`）：两条硬约束——①上下文校验：apply 前核对源文件该处与补丁旧内容是否吻合，不吻合即拒绝，绝不盲改（容忍行号漂移但内容校验是底线）；②原子性：所有 hunk 先打在内存副本，任一失败则整体放弃，不留半成品。这是「失败回滚」在算法层的体现，与 `edit_file` 写盘层回滚共同构成两层可靠性。
- `edit_file` 写入前保留原内容，写入失败时尝试回滚（写盘层）；写入成功后回填 unified diff 预览。
- 沙箱（`src/sandbox/`）为何这么设计：①`detached:true` 让子进程成为新进程组 leader，超时用 `kill(-pid)` 清理整棵进程树，避免 `shell` 派生的后台任务变孤儿；②超时不直接 SIGKILL，而是 SIGTERM→宽限期→SIGKILL 两阶段升级，给进程清理（关连接/删临时文件/释放端口）的机会；③env 用白名单而非黑名单，从根源堵住模型 echo 偷读 API_KEY；④输出头尾各留 40% 截断，尾部往往是最终结果/错误，头部是早期日志，都比中间重要；⑤危险命令在 permission 层（可被 allow-all 跳过的提醒）之外，sandbox 层再做一次硬拦截（纵深防御）。
- 上下文管理（`src/context/`）为何用确定性启发式而非 LLM 摘要：便于单测、零额外 token/延迟，也契合「补算法/启发式短板」的目标，同时预留可注入的 summarizer 供日后无痛换 LLM 版。关键正确性约束：丢弃以「整轮(turn)」为单位（一个 user 到下一个 user 之前的所有消息），永不拆散 assistant 与其 tool 结果，否则违反 OpenAI 工具协议。压缩只作用于「发给模型的副本」，ConversationState 仍保留完整历史用于落库与调试。
- 阶段 4 检索为何「倒排索引 + BM25」而非纯向量：倒排把 query 词的 posting list 取出即可打分，复杂度只与命中文档数相关（查得快）；BM25 在 TF-IDF 上加了词频饱和(k1)与文档长度归一(b)，避免长文件/刷屏词虚高（查得准）。这两条是工业检索（Lucene/ES）的默认，且全部可手写、可单测。详见 `src/search/inverted-index.ts`。
- 文档粒度取「文件」：先用 BM25 召回相关文件，再在文件内定位命中查询词最多的行做片段，把 token 预算花在真正相关的代码上，而非整文件塞进上下文。片段在查询时按需读盘，避免整库内容常驻内存。
- 符号名用 tree-sitter（AST 而非正则）提取并加权进索引：代码里最该被检索命中的就是「定义符号的位置」。语法 wasm 用预编译的 `tree-sitter-wasms`，注意它由 tree-sitter-cli 0.20.x 构建，需配套 `web-tree-sitter@0.22.x`，与 0.26 运行时的 emscripten dylink 格式不兼容（踩坑点）。
