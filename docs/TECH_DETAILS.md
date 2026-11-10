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
- Lead 和 Collaborator 之间只有两条消息通道：
  - Lead → Collaborator：`send` 工具。
  - Collaborator → Lead：每轮运行结束时的最终 assistant text，作为 report 返回。
- 两者的运行状态绑定：整体任务只有在两个 agent 都停下时才算结束。

## 3. 会话与文件

- Collaborator 会话按需创建：第一次真正发消息时才建文件。
- 路径：`sessions/<编码后的 cwd>/collab/<时间戳>_<leadSessionId>.jsonl`，会话 ID 和 Lead 相同；查找时匹配 `_<leadSessionId>.jsonl` 结尾，或兼容无时间戳前缀的 `<leadSessionId>.jsonl`。
  - pi 的会话发现只扫 `sessions/<cwd>/*.jsonl` 两层，嵌套的 `collab/` 不会被 `/resume` 扫到。
  - Lead 的 session id 可以从 `ctx.sessionManager.getSessionId()` 获取。
- `/fork`、`/clone` 都走 `session_before_fork`，`position` 分别是 `"before"` 和 `"at"`。
  - 事件本身拿不到新会话 ID。
  - 在新会话的 `session_start`（`reason === "fork"`）用 `previousSessionFile` 找到父会话的协作者文件，复制一份，文件名里的会话 ID 换成新会话的。
  - 副本的 leaf 不在复制时移动，等下次创建协作者会话时按锚点定位（见第 9 节）。
- Collaborator session 不加载 PiCollab 扩展本身，避免递归。
  - 用 `DefaultResourceLoader` 的 `extensionsOverride`，按 `resolvedPath` 只过滤掉本扩展；用户的其他扩展照常加载。
  - 工具用 Lead 当前启用的工具，去掉 `collab_send` / `collab_wait` / `collab_inspect` / `collab_interrupt`。
- Collaborator 的角色提示放在 `prompts/collaborator_role.md`，见 5.5。
- Collaborator 的 cwd 和 Lead 相同。

## 4. 状态模型

三态：

| 状态        | 协作者     | 发送 | 读取 |
| ----------- | ---------- | ---- | ---- |
| not_started | 不存在     | 禁止 | 禁止 |
| active      | 可能在跑   | 允许 | 允许 |
| paused      | 一定不在跑 | 禁止 | 允许 |

规则：

- 状态存在当前分支的 custom entry 里，模型可见的状态用 custom message。
- 状态从当前分支的最新状态条目推导，这是唯一事实来源。
- 内存里可以留 memo，在恢复、切分支、fork、压缩时重建。
- `paused` 不能在协作者运行时进入。关闭命令直接拒绝，提示先等它跑完。不做延迟暂停。
- 取消（ESC / abort）只停当前运行，模式保持 `active`。取消 ≠ 暂停。
- 状态转移：
  - `not_started` → `active`：开启。
  - `active` → `paused`：协作者空闲时关闭。
  - `paused` → `active`：再次开启。
- 状态消息在开启和关闭时各发一条：
  - 用 `pi.sendMessage` 发 `pi-collab/status` custom message，`display: false`，不触发新的一轮；Lead 在下一次请求时看到。
  - 内容包在 `<collab_reminder>` 里，让 Lead 分清这不是用户输入。
  - 开启："Collab mode is now enabled. Read the `collab-mode` skill for the collaboration guidelines." 第一次开和重新开用同一句。
  - 关闭：说明仍可做只读操作（如查看协作者输出），但在用户重新开启前不能给它发消息。
- 修改模型或思考级别不发状态消息。
- `not_started` 不需要状态消息，常驻的短说明已经覆盖。

## 5. 提示词、skill 与缓存

### 5.1 缓存策略

- 不依赖 provider 的 mid-conversation system message / tool changes，统一按"都不支持"处理。
- collab 工具从第一条请求就激活，中途不增删。
- system prompt 里常驻一条**状态中立**的短说明，在 `before_agent_start` 里写进 `sections.collab_reminder`，pi 会自动包成 `<collab_reminder>`：
  - `collab_` 开头的工具属于 collab mode；
  - 只在用户开启后使用；
  - 开启时会收到通知。
