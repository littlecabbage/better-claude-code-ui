/**
 * CC markdown rendering — the block-level part a source rewrite can't reach
 * (markdown.ts covers headings/~~/hr at the source level). Verified against a
 * CC v2.1.288 render of the same verbatim sample:
 *
 *   code block   no fence lines, no indent; known lang → CC's highlighter
 *                (highlight.js 11 + ANSI-16 table, highlight.ts); no lang →
 *                mdCodeBlock color; unknown lang → dim language label line +
 *                plain body
 *   lists        nested lists indented by the parent marker width (2 for
 *                `- `, 3 for `1. `); ordered numbering 1. → a. → i. → 1.;
 *                no blank rows between loose-list items
 *   table        header centered and not bold; body cells follow `:--:`/`--:`
 *   blockquote   dim `▎ ` bar instead of `│ `
 *   H1           bold + italic + underline (inline code inside headings too)
 *   images       `alt (url)` plain text; links keep pi-tui's (CC-identical) style
 *   user message plain text, not markdown
 *
 * Mechanism: wraps PRIVATE methods of pi-tui's public `Markdown` class
 * (render / renderToken / renderList / renderTable / renderInlineTokens), the
 * same prototype technique as host-patches.ts. The loader aliases
 * `@earendil-works/pi-tui` to the host's own module, so this is the class pi
 * renders with. Scope: only Markdown instances whose transform reports
 * messageType "assistant" or "user" (see markdown.ts's transformer, which
 * calls noteMarkdownMessageType during Markdown.render). Tool output, custom
 * messages and thinking keep pi's renderer. Every method is feature-detected;
 * if any is missing nothing is installed and user messages stay markdown.
 */
import { Markdown, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dim } from "./palette.js";
import { ccHighlight } from "./highlight.js";

/** Fence language marking a user message wrapped for verbatim display. */
export const PLAIN_LANG = "cc-ui-plain-text";

// --- shared state (survives /reload re-imports: wrappers are installed once) --
interface State {
	type: string | undefined;
	installed: boolean;
	impl?: Impl;
}
const STATE_KEY = Symbol.for("better-cc-ui:markdown-render");
const state: State = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
	type: undefined,
	installed: false,
}) as State;

/** Called by the markdown transformer while a Markdown instance renders. */
export function noteMarkdownMessageType(type: string): void {
	state.type = type;
}

export function isMarkdownRenderPatched(): boolean {
	return state.installed;
}

