/**
 * sticky-prompt.ts — CC fullscreen 顶部吸附 prompt。
 *
 * 用真实 pi-tui 组件搭文档(Container + UserMessageComponent + 真实 ScrollView),
 * 走 Container.render 产出的 mouseLayout 定位 prompt;TuiAltScreen 实例用
 * Object.create(prototype) 造,只补 getPrimaryScrollView / overlayStack。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, stripTerminalSequences, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import {
	collectPromptSpans,
	installStickyPrompt,
	pickStickyPrompt,
	promptText,
	renderStickyRow,
	setStickyPromptUi,
} from "../extension/sticky-prompt.js";

initTheme("dark");

const theme = {
	fg: (c: string, t: string) => `[fg:${c}]${t}`,
	bg: (c: string, t: string) => `[bg:${c}]${t}[/bg]`,
};

function lines(n: number, tag: string): Text {
	return new Text(Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n"), 0, 0);
}

/** header(2) + chat[ prompt1, reply(30), prompt2, reply(30) ] */
function buildDoc(): { doc: Container; p1: UserMessageComponent; p2: UserMessageComponent } {
	const header = lines(2, "h");
	const chat = new Container();
	const p1 = new UserMessageComponent("first\nprompt", undefined, 1);
	const p2 = new UserMessageComponent("second prompt", undefined, 1);
	chat.addChild(p1);
	chat.addChild(lines(30, "a"));
	chat.addChild(p2);
	chat.addChild(lines(30, "b"));
	const doc = new Container();
	doc.addChild(header);
	doc.addChild(chat);
	return { doc, p1, p2 };
}

test("collectPromptSpans:嵌套 Container 里按渲染行偏移定位每个 prompt", () => {
	const { doc, p1, p2 } = buildDoc();
	doc.render(80);
	const spans = collectPromptSpans(doc, 80, (c) => c instanceof UserMessageComponent);
	assert.equal(spans.length, 2);
	assert.equal(spans[0].component, p1);
	assert.equal(spans[0].start, 2, "header 2 行之后");
	const p1h = p1.render(80).length;
	assert.equal(spans[0].height, p1h);
	assert.equal(spans[1].component, p2);
	assert.equal(spans[1].start, 2 + p1h + 30);
});

test("collectPromptSpans:自带 render 逻辑的 Container 子类不下钻(子偏移不可信)", () => {
	class Boxed extends Container {
		override render(width: number): string[] {
			return ["top", ...super.render(width), "bottom"];
		}
	}
	const inner = new Boxed();
	inner.addChild(new UserMessageComponent("hidden", undefined, 1));
	const root = new Container();
	root.addChild(inner);
	root.render(80);
	assert.deepEqual(collectPromptSpans(root, 80, (c) => c instanceof UserMessageComponent), []);
});

test("pickStickyPrompt:只有完全滚出视口才吸附;取顶部之上最近的那条", () => {
	const spans = [
		{ start: 2, height: 3, component: "p1" },
		{ start: 40, height: 3, component: "p2" },
	];
	assert.equal(pickStickyPrompt(spans, 0), undefined, "顶部");
	assert.equal(pickStickyPrompt(spans, 4), undefined, "p1 还露一行");
	assert.equal(pickStickyPrompt(spans, 5)?.component, "p1");
	assert.equal(pickStickyPrompt(spans, 41), undefined, "p2 部分可见:真身在屏上,不吸附");
	assert.equal(pickStickyPrompt(spans, 43)?.component, "p2");
});

test("renderStickyRow:截断后 `…` 和尾部仍在底色里(不被 truncate 的 SGR reset 打断)", () => {
	const row = renderStickyRow("x".repeat(50), 20, theme);
	assert.doesNotMatch(row, /\x1b\[0m/, "没有全量 reset");
	assert.match(row, /^\[bg:userMessageBg\]\[fg:dim\]❯ x+…\[\/bg\]$/);
	assert.equal(row.replace(/\[[^\]]*\]/g, "").length, 20);
});

test("promptText:多行折成一行", () => {
	const p = new UserMessageComponent("a\n\n  b   c", undefined, 1);
	assert.equal(promptText(p, 80), "a b c");
});

function fakeAltScreen(scrollView: ScrollView): TuiAltScreen {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tui = Object.create(TuiAltScreen.prototype) as any;
	tui.overlayStack = [];
	tui.renderedOverlayLayouts = [];
	tui.getPrimaryScrollView = () => scrollView;
	return tui;
}

function frame(tui: TuiAltScreen, scroll: ScrollView, width: number, height: number): string[] {
	// 与 renderLayoutFrame 同序:先渲染文档(写 mouseLayout),再合成
	const content = scroll.render(width);
	const top = scroll.scrollTop;
	const screen = content.slice(top, top + height);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (tui as any).compositeOverlays(screen, width, height);
}

test("TuiAltScreen.compositeOverlays 包装:滚过 prompt 后首行画吸附条,回到能看见时撤掉", () => {
	installStickyPrompt();
	installStickyPrompt(); // 幂等
	setStickyPromptUi({ theme } as never);
	const { doc } = buildDoc();
	const scroll = new ScrollView(doc, { follow: "end", primary: true });
	const tui = fakeAltScreen(scroll);
	const W = 60;
	const H = 10;
	const total = scroll.render(W).length;
	scroll.updateLayout(total, H, () => {});

	scroll.scrollTo(0);
	let out = frame(tui, scroll, W, H);
	assert.equal(stripTerminalSequences(out[0]).trim(), "h0", "顶部:不吸附");

	scroll.scrollTo(20); // p1 已滚出,p2 尚未出现
	out = frame(tui, scroll, W, H);
	// CC v2.1.291: `❯` 从第 0 列起,整行 subtle(dim)前景 + userMessageBg 底色
	assert.match(out[0], /^\[bg:userMessageBg\]\[fg:dim\]❯ first prompt/);
	assert.equal(out[0].replace(/\[[^\]]*\]/g, "").length, W, "整行铺满");
	assert.equal(out.length, H, "不增减行数");

	scroll.scrollTo(total - H); // 末尾:p2 已滚出
	out = frame(tui, scroll, W, H);
	assert.match(out[0], /❯ second prompt/);

	setStickyPromptUi(undefined);
	out = frame(tui, scroll, W, H);
	assert.doesNotMatch(out[0], /❯/, "无 UI 上下文时不画");
});

test("非 fullscreen / 取不到 ScrollView 时原样透传", () => {
	installStickyPrompt();
	setStickyPromptUi({ theme } as never);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tui = Object.create(TuiAltScreen.prototype) as any;
	tui.overlayStack = [];
	tui.renderedOverlayLayouts = [];
	tui.getPrimaryScrollView = () => undefined;
	const screen = ["x", "y"];
	assert.deepEqual(tui.compositeOverlays(screen, 10, 2), ["x", "y"]);
	setStickyPromptUi(undefined);
});
