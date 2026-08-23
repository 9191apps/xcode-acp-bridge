# ACP Bridge — 实现技术文档

Date: 2026-08-16  
Repo: `xcode-acp-bridge`  
Related:
[observe+route design](superpowers/specs/2026-08-15-acp-observe-and-route-design.md) ·
[model selection](superpowers/specs/2026-08-15-acp-model-selection-design.md) ·
[live model switch](superpowers/specs/2026-08-15-acp-live-model-switch-design.md) ·
[后端接入测试清单](./acp-backend-integration.md)

本文总结本仓库 **ACP observe + route + 模型选择** 的落地实现：进程模型、事件管道、会话聚合、下一跳路由/模型、会话内（及 resume）模型切换，以及观察台在真实 Xcode ↔ OpenCode 流量下踩过的坑。

---

## 1. 问题与目标

Xcode Intelligence 可以通过 **ACP Agent**（stdio JSON-RPC）对接外部 agent。本仓库提供一个薄桥：

1. **Observe** — 透传字节的同时 tee 每一行 JSON-RPC 到 `data/acp-events.jsonl`，在仪表盘里按「一次 Xcode 对话」可读地展示，而不是几千行 `session/update` 碎片。
2. **Route** — 用户在仪表盘选择「下一场对话」走哪个 ACP 可执行文件（默认 `opencode acp`）；**当前**对话不热切换后端。
3. **Model** — 仪表盘选择下一场用哪个模型；同一后端下，live 会话可当场换模型，ended 会话的选择按 `sessionId` 记住，Xcode resume 时注入。

并行保留的 HTTP Chat Provider（`:8787` 的 `xcode-observer` stub）是另一张脸，不参与 ACP 路径。

---

## 2. 双进程架构

```text
Xcode (ACP Client)                 Dashboard (bun run start → :8787)
        │ stdio JSON-RPC                      │
        ▼                                     │ GET/PUT next route + model
   src/acp-bridge.ts                          │ GET /api/acp-models
        │ read data/acp-route.json once       │ GET conversations / timeline
        │ resolve → routes[name]              │ PUT conversation model
        ├──spawn──► chosen ACP executable     │ SSE live tail
        │ tee stdin ↔ stdout                  │
        │ inject session/set_config_option    │
        │ watch data/acp-commands/<pid>.json  │
        ▼                                     ▼
   data/acp-events.jsonl  ◄──────── tail ──── ACP tab
   data/acp-session-models.json   (sessionId → model, for resume)
   data/acp-commands/<bridgePid>.json  (live switch mailbox)
```

| 进程 | 职责 | 不做什么 |
|------|------|----------|
| `acp-bridge` | Xcode 拉起；读路由/模型状态；spawn 后端；tee；按需注入 `session/set_config_option`；写 JSONL；随 stdin 退出 | 不绑 HTTP、不热切换**后端** |
| Dashboard | 读 JSONL、聚合会话、改下一跳、给 live/ended 会话选模型、SSE | 宕机不影响正在进行的对话（live 切换靠命令文件，bridge 自己 watch） |

Xcode 只注册一次桥：

| Field | Value |
|-------|-------|
| Name | `ACP Bridge` |
| Interpreter | `~/.bun/bin/bun` |
| Executable | `…/xcode-acp-bridge/src/acp-bridge.ts` |
| Arguments | empty |

---

## 3. 锁定的事实模型（来自真实 capture）

一次真实 OpenCode 会话把下列约束钉死了：

