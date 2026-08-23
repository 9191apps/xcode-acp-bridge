# 接入一个 ACP 后端：回顾与测试清单

接入或升级一个 ACP agent（如 OpenCode、Cursor CLI，或下一个新 route）时，按本清单过一遍。目标不是「能聊一句」，而是 **Xcode ↔ 桥 ↔ agent** 在会话生命周期、模型、resume、扩展协议上都不踩坑。

相关实现：[`docs/acp-bridge.md`](./acp-bridge.md) · 配置：`acp-bridge.config.json`

---

## 0. 改代码后必做

- [ ] **重启 dashboard**（`bun run start`）。观察台进程不会热加载路由/API；漏重启会出现新接口 404、列表空白等假象。
- [ ] 浏览器对观察台 **硬刷新**（Cmd+Shift+R），避免旧 `list.js` / `detail.js` 缓存。
- [ ] `bun test` 全绿。

---

## 1. 配置与启动

| 项 | 要确认什么 |
|---|---|
| `routes.<name>.command` / `args` | 本机可执行；`~` / `$VAR` 展开正确；`process_start` raw 里看到预期 argv |
| `modelsCommand` | 能列出模型；解析格式与该 CLI 一致（一行一个 id，或 `id - Label`） |
| `modelApply` | `"inject"`（默认，`session/set_config_option`）还是 `"spawn-arg"`（`--model`，适合 Cursor） |
| `resumeArgs` / `resumeMode` | Terminal resume 是否真能续 **ACP** 会话（Cursor CLI `--resume` 只管 chat，ACP 要用 `cursor-acp-load` + `session/load`；Qoder CLI 用 `qoder-acp-load` + `session/load` + `qodercli-login`） |
| Auth | 登录/API key；`bun run setup` 对未登录有警告 |
| `defaultRoute` | 是否故意保持旧默认（新 route 仅仪表盘可选） |

---

## 2. 基础 ACP 回合（Xcode New Conversation）

在观察台选中该 route → Xcode **New Conversation** → 发一条简单 prompt：

- [ ] `initialize` → `session/new`（或该 agent 的等价入口）成功
- [ ] `session/prompt` 后有 `agent_message_chunk`（或等价可见回复）
- [ ] prompt **result** 带回 `stopReason`（如 `end_turn`），Xcode **不一直转圈**
- [ ] 工具调用：`tool_call` / `tool_call_update` 与权限 `session/request_permission` 行为可接受
- [ ] 观察台：该 spawn 的 `route`、cwd、**ACP `sessionId`**（不是 MCP UUID）显示正确

**会话 ID 陷阱：** Xcode MCP 的 `MCP_XCODE_SESSION_ID` 也会进 `sessionHints`。列表/账本必须优先真实 ACP id；MCP uuid 不能污染 `acpSessionId`。

---

## 3. 模型

- [ ] 仪表盘 Next conversation 模型下拉有列表（`GET /api/acp-models?route=`）
- [ ] **下一场新对话**选模型后，新 spawn 真用该模型（看 `process_start` args 或注入的 `set_config_option`）
- [ ] **Live** 详情改模型：出现 `bridge-live-…` 注入；下一 turn 生效（或文档写明仅 best-effort）
- [ ] **Ended** 有 `sessionId` 时写入 `acp-session-models.json`；Xcode 再打开时能注入
- [ ] `spawn-arg` 路线：清楚「每次 spawn（含 resume）都会带 `--model`」的语义，避免误伤旧会话模型

---

## 4. Resume / 同会话多 spawn

ACP 会话与观察台「一行」不是一回事：Xcode 每次打开都会 **新 bridgePid**。

