# dsh-session-resume

请求失败后的**手动重试**，以及会话停止时的**无缝恢复**。

- **重试**：模型请求失败后不再直接终结本轮，而是挂起等待你的决定。点「重试」会在**同一轮、同一步、同一份历史**上原地重跑，模型收到的请求与失败前逐字节相同——不新增任何消息，对话记录里也看不出中断。
- **恢复**：输入框为空且会话已停止时，发送按钮保持可用（不再变灰）。点它即直接恢复会话继续未完成的工作，不需要你手动发「继续」。

---

## 一、为什么重试必须「挂起」

DSH 的 `agent/request-error` 是唯一一个能在**不新增 user 消息**的前提下重跑模型请求的扩展点：返回 `{ kind: 'retry' }`，循环就会重跑同一个 step。

代价是这一轮必须保持打开。所以本插件在失败时把这次尝试**挂起**（而不是让它终结），并在以下任一情况释放：

| 释放条件 | 结果 |
|---|---|
| 点「重试」 | 原地重跑该 step，零痕迹 |
| 点「放弃」 | 交给下游，失败按原样终结（出现原生「本轮运行失败」行） |
| 点「停止」/ 会话被取消 | 释放，本轮按取消结束 |
| 超过 `parkTimeoutMs`（默认 30 分钟） | 自动释放，按失败终结 |
| 插件被卸载 | 全部释放 |

**因此挂起期间会话在主机侧仍算「运行中」**（侧边栏会显示运行状态），但界面会显示一条明确的失败条：「本轮运行失败 … [重试] [放弃]」。这是这个设计唯一可见的代价，换来的是真正零痕迹的重试。

> 若你的 provider 配了 `retryPolicy.mode: always`（无限自动重试），插件默认**不介入**，把恢复权交还给该策略。想改成手动把关，设 `manualOnAlways: true`。

## 二、恢复会话的机制与边界

**架构上的硬约束**：一个**已经关闭的轮次**，只能通过向 agent 收件箱投递新输入来重新驱动——而任何进入收件箱的消息都会成为模型可见的历史。也就是说，「零痕迹地恢复一个已结束的轮次」在 DSH 里无法做到；唯一能零痕迹续跑的，是上面那种「步骤仍然打开」的情形。

所以本插件的恢复这样实现，尽量贴近你要的效果：

- 投递的是一条 **`runtime-context` 来源**的续跑消息，内容优先复用该会话**自己最近一次运行时上下文快照的原文**——也就是 harness 本来就会在步骤之间注入的那段文本。
- 于是模型读到的是**一次普通的运行时上下文刷新**，而不是一条「继续」指令；`user` 来源才会渲染成用户气泡，而 `runtime-context` 会渲染成一条低调的上下文行。
- 会话没有历史时不会恢复；会话正在运行时拒绝恢复。

想改成更直白的续跑指令，设 `continuationText`（此时来源会切换为 `plugin`，界面显示为折叠的「插件触发」行）。

## 三、配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖即可：

```yaml
- id: dsh-session-resume
  name: dsh-session-resume
  config:
    # 挂起最长等待时间（毫秒），超时按失败终结。默认 1800000（30 分钟）
    parkTimeoutMs: 1800000
    # 是否在 provider 的 always 重试策略下也接管为手动重试。默认 false
    manualOnAlways: false
    # 显式指定续跑文本；省略则复用会话最近的运行时上下文快照原文
    # continuationText: 'Continue the interrupted work.'
```

## 四、实现

| 文件 | 作用 |
|---|---|
| `host.js` | Host 半身：`agent/request-error` 挂起、会话恢复动作、自有 HTTP 路由 |
| `client.js` | 浏览器半身：失败条 + 发送按钮接管 |
| `cordis.patch.yml` | bundle 补丁：一行 insert 挂载 Host 半身 |
| `locale/*.json` | 插件页显示用的标题与说明 |

两端通过插件自己的路由通信，**不往会话日志写任何自定义事件**——持久化读路径不认识的事件会让日志无法解释，所以这里刻意回避。

Client 半身只在必要时才接管发送按钮：会话已停止、草稿为空、有历史、且没有挂起的重试。接管方式是给原生发送按钮打一个标记（恢复其可用外观）并在其正上方放一个同尺寸的点击层——点击层挂在 `document.body` 上，不进入 React 的 composer 树，因此不会干扰协调。

### 两个必须知道的坑

**1. Cordis 的服务不能直接读属性。** 未声明依赖的 fiber 读 `ctx.agents` 会抛
`cannot get property "agents" without inject`——如果像本插件最初那样用
`try { ctx.agents.get(id) } catch { return undefined }` 包起来，异常会被静默吞掉，
表现就是「插件装了但完全没反应」。正确写法是 `ctx.inject(['agents'], (scoped) => …)`
（与 `webServer` 同一套模式），并用 `ctx.get('agents')` 兜住注入 fiber 就绪前的窗口。