| 事实 | 实现含义 |
|------|----------|
| 一次 Xcode **新**对话 = 一次 bridge spawn = 一个后端进程 = 一个 `ses_…` | **列表分组键是 `bridgePid`**；可执行文件只在 **process_start** 选定 |
| Xcode **resume** 已 ended 的对话 = **新 spawn** 一个 bridge，然后 `session/resume { sessionId }` | 旧 `bridgePid` 已死；要跨 resume 记住模型必须键 **ACP `sessionId`**，不能键 pid |
| `ses_…` 出现在 `session/new` **result**（resume 则在 request params） | 太晚，不能用来选本进程的可执行文件；够用来注入模型 |
| `opencode acp` **没有** `--model` | 模型只能走 ACP `session/set_config_option` |
| `MCP_XCODE_SESSION_ID` 在 `session/new` 的 MCP env 里 | 仅展示 / 关联，不是 spawn key |
| `cwd` 在 `session/new` params | 展示项目名；不猜「前台工程」 |
| `cwd` 是 Xcode 26 「Files」的**虚拟容器**：`/var/folders/…/Xcode/FilesWorkspaces/<UUID>/Files.xcfilescontainer`，不是真实工程路径 | 每次开/重开工程 Xcode 都新建随机 UUID 容器；**Coding Assistant 对话历史按当前容器隔离** → Xcode 重启后旧对话不在列表（见 §6.4） |
| 几乎全是 `agent_message_chunk` / `agent_thought_chunk` | UI 必须以 conversation + 折叠 timeline 为主 |

三类 id 禁止混用：

1. JSON-RPC `id` — 请求/响应配对；桥注入用 `bridge-<n>` / `bridge-live-<n>`，**该响应一律不转给 Xcode**
2. ACP `sessionId`（`ses_…`）— 后端会话；resume 与 ended 模型账本的键
3. `MCP_XCODE_SESSION_ID` — Xcode 侧对话 id

---

## 4. 模块地图

```text
src/acp-bridge.ts          # CLI 入口：load config → resolveRoute → runBridge(+pendingModel)
src/acp/
  config.ts                # acp-bridge.config.json；路径相对 repo root
  route-state.ts           # data/acp-route.json { route, model? } + resolveRoute
  models.ts                # modelsCommand spawn / 从事件观察 configOptions
  commands.ts              # data/acp-commands/<pid>.json 原子写（live 热切换）
  session-models.ts        # data/acp-session-models.json  sessionId → model（resume）
  run-bridge.ts            # spawn + 双向 tee + 注入 + watch 命令文件 + set_mode 改写
  parse.ts                 # 单行 JSON-RPC → 结构化字段（含 modelCurrent / modeCurrent）
  event-store.ts           # JSONL append / load / getById / list
  conversations.ts         # summarizeConversations + conversationDetail
  types.ts / tail.ts
src/dashboard/acp-routes.ts # /api/acp-* HTTP
public/{index.html,app.js,styles.css}  # ACP 观察台 UI
```

配置（`acp-bridge.config.json`）核心形状：

```json
{
  "routes": {
    "opencode": {
      "command": "~/.opencode/bin/opencode",
      "args": ["acp"],
      "modelsCommand": {
        "command": "~/.opencode/bin/opencode",
        "args": ["models"]
      }
    },
    "cursor": {
      "command": "~/.local/bin/agent",
      "args": ["acp"],
      "modelApply": "spawn-arg",
      "resumeArgs": ["--resume", "{sessionId}"],
      "modelsCommand": {
        "command": "~/.local/bin/agent",
        "args": ["models"]
      }
    },
    "qodercli": {
      "command": "~/.local/bin/qodercli",
      "args": ["--acp"],
      "modelApply": "spawn-arg",
      "resumeMode": "qoder-acp-load",
      "modelsCommand": {
        "command": "~/.local/bin/qodercli",
        "args": ["--list-models"]
      }
    }
  },
  "defaultRoute": "opencode",
  "eventsPath": "./data/acp-events.jsonl",
  "routeStatePath": "./data/acp-route.json",
  "maxRawBytes": 2097152
}
```

`command` / `modelsCommand.command` 支持 `~` / `$VAR` 展开；Xcode 拉起的环境没有用户 shell 的 `PATH`，所以不要写裸命令名。

可选后端字段：

| 字段 | 含义 |
|------|------|
| `modelApply` | `"inject"`（默认）：`session/new` 后注入 `session/set_config_option`。`"spawn-arg"`：spawn 时追加 `--model <id>`（Cursor、Qoder CLI） |
| `resumeArgs` | Terminal resume 参数模板，`{sessionId}` 占位；默认 `["-s", "{sessionId}"]` |
| `resumeMode` | `"args"`（默认）：`command` + `resumeArgs`。`"cursor-acp-load"`：走 `cursor-acp-resume.ts` 的 ACP `session/load`（CLI `--resume` 只能续非 ACP 的 chat）。`"qoder-acp-load"`：走 `qoder-acp-resume.ts`（ACP `session/load` + `qodercli-login`） |

