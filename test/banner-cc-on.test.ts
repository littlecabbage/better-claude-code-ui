/**
 * ccBanner: "cc" 时才注册 CC 风格开屏横幅（setHeader）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ccBanner=cc 时替换启动标头", async () => {
	const home = mkdtempSync(join(tmpdir(), "cc-banner-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "cc-banner-cwd-"));
	mkdirSync(join(home, ".pi"), { recursive: true });
	writeFileSync(join(home, ".pi", "settings.json"), JSON.stringify({ ccBanner: "cc" }));
	const origHome = process.env.HOME;
	const origCwd = process.cwd();
	process.env.HOME = home;
	process.chdir(cwd);
	try {
		const { loadExtension, startSession } = await import("./harness.js");
		const pi = await loadExtension();
		await startSession(pi);
		assert.equal(typeof pi.ui.headerFactory, "function", "ccBanner=cc 时应调用 setHeader");
	} finally {
		process.chdir(origCwd);
		process.env.HOME = origHome;
	}
});