- [ ] Xcode 关闭再打开同一对话：走 `session/resume` 或 `session/load`（视 agent），**同一 ACP session id**
- [ ] 观察台列表：同一 `acpSessionId` **合并为一行**（`GET /api/acp-conversation-sessions`），可展开看多次 spawn；不是两个无关会话
- [ ] 详情仍按 `bridgePid`；点父行进到 live/最近 spawn
- [ ] 观察台 **resume** 按钮：Terminal 命令对该后端正确（opencode `-s`；Cursor ACP `session/load` helper 等）
- [ ] 手动在 Terminal 复现 resume，确认不是「看起来开了、其实是新会话」

---

## 5. Mode / 控制面

- [ ] Xcode 切 mode（若 UI 有）：`session/set_mode`；未知 `modeId` 时桥是否按学到的默认改写（OpenCode 路径）
- [ ] agent 不支持的 control command：错误可理解，不拖死整场会话

---

## 6. 厂商扩展方法（极易卡死）

抓一段真实 a2c，搜 agent 自定义 method（如 `cursor/*`）：

| 类型 | 风险 | 要测 |
|---|---|---|
| **阻塞请求**（有 JSON-RPC `id`，等 client result） | Xcode 不实现 → agent 不返回 prompt result → **界面一直转圈** | 必须有 shim/ack，或确认 Xcode 会回 |
| 非阻塞 / 通知 | 列表噪音或未知 method | 可吞掉或转成 `agent_message_chunk` |

Cursor 已覆盖：`create_plan`（转消息 + 嵌套 `accepted`）、`update_todos`、`ask_question`（自动答）——见 `src/acp/cursor-shim.ts`。

Qoder CLI 已覆盖：通用 `qoder/*` ack + suppress（带 `id` 的阻塞 RPC 回 ack，通知 suppress）——见 `src/acp/qoder-shim.ts`。按抓包可加深具体 method 的处理。

新后端：对每个带 `id` 的扩展 RPC 问一句：**没有 client 回复时，prompt 还能结束吗？**

---

## 7. 观察台与存储

- [ ] `GET /api/acp-conversations`（flat）与 `/api/acp-conversation-sessions`（分组）都 200
- [ ] SSE 列表会更新；展开状态刷新后仍在（`sessionStorage`）
- [ ] Clear / Export 不误伤其他 route 的理解（按事件存，不按 route 分库）
- [ ] 大流量下 chunk 聚合仍可读；详情时间线不是纯 chunk 洪水

---

## 8. 自动化 vs 手测

**自动化（合入前）：**

- config / spawn-args / resume 参数展开
- bridge：注入、spawn-arg、set_mode 改写、（若有）extension shim
- dashboard：conversations、sessions 分组、model/resume API 状态码

**必须手测（协议差异测不完）：**

1. Xcode 真机 New Conversation 一轮完整回复  
2. 至少一次 **resume / 再打开**  
3. 一次会触发工具或权限的任务  
4. 若有 plan/todo/问答类扩展，故意打一条会发出扩展 RPC 的 prompt  

---

## 9. 接入新 route 的最小顺序（推荐）

1. 配置 `command`/`args` + setup 探测 → 手测 §2  
2. `modelsCommand` + `modelApply` → 手测 §3  
3. `resumeArgs`/`resumeMode` → 手测 §4  
4. 抓包查扩展 method → 需要则 shim → 手测 §6  
5. 补单测 + 更新本清单/README 验收条目  
6. **重启 dashboard**，再做一次端到端冒烟  

---

## 10. 已知对照（本仓库）

| | OpenCode | Cursor CLI | Qoder CLI |
|---|---|---|---|
| 入口 | `opencode acp` | `agent acp` | `qodercli --acp` |
| 模型应用 | inject | spawn-arg `--model` | spawn-arg `--model` |
| Terminal resume | `-s {sessionId}` | `cursor-acp-load` | `qoder-acp-load`（`session/load` + `qodercli-login`） |
| 扩展 RPC | 少 | `cursor/*` shim | `qoder/*` shim（通用 ack；按抓包加深） |
| 默认 route | 是 | 否 | 否 |
