# better-claude-code-ui

[English](README.md) | [简体中文](README_CN.md)

为 [pi](https://pi.dev) 打造的 Claude Code 视觉风格扩展：包含主题、欢迎横幅（Banner）、状态栏、加载微标（Spinner）、回合尾注（Turn Footer）以及 CC 风格工具调用渲染 —— 逐行忠实对齐 Claude Code 源码实现。

## 安装

```bash
pi install npm:better-claude-code-ui
```

免安装直接体验：

```bash
pi -e npm:better-claude-code-ui
```

### 推荐设置

本扩展自带欢迎横幅，因此 pi 内置的启动标头会显得多余。建议在 `~/.pi/agent/settings.json` 中将其隐藏：

```json
{ "quietStartup": true }
```

首次在某个项目中打开时会展示完整的双栏横幅（扩展列表 + Skills），对齐 CC 的 `showOnboarding` 行为；后续在该项目中启动则使用精简版 Logo。

## 功能特性

**6 套主题**（可在终端输入 `/themes` 切换，或使用 `/cc-theme` 仅在 CC 主题间切换）：

- `claude-code-dark` / `claude-code-light` — 真彩色（Truecolor），键值逐项对齐 CC 官方配色
- `claude-code-dark-ansi` / `claude-code-light-ansi` — ANSI-16 颜色，适用于不支持真彩色的终端
- `claude-code-dark-daltonized` / `claude-code-light-daltonized` — 色弱/色盲友好变体

**UI 模块**：

- **欢迎横幅（Welcome banner）** — 启动时展示 CC 风格精简 Logo；检测到新版本或在项目中首次运行时显示边框盒式横幅
- **状态栏（Status line）** — 模型、工作目录 cwd（支持 `~` 缩写）、Git 分支
- **加载微标（Spinner）** — CC 经典动词轮换动画，带副标题信息：已耗时、Token 统计、`esc to interrupt`
- **回合尾注（Turn footer）** — 单次请求的成本与耗时概览，对齐 CC v2.1.234 行为
- **工具渲染（Tool rendering）** — CC 风格工具调用行（无背景色边框），支持连续调用合并折叠与 `⎿` 分支引导线，忠实还原 CC 规范的代码 Diff 渲染与语法高亮（基于 shiki）
- **思考过程（Thinking）** — 默认折叠并采用 CC 标签样式；支持 `alt+t` 展开
- **提示词输入区（Prompt editor）** — CC 经典的 `❯` 提示符指针

**命令**：

- `/cc-theme` — 主题选择器（仅限 CC 主题）
- `/cc-tools` — 切换 CC 风格工具渲染选项
- `/cc-spinner` — 加载动画微标选项

## 运行要求

运行于 pi (`@earendil-works/pi-coding-agent`) 内部；pi 核心包由宿主环境提供（作为 peer dependencies）。已在 pi 0.84.x 上完成测试。

## 开源协议

MIT
