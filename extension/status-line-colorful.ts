/**
 * Colorful status line variant: 三行布局，色彩丰富的状态栏
 * 
 * 布局：
 * - 第一行：模型身份（供应商 · 模型 · thinking）+ 上下文使用进度条
 * - 第二行：工作空间（目录 · Git 分支）+ 性能指标（TTFT · 速度 · 吞吐）
 * - 第三行：会话统计（成本 · 时长 · 轮次）+ 缓存命中率
 * 
 * 特点：
 * - 使用 Nerd Font 图标（优雅且等宽）
 * - 避免斜杠符号，使用 · 分隔
 * - 内容均匀分布，填满整行空间（两端对齐）
 * - 动态颜色区分关键信息
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isExtraDetail } from "./commands.js";

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
	return `${(n / 1000).toFixed(1)}k`;
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
	const filled = Math.round((pct / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

// 创建两端对齐的行：左侧内容 + 填充空格 + 右侧内容
function justifyLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const padding = Math.max(0, width - leftWidth - rightWidth);
	return left + " ".repeat(padding) + right;
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
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// 从历史记录中恢复状态
		cost = 0;
		turns = 0;
		earliestMs = Date.now();
		
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const msg = e.message as unknown as AssistantUsage;
				cost += msg.usage?.cost?.total ?? 0;
			}
			if (e.type === "message" && e.message.role === "user") {
				turns += 1;
			}
			if (typeof e.timestamp === "string") {
				const t = Date.parse(e.timestamp);
				if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
			}
		}
		sessionStartMs = earliestMs;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// 获取基础信息
					const modelId = ctx.model?.id ?? "no-model";
					const provider = ctx.model?.provider ?? "";
					const thinkingLevel = ctx.thinkingLevel ?? "off";
					const cwd = tildeHome(ctx.cwd);
					const branch = footerData.getGitBranch();
					const usage = ctx.getContextUsage();
					const window = ctx.model?.contextWindow ?? 0;
					const tokens = usage?.tokens ?? 0;
					const pct = window > 0 ? Math.round((tokens / window) * 100) : 0;
					const warn = window > 0 && tokens > window * 0.9;
					const critical = window > 0 && tokens > window * 0.95;

					const lines: string[] = [];

					// === 第一行：模型身份（左） + 上下文使用（右）===
					const leftParts1: string[] = [];
					
					// 🌐 供应商 · 🤖 模型
					if (provider) {
						leftParts1.push(theme.fg("muted", `🌐 ${provider}`));
						leftParts1.push(theme.fg("accent", `🤖 ${modelId}`));
					} else {
						leftParts1.push(theme.fg("accent", `🤖 ${modelId}`));
					}
					
					// 💭 thinking 等级
					if (thinkingLevel !== "off") {
						const thinkingColor = ["high", "xhigh", "max"].includes(thinkingLevel) ? "warning" : "muted";
						leftParts1.push(theme.fg(thinkingColor, `💭 ${thinkingLevel}`));
					}
					
					const left1 = leftParts1.join(theme.fg("dim", " · "));
					
					// 右侧：上下文使用进度条
					let right1 = "";
					if (tokens > 0) {
						const barWidth = Math.min(20, Math.floor(width / 4));
						const bar = drawContextBar(pct, barWidth);
						let ctxDisplay = "";
						if (critical) {
							ctxDisplay = theme.fg("error", `⚠ ${bar} ${pct}%`);
						} else if (warn) {
							ctxDisplay = theme.fg("warning", `${bar} ${pct}%`);
						} else if (pct > 50) {
							ctxDisplay = theme.fg("text", `${bar} ${pct}%`);
						} else {
							ctxDisplay = theme.fg("success", `✓ ${bar} ${pct}%`);
						}
						right1 = ctxDisplay;
					}
					
					lines.push(justifyLine(left1, right1, width));

					// === 第二行：工作空间（左）+ 性能指标（右）===
					const leftParts2: string[] = [];
					
					// 📁 工作目录
					leftParts2.push(theme.fg("muted", `📁 ${cwd}`));
					
					// 🌿 Git 分支
					if (branch) {
						leftParts2.push(theme.fg("dim", `🌿 ${branch}`));
					}
					
					const left2 = leftParts2.join(theme.fg("dim", " · "));
					
					// 右侧：性能指标
					const perfParts: string[] = [];
					
					// ⏱ TTFT
					if (lastTtft !== null) {
						const ttftColor = lastTtft < 1000 ? "success" : lastTtft < 3000 ? "text" : "warning";
						perfParts.push(theme.fg(ttftColor, `⏱ ${formatMs(lastTtft)}`));
					}
					
					// ⚡ 解码速度
					if (lastDecodeSpeed !== null) {
						const speedColor = lastDecodeSpeed > 50 ? "success" : lastDecodeSpeed > 20 ? "text" : "warning";
						perfParts.push(theme.fg(speedColor, `⚡ ${formatSpeed(lastDecodeSpeed)}`));
					}
					
					// 🚀 整体吞吐
					if (lastThroughput !== null) {
						const throughputColor = lastThroughput > 30 ? "success" : lastThroughput > 10 ? "text" : "warning";
						perfParts.push(theme.fg(throughputColor, `🚀 ${formatSpeed(lastThroughput)}`));
					}
					
					const right2 = perfParts.length > 0 ? perfParts.join(theme.fg("dim", " · ")) : "";
					lines.push(justifyLine(left2, right2, width));

					// === 第三行：会话统计（左）+ 缓存指标（右）===
					const leftParts3: string[] = [];
					
					// 💰 成本
					if (cost > 0) {
						const costColor = cost > 1 ? "warning" : "muted";
						leftParts3.push(theme.fg(costColor, `💰 $${cost.toFixed(2)}`));
					}
					
					// ⏰ 会话时长
					if (turns > 0) {
						const total = formatDuration(Date.now() - sessionStartMs);
						leftParts3.push(theme.fg("dim", `⏰ ${total}`));
						leftParts3.push(theme.fg("dim", `💬 ${turns}`));
					}
					
					const left3 = leftParts3.join(theme.fg("dim", " · "));
					
					// 右侧：缓存命中率
					const rightParts3: string[] = [];
					
					if (lastInput > 0 || lastCacheRead > 0) {
						const totalTokens = lastInput + lastCacheRead;
						const cacheHitRate = totalTokens > 0 ? Math.round((lastCacheRead / totalTokens) * 100) : 0;
						const cacheColor = cacheHitRate > 70 ? "success" : cacheHitRate > 30 ? "text" : "muted";
						rightParts3.push(theme.fg(cacheColor, `📦 ${cacheHitRate}%`));
					}
					
					// Extra detail 指示器
					if (isExtraDetail()) {
						rightParts3.push(theme.fg("warning", "⚙ detail"));
					}
					
					const right3 = rightParts3.join(theme.fg("dim", " · "));
					lines.push(justifyLine(left3, right3, width));

					return lines;
				},
			};
		});
	});
}