Cursor 需预先 `agent login`（或 `CURSOR_API_KEY`）；桥不注入 `authenticate` / `cursor_login`。

**Cursor extension shim**（`src/acp/cursor-shim.ts`）：Xcode 不实现 `cursor/*`。桥在 a2c 拦截：`create_plan` → `agent_message_chunk` + 嵌套 `accepted` ack（否则 agent 阻塞、Xcode 一直转圈）；`update_todos` / 未知 `cursor/*` 仅 ack 不转发；`ask_question` 自动选第一项。

Qoder CLI 需预先 `qodercli login`（或 `QODER_PERSONAL_ACCESS_TOKEN`）；桥不注入 `authenticate` / `qodercli-login`（resume helper 会）。

**Qoder extension shim**（`src/acp/qoder-shim.ts`）：Xcode 不实现 `qoder/*`。桥在 a2c 拦截：带 `id` 的扩展 RPC 一律以 `{ outcome: { outcome: "accepted" } }` ack 并 suppress 原行；无 `id` 的通知仅 suppress。按真实抓包可加深（如 `create_plan` 转 chunk），当前通用 ack 已足够避免 prompt 卡死。

磁盘副作用都衍生自 `eventsPath` 所在目录：

| 文件 | 用途 |
|------|------|
| `data/acp-events.jsonl` | tee 日志 |
| `data/acp-route.json` | 下一场 spawn 的 route + 可选 model |
| `data/acp-commands/<bridgePid>.json` | `{ model, ts }`，dashboard → **正在跑的** bridge |
| `data/acp-session-models.json` | `{ [sessionId]: model }`，ended / resume 账本 |

---

## 5. Bridge 运行时

`runBridge` 做的事：

1. 写 `process_start`（raw 含实际 `route` / `command` / `args`）。
2. `spawn(command, args)`，把 Xcode stdin → 后端 stdin，后端 stdout → Xcode stdout，两边按行 parse 后 append 事件。
3. 方向标记：`c2a`（client→agent）/ `a2c`（agent→client）。`process_*` 是 bridge 自己记的，不是 RPC。
4. **文档化的两处改写**：① 向后端 stdin 注入 `session/set_config_option`（见 §6）；② 兼容改写：Xcode 的 `session/set_mode` 若带后端不认识的 `modeId`（如 `standard`）改写为默认 mode（见 §7.1）。注入请求记入 JSONL；对应 a2c 响应记入 JSONL 后 **丢掉，不写 Xcode stdout**。其它行仍原样转发；parse 失败仍转发原行，并带 `parseError`。
5. stdin 关闭或子进程退出 → `process_end`（或启动失败 → `process_start_error`）；关闭 `fs.watch`，尽力删掉自己的命令文件。

路由解析（`resolveRoute`）：

- 读 `data/acp-route.json` 的 `{ "route": "…", "model": "…" }`。
- 合法且在 `routes` 中 → 用它；否则回退 `defaultRoute`，stderr 打一行（绝不写到 ACP stdout），此时 **不带** `pendingModel`。
- **每个 bridge 进程只读一次** route state；仪表盘改的是「下一场」新 spawn。

---

## 6. 模型控制

OpenCode 的模型不能靠 spawn args。桥在拿到 `sessionId` 之后注入：

```json
{
  "jsonrpc": "2.0",
  "id": "bridge-<n> | bridge-live-<n>",
  "method": "session/set_config_option",
  "params": {
    "sessionId": "<ses_…>",
    "configId": "model",
    "type": "select",
    "value": "<model-id>"
  }
}
```

必须 **先让 `session/new` 或 `session/resume` 到达 agent 并返回**，再注入；否则 agent 还没有这个 session。

### 6.1 下一场新对话（`data/acp-route.json`）

