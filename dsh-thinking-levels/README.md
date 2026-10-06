# dsh-thinking-levels

给**第三方（手写声明的）模型**补上「思考深度 / 推理等级」选择器，并让选中的等级真正随请求下发。

内置的 DeepSeek 官方模型本来就有这个选择器；而通过 `@deepseek-ai/dsh-llm-pi-ai` 手写声明的第三方路由（`api: openai-completions` + 自己的 `baseURL` + `models:` 列表）默认**没有**，因为它们没有声明自己支持哪些思考等级。

安装本插件后，这些路由的每个模型都会获得：

```
off · low · medium · high · xhigh · max
```

---

## 它到底做了什么

### 为什么原来没有选择器

Harness 渲染「推理等级」这一行，**只取决于** Host 模型目录里那个模型有没有 `reasoning` 元数据：

- `@deepseek-ai/dsh-client-ui-model-selection` 从 `ctx.remote.session.modelCatalog()` 读 `model.reasoning`；
- 该目录由 `buildModelCatalog()` → `ctx.llm.resolveModelInfo()` 生成；
- `resolveModelInfo()` 的结果来自 adapter 的 `resolveModel()`；
- `dsh-llm-pi-ai` 的 `resolveModel()` 读的是 pi-ai 模型描述符上的 `reasoning` / `thinkingLevelMap`；
- 手写声明的路由从 `reasoning: false` 起步 —— 除非你在 `cordis.patch.yml` 里给**每一个模型**都写上一段 `reasoningEfforts`。

而且就算你手选了等级，`LlmRuntime.resolveCallConfig()` 也会先拿同一份元数据校验，直接抛 `UNSUPPORTED_REASONING_EFFORT`，请求根本发不出去。

### 本插件的做法

不去改你的 `cordis.patch.yml`，而是在**所有读取路径唯一的漏斗**上给描述符补上能力：

```
PiAiAdapter.modelOf(snapshot, provider, model)
```

`modelInfo()`（目录 + 调用校验）和 `streamWithSnapshot()`（真正发请求）都经过它。补上 `reasoning` 与 `thinkingLevelMap` 之后，三件事同时成立：

| 环节 | 读取的东西 | 结果 |
|---|---|---|
| `resolveModel` / `prepareCall` → `modelInfo()` → `reasoningInfo()` | `model.reasoning`、`model.thinkingLevelMap` | 目录里出现 6 个等级 → **选择器出现** |
| `LlmRuntime.resolveCallWithInfo()` | 同上（`reasoning.efforts`） | 选中的等级被接受，不再报 `UNSUPPORTED_REASONING_EFFORT` |
| `streamWithSnapshot()` → `resolveReasoningLevel()` → pi-ai `{ reasoning }` | 同上 | pi-ai 按 `thinkingLevelMap` 把等级写成线上的 `reasoning_effort` → **选择生效** |

补完之后插件会发一次 `llm/adapters-updated`，浏览器端已经订阅了它（`catalog.refresh()`），所以**不用刷新页面**，打开模型菜单就能看到「推理等级」。

模型切换和重试也由插件一起处理：

- 切换模型时，如果当前有显式选择的 effort，且新模型也提供同一个 effort，插件会把它带到新模型；新模型不支持时则省略该字段，让新模型使用自己的默认值。
- 每次 `agent/request`（包括错误后的手动重试）都会重新读取 Session 最新的 `model/selection`。因此错误弹窗出现后先切换模型或思考深度，再点「重试」，这次请求会立即使用新选择，而不会复用失败时冻结的旧配置。

### 什么不会被改

- 已经声明过思考能力的模型（pi-ai 内置目录里的、或你自己写了 `reasoningEfforts` 的）**一律不动** —— 显式声明永远优先于插件的默认值。
- `off` 默认**不带线上取值**，也就是 pi-ai 自己的语义：「什么都不发」，等于该 provider 的默认行为。OpenAI 兼容端点没有统一的「别思考」写法；如果你的网关支持（比如 `reasoning_effort: none`），用 `wire.off` 指定即可。

---

## 配置

默认配置（`{}`）就会接管**所有第三方路由**。需要时在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-thinking-levels
  name: dsh-thinking-levels
  config:
    enabled: true
    routes: []            # 留空 = 所有「非内置目录」的 pi-ai 路由；填了则只接管这些
    skipRoutes: []        # 排除某些路由
    skipModels: []        # "route/model" 或裸 "model"
    levels: [off, low, medium, high, xhigh, max]
    wire: {}              # 等级 -> 线上取值；不写则用等级本身
    compat: {}            # 可选：{ thinkingFormat, supportsReasoningEffort, ... }
    reportPath: ""        # 可选：把自检快照写成 JSON 文件（见下）
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉即完全不介入 |
| `routes` | `[]` | 留空表示自动接管所有 `declared: true`（pi-ai 内置目录没有的）路由 |
| `skipRoutes` | `[]` | 从接管集合里去掉 |
| `skipModels` | `[]` | 精确跳过某些模型 |
| `levels` | 上面 6 个 | 提供哪些等级；`minimal` 也支持但默认不提供 |
| `wire` | `{}` | 等级 → 线上取值 |
| `compat` | `{}` | 透传给 pi-ai 的兼容开关 |
| `reportPath` | `""` | 填了就把 `/state` 的快照写成该路径的 JSON（无 cookie 的脚本也能读） |

