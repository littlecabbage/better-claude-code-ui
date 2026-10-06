/**
 * CC's code-block syntax highlighter, ported from the Claude Code v2.1.291
 * bundle: highlight.js 11.11.1 (same version CC bundles) + CC's own
 * scope → ANSI-16 color table. pi's highlightCode uses highlight.js 10.7.3
 * and theme truecolor tokens, which tokenizes differently (e.g. a TS return
 * type is `title` in 10.x) and colors differently.
 *
 * CC semantics reproduced:
 *   - highlight(code, { language, ignoreIllegals: true }); unknown language →
 *     undefined (caller falls back to the plain rendering);
 *   - each emitter node is styled by its scope, falling back by stripping
 *     the last `.segment` (`title.function.invoke` → `title.function` →
 *     `title`); unmapped scopes inherit the parent's style;
 *   - "reset" scopes (title/params/subst/…) render with NO color even inside
 *     a colored parent: CC wraps them in SGR 0 (chalk.reset), so the parent's
 *     color is off from there until the parent closes;
 *   - SGR codes are ANSI-16 (keyword 34 blue, built_in 36 cyan, string 31
 *     red, number/comment 32 green, function 33 yellow, meta/tag 90 grey).
 *   - CC re-cuts text leaves on grapheme boundaries before styling; that only
 *     matters for cluster-splitting leaves and is skipped here.
 */
import { createRequire } from "node:module";

type Style = { open: string; close: string } | "reset";

const S = (open: string, close: string): Style => ({ open: `\x1b[${open}m`, close: `\x1b[${close}m` });
const BLUE = S("34", "39");
const CYAN = S("36", "39");
const CYAN_DIM = S("36;2", "22;39");
const GREEN = S("32", "39");
const RED = S("31", "39");
const YELLOW = S("33", "39");
const GREY = S("90", "39");

/** CC v2.1.291 table, verbatim (chalk.reset → "reset"). */
const SCOPES = new Map<string, Style>(Object.entries({
	keyword: BLUE, built_in: CYAN, type: CYAN_DIM, literal: BLUE, number: GREEN, regexp: RED, string: RED,
	subst: "reset", symbol: "reset", class: BLUE, function: YELLOW, title: "reset", "title.function": YELLOW,
	"title.class": BLUE, params: "reset", comment: GREEN, doctag: GREEN, meta: GREY, "meta-keyword": "reset",
	"meta-string": "reset", "meta.keyword": "reset", "meta.string": "reset", section: "reset", tag: GREY,
	name: BLUE, attr: CYAN, attribute: "reset", variable: "reset", bullet: "reset", code: "reset",
	emphasis: S("3", "23"), strong: S("1", "22"), link: S("4", "24"), quote: "reset",
	addition: GREEN, deletion: RED,
}));

function styleFor(scope: string): Style | undefined {
	let s = scope.replace(/^hljs-/, "");
	for (;;) {
		const hit = SCOPES.get(s);
		if (hit) return hit;
		const dot = s.lastIndexOf(".");
		if (dot < 0) return undefined;
		s = s.slice(0, dot);
	}
}

interface HljsNode {
	scope?: string;
	kind?: string;
	children: Array<HljsNode | string>;
}

/** Render a node; `stack` holds the attributes currently open from ancestors. */
function renderNode(node: HljsNode | string, stack: Array<{ open: string; close: string }>): string {
	if (typeof node === "string") return node;
	const scope = node.scope ?? node.kind;
	const style = scope ? styleFor(scope) : undefined;
	if (style === "reset") {
		// CC: chalk.reset(inner) = SGR 0 … SGR 0. The content shows uncolored, and
		// — like chalk — the enclosing color is NOT re-applied afterwards: the rest
		// of the parent stays plain until the parent closes (CC capture:
		// `\x1b[31m`hello \x1b[39m${name}`;` — the closing backtick is uncolored).
		const closeAll = [...stack].reverse().map((s) => s.close).join("");
		return closeAll + node.children.map((c) => renderNode(c, [])).join("");
	}
	if (style) {
		const inner = node.children.map((c) => renderNode(c, [...stack, style])).join("");
		return style.open + inner + style.close + stack.map((s) => s.open).join("");
	}
	return node.children.map((c) => renderNode(c, stack)).join("");
}

type Hljs = {
	highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { _emitter?: unknown; emitter?: unknown };
	getLanguage(name: string): unknown;
};

let hljs: Hljs | null | undefined;
function load(): Hljs | null {
	if (hljs !== undefined) return hljs;
	try {
		const required = createRequire(import.meta.url)("highlight.js") as Hljs & { default?: Hljs };
		hljs = required.default ?? required;
	} catch {
		hljs = null;
	}
	return hljs;
}

/** Whether CC would highlight this language (highlight.js 11 knows it). */
export function ccSupportsLanguage(lang: string): boolean {
	const h = load();
	return !!h && !!lang && h.getLanguage(lang.toLowerCase()) !== undefined;
}

/**
 * Highlight like CC. Returns one ANSI string per source line, or undefined
 * when the language is unknown or highlight.js is unavailable.
 */
export function ccHighlight(code: string, lang: string): string[] | undefined {
	const h = load();
	if (!h || !ccSupportsLanguage(lang)) return undefined;
	try {
		const result = h.highlight(code, { language: lang.toLowerCase(), ignoreIllegals: true });
		const emitter = (result._emitter ?? result.emitter) as { rootNode?: HljsNode; root?: HljsNode } | undefined;
		const root = emitter?.rootNode ?? emitter?.root;
		if (!root || typeof root === "string") return undefined;
		return splitLines(root.children.map((c) => renderNode(c, [])).join(""));
	} catch {
		return undefined;
	}
}

/**
 * Split on newlines, carrying open SGR attributes across the break so each
 * line is self-contained (a multi-line comment stays green on every line).
 */
function splitLines(ansi: string): string[] {
	const out: string[] = [];
	let open: string[] = [];
	for (const line of ansi.split("\n")) {
		const prefix = open.join("");
		const codes = line.match(/\x1b\[[0-9;]*m/g) ?? [];
		for (const code of codes) {
			const params = code.slice(2, -1);
			if (/^(39|22|23|24|22;39)$/.test(params)) {
				// closes: drop the most recent opener of the same family
				const family = params === "39" ? /^\x1b\[(3[0-7]|9[0-7])/ : params === "22;39" ? /^\x1b\[36;2/ : params === "22" ? /^\x1b\[1m/ : params === "23" ? /^\x1b\[3m/ : /^\x1b\[4m/;
				for (let k = open.length - 1; k >= 0; k--) {
					if (family.test(open[k])) {
						open.splice(k, 1);
						break;
					}
				}
			} else {
				open.push(code);
			}
		}
		const suffix = open.length ? "\x1b[0m" : "";
		out.push(prefix + line + suffix);
	}
	return out;
}
