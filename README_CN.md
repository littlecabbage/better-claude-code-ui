# better-claude-code-ui

[English](README.md) | [简体中文](README_CN.md)

为 [pi](https://pi.dev) 打造的 Claude Code 视觉风格扩展：包含主题、欢迎横幅（Banner）、状态栏、加载微标（Spinner）、回合尾注（Turn Footer）以及 CC 风格工具调用渲染 —— 逐行忠实对齐 Claude Code 源码实现。

## 安装

本仓库 fork 自 [Demo-0416/my-pi-extensions](https://github.com/Demo-0416/my-pi-extensions/tree/master/better-claude-code-ui)，请通过本仓库的 git 源安装：

```bash
pi install git:github.com/littlecabbage/better-claude-code-ui
```

免安装直接体验：

```bash
pi -e git:github.com/littlecabbage/better-claude-code-ui
```

> `npm:better-claude-code-ui` 是上游作者 Demo-0416 发布的 npm 包，不包含本 fork 的改动（例如 colorful 状态栏）。

### 开屏横幅

默认保留 pi 内置的启动标头和已加载资源列表（`[Context]`、`[Skills]`、`[Extensions]` 等）。执行 `/cc-banner cc` 可换成 Claude Code 风格的 Logo：首次在某个项目中打开或 pi 升级后显示带边框的双栏横幅（扩展列表 + Skills），之后显示精简 Logo。使用 CC 横幅时，pi 自带的标头就重复了，可以在 `~/.pi/agent/settings.json` 中隐藏：

```json
{ "quietStartup": true }
```

如果想保留 pi 的标头、只隐藏资源列表，用 `"quietStartup": "header"`。

## 功能特性

**6 套主题**（可在终端输入 `/themes` 切换，或使用 `/cc-theme` 仅在 CC 主题间切换）：

- `claude-code-dark` / `claude-code-light` — 真彩色（Truecolor），键值逐项对齐 CC 官方配色
- `claude-code-dark-ansi` / `claude-code-light-ansi` — ANSI-16 颜色，适用于不支持真彩色的终端
- `claude-code-dark-daltonized` / `claude-code-light-daltonized` — 色弱/色盲友好变体

**UI 模块**：

- **欢迎横幅（Welcome banner）**（需手动开启：`/cc-banner cc`）— 启动时展示 CC 风格精简 Logo；检测到新版本或在项目中首次运行时显示边框盒式横幅
- **状态栏（Status line）** — 两种样式：
  - `default`：单行暗色，显示模型、工作目录 cwd（支持 `~` 缩写）、Git 分支、上下文占比、成本、会话时长
  - `colorful`：三行共用一套三列网格，各分区上下对齐，多余空间平均分到列间距：

    ```
    [xai] grok-4.7 (medium)             [Topic] 状态栏分区改版                            [Context] ████░░░░░░░░ 36% · 91k · 256k
    [Usage] $0.39 · 5m 8s · 1 turn      [Perf] TTFT 402ms · Gen 63.9t/s · E2E 45.6t/s     [Cache] 96%
    [Workspace] ~/projects/app          [Git] main   [Platform] macOS 27.0.1 (arm64)      [System] CPU 10% · Mem 54% · Net ↓2K/s ↑6K/s
    ```

    - 第一行：`[供应商] 模型 (thinking 等级)`；对话主题（`/name` 设置的 session 名称，没有时取第一条用户消息）；上下文进度条、百分比、已用 token、窗口大小
    - 第二行（本次对话）：会话成本、时长、轮次；最近一次请求的 TTFT、首 token 之后的生成速度（Gen）、端到端速度（E2E）；缓存命中率。第一次请求完成前显示 `--`
    - 第三行（运行环境）：工作目录、Git 分支、操作系统和架构；每 2 秒采样一次的 CPU、内存、网速。网速只统计物理网卡和无线网卡，Windows 上不显示
    - 数值超过阈值会变黄或变红
    - 长度不固定的字段有最长宽度，超出用 `…` 截断：模型 36 列（只截断模型 id，保留供应商和 thinking 等级）、供应商 14、主题 30、工作目录 40、Git 分支 20、系统名称 24
    - 终端较窄时先压缩中间列（去掉系统版本号和 E2E），再截断路径和模型 id，最后缩短进度条、去掉网速。任何宽度下各列都保持对齐
- **加载微标（Spinner）** — CC 经典动词轮换动画，带副标题信息：已耗时、Token 统计、`esc to interrupt`
- **回合尾注（Turn footer）** — 单次请求的成本与耗时概览，对齐 CC v2.1.234 行为
- **工具渲染（Tool rendering）** — CC 风格工具调用行（无背景色边框），支持连续调用合并折叠与 `⎿` 分支引导线，忠实还原 CC 规范的代码 Diff 渲染与语法高亮（基于 shiki）
- **思考过程（Thinking）** — 默认折叠并采用 CC 标签样式；支持 `alt+t` 展开
- **提示词输入区（Prompt editor）** — CC 经典的 `❯` 提示符指针

**命令**：

- `/cc-theme` — 主题选择器（仅限 CC 主题）
- `/cc-tools` — 切换 CC 风格工具渲染选项
- `/cc-spinner` — 加载动画微标选项
- `/cc-banner [default|cc|toggle]` — 切换开屏横幅：`default` 为 pi 内置启动标头，`cc` 为 CC 风格 Logo。选择保存到 `~/.pi/settings.json`（`ccBanner`），执行 `/reload` 或重启 pi 后生效
- `/cc-statusline [default|colorful|toggle]` — 切换状态栏样式。选择会保存到 `~/.pi/settings.json`（`ccStatusLineStyle`），执行 `/reload` 或重启 pi 后生效

## 运行要求

运行于 pi (`@earendil-works/pi-coding-agent`) 内部；pi 核心包由宿主环境提供（作为 peer dependencies）。已在 pi 0.84.x 上完成测试。

## 开源协议

MIT