| | |
|--|--|
| UI | ACP 页顶部 **Next conversation** 的 Route + Model |
| API | `PUT /api/acp-route` `{ route, model? }` 整表替换：省略/`null` model = 不注入 |
| Bridge | `pendingModel` 在 a2c `session/new` 结果之后注入，id `bridge-<n>` |
| 不影响 | 正在进行的会话；`session/resume` |

模型列表：`GET /api/acp-models?route=`。有 `modelsCommand` 就 spawn（5s、内存缓存，`?refresh=1` 刷新）；失败则扫该 route 最近一次 a2c `configOptions`。

### 6.2 Live 热切换（同一后端、同一 `bridgePid`）

| | |
|--|--|
| UI | 点开 **status=live** 的会话，详情 header 的 **model:** 下拉 |
| API | `PUT /api/acp-conversations/:bridgePid/model` `{ model }` |
| 通道 | dashboard 原子写 `data/acp-commands/<bridgePid>.json`；bridge `fs.watch` 目录 + 每条 c2a `stat` 兜底 |
| Bridge | id `bridge-live-<n>`；`ts < startedAtMs` 的残留文件忽略（PID 复用）；同一文件同一 `ts` 只应用一次，**更新 ts** 视为重试 |
| 不写 | `acp-route.json` |

进行中的 turn 可能仍用旧模型跑完（agent 定义）；下一 turn 用新模型。进程活着时还会把该选择写入 `acp-session-models.json`（若已有 `sessionId`），这样后来 resume 也能跟上。

PUT 在进程已死且没有 `sessionId` 时 409 `conversation not live`。

### 6.3 Ended / Resume（按 `sessionId`）

Ended 会话仍可被 Xcode 再打开：新的 bridge + `session/resume`。

| | |
|--|--|
| UI | 点开 **有 `sessionId`** 的 ended 会话，同一条 **model:** 下拉 |
| API | 同一个 PUT；不写命令文件（没人 watch），只写 `data/acp-session-models.json` |
| Bridge | 新进程在 `session/resume`（或 `session/load`）拿到 `sessionId` 后查账本，注入 `bridge-live-<n>` |
| 列表 | GET conversations / detail 会把账本上的 model **overlay** 到摘要，所以列表列马上更新 |
| 409 | 从未真正建 session 的行（没有 `acpSessionId`）→ `no session id` |

刷新观察台之后：改代码必须重启 `bun run start` 并硬刷新浏览器。

### 6.4 恢复旧对话（Xcode 重启后列表丢失）

Xcode 重启 / 重开工程后，Coding Assistant 对话列表经常看不到旧对话。根因是 **cwd 是 Xcode 的 Files 虚拟容器**（§3）：每次重开 Xcode 都新建随机 UUID 的 `FilesWorkspaces/<UUID>/`，而对话历史按容器隔离；旧对话存在旧 UUID 的 `Files-*` 目录里，新容器列表自然没有它。真实工程路径在 ACP 协议和 opencode 数据库里都拿不到，桥无法修复 Xcode 侧。

但**后端会话本身完整**（opencode 存 `~/.local/share/opencode/opencode.db`，含全部消息）。恢复办法：

- **观察台**：详情页有 `acpSessionId` 的会话 → 点 **resume** → Terminal 打开路由的 resume 命令（opencode: `-s`；cursor: ACP `session/load` helper；qodercli: `qoder-acp-load` helper）。
- **手动**：`opencode -s <sessionId>`，或 `bun src/acp/cursor-acp-resume.ts --agent ~/.local/bin/agent --session-id <uuid> --cwd <project>`，或 `bun src/acp/qoder-acp-resume.ts --agent ~/.local/bin/qodercli --session-id <uuid> --cwd <project>`。

---

## 7. 事件解析与存储

`parseRpcLine` 在不动字节的前提下抽出仪表盘常用字段：

