/**
 * colorful 状态栏：对话主题 / 操作系统 / 系统负载
 *
 * - 第一行带 session 名称（无名称时退回第一条用户消息）
 * - 第二行路径前带 OS 标签
 * - 第三行带 CPU / 内存（/ 网速）
 * - 上下文用量超过 100% 不抛 RangeError，且每行不超宽
 * - sys-monitor 的 vm_stat / meminfo / netstat / /proc/net/dev 解析
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, FakeTheme } from "./harness.js";
import { registerColorfulStatusLine } from "../extension/status-line-colorful.js";
import { parseMeminfo, parseNetstat, parseProcNetDev, parseVmStat, formatRate, cpuPercent } from "../extension/sys-monitor.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

async function renderFooter(opts: { name?: string; firstUser?: string; tokens?: number; window?: number; width?: number; waitMs?: number }) {
	const pi = new FakePi();
	pi.sessionName = opts.name;
	pi.model = { id: "claude-test", provider: "acme", contextWindow: opts.window ?? 200000 };
	const entries = opts.firstUser
		? [{ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: opts.firstUser }] } }]
		: [];
	pi.sessionManager = { ...pi.sessionManager, getBranch: () => entries } as any;
	const baseCtx = pi.ctx.bind(pi);
	pi.ctx = () => ({ ...baseCtx(), getContextUsage: () => ({ tokens: opts.tokens ?? 0 }) });
	registerColorfulStatusLine(pi as any);
	await pi.emit("session_start", { reason: "startup" });
	const factory = (pi.ui as any).footerFactory;
	const footer = factory({ requestRender() {} }, new FakeTheme("claude-code-dark"), {
		onBranchChange: () => () => {},
		getGitBranch: () => "main",
	});
	if (opts.waitMs) await new Promise((r) => setTimeout(r, opts.waitMs));
	const raw: string[] = footer.render(opts.width ?? 160);
	footer.dispose();
	return raw;
}

test("第一行显示 session 名称", async () => {
	const lines = (await renderFooter({ name: "重构状态栏", tokens: 90000 })).map(stripTerminalSequences);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /🤖【acme】claude-test \(medium\)/);
	assert.match(lines[0]!, /\[Topic\] 重构状态栏/);
	assert.match(lines[0]!, /\[Context\] .*45% · 90k · 200k/);
});

test("无 session 名称时用第一条用户消息作为主题", async () => {
	const lines = (await renderFooter({ firstUser: "帮我看看   这个报错" })).map(stripTerminalSequences);
	assert.match(lines[0]!, /\[Topic\] 帮我看看 这个报错/);
});

test("第二行是本次对话指标，第三行是运行环境（路径 → Git → 平台 → 系统负载）", async () => {
	// 首次采样是异步的（vm_stat / meminfo），等它跑完
	const lines = (await renderFooter({ waitMs: 1000 })).map(stripTerminalSequences);
	// 新会话也有占位，不会出现空行
	assert.match(lines[1]!, /^\[Usage\] \$0\.00 · \S+ · 0 turns +\[Perf\] TTFT -- · Gen -- · E2E -- +\[Cache\] --/);
	const order = ["[Workspace]", "[Git] main", "[Platform]", "[System]"].map((s) => lines[2]!.indexOf(s));
	assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!)), `第三行顺序不对: ${lines[2]}`);
	assert.match(lines[2]!, /\[Platform\] \S.* \((arm64|x64|ia32|arm)\)/);
	assert.match(lines[2]!, /\[System\] CPU (\d+%|--) · Mem \d+%/);
});

test("上下文超过 100% 不抛错，窄终端每行不超宽", async () => {
	for (const width of [160, 80, 40]) {
		const raw = await renderFooter({ name: "a very long session name that should be truncated", tokens: 250000, window: 200000, width });
		for (const line of raw) assert.ok(visibleWidth(line) <= width, `width ${width} 超宽: ${stripTerminalSequences(line)}`);
		// 40 列连模型 + 上下文都放不下，只要求不超宽不抛错
		if (width >= 80) assert.match(stripTerminalSequences(raw[0]!), /125%/);
	}
});

test("parseVmStat：app + wired + compressed", () => {
	const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    20113.
Pages active:                                 233033.
Pages wired down:                             183456.
Pages purgeable:                               20300.
Anonymous pages:                              318721.
Pages occupied by compressor:                 341200.
`;
	assert.equal(parseVmStat(text), (318721 - 20300 + 183456 + 341200) * 16384);
});

test("parseMeminfo：MemTotal - MemAvailable", () => {
	const m = parseMeminfo("MemTotal:       16000000 kB\nMemFree:  1000 kB\nMemAvailable:    4000000 kB\n");
	assert.deepEqual(m, { total: 16000000 * 1024, used: 12000000 * 1024 });
});

test("parseNetstat：只累加物理网卡 Link 行，空 Address 列也能解析", () => {
	const text = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       2456652     0  396915184  2456652     0  396915184     0
en0        1500  <Link#9>    aa:bb:cc:dd:ee:ff  1000     0     500000     900     0     200000     0
en0        1500  192.168.1     192.168.1.2      1000     -     500000     900     -     200000     -
en1        1500  <Link#8>                          0     0          0        0     0       1000     0
utun3      1380  <Link#20>                       500     0     400000      400     0     100000     0
`;
	assert.deepEqual(parseNetstat(text), { rx: 500000, tx: 201000 });
});

test("parseProcNetDev：排除 lo / docker", () => {
	const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 10 0 0 0 0 0 0 9999 10 0 0 0 0 0 0
  eth0: 1200 10 0 0 0 0 0 0 3400 10 0 0 0 0 0 0
docker0: 777 10 0 0 0 0 0 0 777 10 0 0 0 0 0 0
`;
	assert.deepEqual(parseProcNetDev(text), { rx: 1200, tx: 3400 });
});

test("formatRate / cpuPercent", () => {
	assert.equal(formatRate(512), "512B/s");
	assert.equal(formatRate(2048), "2K/s");
	assert.equal(formatRate(3 * 1024 * 1024), "3.0M/s");
	assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 400 }), 75);
	assert.equal(cpuPercent({ idle: 1, total: 1 }, { idle: 1, total: 1 }), undefined);
});
