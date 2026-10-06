/**
 * CC markdown 源改写(extension/markdown.ts)——对照 CC 同一份逐字样例的实测渲染
 * (v2.1.288,并在 v2.1.291 用 pty 录制复核):
 *   - H3–H6 无 `#` 前缀,纯粗体(pi-tui depth>=3 保留 `### `)
 *   - `~~x~~`:v2.1.291 是真删除线(与 pi-tui 一致),源文本不再转义
 *   - `---` / `***` 原样显示 `---`,不画 80 列 `─`
 * 渲染断言走真实 pi-tui Markdown(剥 ANSI),源改写断言走纯函数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FakePi } from "./harness.js";
import { ccMarkdown, escapeStrikethrough, registerMarkdown } from "../extension/markdown.js";

const id = (s: string) => s;
const theme = {
	heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id,
	quote: id, quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id,
	strikethrough: (s: string) => `<del>${s}</del>`, underline: id,
};

function render(md: string): string[] {
	const comp = new Markdown(ccMarkdown(md), 0, 0, theme);
	return comp.render(80).map((l) => stripTerminalSequences(l).trimEnd());
}

test("H3–H6 降为 H2:渲染无 # 前缀", () => {
	const out = render("### H3 标题\n#### H4\n##### H5\n###### H6");
	assert.deepEqual(out.filter(Boolean), ["H3 标题", "H4", "H5", "H6"]);
});

test("H1/H2 不动;引用里的 ### 也降级;`#hashtag` 不是标题", () => {
	assert.equal(ccMarkdown("# a\n## b"), "# a\n## b");
	assert.equal(ccMarkdown("> ### q"), "> ## q");
	assert.equal(ccMarkdown("###no-space"), "###no-space");
});

test("~~ 交给 pi-tui 渲染成删除线(CC v2.1.291 实测 SGR 9),源文本不动", () => {
	assert.equal(ccMarkdown("普通 ~~删除线~~ 结束"), "普通 ~~删除线~~ 结束");
	const out = render("普通 ~~删除线~~ 结束");
	assert.deepEqual(out, ["普通 <del>删除线</del> 结束"]);
});

test("escapeStrikethrough(保留导出):行内代码里的 ~~ 不转义;已转义的保持原样", () => {
	assert.equal(escapeStrikethrough("`a ~~ b` ~~x~~"), "`a ~~ b` \\~\\~x\\~\\~");
	assert.equal(escapeStrikethrough("``x ` ~~ y`` z"), "``x ` ~~ y`` z");
	// `\~` 已转义保持原样,其后剩下的单个 `~` 不成对,不动
	assert.equal(escapeStrikethrough("\\~~a"), "\\~~a");
});

test("分隔线 --- / *** / ___ 原样显示为 ---", () => {
	const out = render("a\n\n---\n\nb\n\n***\n\nc\n\n_ _ _");
	assert.deepEqual(out.filter(Boolean), ["a", "---", "b", "---", "c", "---"]);
});

test("段落下紧跟 --- 是 setext H2,不改写", () => {
	assert.equal(ccMarkdown("Title\n---"), "Title\n---");
	assert.deepEqual(render("Title\n---").filter(Boolean), ["Title"]);
});

test("列表项下紧跟 --- 仍是分隔线", () => {
	assert.equal(ccMarkdown("- item\n---"), "- item\n\\-\\-\\-");
});

test("代码块内容逐字保留(含 ### / ~~ / ---)", () => {
	const src = "```md\n### keep\n~~keep~~\n---\n```\n### after";
	assert.equal(ccMarkdown(src), "```md\n### keep\n~~keep~~\n---\n```\n## after");
});

test("~~~ 围栏同样识别,且只被同字符等长以上的围栏关闭", () => {
	const src = "~~~\n```\n### in\n~~~\n### out";
	assert.equal(ccMarkdown(src), "~~~\n```\n### in\n~~~\n## out");
});

test("assistant 正文改写;user 包成逐字显示的块(渲染补丁生效时);thinking 原样", () => {
	const pi = new FakePi();
	registerMarkdown(pi as never);
	const t = pi.markdownTransformers[0] as (md: string, ctx: { messageType: string }) => string;
	assert.equal(t("### x", { messageType: "assistant" }), "## x");
	assert.equal(t("### x", { messageType: "user" }), "```cc-ui-plain-text\n### x\n```");
	assert.equal(t("### x", { messageType: "assistant-thinking" }), "### x");
});