/** Wrap a user message so the patched renderer prints it verbatim. */
export function wrapPlainText(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${PLAIN_LANG}\n${text}\n${fence}`;
}

// --- helpers ----------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
type Md = any;
type Token = any;

function withTheme<T>(md: Md, patch: Record<string, unknown>, fn: () => T): T {
	const original = md.theme;
	md.theme = { ...original, ...patch };
	try {
		return fn();
	} finally {
		md.theme = original;
	}
}

function toLetters(n: number): string {
	let out = "";
	for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) out = String.fromCharCode(97 + ((v - 1) % 26)) + out;
	return out || String(n);
}

function toRoman(n: number): string {
	if (n <= 0 || n >= 4000) return String(n);
	const table: Array<[number, string]> = [
		[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
		[50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
	];
	let out = "";
	let v = n;
	for (const [value, glyph] of table) {
		while (v >= value) {
			out += glyph;
			v -= value;
		}
	}
	return out;
}

/** CC numbering by nesting depth (0-based): 1. → a. → i. → 1. */
export function listNumber(depth: number, n: number): string {
	if (depth === 1) return toLetters(n);
	if (depth === 2) return toRoman(n);
	return String(n);
}

function align(text: string, width: number, alignment: string | null | undefined): string {
	const extra = Math.max(0, width - visibleWidth(text));
	if (alignment === "right") return " ".repeat(extra) + text;
	if (alignment === "center") {
		const left = Math.floor(extra / 2);
		return " ".repeat(left) + text + " ".repeat(extra - left);
	}
	return text + " ".repeat(extra);
}

// --- CC implementations -----------------------------------------------------
interface Impl {
	renderToken(md: Md, original: Function, args: unknown[]): string[];
	renderList(md: Md, original: Function, args: unknown[]): string[];
	renderTable(md: Md, original: Function, args: unknown[]): string[];
	renderInlineTokens(md: Md, original: Function, args: unknown[]): string;
}

function ccCode(md: Md, token: Token, nextTokenType: string | undefined): string[] {
	const text: string = token.text ?? "";
	const lang = String(token.lang ?? "").trim();
	const lines: string[] = [];
	if (!lang) {
		for (const line of text.split("\n")) lines.push(md.theme.codeBlock(line));
	} else {
		// CC: highlight.js 11 + CC's ANSI-16 scope table; unknown language →
		// dim language label line + plain body.
		const highlighted = ccHighlight(text, lang);
		if (highlighted) lines.push(...highlighted);
		else lines.push(dim(lang), ...text.split("\n"));
	}
	if (nextTokenType && nextTokenType !== "space") lines.push("");
	return lines;
}

function ccList(md: Md, token: Token, depth: number, indent: string, width: number, styleContext: unknown): string[] {
	const lines: string[] = [];
	const start = typeof token.start === "number" ? token.start : 1;
	const items: Token[] = token.items ?? [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const bullet = token.ordered ? `${listNumber(depth, start + i)}. ` : "- ";
		const marker = bullet + (item.task ? `[${item.checked ? "x" : " "}] ` : "");
		const firstPrefix = indent + md.theme.listBullet(marker);
		const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
		const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
		let rendered = false;
		for (const child of item.tokens ?? []) {
			if (child.type === "checkbox") continue;
			if (child.type === "list") {
				// Nested lists line up under the parent item's text (CC).
				lines.push(...ccList(md, child, depth + 1, indent + " ".repeat(visibleWidth(bullet)), width, styleContext));
				rendered = true;
				continue;
			}
			for (const line of md.renderToken(child, itemWidth, undefined, styleContext) as string[]) {
				for (const wrapped of wrapTextWithAnsi(line, itemWidth)) {
					lines.push((rendered ? continuationPrefix : firstPrefix) + wrapped);
					rendered = true;
				}
			}
		}
		if (!rendered) lines.push(firstPrefix);
		// CC: no blank row between loose-list items.
	}
	return lines;
}

/**
 * pi-tui's renderTable (1.0.x) with CC alignment: header centered + not bold, body per column align.
 * One deviation from pi: a column never shrinks below its widest grapheme (2 for CJK). pi floors
 * at 1, so a wide char overflows its cell and the row wraps, tearing the table apart.
 */
function ccTable(md: Md, token: Token, availableWidth: number, nextTokenType: string | undefined, styleContext: any): string[] {
	const lines: string[] = [];
	const numCols = token.header.length;
	if (numCols === 0) return lines;
	const borderOverhead = 3 * numCols + 1;
	const availableForCells = availableWidth - borderOverhead;
	const floors: number[] = [];
	const cellsOf = (i: number): Token[] => [token.header[i], ...token.rows.map((r: Token[]) => r[i])].filter(Boolean);
	for (let i = 0; i < numCols; i++) {
		let widest = 1;
		for (const cell of cellsOf(i)) {
			for (const ch of stripTerminalSequences(md.renderInlineTokens(cell.tokens || [], styleContext))) {
				widest = Math.max(widest, visibleWidth(ch));
			}
		}
		floors[i] = widest;
	}
	if (availableForCells < floors.reduce((a, b) => a + b, 0)) {
		const fallback = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
		if (nextTokenType && nextTokenType !== "space") fallback.push("");
		return fallback;
	}
	const maxUnbrokenWordWidth = 30;
	const naturalWidths: number[] = [];
	const minWordWidths: number[] = [];
	for (let i = 0; i < numCols; i++) {
		const headerText = md.renderInlineTokens(token.header[i].tokens || [], styleContext);
		naturalWidths[i] = visibleWidth(headerText);
		minWordWidths[i] = Math.max(1, md.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
	}
	for (const row of token.rows) {
		for (let i = 0; i < row.length; i++) {
			const cellText = md.renderInlineTokens(row[i].tokens || [], styleContext);
			naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
			minWordWidths[i] = Math.max(minWordWidths[i] || 1, md.getLongestWordWidth(cellText, maxUnbrokenWordWidth));
		}
	}
	let minColumnWidths = minWordWidths.map((w, i) => Math.max(w, floors[i]));
	let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
	if (minCellsWidth > availableForCells) {
		minColumnWidths = [...floors];
		const remaining = availableForCells - floors.reduce((a, b) => a + b, 0);
		if (remaining > 0) {
			const totalWeight = minWordWidths.reduce((t, w, i) => t + Math.max(0, w - floors[i]), 0);
			const growth = minWordWidths.map((w, i) => (totalWeight > 0 ? Math.floor((Math.max(0, w - floors[i]) / totalWeight) * remaining) : 0));
			for (let i = 0; i < numCols; i++) minColumnWidths[i] += growth[i] ?? 0;
			let leftover = remaining - growth.reduce((t, w) => t + w, 0);
			for (let i = 0; leftover > 0 && i < numCols; i++) {
				minColumnWidths[i]++;
				leftover--;
			}
		}
		minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
	}
	const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
	let columnWidths: number[];
	if (totalNaturalWidth <= availableWidth) {
		columnWidths = naturalWidths.map((w, i) => Math.max(w, minColumnWidths[i]));
	} else {
		const totalGrowPotential = naturalWidths.reduce((t, w, i) => t + Math.max(0, w - minColumnWidths[i]), 0);
		const extraWidth = Math.max(0, availableForCells - minCellsWidth);
		columnWidths = minColumnWidths.map((minWidth, i) => {
			const delta = Math.max(0, naturalWidths[i] - minWidth);
			return minWidth + (totalGrowPotential > 0 ? Math.floor((delta / totalGrowPotential) * extraWidth) : 0);
		});
		let remaining = availableForCells - columnWidths.reduce((a, b) => a + b, 0);
		while (remaining > 0) {
			let grew = false;
			for (let i = 0; i < numCols && remaining > 0; i++) {
				if (columnWidths[i] < naturalWidths[i]) {
					columnWidths[i]++;
					remaining--;
					grew = true;
				}
			}
			if (!grew) break;
		}
	}
	const alignments: Array<string | null> = token.align ?? [];
	const renderRow = (cells: Token[], header: boolean): void => {
		const cellLines = cells.map((cell, i) =>
			md.wrapCellText(md.renderInlineTokens(cell.tokens || [], styleContext), columnWidths[i], styleContext?.stylePrefix) as string[],
		);
		const height = Math.max(...cellLines.map((c) => c.length));
		for (let lineIdx = 0; lineIdx < height; lineIdx++) {
			const parts = cellLines.map((c, i) => align(c[lineIdx] || "", columnWidths[i], header ? "center" : alignments[i]));
			lines.push(`│ ${parts.join(" │ ")} │`);
		}
	};
	lines.push(`┌─${columnWidths.map((w) => "─".repeat(w)).join("─┬─")}─┐`);
	renderRow(token.header, true);
	const separator = `├─${columnWidths.map((w) => "─".repeat(w)).join("─┼─")}─┤`;
	lines.push(separator);
	for (let r = 0; r < token.rows.length; r++) {
		renderRow(token.rows[r], false);
		if (r < token.rows.length - 1) lines.push(separator);
	}
	lines.push(`└─${columnWidths.map((w) => "─".repeat(w)).join("─┴─")}─┘`);
	if (nextTokenType && nextTokenType !== "space") lines.push("");
	return lines;
}

/**
 * Images, CC style: `alt (url)` plain text (CC v2.1.291 pty capture). Links are
 * left to pi-tui, whose rendering already matches CC: mdLink color (ANSI 12) +
 * underline, OSC 8 hyperlink with the URL hidden when the terminal forwards it.
 * Tokens are cached by pi-tui: never mutate them.
 */
function ccInlineTokens(tokens: Token[]): Token[] {
	let changed = false;
	const out: Token[] = [];
	for (const token of tokens) {
		if (token?.type === "image") {
			changed = true;
			const alt = String(token.text ?? "");
			const href = String(token.href ?? "");
			const label = alt ? `${alt} (${href})` : href;
			out.push({ type: "text", raw: label, text: label });
		} else {
			out.push(token);
		}
	}
	return changed ? out : tokens;
}

const impl: Impl = {
	renderToken(md, original, args) {
		const [token, , nextTokenType] = args as [Token, number, string | undefined];
		if (state.type === "user") {
			if (token?.type === "code" && token.lang === PLAIN_LANG) {
				return String(token.text ?? "").split("\n").map((line) => md.applyDefaultStyle(line));
			}
			return original.apply(md, args);
		}
		if (state.type !== "assistant") return original.apply(md, args);
		switch (token?.type) {
			case "code":
				return ccCode(md, token, nextTokenType);
			case "heading": {
				// CC: H1 bold+italic+underline, others bold — and inline code inside a
				// heading carries the heading style too (pi resets it).
				const t = md.theme;
				const h1 = token.depth === 1;
				const style = h1
					? (s: string) => t.heading(t.bold(t.italic(t.underline(s))))
					: (s: string) => t.heading(t.bold(s));
				const patch: Record<string, unknown> = { code: (s: string) => style(t.code(s)) };
				if (h1) patch.underline = (s: string) => t.italic(t.underline(s));
				return withTheme(md, patch, () => original.apply(md, args));
			}
			case "blockquote":
				return withTheme(md, { quoteBorder: (t: string) => dim(t.replace("│", "▎")) }, () => original.apply(md, args));
			default:
				return original.apply(md, args);
		}
	},
	renderList(md, original, args) {
		if (state.type !== "assistant") return original.apply(md, args);
		const [token, depth, width, styleContext] = args as [Token, number, number, unknown];
		return ccList(md, token, depth ?? 0, "", width, styleContext);
	},
	renderTable(md, original, args) {
		if (state.type !== "assistant") return original.apply(md, args);
		const [token, width, nextTokenType, styleContext] = args as [Token, number, string | undefined, unknown];
		return ccTable(md, token, width, nextTokenType, styleContext);
	},
	renderInlineTokens(md, original, args) {
		if (state.type !== "assistant" || !Array.isArray(args[0])) return original.apply(md, args);
		return original.apply(md, [ccInlineTokens(args[0] as Token[]), ...args.slice(1)]);
	},
};

const METHODS = ["renderToken", "renderList", "renderTable", "renderInlineTokens"] as const;
const REQUIRED = [...METHODS, "render", "applyDefaultStyle", "wrapCellText", "getLongestWordWidth"];

export function installMarkdownRender(): boolean {
	state.impl = impl;
	const proto = (Markdown as any)?.prototype;
	if (!proto) return false;
	if (state.installed) return true;
	if (!REQUIRED.every((name) => typeof proto[name] === "function")) return false;

	const originalRender = proto.render;
	proto.render = function ccUiMarkdownRender(this: Md, ...args: unknown[]): string[] {
		// The transform (run inside render) reports the message type; reset so
		// a Markdown without our transformer never inherits a stale type.
		const previous = state.type;
		state.type = undefined;
		try {
			return originalRender.apply(this, args);
		} finally {
			state.type = previous;
		}
	};
	for (const name of METHODS) {
		const original = proto[name];
		proto[name] = function ccUiMarkdownMethod(this: Md, ...args: unknown[]): unknown {
			const current = state.impl;
			if (!current) return original.apply(this, args);
			try {
				return current[name](this, original, args);
			} catch {
				return original.apply(this, args);
			}
		};
	}
	state.installed = true;
	return true;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