- 短说明不能写"当前没开"。否则开启后要么内容错误，要么改 section 破缓存。
- 因为工具和 section 都不变，中途零缓存破坏；首次请求付一次写入，之后都是缓存读。

### 5.2 协议放 skill

- 完整协作协议放在扩展自带的 skill：`skills/collab-mode/SKILL.md`，只写给 Lead。
- 通过 `resources_discover` 返回 `{ skillPaths: [...] }` 暴露，不在 `package.json` 的 `pi.skills` 里声明。
  - `resources_discover` 只发给加载了本扩展的会话；协作者过滤掉了本扩展，所以看不到这个 skill。
  - 如果写进 `pi.skills`，pi 会直接加载，协作者也会看到。
- description："Guidelines for working as the lead agent in collab mode. Use when the user enables collab mode or asks how it works."
- skill 的描述常驻 system prompt，完整内容只在模型读取时进入上下文；压缩后还能再读。
- 分工：工具 description 只写机制（返回什么、超时会怎样）；skill 写什么时候用、怎么用；两边不重复。
- skill 说明 `<collaborator_report>` 来自协作者、`<collab_reminder>` 来自 collab mode 系统，都不是用户输入，不要当成用户的话来回复。

### 5.3 开启时的做法（已确认）

- 发一条"已开启，读 collab-mode skill"的状态消息，不内联 skill 内容，由模型自己去读。
- 不用 `pi.sendUserMessage("/skill:collab-mode", ...)` 展开：内容会进对话，压缩后可能被丢掉。
- 第一条开启消息在 Lead 读 skill 之前到达，不受 skill 里 tag 规则的约束；模型通常很快就读，问题不大。

### 5.4 已核实的缓存事实

- `before_agent_start` 的 `event.systemPromptOptions.sections` 可变；pi 会把变化做成 system patch。
- 模型没有 `supportsMidConvoSystemMessages` 时，pi 会把所有 system 消息折叠成开头一条 system prompt，头部一变就整段缓存失效。
- `supportsMidConvoToolChanges`（Anthropic）和 `supportsAdditionalTools` / `supportsToolSearch`（OpenAI）是另一组"工具负载格式"flag，和 section 文本无关。
- 只有通道、没有工具格式的模型：section 变化便宜，工具变化贵。
- 目录里 Claude Sonnet 4.5 / Opus 4.5 / 4.6 没有 mid-convo 支持；Opus 4.8 / Opus 5 / Sonnet 5.5+ 有。
- 旧 GPT-5 没有 mid-convo 支持；GPT-5.4+ 有。
- 压缩不会丢 system prompt 状态；compaction entry 里的 `systemMessage` 会重放它。

### 5.5 协作者角色提示

- 放在 `prompts/collaborator_role.md`，纯 Markdown，没有 frontmatter。不做成 skill，因为协作者每次都需要它。
- 创建协作者会话时读一次文件（去掉首尾空白），通过内嵌扩展 `collab-role` 在 `before_agent_start` 里写进 `sections.collaborator_role`；pi 会自动包成 `<collaborator_role>`。
- 读不到文件就让创建失败，走正常的错误路径。
- 改了文件要等下次新建协作者会话才生效。
- 内容要点：运行中联系不到 Lead，需要 Lead 决定的事就停下来，说明做完了什么、没做什么、需要 Lead 处理什么；完整完成时按任务要求的格式报告，中途停下不用套格式；运行中收到的消息当作对当前任务的调整。

## 6. 消息与工具

### 6.1 术语

handoff 和 steer 是同一个 `send` 工具在不同运行状态下的行为名称，不是两个工具。它们只是本文的术语；给模型看的文字（skill、工具 description）不用这两个词，直接描述工具行为。

- **handoff**：Lead 通过 `send` 给空闲的 Collaborator 发消息，开启一轮任务。
- **steer**：Collaborator 正在运行时，Lead 再次调用 `send`，向当前运行补充指令。
- **report**：一次 Collaborator agent loop 最后 settle 之前输出的那段 assistant text，返回给 Lead。
- **中间文本**：Collaborator 运行过程中的其他 assistant text，不作为 report 自动投递；Lead 可以通过 `inspect` 查看。