### 关于线上取值（`wire`）

第三方网关对「思考深度」的叫法并不统一，`wire` 就是给它们改名用的：

```yaml
wire:
  low: low
  medium: medium
  high: high
  xhigh: high     # 网关只认 low/medium/high 时，把 xhigh 折叠到 high
  max: high
  off: none       # 网关支持显式关闭时
```

默认是**同名直传**：选 `high` 就发 `reasoning_effort: high`。这样做是刻意的 —— 如果默认把 `xhigh` 偷偷折叠成 `high`，选择器就在说谎（用户以为自己选了更高的档，实际没有）。要折叠请显式配置。

### 关于 `compat`

`dsh-llm-pi-ai` 会按 `baseURL` / provider 名自动探测协议兼容性，手写路由通常落在 `thinkingFormat: openai`（发 `reasoning_effort`）。如果你的网关要的是别家的写法，用 `compat.thinkingFormat` 指定，例如：

```yaml
compat:
  thinkingFormat: deepseek     # 发 thinking:{type:enabled} + reasoning_effort
```

可选值（来自 pi-ai）：`openai`、`deepseek`、`openrouter`、`together`、`baseten`、`zai`、`qwen`、`chat-template`、`qwen-chat-template`、`string-thinking`、`ant-ling`。

---

## 自检

插件自带两个只读诊断路由（只接受本机同源请求）：

```powershell
# 现在选择器会显示什么？直接问 Host 的公开 LLM 服务，不看插件自己的账本
curl.exe -s http://127.0.0.1:19387/api/dsh-thinking-levels/state

# 改了配置之后强制重新对账
curl.exe -s -X POST http://127.0.0.1:19387/api/dsh-thinking-levels/resync
```

`/state` 里每个模型都带 `efforts` —— 那正是模型菜单会渲染的等级列表。`efforts: null` 表示这个模型仍然没有思考能力（例如它本来就已经声明为不可思考）。

> 这两个路由和 harness 自己的 `/api/*` 一样，走的是浏览器会话鉴权：没有 cookie 的进程调用会拿到 `401 {"error":"unauthorized"}`。**在已登录的 GUI 页面地址栏里直接打开上面的 URL** 就能看到 JSON；要在脚本里读，请配置 `reportPath`。

### 跑一遍验证

插件自带一套不依赖运行中 harness 的验证（会真的调用已安装的 pi-ai，抓取它发出的请求体）：

```powershell
node test/verify.mjs
```

覆盖：第三方路由拿到 6 个等级、模型切换保留兼容 effort、错误后的重试读取最新模型/effort、`resolveModelInfo` 的形状、请求路径校验、已声明能力的模型不被改动、`levels`/`wire`/`skipModels`/`enabled` 配置、`dispose` 还原、以及最关键的 —— 选 `high`/`max`/`xhigh`/`low` 时 `reasoning_effort` 真的出现在请求体里、选 `off` 时什么都不发。

---

## 已知边界

- 依赖 `llm.adapters` 这个注册表来拿到 adapter 实例，并依赖 pi-ai adapter 暴露 `modelOf()` / `current()`。这不是公开契约；两者任一不存在时，插件对该路由**静默跳过**并在日志里说明，绝不猜测、绝不改配置。
- 装饰是**内存态**：`cordis.patch.yml` 保持原样，重启后由插件重新补上。如果你更希望能力写进配置（脱离插件也生效），那应该改用官方的 `reasoningEfforts` 字段。
- **改代码后必须重启 DSH**：loader 按模块说明符缓存已加载的模块，`set_plugin` 开关、改 profile 配置都不会重新执行本地 `link:` 插件的 `host.js`。只有重启进程才会加载新代码。
- 禁用插件（`enabled: false` 或直接卸载）时，`dispose` 会把改过的描述符按原样还原；唯一例外是被 `Object.freeze` 的描述符，它要等下一次快照重建。
- `routes` 留空时只接管「pi-ai 内置目录里没有的」路由。如果你的第三方路由**借用**了内置目录的名字（例如叫 `deepseek`），请显式写进 `routes`。
- `off` 与 `Default` 在默认配置下线上表现相同（都是「不发任何思考参数」），区别只在于 `off` 是用户显式选择、会记进会话日志。
- 第三方网关的 `baseURL` 里如果含有 `deepseek.com`，pi-ai 会把它判成 `thinkingFormat: deepseek`（发 `thinking:{type:enabled}`）；那同样能带上 `reasoning_effort`，但若网关不认，请用 `compat.thinkingFormat: openai` 明确指定。
