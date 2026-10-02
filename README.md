# 自用 DeepSeek Harness 插件

## 1. dsh-topmost

在 dsh 桌面窗口的**最小化按钮左侧**加一个「窗口置顶」开关：点亮后 dsh 窗口保持在其他窗口之上，再点一次恢复常规层级。

[dsh-topmost](/dsh-topmost)

## 2. dsh-thinking-levels

给**第三方（手写声明的）模型**补上「思考深度 / 推理等级」选择器，并让选中的等级真正随请求下发。

内置的 DeepSeek 官方模型本来就有这个选择器；而通过 `@deepseek-ai/dsh-llm-pi-ai` 手写声明的第三方路由（`api: openai-completions` + 自己的 `baseURL` + `models:` 列表）默认**没有**，因为它们没有声明自己支持哪些思考等级。

安装本插件后，这些路由的每个模型都会获得：

```
off · low · medium · high · xhigh · max
```

[dsh-thinking-levels](/dsh-thinking-levels/)

## 3. dsh-session-resume

请求失败后的**手动重试**，以及会话停止时的**无缝恢复**。

- **重试**：模型请求失败后不再直接终结本轮，而是挂起等待你的决定。点「重试」会在**同一轮、同一步、同一份历史**上原地重跑，模型收到的请求与失败前逐字节相同——不新增任何消息，对话记录里也看不出中断。
- **恢复**：输入框为空且会话已停止时，发送按钮保持可用（不再变灰）。点它即直接恢复会话继续未完成的工作，不需要你手动发「继续」。

[dsh-session-resume](/dsh-session-resume/)

## 4. dsh-session-rollback

编辑回溯：把过去的用户消息载入已有输入框编辑，发送时在该消息处新建分支，并把工作区文件恢复到那一刻（取消编辑即取消回溯）。

[dsh-session-rollback](/dsh-session-rollback/)

## 5. dsh-session-branch

在用户消息的复制按钮旁、以及 AI 响应底部的分支按钮旁显示会话分支翻页器 < n / N >。同一分叉点的兄弟分支中只保留当前分支在侧边栏可见，其余自动归档；用翻页器切到归档分支时会把它取回、并把原来的分支归档。

[dsh-session-branch](/dsh-session-branch)