### 6.2 Lead 工具

工具名是 `collab_send`、`collab_wait`、`collab_inspect`、`collab_interrupt`，下文简称 `send` / `wait` / `inspect` / `interrupt`。

- `send`：Lead 给 Collaborator 发消息的唯一工具，立即返回，不等待完成。
  - 协作者空闲 → handoff，开新一轮；正在跑 → steer 当前运行。
  - 协作者会话每写入一条 user message，就在 Lead 会话里写一条锚点 custom entry（`pi-collab/anchor`），记录它的 entry ID。
  - 只在 `active` 时可用。
  - 创建协作者会话失败：给用户弹红字提示，工具报错。
  - 这一轮没能启动（比如模型或认证有问题）：按 `error` 结果投递，见 7.3。
- `wait`：阻塞等待，见第 7 节。`timeout` 可不填，默认 300 秒，最大 1200 秒；skill 里只写"可能要几分钟"，不给具体数值。
- `inspect`：只读，查看协作者现在是否在跑，以及最近的活动。
  - 参数只有可选的 `count`，默认 5。
  - 一条活动是协作者回复里的一段文字，或者一个工具调用；不含思考、工具结果、Lead 发给它的消息、只有空白的文字。
  - 正在生成的那条回复也带上，里面的活动都标 `(generating)`；正在执行的工具调用标 `(running)`。不单独处理按顺序执行时排队的调用。
  - 工具参数用紧凑 JSON，超过 500 字符截断并标 `(truncated)`。
  - 输出开头一行 `status: running|idle`，每条活动以 `[text]` 或 `[tool_call 工具名]` 开头，条目之间空一行；外层不包 tag，因为它是工具结果，不会被当成用户消息。
  - 整体输出按 50k 截断，完整内容写到临时文件。
  - `paused` 时也能用。当前分支没有锚点、内存里也没有协作者会话时，报"还没有协作者"，不创建空会话。有锚点时会从文件加载协作者会话，不发请求。
  - 暂不做分页、区间、过滤，也不做显示工具结果的参数（用途不明确，误用会把大量内容塞进上下文）。
- `interrupt`：停止协作者当前运行的控制工具。
  - 先 `clearQueue()` 丢弃排队消息，再 `abort()` 当前运行。
  - 保留协作者 session 和上下文；本次运行不产生 report，之后可以用 `send` 开始新一轮。
  - 只在 `active` 且协作者正在运行时可用；协作者空闲或模式未开启时报错。

### 6.3 Collaborator 的 report

- Collaborator 不提供向 Lead 发消息的工具，只通过最终 assistant text 返回 report。
- 在 `agent_settled` 时确定本轮 report；不把中间的 `message_end` 当作任务完成。被 abort 的运行不投递结果。
- report 不带 `kind` 字段；Lead 自己从内容判断结果或需要回答的问题。
- 中间文本不进 wait 结果；Lead 想看就用 `inspect`。

### 6.4 投递路由

Collaborator settle 后，将运行状态和 report 一起投递：

```
waiting === true  → 结束等待，作为 wait 结果返回
waiting === false → pi.sendMessage(reportMessage, { triggerTurn: true })
                    Lead 空闲时开新一轮；Lead 正在跑时以 steer 投递，并置 pendingCollaboratorSteer
```

- 不 wait 时投递的是 `pi-collab/report` custom message，`display: true`，内容同样是 `<collaborator_report state="...">`。

## 7. wait 与生命周期

### 7.1 主路径

- Lead 主动调用 `wait`，工具阻塞 Lead 的 agent loop。
- 不设计"Lead 结束、系统替它等"的第二种模式。
- 正常完成路径上，如果协作者仍在运行，`agent_before_settle` 会用 nudge 拦截 Lead 结束；Lead 没 wait 就结束，仍视为协议违规。

### 7.2 违规兜底

`agent_before_settle` 里调用 `beforeLeadSettle`。满足条件时返回一个隐藏的 `custom_message` 草稿（`customType` 为 `pi-collab/nudge`），`index.ts` 把它追加到 `event.entries` 并返回 `continue: true`：

```
if collaborator missing or idle: return
if outcome === "error": 提示用户协作者仍在运行; return
if outcome !== "completed": return
return hidden custom_message draft  // 不设次数上限
```