| 字段 | 来源 |
|------|------|
| `method` / `rpcId` / `dir` | JSON-RPC 外壳 |
| `cwd` | `session/new` params |
| `mcpXcodeSessionId` | 深度遍历 payload；MCP env 可能是 `{name,value}[]` |
| `sessionHints` | `sessionId` / `session_id` / MCP id |
| `sessionUpdate` | `params.update.sessionUpdate` |
| `toolName` | `tool_call` / `tool_call_update` 的 title/name/kind |
| `modelCurrent` / `modelCount` | a2c `result.configOptions` 里 category/id 为 `model` 的 select |
| `modeCurrent` / `modeOptions` | 同上 category/id 为 `mode` 的 select：`currentValue`（默认 mode）+ options 的 value 列表 |

### 7.1 `session/set_mode` 兼容改写

Xcode 会发 `session/set_mode { modeId: "standard" | "plan", sessionId }`。`plan` 通常后端直接支持；`standard`（或任何后端不认识的 modeId）会被 OpenCode 等后端拒绝，返回 `Invalid params: mode not found: standard`。

桥的做法：从 a2c `session/new` / `session/resume` 的 `configOptions` 学到后端的可用 modes 与默认 mode（`modeCurrent`），随后对 c2a 的 `session/set_mode`：

- `modeId` 在后端 modes 里 → 原样转发；
- 不认识且已学到默认 mode → 把 `modeId` 改写为默认 mode 再转发（日志里 `raw` 即改写后的请求）；
- 还没学到 modes（如 set_mode 早于任何 `session/new` 结果）→ 原样转发，让后端自行报错。

这样 Xcode 的「standard」落到 OpenCode 的默认 agent（`build`），不再产生 -32602。

`AcpEventStore` 负责 JSONL；`getById` 供详情面板按需拉单条 raw。旧事件缺结构化字段时，聚合层会回退解析 `raw`（纯函数、不重写文件）。

会话摘要 `model` = 事件流 `lastNonNull(modelCurrent)`，再被 `acp-session-models.json` overlay。

---

## 8. 会话聚合与 Timeline

**Conversation = 同一 `bridgePid` 的事件集合。** Resume 是新的一行（新 pid），用详情里的 `sessionId` 和上一场对得上。

`summarizeConversations` 产出列表行：route、**model**、cwd、两个 session id、status（`live` / `ended` / `error`）、prompt/tool 计数、**active duration**。

- `live`：还没有 `process_end`（bridge 多半还在，或进程被 kill 来不及记 end）。
- `ended`：stdio 已关。仍可 resume，但是 **另一个** spawn。
- Status 列的意义就是区分这两类，从而知道详情里的 model 下拉是「立刻注入」还是「留给下次 resume」。

`conversationDetail` 把原始事件压成 timeline：

| 保留为独立行 | 折叠规则 |
|--------------|----------|
| `process_*`、`initialize`、`session/new` / `resume`、`session/prompt`、`session/cancel`、注入的 `set_config_option` | 连续 `agent_message_chunk` / `agent_thought_chunk` → 一条 `chunks`（拼接 `content.text`） |
| `sessionUpdate === "tool_call"` | 紧随其后的 `tool_call_update` 并入同一行（`updateCount` / `lastTs`） |

每行携带：

- `raw` — 主事件原文（chunk 组用最后一条）
- `gapMs` — 距上一行结束
- `durationMs` — chunks 跨度、tool_call 跨度、或 a2c RPC 相对同 `rpcId` 的 c2a 往返

`rpcId` 以 `bridge-` 开头的行标成 `(bridge)`。

### 时长语义（重要）

早期实现用 `process_end − process_start`，live 时用 `now − process_start`。这会严重偏大：

- Xcode 常在 agent `end_turn` 后很久才关 stdin → `process_end` 晚到。
- live 会话的墙钟会一直涨（曾出现观察台 **60m 23s** vs OpenCode **13m 26s**）。

当前约定：

```text
durationMs = lastActivityAt − startedAt
lastActivityAt = 最新一条 kind ≠ process_end 的事件
```

即 **有效活动跨度**，与 OpenCode 会话统计对齐；`endedAt` 仍保留进程生命周期供调试。

---

## 9. Dashboard API 与 UI

主要端点（`src/dashboard/acp-routes.ts`）：

