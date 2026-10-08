/**
 * 开屏横幅默认不启用：没有 ccBanner 设置时，扩展不调用 setHeader，pi 保留内置启动标头。
 * /cc-banner cc 会把 ccBanner 写进 ~/.pi/settings.json（下次加载生效）。
 *
 * commands.ts 在模块顶层读 settings，所以先隔离 HOME / cwd 再动态 import。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("默认不替换 pi 内置启动标头；/cc-banner cc 写入设置", async () => {
	const home = mkdtempSync(join(tmpdir(), "cc-banner-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "cc-banner-cwd-"));
	const origHome = process.env.HOME;
	const origCwd = process.cwd();
	process.env.HOME = home;
	process.chdir(cwd);
	try {
		const { loadExtension, startSession } = await import("./harness.js");
		const pi = await loadExtension();
		await startSession(pi);
		assert.equal(pi.ui.headerFactory, undefined, "默认不应调用 setHeader");

		const cmd = pi.commands.get("cc-banner");
		assert.ok(cmd, "/cc-banner 已注册");
		await cmd.handler("cc", pi.ctx());
		const saved = JSON.parse(readFileSync(join(home, ".pi", "settings.json"), "utf8"));
		assert.equal(saved.ccBanner, "cc");
		assert.match(pi.ui.notifications.at(-1)?.message ?? "", /Startup banner: cc/);
	} finally {
		process.chdir(origCwd);
		process.env.HOME = origHome;
	}
});