**2. 改 Host 代码必须重启 DSH。** Node 会缓存 `package.json` 的 `exports`，
所以即使改了 `exports` 指向新文件、甚至删掉旧文件，正在运行的进程仍会拿到
第一次导入的那个模块（内存里的旧模块）。Plugin Manager 对「包替换」也会明确报
`restart-required`。Client 半身不受影响：它按文件提供，重新选择 bundle 即可生效。

## 五、安装 / 卸载

```powershell
# 安装（本地 link）
# 在 profile package.json 的 dependencies 加：
#   "dsh-session-resume": "link:<本目录绝对路径>"
# 并在 dsh.profile.bundles 里追加 "dsh-session-resume"
# 然后 pnpm install
```

卸载：从 `dsh.profile.bundles` 与 `dependencies` 移除，再 `pnpm install`。

### 回归测试

`.plugin-work/test-host.mjs` 是一个不依赖运行时的 Host 半身测试：用一个最小
Cordis 假上下文（其中 `ctx.agents` 故意按真实行为抛异常）驱动 `apply()`，覆盖
挂起/重试/放弃/中止/always 策略/恢复/参数校验，以及第 8 项——**注册表必须能通过
`inject` 与 `ctx.get` 两条路取到**（就是上面第 1 个坑的回归测试）。

```powershell
& "<node>" "<workspace>\.plugin-work\test-host.mjs"
```

---

## 六、会话分支翻页器 `< n / N >`

**「快照」= 会话分支。** DSH 的「在新对话中分支」会以某个事件序号为**切割点**复制出一个子会话；
同一个切割点产生的所有会话互为兄弟。翻页器就显示「当前是第几个分支，共几个」。

切割点不需要猜：子会话的 `Session.inheritedEventCount` 就是「复制过来的源事件数」，
所以 `boundary = inheritedEventCount - 1`，与父会话的序号空间直接可比。

Host 用 `ctx.sessionQuery` 取**完整语料**（活着的 + 已落盘的），而不是只取活着的 `ctx.sessions`，
再按 `{kind:'parent'}` 过滤出同一个父会话下的所有子会话，逐个比对切割点——只有切割点完全
相同的才算兄弟。

翻页器挂在两处：

| 位置 | 做法 |
|---|---|
| AI 响应底部、**新分支按钮旁** | 注册官方插槽 `conversation.chat.assistant-actions`（就渲染在 Copy 与 Branch 之间），拿到 `messageId` 干净渲染 |
| 用户消息的**复制按钮旁** | 官方用户气泡渲染器没有 extra-actions 座位，所以走稳定的 `data-*` 契约：`[data-chat-flow-kind="user"]` 是消息行、`data-chat-flow-key` 就是消息 id、`[data-clock="start"]` 是它的操作行。用 MutationObserver 注入并在 React 重建行后自动补回 |

一个切割点会**同时**锚在它前一条和后一条消息上（分歧就在这两条之间），这正好覆盖你要的
两个位置。点击 `‹`/`›` 用 `ctx.uiWorkspace.openSession(sibling)` 切到兄弟分支。

## 七、编辑回溯

用户消息操作行里的 ✎ 按钮：

1. 点击 → `POST /rollback/plan` 拿到该消息的 `boundary`、**原文**和**将要恢复的文件清单**；
2. 原文被塞进**已有的输入框**（`inputActions.setDraft`），横幅提示「发送后将在该消息处新建分支，
   并恢复 N 个文件」；
3. 此时**取消编辑（横幅上的取消，或把草稿清空）即取消回溯**，什么都还没发生；
4. 按发送（发送按钮被接管，Enter 也被捕获）→ 依次：
   `ctx.sessions.fork({atSeq: boundary})` 分叉 → `POST /rollback/apply` 写回文件并把编辑后的文本
   投进子会话 → 打开子会话。

**文件快照怎么来的：** 不需要拦截工具调用。官方的 `write` / `edit` / `str_replace_editor`
的结果里本来就带 `{ path, before, after }`——`before` 就是这次改动前的完整原文。插件监听
`tools/result`，把 `before` 按内容 sha1 存进 `$DSH_HOME/storages/session-resume/<sessionId>/`，
并记一条 `{seq, path, blob|existed:false}`。

回溯到 `boundary` 时：对每个路径取**切割点之后最早**的那条记录，写回原文；若当时文件**不存在**
（`before === null`，即创建）就删掉它。超过 4 MB 的文件记为 `skipped`，不参与恢复。

**已知边界：** 只覆盖文件工具（`write`/`edit`/`str_replace_editor`）的改动——纯 shell 命令
改的文件不会被记录；这也是官方 `workspaceChanges` 在当前工作区（**不是 git 仓库**）下的同一限制。