- 只有 Lead 正常完成（`outcome === "completed"`）才 nudge；Lead 因错误结束时不继续，只给用户弹提示。
- 不设 nudge 次数上限：协作者在跑时 Lead 就不能停。
- nudge 内容提醒 Lead 调用 `wait`；若协作者卡住则调用 `interrupt`。
- 这不是长挂起，只持续到隐藏提醒进入下一次请求，Lead 随后应在工具里真正调用 `wait`。

### 7.3 wait 结果

- `wait` 只等协作者彻底停下，不再区分 message / settle 模式。
- 只有协作者停下时，结果才带 `state`，写成 `<collaborator_report state="...">`：
  - `completed`：最后一条 assistant 消息正常结束（`stopReason === "stop"`），标签里放它的文字作为 report；没有文字就是空标签。
  - `error`：其他停止原因（出错、达到输出上限、工具调用后被结束等），或这一轮没能启动。标签里放按原因写的说明，后面附原始错误；不带任何 report，中途的文字也不算。
  - 出错时同时给用户弹 `Collaborator error: 原文` 的红字提示。
- 其他结果不带 `state`，各自的文字已经说明了协作者的状态：
  - 超时：协作者还在跑，不提前返回 report。Lead 继续活跃，可以再 inspect / send / wait。
  - `interruptedByUser`：用户打断，协作者还在跑，见 7.5。
  - `aborted`：Lead 被中断，协作者也跟着被中断。
  - `collaboratorInterrupted`：wait 期间协作者被 `interrupt` 停下（包括和 wait 并行调用）；没有 report。Lead 被中止或切分支时仍是 `aborted`。
  - `reportQueued`：协作者在 wait 开始前已经停下，结果已经作为消息排队投递。
- 不设 `cancelled`。协作者被中断时使用 `collaboratorInterrupted`。
- report 如果太长，按类似 bash 的 50k 上限截断，完整内容写到临时文件，并在结果里给出路径。

### 7.4 等待状态机

- `waiting`：是否正在等待，一次只允许一个 wait；第二个直接报错。
- 存的是 resolve 回调，不是 promise 本身。
- 开始时先检查是否有已排队的结果（返回 `reportQueued`），再检查协作者是否空闲；空闲就直接报错，因为它上一轮的结果已经投递给 Lead 了。
- 超时 / abort 必须同步清理等待状态和 resolve。

### 7.5 被 steer 打断

- 用户在 wait 期间发消息 → 用 `interruptedByUser` 结果结束等待，`isError: true`。
- 用户消息作为单独消息出现在同一请求里，不塞进 tool result。
- 只对 `streamingBehavior === "steer"` 打断，`followUp` 不打断。
- 实现方式：`input` 事件后等一个 tick，再检查 `ctx.hasPendingMessages()`；图片处理可能延迟入队，所以用短间隔重试。
- 为什么不能直接在 `input` 里 resolve：`input` 比消息入队早，wait 返回后 loop 可能 poll 到空队列，steer 会迟一轮。
- 已核实：agent loop 在工具批次结束之后、下一次请求之前 drain steering。只要 steer 已在队列里，tool result 和 steer 会进同一请求。
- `hasPendingMessages()` 能看到用户 steer（`_queueSteer` 先 push 到 session 的 `_steeringMessages`，再 `agent.steer`，同步完成），但看不到扩展用 `sendMessage({ deliverAs: "steer" })` 塞的 custom message。
- 协作者 report 恰好在 wait 前被投递为 steer 的窄竞态：用一个 boolean `pendingCollaboratorSteer`，投递时置 true，Lead 的 `message_start` 看到对应 customType 时清掉；wait 开始时如果为 true，直接返回 `reportQueued`。

### 7.6 取消与导航

- ESC 取消 Lead 和 Collaborator，走正常 streaming 路径。
- `/tree`、`/fork`、`/resume`、`/new`、`/compact` 都会先 `abort()`，所以会取消当前 wait 和协作者。这是正常语义。
- `/reload`、切换 session、pi 退出（`session_shutdown`）：如果有 wait 在等，先 abort Lead 并等它 settle，让 wait 的工具结果写进会话；再 dispose 协作者 session，清 waiting 状态。

