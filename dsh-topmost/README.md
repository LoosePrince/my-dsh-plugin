# dsh-topmost

在 dsh 桌面窗口的**最小化按钮左侧**加一个「窗口置顶」开关：点亮后 dsh 窗口保持在其他窗口之上，再点一次恢复常规层级。

```
┌─────────────────────────────┬────┬────┬────┐
│  …（窗口顶栏）…             │ 📌 │ ─  │ □  │ ✕ │
└─────────────────────────────┴────┴────┴────┘
                               ↑ 本插件
```

## 它做了什么

- **Host 半身**（`index.js`）：通过 `user32` 找到桌面外壳的顶层窗口，用 `SetWindowPos` 切换 `WS_EX_TOPMOST`（不移动、不缩放、不激活窗口），并把自己的一条 HTTP 路由 `/api/dsh-topmost`（`GET /state`、`POST /toggle`）注册到 `webServer` 上。
- **Client 半身**（`client.js`）：往框架的 `shell.overlay` 槽注册一个按钮，放在窗口顶栏里原生按钮的左侧，用主题 token 取色，`aria-pressed` 表达开关状态。

为什么走 Win32 而不是 Electron API：窗口属于 Electron 主进程，而本插件运行在外壳拉起的 Host 子进程（`dsh-desktop-host`）里，外壳的 IPC 没有暴露窗口状态这类动词，所以子进程直接对同一个窗口句柄操作。`koffi` 从宿主进程自身的模块图解析（不随插件安装依赖）。

## 位置是怎么算出来的

Windows 为每个标题栏按钮预留 `SM_CXSIZE + 2 × SM_CXPADDEDBORDER` 个物理像素，三个原生按钮因此占据窗口右边缘起的三倍宽度。Host 用 `GetDpiForWindow` / `GetSystemMetricsForDpi` 读出这个宽度并换算成 CSS 像素交给 Client（例如 125% 缩放下为 134.4px），Client 把按钮放在 `right: 134.4px`、宽度取三分之一，正好与原生按钮同宽同高（高度取框架自己发布的 `--dsh-windows-titlebar-height`）。若外壳暴露了 Window Controls Overlay 的 `env(titlebar-area-*)`，则优先用实测值，DPI 变化时重新测量。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单：`dsh.bundle.patch` 挂 Host 半身，`dsh.client` 声明浏览器半身 |
| `cordis.patch.yml` | 一行 `insert`，把 `dsh-topmost` 这一行挂进 profile |
| `index.js` | Host 半身：Win32 置顶控制 + `/api/dsh-topmost` 路由 + 请求信任栅栏 |
| `client.js` | 浏览器半身：`shell.overlay` 里的顶栏按钮 |
| `locale/*.json` | 插件管理页里的名称与描述 |
| `icon.svg` | 插件图标 |

## 安装与卸载

安装：`plugin_manager` 的 `install_bundle`，`target` 填本目录的绝对路径。

卸载：`plugin_manager` 的 `remove_bundle`，`target` 填 `dsh-topmost`。

## 已知边界

- 只在 **Windows 桌面版** 有意义：浏览器里打开的会话没有可置顶的窗口，Host 会回 `supported: false`，按钮不渲染。
- 置顶状态由窗口自己持有，**不跨重启保留**（重新打开 dsh 后回到常规层级）。
- 按钮是 Web 内容，原生按钮永远绘制在它之上；它只占据原生按钮左侧那块由页面绘制的顶栏区域，不覆盖系统按钮，也不参与窗口拖拽（自身标了 `-webkit-app-region: no-drag`）。