| Method | Path | 作用 |
|--------|------|------|
| GET | `/api/acp-conversations` | 会话列表（flat，按 bridgePid；model 已 overlay 账本） |
| GET | `/api/acp-conversation-sessions` | 按 `acpSessionId` 分组的列表（同 overlay / live status；供 Observatory 一级列表） |
| GET | `/api/acp-conversations/:pid` | 详情 + timeline |
| PUT | `/api/acp-conversations/:pid/model` | `{ model }`：live 写命令文件（进程在则立即注入）；有 `sessionId` 则写入 resume 账本。409：`conversation not live` / `no session id` |
| POST | `/api/acp-conversations/:pid/resume` | 有 `acpSessionId` 的会话 → 写 `.command` 并用 Terminal 打开，执行路由 `resumeArgs`（默认 `-s`；cursor 为 `--resume`）。409：`no session id` / `no route for this conversation` |
| GET | `/api/acp-route` / PUT | 读/写下一跳 **路由 + 模型**（PUT 整表替换） |
| GET | `/api/acp-models?route=` | 该 route 的模型列表（`source`: command / observed / none） |
| GET | `/api/acp-events/:id` | 单事件 raw |
| SSE | `/acp-events` | 列表/详情增量刷新 |

UI 要点：

- 列表按 **ACP session** 分组（`GET /api/acp-conversation-sessions`）：同一 `acpSessionId` 的多次 bridge spawn 合并为一行，可展开查看各 spawn；无 session id 的仍单独成行。点父行进代表 spawn（优先 live），点子行进该 `bridgePid`。详情 / model / resume 仍按 `bridgePid`。
- **Model 列只读**，随 SSE / overlay 更新。
- **Next conversation** 下拉即时 PUT；只影响下一场 **新** spawn。
- 详情 **model:** 在 `route` 已知且（live **或** 有 `sessionId`）时变成 `<select id="acp-live-model">`。下拉获焦时暂停详情重绘，避免选一半被 SSE 冲掉。重选当前项（focus 时 `selectedIndex = -1`）可对失败注入重试。
- Timeline 行可点；**Selected event** 粘在底部，pretty-print JSON。
- Source 标签：`Xcode → Agent` / `Agent → Xcode` / `bridge`。
- 详情 `sessionId` 旁有 **resume** 按钮（§6.4）：一键起终端续聊旧会话（按路由 `resumeArgs`）。
- **布局（v2，两级页面）**：一级 `/`（`index.html` + `list.js`）= 会话列表，全宽表格 + 过滤框 + Next conversation 路由/模型；点行跳 `/conversation.html?pid=NNN`（`conversation.html` + `detail.js`）= 二级详情页，时间线占满全宽视口为主角。详情页 raw 抽屉高度可拖拽（分隔条 drag；双击分隔条或 ▾/▸ 按钮折叠，折叠后时间线占满详情区）；时间线行两行显示：时间戳 + 方向标签 + 方法 + 耗时/间隔，第二行是 payload 内容预览（prompt 文本 / result / chunks 文本片段）；工具栏有过滤框（按方法/内容过滤，选中与 `data-index` 不受影响）。折叠/过滤/raw 高度状态存 JS 变量，SSE 重绘不丢失；拖拽或查看 raw 时暂停详情自动刷新。列表页滚动位置经 sessionStorage 在返回时恢复。

### 实现期踩坑（观察台）

1. **Live SSE 整表重绘** 会丢掉选中行 → 事件委托 + 选中时暂停详情自动刷新 + debounce。
2. **跑着的 dashboard 进程过期** 导致 API/字段对不上 → 改后端后必须重启 `bun run start` 并硬刷新。
3. MCP env 真实形状是 `{name,value}[]`，不是 map → 解析要同时支持。
4. `process_start` 是 bridge 日志，不是 Xcode/OpenCode RPC → 方向展示为 `bridge`。
5. Xcode 的 Review 等 **control commands** 不是 ACP `available_commands`，OpenCode 会报 `This agent does not support control commands`；这与 resume / 模型注入无关。
6. `fs.watch` 会拖住事件循环：exit 路径必须 `watcher.close()`，否则单测挂死。
7. 注入若写在 `session/resume` **之前**，agent 还没有 session → 必须等 resume/new 的 a2c 结果后再 `bridge-live-*`。