### 7.7 为什么不用自定义 editor / 长挂起

- ESC 只在 `isStreaming` 为 true 时走 abort 分支；空闲时走双击 ESC 的 tree/fork。
- `registerShortcut("escape", ...)` 会拦截所有 ESC 并吞掉默认处理。
- `setEditorComponent` 会覆盖用户已有的 editor（例如双击 ESC 取消的扩展）。
- 所以让 wait 工具保持 session streaming 是最干净的做法；不需要长挂起，也不需要碰 editor。

## 8. 压缩

- 规则在 skill 里，不重新注入。
- 压缩可能把最后一条状态消息总结掉。处理方式是在每次请求前的 `context` 事件里把它插回去，不发新消息、不写会话：
  1. 第一条消息不是 `compactionSummary` 就不处理。
  2. 在当前分支上找最近的 `compaction` 条目。会话文件里它追加在保留窗口之后，保留窗口从它的 `firstKeptEntryId` 开始。
  3. 从压缩条目往前找最后一条 `pi-collab/status` 消息：
     - 在保留窗口里：模型已经能看到，不插。
     - 在保留窗口之前：已被总结掉，原样插在 summary 后面。
     - 没找到：不插。
  4. 找不到 `firstKeptEntryId` 对应的条目时，当作没有保留窗口。
  5. 压缩之后才发的状态消息本来就在上下文里，不用管。
- 不在 `session_compact` 里重发：压缩可能发生在 Lead 运行中，`sendMessage` 会 steer，可能多出一轮。
- 切分支、fork/clone、恢复会话不需要补：状态消息和状态条目在同一条分支上，只有压缩会让它离开上下文。
- 状态事实来自分支上的 custom entry，不是 summary。
- 每次请求都扫一遍分支，开销可以忽略，不做缓存。

## 9. 分支同步

- 每次 Lead 发消息给协作者，在 Lead 会话写一条锚点 custom entry，记录协作者会话里对应的 user message entry ID。
- 切分支时（`session_tree`）：
  1. 先取消正在跑的协作者，dispose 它的 session，清掉分支相关的内存状态。
  2. 下次需要协作者时重新打开文件，从当前 leaf 往上找最近的锚点条目。
  3. 到协作者会话里，从锚点 entry 往后找下一个 user message：
     - 没有下一个 user：leaf 移到文件最后一个 entry；
     - 有下一个 user：在它之前向前找最近的 assistant message，找到就把 leaf 移到该 assistant；找不到则移到下一个 user 之前的 entry，再退回锚点 entry。
  4. 目标分支没有锚点 → 协作者 leaf 回根。模式状态另由分支上的状态条目决定，和锚点无关。
- 协作者会话因此变成一棵树；`branch()` 不删条目，forward 切换也能恢复。
- 切分支只同步上下文，不回滚文件改动。
- fork / clone：复制协作者文件，再用同样的锚点逻辑把副本 leaf 移到对应位置。
- 条目 ID 原样保留，所以 Lead 里复制的锚点仍然有效。
- 上述算法在有下一个 user 时取最近的 assistant message，但不检查它是否已经完成；"未完成 turn"是否必须保留到已完成 assistant 的语义仍待定。

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

- **Disable**：关闭协作模式，进入 `paused`，保留会话历史与配置。Collaborator 正在运行时拒绝关闭，弹黄色提示 "The collaborator is still running. Wait for it to finish before disabling collab mode."。不提示按 Esc 取消，因为 Esc 会连 Lead 一起停掉。
- **Change model or effort**：打开通用选择面板，初始光标定位到当前模型；完成后更新配置，协作模式保持 `active`。取消则保留原配置并返回总览。

总览面板按 Esc 关闭，不改变协作状态或配置。

配置生效时机：

- 沿用 pi 原生的 `setModel` / `setThinkingLevel` 行为，不另做延迟生效机制。
- Collaborator 空闲时修改，下一轮 handoff 使用新配置。
- Collaborator 正在运行时修改，从下一次模型请求开始使用新配置，不必等整个 agent loop 结束；已经发出的请求不受影响，也不重启当前运行。
- 当前安装的 pi 1.3.0 会直接更新 agent state，并在每次模型请求前通过 `prepareRequest` 读取最新模型和思考级别。
- 应用配置失败时弹 `Failed to apply collaborator configuration: 原文`。

