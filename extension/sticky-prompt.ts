/**
 * CC fullscreen sticky prompt — when the prompt that owns the content at the
 * top of the viewport has scrolled fully off-screen (a long reply streaming,
 * or the user scrolling back), pin a one-row copy of it to the top row.
 *
 * Only pi's fullscreen renderer (TuiAltScreen, the default `tuiMode` in pi
 * 1.x) owns its viewport. In regular mode the transcript lives in the
 * terminal's own scrollback, which no app can pin — nothing is installed there.
 *
 * Why a prototype wrap and not `ctx.ui.custom({ overlay: true })`: any entry
 * on the overlay stack, even a non-capturing one, blocks `/settings` TUI-mode
 * switching (switchTuiMode returns false on `hasOverlayEntries`), and a visible
 * one disables scrollbar hit-testing and the viewport's selection mapping
 * (`hasOverlay()` checks in tui-alt-screen.js). So we paint directly into the
 * frame instead: TuiAltScreen.doRender calls `compositeOverlays(screen, …)`
 * right after layout, and we wrap exactly that method on TuiAltScreen.prototype
 * (TuiMainScreen keeps the TuiBase original). Real overlays still composite on
 * top of our row.
 *
 * Runtime-only (TS-private) surface this relies on, all feature-detected —
 * any miss renders nothing:
 *   - TuiAltScreen#getPrimaryScrollView()  the transcript ScrollView
 *   - Container#mouseLayout                per-child heights of the last render
 *                                          (pi-tui >= 1.0; older: re-render)
 *   - UserMessageComponent#text            the raw prompt text
 * ScrollView#children[0] (the document) and #scrollTop are public.
 * Prompts sit in plain Containers (documentContainer → chatContainer); only
 * those are descended into, never components with their own render logic.
 * The transcript is assumed to start at screen row 0 (pi's createChatViewport
 * stacks [transcript, dock]).
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, TuiAltScreen, truncateToWidth } from "@earendil-works/pi-tui";

export interface PromptSpan {
	/** First row of the prompt within the scroll document. */
	start: number;
	height: number;
	component: unknown;
}

interface ChildHeight {
	component: unknown;
	height: number;
}

/** Per-child heights at `width`: the last render's mouseLayout when it matches, else re-render. */
function childHeights(container: unknown, width: number): ChildHeight[] | undefined {
	const layout = (container as { mouseLayout?: { width: number; children: ChildHeight[] } }).mouseLayout;
	if (layout && layout.width === width && Array.isArray(layout.children)) return layout.children;
	const children = (container as { children?: unknown[] }).children;
	if (!Array.isArray(children)) return undefined;
	return children.map((component) => ({
		component,
		height: (component as { render(w: number): string[] }).render(width).length,
	}));
}

/** Plain Containers only: their render is exactly the concatenation of their children. */
function isPlainContainer(component: unknown): boolean {
	return component instanceof Container && Object.getPrototypeOf(component) === Container.prototype;
}

/** Walk plain Containers from `root` and collect every prompt's row span. */
export function collectPromptSpans(root: unknown, width: number, isPrompt: (c: unknown) => boolean): PromptSpan[] {
	const spans: PromptSpan[] = [];
	const visit = (container: unknown, offset: number): void => {
		const children = childHeights(container, width);
		if (!children) return;
		let y = offset;
		for (const { component, height } of children) {
			if (isPrompt(component)) {
				if (height > 0) spans.push({ start: y, height, component });
			} else if (height > 0 && isPlainContainer(component)) {
				visit(component, y);
			}
			y += height;
		}
	};
	visit(root, 0);
	return spans;
}

/**
 * The prompt owning the top row of the viewport: the last one starting above
 * `top`. Pinned only once it is entirely off-screen — while any of its rows is
 * still visible the real one is on screen.
 */
export function pickStickyPrompt(spans: readonly PromptSpan[], top: number): PromptSpan | undefined {
	let owner: PromptSpan | undefined;
	for (const span of spans) {
		if (span.start < top) owner = span;
		else break;
	}
	return owner && owner.start + owner.height <= top ? owner : undefined;
}

