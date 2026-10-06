/**
 * markdown-render.ts — CC 块级渲染(Markdown.prototype 补丁),对照 CC v2.1.288
 * 同一份逐字样例的实测渲染。走真实 pi-tui Markdown + pi 的 getMarkdownTheme()
 * + 本扩展 transformer(createMarkdownTransform 同款调用:transform(text, width))。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Markdown, setCapabilities, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FakePi } from "./harness.js";
import { registerMarkdown } from "../extension/markdown.js";
import { listNumber } from "../extension/markdown-render.js";

initTheme("dark");
const pi = new FakePi();
registerMarkdown(pi as never);
const transformer = pi.markdownTransformers[0] as (md: string, ctx: Record<string, unknown>) => string;

function md(text: string, messageType: string, style?: Record<string, unknown>): Markdown {
	return new Markdown(text, 0, 0, getMarkdownTheme(), style as never, {
		transform: (markdown: string, availableWidth: number) =>
			transformer(markdown, { messageType, isStreaming: false, availableWidth }),
	});
}

const raw = (text: string, type = "assistant", width = 80) => md(text, type).render(width).map((l) => l.trimEnd());
const plain = (text: string, type = "assistant", width = 80) => raw(text, type, width).map((l) => stripTerminalSequences(l).trimEnd());

test("代码块:无围栏、无缩进;带语言仍高亮", () => {
	const out = plain("```ts\nconst a = 1;\n```");
	assert.deepEqual(out, ["const a = 1;"]);
	assert.match(raw("```ts\nconst a = 1;\n```")[0], /\x1b\[/, "ts 有高亮转义");
});

test("代码块:无语言整块走 mdCodeBlock 色", () => {
	const lines = raw("```\nplain\n  indented\n```");
	assert.deepEqual(lines.map((l) => stripTerminalSequences(l)), ["plain", "  indented"]);
	assert.match(lines[0], /\x1b\[38;/, "有前景色");
});

test("代码块:未知语言 → dim 语言标签行 + 原文", () => {
	const lines = raw("```unknownlang\nbody\n```");
	assert.equal(stripTerminalSequences(lines[0]), "unknownlang");
	assert.match(lines[0], /\x1b\[2m/, "标签 dim");
	assert.equal(lines[1], "body");
});

test("无序列表:子级按父符号宽度缩进 2 格", () => {
	assert.deepEqual(plain("- a\n  - b\n    - c\n- d"), ["- a", "  - b", "    - c", "- d"]);
});

test("有序列表:1. → a. → i.,按父编号宽度缩进", () => {
	const out = plain("1. one\n2. two\n   1. x\n   2. y\n      1. p\n      2. q\n3. three");
	assert.deepEqual(out, ["1. one", "2. two", "   a. x", "   b. y", "      i. p", "      ii. q", "3. three"]);
});

test("有序列表:起始号保留(5. 6.)", () => {
	assert.deepEqual(plain("5. five\n6. six"), ["5. five", "6. six"]);
});

test("松散列表项之间不插空行;任务列表照旧", () => {
	assert.deepEqual(plain("- a\n\n- b"), ["- a", "- b"]);
	assert.deepEqual(plain("- [ ] todo\n- [x] done"), ["- [ ] todo", "- [x] done"]);
});

test("列表续行与首行文字对齐", () => {
	const out = plain("- " + "字".repeat(50), "assistant", 40);
	assert.equal(out[0].slice(0, 2), "- ");
	assert.ok(out[1].startsWith("  字"), `续行缩进 2: ${JSON.stringify(out[1])}`);
});

test("listNumber:深度编号规则", () => {
	assert.equal(listNumber(0, 3), "3");
	assert.equal(listNumber(1, 1), "a");
	assert.equal(listNumber(1, 27), "aa");
	assert.equal(listNumber(2, 4), "iv");
	assert.equal(listNumber(3, 2), "2");
});

test("表格:表头居中且不加粗;正文按 :--: / --: 对齐", () => {
	const src = "| 左 | 中 | 右 |\n|:--|:--:|--:|\n| a | b | c |\n| long-left | long-mid | long-right |";
	const out = raw(src).map((l) => stripTerminalSequences(l));
	assert.equal(out[1], "│    左     │    中    │     右     │");
	assert.equal(out[3], "│ a         │    b     │          c │");
	const theme = { ...getMarkdownTheme(), bold: (t: string) => `<b>${t}</b>` };
	const m = new Markdown(src, 0, 0, theme, undefined, {
		transform: (s: string, w: number) => transformer(s, { messageType: "assistant", isStreaming: false, availableWidth: w }),
	});
	assert.doesNotMatch(m.render(80)[1], /<b>/, "表头不加粗");
});

test("表格窄宽度 + CJK:列不窄于最宽字符,每行边框完整不被折断", () => {
	const src = "| 左对齐 | 居中 | 右对齐 |\n|:--|:--:|--:|\n| a | b | c |\n| 中文单元格 | 一个很长的单元格 | 123 |";
	for (const width of [16, 20, 24]) {
		const out = plain(src, "assistant", width);
		for (const line of out) {
			assert.ok(line.length === 0 || /^[┌├└│]/.test(line), `@${width} 不应有被折出来的碎行: ${JSON.stringify(line)}`);
			if (line.startsWith("│")) assert.equal((line.match(/│/g) ?? []).length, 4, `@${width} 每行 4 根竖线: ${JSON.stringify(line)}`);
		}
	}
});

test("表格太窄放不下时退回原始 markdown 文本", () => {
	const out = plain("| 中 | 文 | 字 |\n|--|--|--|\n| 一 | 二 | 三 |", "assistant", 12);
	assert.ok(out.some((l) => l.includes("| 中")), JSON.stringify(out));
});

test("引用:dim ▎ 前缀,嵌套叠加", () => {
	const lines = raw("> one\n>\n> > two");
	const out = lines.map((l) => stripTerminalSequences(l).trimEnd());
	assert.deepEqual(out, ["▎ one", "▎", "▎ ▎ two"]);
	assert.match(lines[0], /\x1b\[2m▎/);
});

test("H1:粗体 + 斜体 + 下划线", () => {
	// chalk 在无 TTY 的测试里不出色,用标记型 theme 断言样式组合
	const tag = (name: string) => (t: string) => `<${name}>${t}</${name}>`;
	const theme = { ...getMarkdownTheme(), bold: tag("b"), italic: tag("i"), underline: tag("u"), heading: (t: string) => t };
	const h = new Markdown("# Title", 0, 0, theme, undefined, {
		transform: (m: string, w: number) => transformer(m, { messageType: "assistant", isStreaming: false, availableWidth: w }),
	});
	const line = h.render(80)[0];
	assert.match(line, /<b><i><u>Title<\/u><\/i><\/b>/);
	const h2 = new Markdown("## Sub", 0, 0, theme, undefined, {
		transform: (m: string, w: number) => transformer(m, { messageType: "assistant", isStreaming: false, availableWidth: w }),
	});
	assert.match(h2.render(80)[0], /<b>Sub<\/b>/, "H2 只粗体");
	const h1code = new Markdown("# A `x`", 0, 0, { ...theme, code: (t: string) => `<c>${t}</c>` }, undefined, {
		transform: (m: string, w: number) => transformer(m, { messageType: "assistant", isStreaming: false, availableWidth: w }),
	});
	assert.match(h1code.render(80)[0], /<b><i><u><c>x<\/c><\/u><\/i><\/b>/, "标题里的行内代码带标题样式");
});

test("链接/图片(终端不支持 OSC 8):链接走 pi-tui `文字 (url)`;自动链接只留文字;图片 `alt (url)`", () => {
	const saved = getCapabilities();
	setCapabilities({ ...saved, hyperlinks: false });
	try {
		const lines = raw("[文字](https://example.com/p) <https://a.org> ![alt](https://x/i.png)");
		const out = stripTerminalSequences(lines[0]);
		assert.equal(out, "文字 (https://example.com/p) https://a.org alt (https://x/i.png)");
		assert.doesNotMatch(lines[0], /\x1b\]8;/, "不走 OSC 8");
	} finally {
		setCapabilities(saved);
	}
});

test("链接(终端支持 OSC 8):保留 pi-tui 的 link+underline 样式与超链接,不打印 url;图片 `alt (url)`(CC v2.1.291 pty 实测)", () => {
	const saved = getCapabilities();
	setCapabilities({ ...saved, hyperlinks: true });
	try {
		const lines = raw("[文字](https://example.com/p) 和 **[粗](https://b.io)** ![alt](https://x/i.png)");
		assert.equal(stripTerminalSequences(lines[0]), "文字 和 粗 alt (https://x/i.png)");
		assert.ok(lines[0].includes("\x1b]8;;https://example.com/p\x1b\\"), JSON.stringify(lines[0]));
		assert.ok(lines[0].includes("\x1b]8;;https://b.io\x1b\\"), "粗体里的链接也是超链接");
		assert.doesNotMatch(lines[0], /\x1b\]8;;https:\/\/x\/i\.png/, "图片不是超链接");
		const theme = { ...getMarkdownTheme(), underline: (t: string) => `<u>${t}</u>`, link: (t: string) => `<a>${t}</a>` };
		const m = new Markdown("[x](https://e.com)", 0, 0, theme, undefined, {
			transform: (s: string, w: number) => transformer(s, { messageType: "assistant", isStreaming: false, availableWidth: w }),
		});
		assert.match(m.render(80)[0], /<a><u>x<\/u><\/a>/, "link 色 + 下划线(CC: ANSI 12 + SGR 4)");
	} finally {
		setCapabilities(saved);
	}
});

test("用户消息:原样纯文本(markdown 语法不解析)", () => {
	const src = "### H3\n~~del~~ **b**\n```ts\nx\n```";
	const out = md(src, "user", { color: (t: string) => t }).render(80).map((l) => stripTerminalSequences(l).trimEnd());
	assert.deepEqual(out, ["### H3", "~~del~~ **b**", "```ts", "x", "```"]);
});

test("非 assistant/user 的 Markdown(工具输出等)保持 pi 原渲染", () => {
	const plainMd = new Markdown("```ts\nx\n```\n- a\n  - b", 0, 0, getMarkdownTheme());
	const out = plainMd.render(80).map((l) => stripTerminalSequences(l).trimEnd());
	assert.deepEqual(out, ["```ts", "  x", "```", "", "- a", "    - b"].filter((l, i, a) => !(l === "" && a[i - 1] === "")));
});

test("thinking 走 pi 原渲染(transformer 透传)", () => {
	const out = plain("- a\n  - b", "assistant-thinking");
	assert.deepEqual(out, ["- a", "    - b"]);
});