### 10.4 其他界面

- 协作者状态显示（footer / widget / 只在 wait 的 tool 里）还没定。
- 用户默认看不到协作者的实时输出，只能看 report 和 inspect。
- 成本显示：footer 只算 Lead；协作者的 token/成本怎么展示还没定。

## 11. pi 内部机制

### 11.1 创建协作者会话

```ts
createAgentSession({
  cwd,
  agentDir,
  model,
  thinkingLevel,
  tools, // Lead 的启用工具，去掉 collab_* 工具
  resourceLoader, // extensionsOverride 过滤本扩展 + extensionFactories 注入 collab-role
  sessionManager, // 已有文件用 SessionManager.open，否则 SessionManager.create(cwd, collabDir, { id })
});
```

- 不传 `settingsManager`，pi 从同一个 `agentDir` 读全局设置。
- 协作者会话自带独立的缓存预热器，沿用全局 `cacheWarming`：默认 `streaming` 只在它跑的时候预热；设成 `idle` 时跑完后最多再预热 30 分钟，关闭 collab mode 不会停掉它。会话被 dispose 时预热器取消。

- `SessionManager.create(cwd, sessionDir?)`、`SessionManager.open(path)`、`SessionManager.inMemory()`。
- `getSessionFile()`、`getSessionId()`、`getHeader()`、`getBranch()`、`getEntries()`、`branch(entryId)`、`appendCustomEntry`、`appendCustomMessageEntry`。
- `session.subscribe(event => ...)`；`message_end` 是权威消息；`agent_settled` 是彻底停下。
- `session.prompt()` 在 streaming 时需要 `streamingBehavior`；`session.steer()` / `followUp()` 可直接用。
- `session.dispose()` 会 abort 当前工作。

### 11.2 事件

- `session_start`：`reason` 是 startup / new / resume / fork / reload，带 `previousSessionFile`。
- `session_before_switch`、`session_before_fork`（`entryId`、`position`）、`session_tree`（`newLeafId`、`oldLeafId`）。
- `session_compact`、`session_shutdown`。
- `context`：每次请求前拿到非 system 消息，可以返回新的 `messages`，不持久化。用于压缩后补状态消息。
- `resources_discover`：返回 `skillPaths` 等，只发给加载了本扩展的会话。
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

- 协作者的资源加载：当前通过 `DefaultResourceLoader` 使用 Lead 的 cwd/agentDir 默认加载项目上下文、skills、prompts 和扩展，仅过滤本扩展；MCP 与权限/审批仍待定。
- 模型与思考级别的默认策略（`src/command.ts`）：当前无已保存配置时，模型选择列表的光标默认停在 Lead 当前模型上，模型仍由用户选；思考级别取已保存配置、Lead 当前级别或 `medium`，再通过 `clampThinkingLevel` 限制到模型支持范围；更换模型后沿用当前思考级别并 clamp。这是否作为最终产品默认仍待确认。
- `inspect` 以后是否需要分页、区间、过滤。
- 协作者会话文件缺失/损坏时 Lead 看到什么。
- 分支同步里"未完成 turn"的完成性语义：当前 `findCollaboratorLeaf` 取下一个 user 之前最近的 assistant，找不到则取下一个 user 之前的 entry（没有下一个 user 时取最后 entry），不检查 assistant 是否已完成；是否要求"已完成"仍待定。
- 协作者自己的压缩：Lead 发过去的任务上下文被压掉后怎么办。
- 状态显示、成本显示、用户如何查看协作者输出。
- 怎么验证成本真的降了、质量没掉。

## 13. MVP 建议

按依赖顺序分三层，先跑通再补。目前三层列出的功能均已完成。

### 第一层：协作闭环

- 创建协作者 session，自定义 prompt，工具：read / bash / edit / write；最终 assistant text 作为 report。
- Lead 工具：`send`（handoff / steer）、`wait`、简单 `inspect`。
- 状态只用 `not_started` / `active`，custom entry + 开启消息。
- 常驻短 section + collab-mode skill。
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
