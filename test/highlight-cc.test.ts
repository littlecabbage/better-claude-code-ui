/**
 * extension/highlight.ts — CC 代码块高亮(highlight.js 11.11.1 + CC 的 scope→ANSI-16 表)。
 * 期望值来自 CC v2.1.291 pty 实录同一段 TS 的 SGR 序列(去掉光标移动后逐段比对)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ccHighlight, ccSupportsLanguage } from "../extension/highlight.js";

/** SGR-annotated runs: `{codes:text}` per styled segment, plain text as-is. */
function runs(line: string): string {
	let out = "";
	let open: string[] = [];
	for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
		const m = /^\x1b\[([0-9;]*)m$/.exec(part);
		if (m) {
			const p = m[1];
			if (p === "39" || p === "0" || p === "22;39") open = [];
			else if (!["22", "23", "24"].includes(p)) open.push(p);
			continue;
		}
		if (!part) continue;
		out += open.length ? `{${open.join(";")}:${part}}` : part;
	}
	return out;
}

const SAMPLE = "// 带语言的代码块\nfunction greet(name: string): string {\n  return `hello ${name}`;\n}";

test("TS 样例与 CC v2.1.291 实录逐段一致", () => {
	const lines = ccHighlight(SAMPLE, "ts")!;
	assert.deepEqual(lines.map(runs), [
		"{32:// 带语言的代码块}",
		"{34:function} {33:greet}({36:name}: {36:string}): {36:string} {",
		"  {34:return} {31:`hello }${name}`;",
		"}",
	]);
});

test("文本不变,只加 SGR", () => {
	const lines = ccHighlight(SAMPLE, "typescript")!;
	assert.equal(lines.map((l) => stripTerminalSequences(l)).join("\n"), SAMPLE);
});

test("未知语言 → undefined;已知别名可识别", () => {
	assert.equal(ccHighlight("x", "unknownlang"), undefined);
	assert.equal(ccSupportsLanguage("unknownlang"), false);
	for (const lang of ["ts", "js", "python", "py", "bash", "sh", "json", "go", "rust"]) assert.ok(ccSupportsLanguage(lang), lang);
});

test("多行注释/字符串跨行:每行自带开闭,不串色", () => {
	const lines = ccHighlight("/* a\n   b */\nx = 1", "js")!;
	assert.match(lines[0], /^\x1b\[32m\/\* a/);
	assert.match(lines[1], /^\x1b\[32m {3}b \*\//, "第二行重新开绿色");
	assert.ok(lines[0].endsWith("\x1b[0m"), "跨行未闭合的行尾复位");
	assert.doesNotMatch(lines[2], /^\x1b\[32m/, "注释结束后不再是绿色");
});

test("scope 回退:title.function.invoke → title.function(黄)", () => {
	const [line] = ccHighlight("foo(1)", "js")!;
	assert.equal(runs(line), "{33:foo}({32:1})");
});
