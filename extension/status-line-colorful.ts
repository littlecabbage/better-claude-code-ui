/**
 * Colorful status line variant：三行分区布局
 *
 * 三行共用一套三列网格（列宽取各行最宽的单元），分区起点上下对齐，剩余空间均分到列间距：
 *
 *   [provider] model (thinking)    [Topic] 对话名称              [Context] 进度条 % · 已用 · 窗口
 *   [Usage] 成本 · 时长 · 轮次        [Perf] TTFT · Gen · E2E        [Cache] 命中率
 *   [Workspace] 路径                 [Git] 分支  [Platform] OS (arch)  [System] CPU · Mem · Net
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

/**
 * 网格单元：给定可用宽度，返回不超过该宽度的内容。
 * 可以按宽度切换不同详细程度（比如去掉进度条 / 缩短路径），放不下时由 gridLayout 截断。
 */
type Cell = (maxWidth: number) => string;

/** 固定内容的单元：按顺序选第一个放得下的变体，都放不下就用最后一个（之后会被截断）。 */
function fixedCell(...variants: string[]): Cell {
	const vs = variants.filter((v) => visibleWidth(v) > 0);
	return (max) => vs.find((v) => visibleWidth(v) <= max) ?? vs[vs.length - 1] ?? "";
}

const NATURAL = 10_000;
const MIN_GAP = 3;

/**
 * 各模块的最长宽度（终端列数）。内容长度不可控的字段（模型 id、会话名、路径、分支、发行版名）
 * 单独限制，避免一个超长值把整列撑宽、挤掉其它模块。
 */
const MAX_WIDTH = {
	model: 36,
	provider: 14,
	topic: 30,
	workspace: 40,
	branch: 20,
	os: 24,
} as const;

/** 超长时截断并加省略号；未超长原样返回。 */
function clip(text: string, max: number): string {
	return visibleWidth(text) > max ? truncateToWidth(text, Math.max(1, max), "…") : text;
}

/**
 * 三行共用一套列宽：每列宽度 = 该列所有行里最宽的单元，所以各行的分区起点上下对齐。
 * - 放得下：剩余空间平均分给列间距，铺满整行
 * - 放不下：按 shrinkOrder 依次把列缩到它的最小宽度（单元自己选更紧凑的变体），
 *   还不够就从最后一列开始硬截断
 */
