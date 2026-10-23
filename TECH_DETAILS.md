# pi-collab 技术细节

本文是设计记录，不是最终 API 文档。"已确认"表示已经定下来的设计；"待定"表示实现前还需要决定。

## 目录

1. [目标](#1-目标)
2. [总体架构](#2-总体架构)
3. [会话与文件](#3-会话与文件)
4. [状态模型](#4-状态模型)
5. [提示词、skill 与缓存](#5-提示词skill-与缓存)
6. [消息与工具](#6-消息与工具)
7. [wait 与生命周期](#7-wait-与生命周期)
8. [压缩](#8-压缩)
9. [分支同步](#9-分支同步)
10. [UI 与命令](#10-ui-与命令)
11. [pi 内部机制](#11-pi-内部机制)
12. [待定问题](#12-待定问题)
13. [MVP 建议](#13-mvp-建议)
14. [关键不变量](#14-关键不变量)

---

## 1. 目标

- Lead（主 agent）保留决策和验收；Collaborator（唯一一个）负责探索、实现、跑命令。
- 用便宜但够用的模型做 Collaborator，降低整体成本。
- 复杂度只服务一个目标：让 Lead 的上下文保持干净、决策集中在它身上。

## 2. 总体架构

- 两个独立的 AgentSession 在同一个 pi 进程里并行，各自有完整历史。
- 不启子进程，不走 RPC。
- 一个 Lead 只对应一个 Collaborator，不是 subagent，不支持多个。
- Lead 和 Collaborator 之间只有两条通道：
  - Lead → Collaborator：`send` 工具。
  - Collaborator → Lead：每轮运行结束时的最终 assistant text，作为 report 返回。
- 两者的运行状态绑定：整体任务只有在两个 agent 都停下时才算结束。

## 3. 会话与文件

- Collaborator 会话按需创建：第一次真正发消息时才建文件。
- 路径：`sessions/<编码后的 cwd>/collab/<leadSessionId>.jsonl`。
  - pi 的会话发现只扫 `sessions/<cwd>/*.jsonl` 两层，嵌套的 `collab/` 不会被 `/resume` 扫到。
  - Lead 的 session id 可以从 `ctx.sessionManager.getSessionId()` 获取。
- `/fork`、`/clone` 都走 `session_before_fork`，`position` 分别是 `"before"` 和 `"at"`。
  - 事件本身拿不到新会话 ID。
  - 在新会话的 `session_start` 用 header 里的 `parentSession` 找到父会话，复制对应的协作者文件。
  - 复制完再跑一次锚点定位，把副本 leaf 移到 fork 点对应的位置。
- Collaborator session 不再加载 PiCollab 扩展本身，避免递归。
  - 用 `DefaultResourceLoader` 的 `noExtensions: true`。
  - 工具通过 `tools` 白名单 + `customTools` 提供。
- Collaborator 的系统提示词建议用 `appendSystemPromptOverride` 追加角色，而不是 `systemPromptOverride` 全量替换。
  - 全量替换会连默认的工具规则、工具列表一起换掉。
- Collaborator 的 cwd 默认和 Lead 相同。

## 4. 状态模型

三态：

| 状态 | 协作者 | 发送 | 读取 |
|---|---|---|---|
| not_started | 不存在 | 禁止 | 禁止 |
| active | 可能在跑 | 允许 | 允许 |
| paused | 一定不在跑 | 禁止 | 允许 |

规则：

- 状态存在当前分支的 custom entry 里，模型可见的状态用 custom message。
- 状态从当前分支的最新状态条目推导，这是唯一事实来源。
- 内存里可以留 memo，在恢复、切分支、fork、压缩时重建。
- `paused` 不能在协作者运行时进入。关闭命令直接拒绝，提示先等待或取消。不做延迟暂停。
- 取消（ESC / abort）只停当前运行，模式保持 `active`。取消 ≠ 暂停。
- 状态转移：
  - `not_started` → `active`：开启。
  - `active` → `paused`：协作者空闲时关闭。
  - `paused` → `active`：再次开启。
- 开启消息统一为："collab mode is currently on，读取 collab skill 了解工作流程。"
  - 第一次开、重新开、压缩后恢复都用同一句，不需要区分 re-read。
- 关闭消息说明：只能读、不能发，当前没有运行中的协作者。
- `not_started` 不需要状态消息，常驻的短说明已经覆盖。

## 5. 提示词、skill 与缓存

### 5.1 缓存策略

- 不依赖 provider 的 mid-conversation system message / tool changes，统一按"都不支持"处理。
- collab 工具从第一条请求就激活，中途不增删。
- system prompt 里常驻一条**状态中立**的短说明：
  - collab mode 存在，和这些工具相关；
  - 需要用户手动开启；
  - 当前状态由消息通知；
  - 没看到开启通知就当作没开，不要调用这些工具。
- 短说明不能写"当前没开"。否则开启后要么内容错误，要么改 section 破缓存。
- 因为工具和 section 都不变，中途零缓存破坏；首次请求付一次写入，之后都是缓存读。

### 5.2 协议放 skill

- 完整协作协议放在扩展自带的 skill：`skills/collab/SKILL.md`。
- 通过 `resources_discover` 返回 `{ skillPaths: [...] }` 暴露。
- description 写明"用户明确开启 collab mode 时读取"。
- skill 的描述常驻 system prompt，完整内容只在模型读取时进入上下文；压缩后还能再读。

### 5.3 开启时的做法

两种可选：

- 发一条"已开启，读 collab skill"；
- 或 `pi.sendUserMessage("/skill:collab", { expandPromptTemplates: true })` 直接展开内容。

前者省一次工具调用，但依赖模型听话；后者规则立刻到位，但内容会进对话，压缩后可能被丢掉（仍可靠 skill 再读）。

### 5.4 已核实的缓存事实

- `before_agent_start` 的 `event.systemPromptOptions.sections` 可变；pi 会把变化做成 system patch。
- 模型没有 `supportsMidConvoSystemMessages` 时，pi 会把所有 system 消息折叠成开头一条 system prompt，头部一变就整段缓存失效。
- `supportsMidConvoToolChanges`（Anthropic）和 `supportsAdditionalTools` / `supportsToolSearch`（OpenAI）是另一组"工具负载格式"flag，和 section 文本无关。
- 只有通道、没有工具格式的模型：section 变化便宜，工具变化贵。
- 目录里 Claude Sonnet 4.5 / Opus 4.5 / 4.6 没有 mid-convo 支持；Opus 4.8 / Opus 5 / Sonnet 5.5+ 有。
- 旧 GPT-5 没有 mid-convo 支持；GPT-5.4+ 有。
- 压缩不会丢 system prompt 状态；compaction entry 里的 `systemMessage` 会重放它。

## 6. 消息与工具

### 6.1 术语

handoff 和 steer 是同一个 `send` 工具在不同运行状态下的行为名称，不是两个工具。

- **handoff**：Lead 通过 `send` 给空闲的 Collaborator 发消息，开启一轮任务。
- **steer**：Collaborator 正在运行时，Lead 再次调用 `send`，向当前运行补充指令。
- **report**：一次 Collaborator agent loop 最后 settle 之前输出的那段 assistant text，返回给 Lead。
- **中间文本**：Collaborator 运行过程中的其他 assistant text，不作为 report 自动投递；Lead 可以通过 `inspect` 查看。

### 6.2 Lead 工具

- `send`：Lead 给 Collaborator 发消息的唯一工具，立即返回，不等待完成。
  - 协作者空闲 → handoff，开新一轮；正在跑 → steer 当前运行。
  - 每次调用在 Lead 会话里写一条锚点 custom entry，记录协作者会话里对应的 user message entry ID。
- `wait`：阻塞等待，见第 7 节。
- `inspect`：pull-only 读取协作者会话，按消息/ID/tail/过滤；长内容按行取。不能自动倒灌进 Lead 上下文。
- 是否加 Lead 主动取消协作者的工具，待定。

### 6.3 Collaborator 的 report

- Collaborator 不提供向 Lead 发消息的工具，只通过最终 assistant text 返回 report。
- 在 `agent_settled` 时确定本轮 report；不把中间的 `message_end` 当作任务完成。
- report 不带 `kind` 字段；Lead 自己从内容判断结果或需要回答的问题。
- 中间文本不进 wait 结果；Lead 想看就用 `inspect`。

### 6.4 投递路由

Collaborator settle 后，将运行状态和 report 一起投递：

```
waiting === true  → 结束等待，作为 wait 结果返回
waiting === false → pi.sendMessage(reportMessage, { triggerTurn: true })
                    streaming 时 steer，空闲时开新一轮
```

## 7. wait 与生命周期

### 7.1 主路径

- Lead 主动调用 `wait`，工具阻塞 Lead 的 agent loop。
- 不设计"Lead 结束、系统替它等"的第二种模式。
- Lead 没 wait 就结束，视为协议违规。

### 7.2 违规兜底

`agent_before_settle` 里：

```
if outcome !== "completed": return
if collaborator idle or mode not active: return
if nudge 次数 >= 上限: return
pi.sendMessage(reminder, { deliverAs: "steer" })
```

- 队列里有消息，边界会自动 continue。
- 挂起只持续到 reminder 入队，几毫秒，不是长挂起。
- 下一轮 Lead 调 `wait`，真正阻塞在工具里。
- nudge 建议让 Lead 调 `wait`。

### 7.3 wait 结果

- `wait` 只等协作者彻底停下，不再区分 message / settle 模式。
- 结果：`state`（completed / error / aborted / cancelled）+ 本轮 report；未产生最终文本时没有 report，不拿中间文本代替。
- 支持超时；超时返回当前 `state`，不提前返回 report。Lead 继续活跃，可以再 inspect / send / wait。
- report 如果太长，按类似 bash 的 50k 上限截断，并给出 entry 范围。

### 7.4 等待状态机

- `waiting`：是否正在等待，一次只允许一个 wait；第二个直接报错。
- 存的是 resolve 回调，不是 promise 本身。
- 开始时先设状态，再检查协作者是否已经 idle；已 idle 就立即返回运行状态和最近一轮 report，避免错过 settle 事件。
- 超时 / abort 必须同步清理等待状态和 resolve。

### 7.5 被 steer 打断

- 用户在 wait 期间发消息 → 用 `interrupted` 结果结束等待，`isError: false`，带上当前 state。
- 用户消息作为单独消息出现在同一请求里，不塞进 tool result。
- 只对 `streamingBehavior === "steer"` 打断，`followUp` 不打断。
- 实现方式：`input` 事件后等一个 tick，再检查 `ctx.hasPendingMessages()`；图片处理可能延迟入队，所以用短间隔重试。
- 为什么不能直接在 `input` 里 resolve：`input` 比消息入队早，wait 返回后 loop 可能 poll 到空队列，steer 会迟一轮。
- 已核实：agent loop 在工具批次结束之后、下一次请求之前 drain steering。只要 steer 已在队列里，tool result 和 steer 会进同一请求。
- `hasPendingMessages()` 能看到用户 steer（`_queueSteer` 先 push 到 session 的 `_steeringMessages`，再 `agent.steer`，同步完成），但看不到扩展用 `sendMessage({ deliverAs: "steer" })` 塞的 custom message。
- 协作者 report 恰好在 wait 前被投递为 steer 的窄竞态：用一个 boolean `pendingCollaboratorSteer`，投递时置 true，Lead 的 `message_start` 看到对应 customType 时清掉；wait 开始时如果为 true，直接返回 `interrupted`。

### 7.6 取消与导航

- ESC 取消 Lead 和 Collaborator，走正常 streaming 路径。
- `/tree`、`/fork`、`/resume`、`/new`、`/compact` 都会先 `abort()`，所以会取消当前 wait 和协作者。这是正常语义。
- `/reload`、切换 session、pi 退出：dispose 协作者 session，清 waiting 状态。

### 7.7 为什么不用自定义 editor / 长挂起

- ESC 只在 `isStreaming` 为 true 时走 abort 分支；空闲时走双击 ESC 的 tree/fork。
- `registerShortcut("escape", ...)` 会拦截所有 ESC 并吞掉默认处理。
- `setEditorComponent` 会覆盖用户已有的 editor（例如双击 ESC 取消的扩展）。
- 所以让 wait 工具保持 session streaming 是最干净的做法；不需要长挂起，也不需要碰 editor。

## 8. 压缩

- 规则在 skill 里，不重新注入。
- 压缩后，如果压缩前这个分支状态是 `active` 或 `paused`，无论如何补一条对应的状态消息；`not_started` 不补。
- 同样的检查在切分支、fork/clone、恢复会话时也要跑。
- 状态事实来自分支上的 custom entry，不是 summary。
- 重复一条状态消息可以接受，比去投影里找"是否已存在"简单。

## 9. 分支同步

- 每次 Lead 发消息给协作者，在 Lead 会话写一条锚点 custom entry，记录协作者会话里对应的 user message entry ID。
- 切分支时（`session_tree` 给 `newLeafId`）：
  1. 先取消正在跑的协作者。
  2. 从新 leaf 往上找最近的锚点条目。
  3. 到协作者会话里，保留那个 user message 开始的整个 turn（到下一个 user message 之前，取最后一个 assistant message），把 leaf 移过去。
  4. 目标分支没有锚点 → 协作者 leaf 回根，状态 `not_started`。
- 协作者会话因此变成一棵树；`branch()` 不删条目，forward 切换也能恢复。
- 切分支只同步上下文，不回滚文件改动。
- fork / clone：复制协作者文件，再用同样的锚点逻辑把副本 leaf 移到对应位置。
- 条目 ID 原样保留，所以 Lead 里复制的锚点仍然有效。
- "turn 没跑完时保留到哪里"待定：保留到发送点，还是保留到最后一个已完成的 assistant 消息。

## 10. UI 与命令

### 10.1 通用模型与思考级别选择面板

开启协作和修改配置复用同一个两步面板，先选模型，再选思考级别（effort / thinking level）。

1. **模型选择页**：交互参考 pi 自带的 `/model` 界面，提供搜索框和模型列表；按 Enter 确认模型，进入思考级别选择页。
2. **思考级别选择页**：选择该模型支持的思考级别，按 Enter 确认，完成整个选择流程。

返回与取消：

- 思考级别页按 Esc：返回模型选择页，不关闭整个面板，保留刚才选择的模型位置。
- 模型选择页按 Esc：取消本次选择，不提交配置。
- 只有完成两步选择才提交模型和思考级别；中途返回或取消不改变现有配置或协作状态。

修改已有配置时：

- 模型列表的初始光标定位到 Collaborator 当前使用的模型，而不是列表第一项。
- 模型未变时，思考级别页的初始选中项为当前思考级别。

### 10.2 未开启时的 `/collab`

- 当前为 `not_started` 或 `paused` 时，输入 `/collab` 直接打开通用选择面板，不先显示总览。
- 完成模型和思考级别选择后，保存 Collaborator 配置，将状态设为 `active`，并向 Lead 发送开启通知。
- 取消选择则保持原状态。
- 开启模式本身不创建 Collaborator 会话，仍等第一次 `send` 才按需创建。

### 10.3 已开启时的 `/collab`

当前为 `active` 时，输入 `/collab` 打开总览面板，展示当前模型和思考级别，暂时只提供两个选项：

- **Disable**：关闭协作模式，进入 `paused`，保留会话历史与配置。Collaborator 正在运行时拒绝关闭，明确提示先等待或取消。
- **Change model or effort**：打开通用选择面板，初始光标定位到当前模型；完成后更新配置，协作模式保持 `active`。取消则保留原配置并返回总览。

总览面板按 Esc 关闭，不改变协作状态或配置。

配置生效时机：

- 沿用 pi 原生的 `setModel` / `setThinkingLevel` 行为，不另做延迟生效机制。
- Collaborator 空闲时修改，下一轮 handoff 使用新配置。
- Collaborator 正在运行时修改，从下一次模型请求开始使用新配置，不必等整个 agent loop 结束；已经发出的请求不受影响，也不重启当前运行。
- 当前安装的 pi 1.3.0 会直接更新 agent state，并在每次模型请求前通过 `prepareRequest` 读取最新模型和思考级别。

### 10.4 其他界面

- 协作者状态显示（footer / widget / 只在 wait 的 tool 里）还没定。
- 用户默认看不到协作者的实时输出，只能看 report 和 inspect。
- 成本显示：footer 只算 Lead；协作者的 token/成本怎么展示还没定。

## 11. pi 内部机制

### 11.1 创建协作者会话

```ts
createAgentSession({
  cwd,
  modelRuntime,
  model,
  thinkingLevel,
  tools: [...],          // read / bash / edit / write 等
  // 不注入向 Lead 发消息的自定义工具
  resourceLoader,        // noExtensions + appendSystemPromptOverride
  sessionManager,        // SessionManager.create(cwd, collabDir)
  settingsManager,
})
```

- `SessionManager.create(cwd, sessionDir?)`、`SessionManager.open(path)`、`SessionManager.inMemory()`。
- `getSessionFile()`、`getSessionId()`、`getHeader()`、`getBranch()`、`getEntries()`、`branch(entryId)`、`appendCustomEntry`、`appendCustomMessageEntry`。
- `session.subscribe(event => ...)`；`message_end` 是权威消息；`agent_settled` 是彻底停下。
- `session.prompt()` 在 streaming 时需要 `streamingBehavior`；`session.steer()` / `followUp()` 可直接用。
- `session.dispose()` 会 abort 当前工作。

### 11.2 事件

- `session_start`：`reason` 是 startup / new / resume / fork / reload，带 `previousSessionFile`。
- `session_before_switch`、`session_before_fork`（`entryId`、`position`）、`session_tree`（`newLeafId`、`oldLeafId`）。
- `session_compact`、`session_shutdown`。
- `before_agent_start`：`systemPromptOptions` 可变，`sections` 可加。
- `agent_start` / `agent_end` / `agent_before_settle` / `agent_settled`。
- `message_start` / `message_end` / `turn_start` / `turn_end`。
- `tool_call` / `tool_result`：用于 gate。
- `input`：带 `streamingBehavior` 和 `source`。

### 11.3 事件顺序

```
agent_end（TUI 清掉转圈）
→ post-run 处理
→ agent_before_settle（isStreaming 仍为 true）
→ agent_settled（isStreaming 变 false）
```

- 长挂起 `before_settle` 时，TUI 的转圈已经在 `agent_end` 被清掉，需要 `setWorkingMessage` + `setWorkingVisible(true)` 手动重开。
- 本设计只做毫秒级 nudge，不需要这套。

### 11.4 工具注册与上下文

- `pi.registerTool`、`pi.registerCommand`、`pi.registerShortcut`、`pi.on`。
- `pi.sendMessage`、`pi.sendUserMessage`、`pi.appendEntry`。
- `pi.getActiveTools` / `setActiveTools` / `getAllTools` / `getSettings`。
- `ctx.ui.setStatus` / `setWorkingMessage` / `setWorkingVisible` / `setWidget`。
- `ctx.hasPendingMessages()`、`ctx.isIdle()`、`ctx.signal`、`ctx.model`、`ctx.modelRegistry`。
- `ctx.sessionManager` 是只读的。

### 11.5 会话文件与发现

- `sessions/<编码后的 cwd>/<文件名>.jsonl`。
- 会话发现只扫两层：`sessions/*/*.jsonl`。
- header 里有 `id`、`cwd`、`parentSession`。
- 压缩条目里有 `systemMessage`，用于重放 system 状态。

### 11.6 steering 时序

- agent loop 在工具批次结束、下一次请求之前 drain steering。
- 只要 steer 已在队列里，tool result 和 steer 进同一请求。
- `_queueSteer` 先 push `_steeringMessages`，再 `agent.steer`，同步完成。
- 扩展的 `sendMessage({ deliverAs: "steer" })` 直接进 agent 队列，不经过 `_steeringMessages`。

## 12. 待定问题

- Collaborator 的工具集、是否加载项目 extensions/MCP/skills/AGENTS.md、权限/审批、cwd。
- 模型与思考级别的初始默认值；更换模型后思考级别的默认选项。
- `send` 的消息顺序和关联方式（空闲时 handoff，运行中 steer 已确认）。
- `inspect` 的粒度、分页、过滤。
- `wait` 的默认超时、report 截断策略。
- nudge 次数上限和最后兜底行为。
- 协作者出错、认证失败、session 创建失败、文件缺失/损坏时 Lead 看到什么。
- `/reload`、切换 session 的收尾细节。
- 分支同步里"未完成 turn"的精确定义。
- 协作者自己的压缩：Lead 发过去的任务上下文被压掉后怎么办。
- 状态显示、成本显示、用户如何查看协作者输出。
- 协议文本：skill 里写什么、工具 description 里写什么、短 section 里写什么。
- 怎么验证成本真的降了、质量没掉。

## 13. MVP 建议

按依赖顺序分三层，先跑通再补。

### 第一层：协作闭环

- 创建协作者 session，自定义 prompt，工具：read / bash / edit / write；最终 assistant text 作为 report。
- Lead 工具：`send`（handoff / steer）、`wait`、简单 `inspect`。
- 状态只用 `not_started` / `active`，custom entry + 开启消息。
- 常驻短 section + collab skill。
- 不做 pause、分支同步、fork 复制、压缩补状态、nudge。

### 第二层：生命周期

- wait 超时、steer 打断。
- nudge 兜底。
- pause 三态、关闭拒绝。
- 取消、错误处理。

### 第三层：持久化与分支

- 分支锚点和 leaf 同步。
- fork/clone 复制协作者文件。
- 压缩后补状态。

## 14. 关键不变量

- 工具和 section 中途不变。
- 状态从当前分支推导，不靠 summary。
- `active` / `paused` 时，模型上下文里必须有一条当前状态消息。
- 一次只允许一个 wait。
- Lead 通过 `send` 发起 handoff 或 steer；协作者没有向 Lead 发消息的工具，只以每轮最终 assistant text 返回 report。
- 取消保持 `active`；暂停要求协作者空闲。
- 两个 agent 都结束，整体任务才算结束（由 wait 和 nudge 保证）。
