# better-claude-code-ui

[English](README.md) | [简体中文](README_CN.md)

Claude Code visual identity for [pi](https://pi.dev): themes, welcome banner, status line, spinner, turn footer, and CC-style tool rendering — faithfully aligned against the Claude Code source, line by line.

## Install

This repository is a fork of [Demo-0416/my-pi-extensions](https://github.com/Demo-0416/my-pi-extensions/tree/master/better-claude-code-ui). Install from this repo's git source:

```bash
pi install git:github.com/littlecabbage/better-claude-code-ui
```

Try it without installing:

```bash
pi -e git:github.com/littlecabbage/better-claude-code-ui
```

> `npm:better-claude-code-ui` is the upstream package published by Demo-0416. It does not include this fork's changes, such as the colorful status line.

### Recommended setting

This extension draws its own welcome banner, so pi's built-in startup header
becomes redundant. Hide it in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```

The full two-column banner (extensions + skills) appears the first time you
open a given project, matching CC's `showOnboarding` behavior; later starts in
that project use the condensed logo.

## What you get

**6 themes** (`/themes` to switch, or use `/cc-theme` for a CC-only picker):

- `claude-code-dark` / `claude-code-light` — truecolor, matched key-by-key to CC's palette
- `claude-code-dark-ansi` / `claude-code-light-ansi` — ANSI-16 for terminals without truecolor
- `claude-code-dark-daltonized` / `claude-code-light-daltonized` — color-blind friendly variants

**UI modules**:

- **Welcome banner** — CC's condensed logo on startup, boxed banner for new versions / first run in a project
- **Status line** — two styles:
  - `default`: one dim line with model, cwd (with `~` shortening), git branch, context %, cost, and session time
  - `colorful`: three rows on a shared three-column grid, so sections line up vertically and the spare space is spread between columns:

    ```
    [xai] grok-4.7 (medium)            [Topic] Refactor status line                     [Context] ████░░░░░░░░ 36% · 91k · 256k
    [Usage] $0.39 · 5m 8s · 1 turn     [Perf] TTFT 403ms · Gen 63.9t/s · E2E 45.6t/s    [Cache] 96%
    [Workspace] ~/projects/app         [Git] main   [Platform] macOS 27.0.1 (arm64)     [System] CPU 10% · Mem 54% · Net ↓2K/s ↑6K/s
    ```

    - Row 1: `[provider] model (thinking level)`; session topic (the `/name` session name, or the first user message); context usage bar with percent, used tokens and window size
    - Row 2, this conversation: session cost, duration and turns; last-request TTFT, generation speed after the first token (Gen) and end-to-end speed (E2E); cache hit rate. Shows `--` until the first request finishes
    - Row 3, environment: working directory, git branch, OS and architecture; live CPU, memory and network speed, sampled every 2 seconds. Network speed counts physical and Wi-Fi interfaces only and is not shown on Windows
    - Values turn yellow or red as they cross thresholds
    - Free-form fields have a maximum width and are truncated with `…`: model 36 columns (only the model id is cut; provider and thinking level stay), provider 14, topic 30, workspace 40, git branch 20, OS name 24
    - On narrow terminals the middle column compacts first (drops the OS version and E2E), then paths and model ids are truncated, then the context bar shrinks and network speed is dropped. Columns stay aligned at every width
- **Spinner** — CC's verb rotation with byline: elapsed time, token count, `esc to interrupt`
- **Turn footer** — per-request cost/duration summary, matching CC v2.1.234 behavior
- **Tool rendering** — CC-style tool rows (no background box), grouped consecutive calls with `⎿` continuation lines, CC-faithful diff rendering with syntax highlighting (shiki)
- **Thinking** — collapsed by default with CC's label treatment; `alt+t` to expand
- **Prompt editor** — CC's `❯` prompt pointer

**Commands**:

- `/cc-theme` — theme picker (CC themes only)
- `/cc-tools` — toggle CC-style tool rendering options
- `/cc-spinner` — spinner options
- `/cc-statusline [default|colorful|toggle]` — switch the status line style. The choice is saved to `~/.pi/settings.json` (`ccStatusLineStyle`) and applies after `/reload` or restarting pi

## Requirements

Runs inside pi (`@earendil-works/pi-coding-agent`); pi core packages are peer dependencies provided by the host. Tested against pi 0.84.x.

## License

MIT