function gridLayout(rows: Cell[][], width: number, shrinkOrder: number[]): string[] {
	const cols = Math.max(...rows.map((r) => r.length));
	const cell = (r: number, c: number): Cell => rows[r]![c] ?? (() => "");
	const colWidth = (c: number, max: number) => Math.max(...rows.map((_, r) => visibleWidth(cell(r, c)(max))));

	const widths = Array.from({ length: cols }, (_, c) => colWidth(c, NATURAL));
	const mins = Array.from({ length: cols }, (_, c) => Math.min(widths[c]!, colWidth(c, 0)));
	const gapsTotal = MIN_GAP * (cols - 1);
	let excess = widths.reduce((a, b) => a + b, 0) + gapsTotal - width;

	for (const c of shrinkOrder) {
		if (excess <= 0) break;
		const cut = Math.min(excess, widths[c]! - mins[c]!);
		widths[c]! -= cut;
		excess -= cut;
	}
	for (let c = cols - 1; c >= 0 && excess > 0; c--) {
		const cut = Math.min(excess, widths[c]! - 4);
		if (cut > 0) {
			widths[c]! -= cut;
			excess -= cut;
		}
	}

	// 剩余空间均分到列间距（不足一列的余数给前面的间距）
	const free = Math.max(0, -excess);
	const gaps = Array.from({ length: cols - 1 }, (_, i) => MIN_GAP + Math.floor(free / (cols - 1)) + (i < free % (cols - 1) ? 1 : 0));

	return rows.map((_, r) => {
		let out = "";
		for (let c = 0; c < cols; c++) {
			let text = cell(r, c)(widths[c]!);
			if (visibleWidth(text) > widths[c]!) text = truncateToWidth(text, widths[c]!, "…");
			out += text;
			if (c < cols - 1) out += " ".repeat(widths[c]! - visibleWidth(text) + gaps[c]!);
		}
		return truncateToWidth(out.trimEnd(), width, "");
	});
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
					const none = theme.fg("dim", "--");
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

					// ---- 第一列：身份 / 本次会话 / 工作区 ----
					// [provider] model (thinking)：空间不够时只截断模型 id，保留 provider 和 thinking
					const providerPart = provider ? theme.fg("muted", `[${clip(provider, MAX_WIDTH.provider)}]`) + " " : "";
					let thinkingPart = "";
					if (thinkingLevel !== "off") {
						const thinkingColor = ["high", "xhigh", "max"].includes(thinkingLevel) ? "warning" : "muted";
						thinkingPart = theme.fg(thinkingColor, ` (${thinkingLevel})`);
					}
					const model: Cell = (max) => {
						const idBudget = Math.max(6, Math.min(max, MAX_WIDTH.model) - visibleWidth(providerPart) - visibleWidth(thinkingPart));
						return providerPart + theme.fg("accent", clip(modelId, idBudget)) + thinkingPart;
					};

					const usageHead = `${label("Usage")} ` + theme.fg(cost > 1 ? "warning" : "muted", `$${cost.toFixed(2)}`) + dot + theme.fg("muted", formatDuration(Date.now() - sessionStartMs));
					const usageCell = fixedCell(usageHead + dot + theme.fg("muted", `${turns} ${turns === 1 ? "turn" : "turns"}`), usageHead);

					const cwd = tildeHome(ctx.cwd);
					const workspaceLabel = `${label("Workspace")} `;
					const workspace: Cell = (max) => {
						const budget = Math.max(8, Math.min(max, MAX_WIDTH.workspace) - visibleWidth(workspaceLabel));
						return workspaceLabel + theme.fg("muted", clip(cwd, budget));
					};

					// ---- 第二列：主题 / 性能 / Git + 平台 ----
					const title = pi.getSessionName()?.trim() || firstUserText;
					const topicLabel = `${label("Topic")} `;
					const topic: Cell = (max) => {
						if (!title) return "";
						const budget = Math.min(MAX_WIDTH.topic, max) - visibleWidth(topicLabel);
						return budget >= 6 ? topicLabel + theme.fg("text", clip(title, budget)) : "";
					};

					const ttft = lastTtft !== null ? theme.fg(lastTtft < 1000 ? "success" : lastTtft < 3000 ? "text" : "warning", formatMs(lastTtft)) : none;
					const gen = lastDecodeSpeed !== null ? theme.fg(lastDecodeSpeed > 50 ? "success" : lastDecodeSpeed > 20 ? "text" : "warning", formatSpeed(lastDecodeSpeed)) : none;
					const e2e = lastThroughput !== null ? theme.fg(lastThroughput > 30 ? "success" : lastThroughput > 10 ? "text" : "warning", formatSpeed(lastThroughput)) : none;
					const perfHead = `${label("Perf")} ${theme.fg("dim", "TTFT ")}${ttft}${dot}${theme.fg("dim", "Gen ")}${gen}`;
					const perf = fixedCell(`${perfHead}${dot}${theme.fg("dim", "E2E ")}${e2e}`, perfHead);

					const branch = footerData.getGitBranch();
					const gitPart = branch ? `${label("Git")} ${theme.fg("muted", clip(branch, MAX_WIDTH.branch))}   ` : "";
					const osName = clip(monitor.osLabel, MAX_WIDTH.os);
					const osFull = theme.fg("muted", osName) + " " + theme.fg("dim", `(${arch()})`);
					const osShort = theme.fg("muted", clip(monitor.osLabel.split(" ")[0] ?? monitor.osLabel, MAX_WIDTH.os));
					const env = fixedCell(
						`${gitPart}${label("Platform")} ${osFull}`,
						`${gitPart}${label("Platform")} ${osShort}`,
						gitPart.trimEnd() || `${label("Platform")} ${osShort}`,
					);

					// ---- 第三列：上下文 / 缓存 / 系统负载 ----
					const context: Cell = (max) => {
						if (tokens <= 0 && window <= 0) return "";
						const color = critical ? "error" : warn ? "warning" : pct > 50 ? "text" : "success";
						const tail =
							theme.fg(color, `${pct}%`) +
							dot +
							theme.fg("text", tokens > 0 ? formatTokens(tokens) : "0") +
							dot +
							theme.fg("muted", window > 0 ? formatTokens(window) : "--");
						const head = `${label("Context")} `;
						const barWidth = Math.min(12, max - visibleWidth(head) - visibleWidth(tail) - 1);
						return head + (barWidth >= 5 ? theme.fg(color, drawContextBar(pct, barWidth)) + " " : "") + tail;
					};

					let cacheValue = none;
					if (lastInput > 0 || lastCacheRead > 0) {
						const hit = Math.round((lastCacheRead / (lastInput + lastCacheRead)) * 100);
						cacheValue = theme.fg(hit > 70 ? "success" : hit > 30 ? "text" : "muted", `${hit}%`);
					}
					const detail = isExtraDetail() ? "   " + theme.fg("warning", "[Detail]") : "";
					const cache = fixedCell(`${label("Cache")} ${cacheValue}${detail}`, `${label("Cache")} ${cacheValue}`);

					const sys = monitor.stats;
					const cpu = theme.fg("dim", "CPU ") + (sys.cpuPct !== undefined ? theme.fg(pctColor(sys.cpuPct, 50, 80), `${Math.round(sys.cpuPct)}%`) : none);
					const mem = theme.fg("dim", "Mem ") + (sys.memPct !== undefined ? theme.fg(pctColor(sys.memPct, 75, 90), `${Math.round(sys.memPct)}%`) : none);
					const sysHead = `${label("System")} ${cpu}${dot}${mem}`;
					const net =
						sys.rxRate !== undefined && sys.txRate !== undefined
							? dot + theme.fg("dim", "Net ") + theme.fg("muted", `↓${formatRate(sys.rxRate)} ↑${formatRate(sys.txRate)}`)
							: "";
					const system = fixedCell(sysHead + net, sysHead);

					// 三行共用列宽 → 上下对齐。放不下时先缩第二列（平台去版本号 / 去 E2E），
					// 再缩第一列（截断路径 / 模型 id），最后第三列（缩进度条 / 去网速）
					return gridLayout(
						[
							[model, topic, context],
							[usageCell, perf, cache],
							[workspace, env, system],
						],
						width,
						[1, 0, 2],
					);
				},
			};
		});
	});
}
