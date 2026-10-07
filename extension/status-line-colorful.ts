/**
 * Colorful status line variant：三行分区布局
 *
 * 每行由若干 [Label] 分区组成，分区之间等间距铺满整行：
 * - 第一行：🤖【provider】model (thinking) · [Topic] 对话名称 · [Context] 进度条 % · 已用 · 窗口
 * - 第二行（本次对话）：[Usage] 成本 · 时长 · 轮次 · [Perf] TTFT · Gen · E2E · [Cache] 命中率
 * - 第三行（运行环境）：[Workspace] 路径 · [Git] 分支 · [Platform] OS (arch) · [System] CPU · Mem · Net
 *
 * 只在模型前保留一个 emoji，其余用文字标签 + 颜色区分状态。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { arch, homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isExtraDetail } from "./commands.js";
import { SysMonitor, formatRate } from "./sys-monitor.js";

export function tildeHome(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
}

interface AssistantUsage {
	usage: {
		cost: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number };
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${Math.round(n / 1000000)}M`;
}

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const hours = Math.floor(totalSec / 3600);
	const mins = Math.floor((totalSec % 3600) / 60);
	const secs = totalSec % 60;
	if (hours < 1) return `${mins}m ${secs}s`;
	return `${hours}h ${mins}m ${secs}s`;
}

function formatSpeed(tokensPerSec: number): string {
	if (tokensPerSec >= 100) return `${Math.round(tokensPerSec)}t/s`;
	if (tokensPerSec >= 10) return `${tokensPerSec.toFixed(1)}t/s`;
	return `${tokensPerSec.toFixed(2)}t/s`;
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// 绘制上下文使用进度条
function drawContextBar(pct: number, width: number = 20): string {
	// clamp 到 0-100：用量超过窗口时 repeat(负数) 会抛 RangeError
	const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

// 一行分区的最小宽度：各段宽度 + 段间最小间距（2 列）
function minLineWidth(segments: string[]): number {
	const segs = segments.filter((s) => visibleWidth(s) > 0);
	return segs.reduce((n, s) => n + visibleWidth(s), 0) + Math.max(0, segs.length - 1) * 2;
}

// 把若干段等间距铺满整行（首段贴左、末段贴右，中间段均分剩余空间）
function spreadLine(segments: string[], width: number): string {
	const segs = segments.filter((s) => visibleWidth(s) > 0);
	if (segs.length === 0) return "";
	if (segs.length === 1) return truncateToWidth(segs[0]!, width, "…");
	const total = segs.reduce((n, s) => n + visibleWidth(s), 0);
	const gaps = segs.length - 1;
	const free = width - total;
	if (free < gaps * 2) return truncateToWidth(segs.join("  "), width, "…");
	const base = Math.floor(free / gaps);
	let extra = free % gaps;
	let out = segs[0]!;
	for (let i = 1; i < segs.length; i++) {
		out += " ".repeat(base + (extra > 0 ? 1 : 0)) + segs[i];
		extra -= 1;
	}
	return out;
}

// 取消息的纯文本（content 可能是 string 或 content block 数组）
function messageText(content: unknown): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? ((c as { text?: string }).text ?? "") : ""))
			.join(" ");
	}
	return text.replace(/\s+/g, " ").trim();
}

export function registerColorfulStatusLine(pi: ExtensionAPI): void {
	// 状态跟踪
	let cost = 0;
	let turns = 0;
	let earliestMs = Date.now();
	let sessionStartMs = Date.now();
	
	// 最近一次对话的性能指标
	let lastTurnStartMs: number | null = null;
	let lastFirstTokenMs: number | null = null;
	let lastStreamEndMs: number | null = null;
	let lastOutputTokens = 0;
	let lastTtft: number | null = null;
	let lastDecodeSpeed: number | null = null;
	let lastThroughput: number | null = null;
	
	// 最近一次请求的缓存统计
	let lastCacheRead = 0;
	let lastCacheWrite = 0;
	let lastInput = 0;

	// 对话主题：优先用 session 名称（/name 或其它扩展设置），否则取第一条用户消息
	let firstUserText = "";
	let requestRender: (() => void) | undefined;
	pi.on("session_info_changed", async () => {
		requestRender?.();
	});

	// 监听 turn_start
	pi.on("turn_start", async () => {
		lastTurnStartMs = Date.now();
		lastFirstTokenMs = null;
		lastStreamEndMs = null;
		lastOutputTokens = 0;
		lastCacheRead = 0;
		lastCacheWrite = 0;
		lastInput = 0;
	});

	// 监听 message_update（捕获首个 token）
	pi.on("message_update", async (event) => {
		if (event.message?.role === "assistant" && !lastFirstTokenMs) {
			const deltaEvent = event.assistantMessageEvent;
			if (deltaEvent?.type === "text_delta" || deltaEvent?.type === "thinking_delta") {
				lastFirstTokenMs = Date.now();
			}
		}
	});

	// 监听 message_end
	pi.on("message_end", async (event) => {
		if (event.message?.role === "assistant") {
			const msg = event.message as unknown as { 
				usage?: { 
					cost?: { total?: number };
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
				} 
			};
			const msgCost = msg.usage?.cost?.total ?? 0;
			const outputTokens = msg.usage?.output ?? 0;
			const inputTokens = msg.usage?.input ?? 0;
			const cacheRead = msg.usage?.cacheRead ?? 0;
			const cacheWrite = msg.usage?.cacheWrite ?? 0;
			
			cost += msgCost;
			lastOutputTokens = outputTokens;
			lastInput = inputTokens;
			lastCacheRead = cacheRead;
			lastCacheWrite = cacheWrite;
			lastStreamEndMs = Date.now();
			
			// 计算性能指标
			if (lastTurnStartMs && lastFirstTokenMs && lastStreamEndMs && outputTokens > 0) {
				lastTtft = lastFirstTokenMs - lastTurnStartMs;
				
				const decodeDuration = lastStreamEndMs - lastFirstTokenMs;
				if (decodeDuration > 0) {
					lastDecodeSpeed = (outputTokens / decodeDuration) * 1000;
				}
				
				const totalDuration = lastStreamEndMs - lastTurnStartMs;
				if (totalDuration > 0) {
					lastThroughput = (outputTokens / totalDuration) * 1000;
				}
			}
		} else if (event.message?.role === "user") {
			turns += 1;
			if (!firstUserText) firstUserText = messageText((event.message as { content?: unknown }).content);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// 从历史记录中恢复状态
		cost = 0;
		turns = 0;
		firstUserText = "";
		earliestMs = Date.now();
		
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const msg = e.message as unknown as AssistantUsage;
				cost += msg.usage?.cost?.total ?? 0;
			}
			if (e.type === "message" && e.message.role === "user") {
				turns += 1;
				if (!firstUserText) firstUserText = messageText((e.message as { content?: unknown }).content);
			}
			if (typeof e.timestamp === "string") {
				const t = Date.parse(e.timestamp);
				if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
			}
		}
		sessionStartMs = earliestMs;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			// 每个 footer 实例一个采样器，dispose 时停止
			const monitor = new SysMonitor();
			monitor.onUpdate = () => tui.requestRender();
			monitor.start();
			requestRender = () => tui.requestRender();
			return {
				dispose() {
					unsub();
					monitor.stop();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const dot = theme.fg("dim", " · ");
					const label = (name: string) => theme.fg("dim", `[${name}]`);
					const pctColor = (v: number, warnAt: number, errAt: number) => (v > errAt ? "error" : v > warnAt ? "warning" : "success");

					// 基础信息
					const modelId = ctx.model?.id ?? "no-model";
					const provider = ctx.model?.provider ?? "";
					const thinkingLevel = pi.getThinkingLevel?.() ?? ctx.thinkingLevel ?? "off";
					const usage = ctx.getContextUsage();
					const window = ctx.model?.contextWindow ?? 0;
					const tokens = usage?.tokens ?? 0;
					const pct = window > 0 ? Math.round((tokens / window) * 100) : 0;
					const warn = window > 0 && tokens > window * 0.9;
					const critical = window > 0 && tokens > window * 0.95;

					const lines: string[] = [];

					// === 第一行：🤖【provider】model (thinking)   [Topic] 名称   [Context] 进度条 % · 已用 · 总量 ===
					let model = "🤖" + (provider ? theme.fg("muted", `【${provider}】`) : " ") + theme.fg("accent", modelId);
					if (thinkingLevel !== "off") {
						const thinkingColor = ["high", "xhigh", "max"].includes(thinkingLevel) ? "warning" : "muted";
						model += theme.fg(thinkingColor, ` (${thinkingLevel})`);
					}

					const title = pi.getSessionName()?.trim() || firstUserText;
					const topic = (maxWidth: number) =>
						title && maxWidth >= 6 ? `${label("Topic")} ${theme.fg("text", truncateToWidth(title, maxWidth, "…"))}` : "";

					const context = (barWidth: number) => {
						if (tokens <= 0 && window <= 0) return "";
						const color = critical ? "error" : warn ? "warning" : pct > 50 ? "text" : "success";
						const bar = barWidth > 0 ? drawContextBar(pct, barWidth) + " " : "";
						return (
							`${label("Context")} ` +
							theme.fg(color, `${bar}${pct}%`) +
							dot +
							theme.fg("text", tokens > 0 ? formatTokens(tokens) : "0") +
							dot +
							theme.fg("muted", window > 0 ? formatTokens(window) : "--")
						);
					};

					// 宽度不够时依次：主题缩短到 12 列 → 去掉进度条 → 去掉主题
					const line1Candidates = [
						[model, topic(24), context(12)],
						[model, topic(12), context(12)],
						[model, topic(12), context(0)],
						[model, context(0)],
					];
					const fit1 = line1Candidates.find((segs) => minLineWidth(segs) <= width) ?? line1Candidates[line1Candidates.length - 1]!;
					lines.push(spreadLine(fit1, width));

					// === 第二行（本次对话）：[Usage] 成本 · 时长 · 轮次   [Perf] TTFT · Gen · E2E   [Cache] 命中率   [Detail] ===
					const none = theme.fg("dim", "--");
					const usageSeg =
						`${label("Usage")} ` +
						[
							theme.fg(cost > 1 ? "warning" : "muted", `$${cost.toFixed(2)}`),
							theme.fg("muted", formatDuration(Date.now() - sessionStartMs)),
							theme.fg("muted", `${turns} ${turns === 1 ? "turn" : "turns"}`),
						].join(dot);

					const ttft = lastTtft !== null
						? theme.fg(lastTtft < 1000 ? "success" : lastTtft < 3000 ? "text" : "warning", formatMs(lastTtft))
						: none;
					const gen = lastDecodeSpeed !== null
						? theme.fg(lastDecodeSpeed > 50 ? "success" : lastDecodeSpeed > 20 ? "text" : "warning", formatSpeed(lastDecodeSpeed))
						: none;
					const e2e = lastThroughput !== null
						? theme.fg(lastThroughput > 30 ? "success" : lastThroughput > 10 ? "text" : "warning", formatSpeed(lastThroughput))
						: none;
					const perf = `${label("Perf")} ` + [`${theme.fg("dim", "TTFT ")}${ttft}`, `${theme.fg("dim", "Gen ")}${gen}`, `${theme.fg("dim", "E2E ")}${e2e}`].join(dot);

					let cacheValue = none;
					if (lastInput > 0 || lastCacheRead > 0) {
						const hit = Math.round((lastCacheRead / (lastInput + lastCacheRead)) * 100);
						cacheValue = theme.fg(hit > 70 ? "success" : hit > 30 ? "text" : "muted", `${hit}%`);
					}
					const cache = `${label("Cache")} ${cacheValue}`;
					const detail = isExtraDetail() ? theme.fg("warning", "[Detail]") : "";

					lines.push(spreadLine([usageSeg, perf, cache, detail], width));

					// === 第三行（运行环境）：[Workspace] 路径   [Git] 分支   [Platform] OS (arch)   [System] CPU · Mem · Net ===
					const branch = footerData.getGitBranch();
					const git = branch ? `${label("Git")} ${theme.fg("muted", branch)}` : "";
					const platform = `${label("Platform")} ${theme.fg("muted", monitor.osLabel)} ${theme.fg("dim", `(${arch()})`)}`;

					const sys = monitor.stats;
					const sysParts = [
						theme.fg("dim", "CPU ") + (sys.cpuPct !== undefined ? theme.fg(pctColor(sys.cpuPct, 50, 80), `${Math.round(sys.cpuPct)}%`) : none),
						theme.fg("dim", "Mem ") + (sys.memPct !== undefined ? theme.fg(pctColor(sys.memPct, 75, 90), `${Math.round(sys.memPct)}%`) : none),
					];
					if (sys.rxRate !== undefined && sys.txRate !== undefined) {
						sysParts.push(theme.fg("dim", "Net ") + theme.fg("muted", `↓${formatRate(sys.rxRate)} ↑${formatRate(sys.txRate)}`));
					}
					const system = `${label("System")} ${sysParts.join(dot)}`;

					// 路径占用剩余空间，过长时截断
					const cwd = tildeHome(ctx.cwd);
					const workspaceLabel = `${label("Workspace")} `;
					const cwdBudget = Math.max(8, width - minLineWidth([workspaceLabel, git, platform, system]));
					const workspace = workspaceLabel + theme.fg("muted", visibleWidth(cwd) > cwdBudget ? truncateToWidth(cwd, cwdBudget, "…") : cwd);

					lines.push(spreadLine([workspace, git, platform, system], width));

					return lines;
				},
			};
		});
	});
}