/** Single-line prompt text: whitespace (incl. newlines) collapsed. */
export function promptText(component: unknown, width: number): string {
	const raw = (component as { text?: unknown }).text;
	if (typeof raw === "string") return raw.replace(/\s+/g, " ").trim();
	// Fallback: the component's own rendered rows, ANSI stripped.
	const render = (component as { render?: (w: number) => string[] }).render;
	if (typeof render !== "function") return "";
	return render
		.call(component, width)
		.map((l) => stripTerminalSequences(l))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

type StickyTheme = Pick<ExtensionUIContext["theme"], "fg" | "bg">;

/**
 * CC v2.1.291 (pty capture): `❯ <prompt>` from column 0, the whole row in the
 * subtle color (#505050 dark) on userMessageBg, truncated with `…`.
 */
export function renderStickyRow(text: string, width: number, theme: StickyTheme): string {
	// truncateToWidth emits a full SGR reset before its ellipsis, which would
	// drop the row's bg/fg for the `…` and the padding — strip it, then style.
	const body = truncateToWidth(`❯ ${text}`, width, "…", true).replace(/\x1b\[0m/g, "");
	return theme.bg("userMessageBg", theme.fg("dim", body));
}

const IMAGE_LINE_RE = /\x1b_G|\x1b\]1337;File=/;
const FLAG = Symbol.for("better-cc-ui:sticky-prompt");
/**
 * The prototype wrapper is installed once per process, but /reload re-imports
 * this module (fresh module state). The wrapper therefore calls through a
 * global hook that every module instance re-points at its own painter.
 */
const HOOK = Symbol.for("better-cc-ui:sticky-prompt-paint");
type Painter = (tui: unknown, lines: string[], width: number) => string[];

/** Live UI context (its `theme` getter follows /theme switches). */
let activeUi: Pick<ExtensionUIContext, "theme"> | undefined;

/** Test hook. */
export function setStickyPromptUi(ui: Pick<ExtensionUIContext, "theme"> | undefined): void {
	activeUi = ui;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paintSticky(tui: any, lines: string[], width: number): string[] {
	const theme = activeUi?.theme;
	if (!theme || lines.length === 0) return lines;
	const scrollView = typeof tui.getPrimaryScrollView === "function" ? tui.getPrimaryScrollView() : undefined;
	const top = scrollView?.scrollTop;
	if (typeof top !== "number" || top <= 0 || !(scrollView.viewportHeight > 1)) return lines;
	const doc = scrollView.children?.[0];
	if (!doc) return lines;
	const contentWidth = typeof scrollView.getContentWidth === "function" ? scrollView.getContentWidth(width) : width;
	const hit = pickStickyPrompt(collectPromptSpans(doc, contentWidth, (c) => c instanceof UserMessageComponent), top);
	if (!hit) return lines;
	if (IMAGE_LINE_RE.test(lines[0] ?? "")) return lines;
	const text = promptText(hit.component, width);
	if (!text) return lines;
	const out = [...lines];
	out[0] = renderStickyRow(text, width, theme);
	return out;
}

export function installStickyPrompt(): void {
	(globalThis as Record<symbol, unknown>)[HOOK] = paintSticky satisfies Painter;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const proto = (TuiAltScreen as any)?.prototype;
	if (!proto || proto[FLAG] || typeof proto.compositeOverlays !== "function") return;
	const original = proto.compositeOverlays;
	proto.compositeOverlays = function ccUiStickyPrompt(lines: string[], termWidth: number, termHeight: number): string[] {
		let screen = lines;
		try {
			const paint = (globalThis as Record<symbol, unknown>)[HOOK] as Painter | undefined;
			if (paint) screen = paint(this, lines, termWidth);
		} catch {
			/* best-effort: never break a frame */
		}
		return original.call(this, screen, termWidth, termHeight);
	};
	proto[FLAG] = true;
}

export function registerStickyPrompt(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeUi = ctx.ui;
		installStickyPrompt();
	});
	pi.on("session_shutdown", async () => {
		activeUi = undefined;
	});
}