---

## 10. 数据流小结

```text
Xcode stdin line
  → parse → append JSONL (c2a)
  → （resume/new 之外）maybe inject from command file / session map
  → backend.stdin

backend stdout line
  → parse → append JSONL (a2c)
  → 若 id ∈ injectedIds：吞掉，不写 Xcode
  → 否则 Xcode stdout
  → session/new 结果：pendingModel → inject bridge-<n>
  → session/resume 结果：session-models 账本 → inject bridge-live-<n>

Dashboard
  → load JSONL → group by bridgePid → overlay session-models
  → PUT live → acp-commands/<pid>.json
  → PUT ended → acp-session-models.json
  → PUT next → acp-route.json
```

---

## 11. 测试与运维

接入或升级一个 ACP 后端时，按 **[acp-backend-integration.md](./acp-backend-integration.md)** 做回顾测试（配置、完整回合、模型、resume/同 session 多 spawn、厂商扩展 RPC、观察台）。

- 单测覆盖：config（含 `modelsCommand`）、route-state 的 model、parse `configOptions`（含 model/mode 抽取）、conversations 折叠/时长/model、**session 列表分组**、commands 文件协议、session-models 账本、bridge 注入（new / live / stale ts / retry ts / resume 账本）、**set_mode 未知 modeId 改写（含未学到 modes 时透传）**、cursor extension shim、**qoder extension shim**、dashboard PUT/`resume` 各状态码。
- `data/` 已 gitignore；本地 JSONL / route state / commands / session-models 不入库。
- 改 API、注入逻辑或 `public/*` 后：重启 dashboard，浏览器硬刷新（否则新接口 404 → 列表空白）。
- 桥本身无端口；只依赖 config 与可写的 `eventsPath` 目录。
- `opencode acp` 必须是刚启动的新 bridge 才能读到刚写入的 `acp-session-models.json`（resume 总是新 spawn，满足这一点）。

---

## 12. 非目标与后续

**刻意不做**

- 对话中途热切换**后端**（会话状态在后端进程里，没有历史搬运）
- 把 live 模型选择写回 `acp-route.json`（下一场新对话的默认保持独立）
- 在桥里重写 ACP / 双开 SDK（含把 `session/new` 改写成 `session/resume` 来「恢复旧会话」——Xcode 列表丢失的解法是 §6.4 直连 opencode，不做桥改写）
- 用 HTTP Chat Completions 冒充 agent 工具循环
- 把 JSON-RPC `id` 或 `ses_…` 当成 spawn 路由键
- Unix socket / HTTP 反通道（命令文件够用）
- turn 边界排队、mode 切换 UI、ack 协议（注：不提供 mode 选择 UI；Xcode 发来的 `session/set_mode` 只做 §7.1 的兼容改写）

**自然延伸**

- 配置更多 `routes`（如 `pi-xcode`）无需改代码；给新 route 配 `modelsCommand` 即可出模型列表
- 区分展示「active duration」与「process uptime」双指标
- 清理仅有 `process_start`、长期 stale 的 live 行，以及 `acp-commands/` 孤儿文件
- `process.kill(pid, 0)` 的 false-live：pid 已被别的进程复用时，仍可能把命令文件写给无关进程（`ts < startedAtMs` 会挡掉旧文件）

---

## 13. 关键文件速查

| 路径 | 说明 |
|------|------|
| `src/acp-bridge.ts` | Xcode 入口；传入 `pendingModel` |
| `src/acp/run-bridge.ts` | tee + 注入 + watch |
| `src/acp/commands.ts` | live 命令文件 |
| `src/acp/session-models.ts` | resume 账本 |
| `src/acp/models.ts` | 模型列表 |
| `src/acp/conversations.ts` | 会话 / timeline / duration / model 摘要 |
| `src/acp/route-state.ts` | 下一跳路由 + 模型 |
| `src/dashboard/acp-routes.ts` | HTTP API |
| `public/app.js` | ACP 观察台 |
| `acp-bridge.config.json` | routes / modelsCommand / paths |
