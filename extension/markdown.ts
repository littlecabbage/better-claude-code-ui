/**
 * CC markdown alignment for assistant text — the part reachable through pi's
 * public `registerMarkdownTransformer` (source rewrite before pi-tui's lexer).
 *
 * Verified against CC renders of the same verbatim sample (v2.1.288, re-checked
 * on v2.1.291 via pty capture):
 *   - H3–H6 render as plain bold with NO `#` prefix. pi-tui keeps `### `
 *     for depth >= 3 (markdown.js case "heading") and bolds H2 — so demote
 *     H3–H6 to H2.
 *   - Thematic breaks (`---` / `***` / `___`) render as the literal text
 *     `---` in CC; pi-tui draws an 80-col `─` rule — so escape them into a
 *     paragraph reading `---`.
 *   - `~~x~~`: CC v2.1.288 showed it literally, v2.1.291 renders real
 *     strikethrough (SGR 9) — same as pi-tui, so it is left alone.
 *     escapeStrikethrough stays exported for callers that want the old look.
 *
 * Fenced code block bodies are copied verbatim. A `---` directly under a
 * paragraph line is a setext H2 underline (not a break) and is left alone;
 * CC renders that as a bold heading too.
 *
 * Out of reach for a source rewrite — handled by markdown-render.ts (a
 * Markdown.prototype patch): code fence lines + 2-col indent, list
 * indent/`a.`/`i.` numbering, loose list spacing, table alignment, `▎` quote
 * bar, H1 italic, `text (url)` links, plain-text user messages.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addMarkdownTransformer } from "./markdown-transformers.js";
import { installMarkdownRender, isMarkdownRenderPatched, noteMarkdownMessageType, wrapPlainText } from "./markdown-render.js";

/** Optional blockquote prefix (`> `, `> > `) a block construct may sit behind. */
const QUOTE_PREFIX = String.raw`((?: {0,3}>[ \t]?)*)`;
const FENCE_RE = new RegExp(String.raw`^${QUOTE_PREFIX} {0,3}(\`{3,}|~{3,})`);
const HEADING_RE = new RegExp(String.raw`^${QUOTE_PREFIX}( {0,3})#{3,6}(?=[ \t]|$)`);
const HR_RE = new RegExp(String.raw`^${QUOTE_PREFIX} {0,3}([-*_])(?:[ \t]*\2){2,}[ \t]*$`);
/** Lines that can NOT be a setext heading's text (so a `---` after them is a break). */
const NON_PARAGRAPH_RE = new RegExp(String.raw`^${QUOTE_PREFIX}(?:[ \t]*$| {0,3}(?:#{1,6}(?:[ \t]|$)|[-+*][ \t]|\d{1,9}[.)][ \t]))`);

/** Escape every `~~` outside inline code spans (backtick runs of equal length). */
export function escapeStrikethrough(line: string): string {
	if (!line.includes("~~")) return line;
	let out = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "`") {
			let n = 1;
			while (line[i + n] === "`") n++;
			const run = "`".repeat(n);
			// Closing run must be exactly n backticks long.
			let j = line.indexOf(run, i + n);
			while (j !== -1 && (line[j + n] === "`" || line[j - 1] === "`")) j = line.indexOf(run, j + 1);
			if (j === -1) {
				out += run;
				i += n;
				continue;
			}
			out += line.slice(i, j + n);
			i = j + n;
			continue;
		}
		if (line[i] === "\\" && i + 1 < line.length) {
			// Already-escaped character: keep the pair as-is.
			out += line.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (line[i] === "~" && line[i + 1] === "~") {
			out += "\\~\\~";
			i += 2;
			continue;
		}
		out += line[i];
		i++;
	}
	return out;
}

export function ccMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	let fence: { char: string; len: number } | undefined;
	// Whether the previous line is paragraph text (a `---` under it is setext).
	let prevParagraph = false;
	for (let k = 0; k < lines.length; k++) {
		const line = lines[k];
		const fenceMatch = FENCE_RE.exec(line);
		if (fence) {
			// Closing fence: same char, at least as long, nothing else after it.
			if (fenceMatch && fenceMatch[2][0] === fence.char && fenceMatch[2].length >= fence.len
				&& line.slice(fenceMatch[0].length).trim() === "") {
				fence = undefined;
			}
			prevParagraph = false;
			continue;
		}
		if (fenceMatch) {
			fence = { char: fenceMatch[2][0], len: fenceMatch[2].length };
			prevParagraph = false;
			continue;
		}

		const hr = HR_RE.exec(line);
		if (hr) {
			// `---` right under a paragraph line is a setext H2 underline.
			const setext = hr[2] === "-" && prevParagraph;
			if (!setext) lines[k] = `${hr[1]}\\-\\-\\-`;
			prevParagraph = false;
			continue;
		}

		lines[k] = line.replace(HEADING_RE, "$1$2##");
		prevParagraph = !NON_PARAGRAPH_RE.test(line);
	}
	return lines.join("\n");
}

export function registerMarkdown(pi: ExtensionAPI): void {
	installMarkdownRender();
	addMarkdownTransformer(pi, (markdown, { messageType }) => {
		// Runs inside Markdown.render: tells the render patch whose text this is.
		noteMarkdownMessageType(messageType);
		if (messageType === "assistant") return ccMarkdown(markdown);
		// CC shows the user's prompt as typed. Only wrap when the render patch
		// is live — otherwise the wrapper would show up as a code block.
		if (messageType === "user" && isMarkdownRenderPatched()) return wrapPlainText(markdown);
		return markdown;
	});
}
