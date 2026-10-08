/**
 * 系统负载采样（供 colorful 状态栏第二、三行使用）
 *
 * - CPU：os.cpus() 两次采样的 busy/total 差值
 * - 内存：macOS 用 vm_stat（app + wired + compressed，接近活动监视器的"已使用内存"），
 *   Linux 用 /proc/meminfo 的 MemTotal - MemAvailable，其它平台退回 os.freemem()
 * - 网速：macOS 用 `netstat -ib -n`，Linux 用 /proc/net/dev；只统计物理/无线网卡
 *   （en/eth/wl/ww），排除 lo、utun、bridge、docker 等虚拟接口，避免 VPN/TUN 重复计数
 *
 * 全部异步执行（execFile / readFile），定时器 unref，不阻塞 TUI 渲染也不阻止进程退出。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

export interface SysStats {
	/** CPU 使用率 0-100；首次采样前为 undefined */
	cpuPct?: number;
	/** 内存使用率 0-100 */
	memPct?: number;
	/** 下行 / 上行速率（bytes/s）；平台不支持时为 undefined */
	rxRate?: number;
	txRate?: number;
}

interface CpuSnapshot {
	idle: number;
	total: number;
}

interface NetSnapshot {
	rx: number;
	tx: number;
	at: number;
}

const PHYSICAL_IFACE = /^(en|eth|wl|ww)/;

function run(cmd: string, args: string[], timeoutMs = 1500): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout);
		});
	});
}

export function cpuSnapshot(): CpuSnapshot {
	let idle = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		const t = cpu.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	return { idle, total };
}

export function cpuPercent(prev: CpuSnapshot, cur: CpuSnapshot): number | undefined {
	const total = cur.total - prev.total;
	if (total <= 0) return undefined;
	const busy = total - (cur.idle - prev.idle);
	return Math.min(100, Math.max(0, (busy / total) * 100));
}

/** 解析 vm_stat 输出，返回已使用内存（bytes）。 */
export function parseVmStat(text: string): number | undefined {
	const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
	const pages = (label: string): number | undefined => {
		const m = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text);
		return m ? Number(m[1]) : undefined;
	};
	const anonymous = pages("Anonymous pages");
	const purgeable = pages("Pages purgeable") ?? 0;
	const wired = pages("Pages wired down");
	const compressed = pages("Pages occupied by compressor") ?? 0;
	if (wired === undefined) return undefined;
	// 老版本 macOS 没有 Anonymous pages，退回 active
	const app = anonymous !== undefined ? Math.max(0, anonymous - purgeable) : (pages("Pages active") ?? 0);
	return (app + wired + compressed) * pageSize;
}

/** 解析 /proc/meminfo，返回 { total, used }（bytes）。 */
export function parseMeminfo(text: string): { total: number; used: number } | undefined {
	const kb = (key: string): number | undefined => {
		const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
		return m ? Number(m[1]) * 1024 : undefined;
	};
	const total = kb("MemTotal");
	const available = kb("MemAvailable");
	if (!total || available === undefined) return undefined;
	return { total, used: total - available };
}

/** 解析 `netstat -ib -n`，累加物理网卡 Link 行的 Ibytes / Obytes。 */
export function parseNetstat(text: string): { rx: number; tx: number } | undefined {
	let rx = 0;
	let tx = 0;
	let found = false;
	for (const line of text.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 10 || !cols[2]?.startsWith("<Link#")) continue;
		const name = cols[0]!.replace(/\*$/, "");
		if (!PHYSICAL_IFACE.test(name)) continue;
		// 末尾 7 列固定为 Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll（Address 列可能为空）
		const n = cols.length;
		const ib = Number(cols[n - 5]);
		const ob = Number(cols[n - 2]);
		if (!Number.isFinite(ib) || !Number.isFinite(ob)) continue;
		rx += ib;
		tx += ob;
		found = true;
	}
	return found ? { rx, tx } : undefined;
}

/** 解析 /proc/net/dev，累加物理网卡的 rx/tx bytes。 */
export function parseProcNetDev(text: string): { rx: number; tx: number } | undefined {
	let rx = 0;
	let tx = 0;
	let found = false;
	for (const line of text.split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const name = line.slice(0, idx).trim();
		if (!PHYSICAL_IFACE.test(name)) continue;
		const cols = line.slice(idx + 1).trim().split(/\s+/);
		const r = Number(cols[0]);
		const t = Number(cols[8]);
		if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
		rx += r;
		tx += t;
		found = true;
	}
	return found ? { rx, tx } : undefined;
}

/** 最长 7 列（如 `1024K/s`、`12.3M/s` → ≥ 10M 时取整 `123M/s`），配合 padStart 做等宽显示。 */
export function formatRate(bytesPerSec: number): string {
	if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)}B/s`;
	if (bytesPerSec < 1024 * 1024) return `${Math.round(bytesPerSec / 1024)}K/s`;
	if (bytesPerSec < 1024 * 1024 * 1024) {
		const mb = bytesPerSec / 1024 / 1024;
		return mb < 10 ? `${mb.toFixed(1)}M/s` : `${Math.round(mb)}M/s`;
	}
	return `${(bytesPerSec / 1024 / 1024 / 1024).toFixed(1)}G/s`;
}

/** 同步的初始 OS 名称（不含版本），异步解析后会被替换。arch 由调用方自行拼接。 */
export function basicOsLabel(): string {
	return process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : os.type();
}

async function resolveOsLabel(): Promise<string> {
	try {
		if (process.platform === "darwin") {
			const ver = (await run("sw_vers", ["-productVersion"])).trim();
			if (ver) return `macOS ${ver}`;
		} else if (process.platform === "linux") {
			const text = await readFile("/etc/os-release", "utf8");
			const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)?.[1];
			if (pretty) return pretty;
		} else if (process.platform === "win32") {
			return os.version();
		}
	} catch {
		// 忽略，使用基础标签
	}
	return basicOsLabel();
}

export class SysMonitor {
	stats: SysStats = {};
	/** 当前平台能否采集网速（用于在首次采样前就预留占位，避免出现时布局跳动） */
	readonly netSupported = process.platform === "darwin" || process.platform === "linux";
	osLabel = basicOsLabel();
	onUpdate: () => void = () => {};

	private timer: ReturnType<typeof setInterval> | undefined;
	private prevCpu: CpuSnapshot | undefined;
	private prevNet: NetSnapshot | undefined;
	private busy = false;

	constructor(private readonly intervalMs = 2000) {}

	start(): void {
		if (this.timer) return;
		void resolveOsLabel().then((label) => {
			this.osLabel = label;
			this.onUpdate();
		});
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private async tick(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const cpu = cpuSnapshot();
			if (this.prevCpu) this.stats.cpuPct = cpuPercent(this.prevCpu, cpu);
			this.prevCpu = cpu;

			this.stats.memPct = await this.sampleMem();

			const net = await this.sampleNet();
			if (net) {
				const now = Date.now();
				if (this.prevNet && now > this.prevNet.at) {
					const sec = (now - this.prevNet.at) / 1000;
					this.stats.rxRate = Math.max(0, net.rx - this.prevNet.rx) / sec;
					this.stats.txRate = Math.max(0, net.tx - this.prevNet.tx) / sec;
				}
				this.prevNet = { ...net, at: now };
			}
			this.onUpdate();
		} finally {
			this.busy = false;
		}
	}

	private async sampleMem(): Promise<number | undefined> {
		const total = os.totalmem();
		try {
			if (process.platform === "darwin") {
				const used = parseVmStat(await run("vm_stat", []));
				if (used !== undefined && total > 0) return Math.min(100, (used / total) * 100);
			} else if (process.platform === "linux") {
				const m = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
				if (m) return (m.used / m.total) * 100;
			}
		} catch {
			// 退回 os.freemem
		}
		return total > 0 ? ((total - os.freemem()) / total) * 100 : undefined;
	}

	private async sampleNet(): Promise<{ rx: number; tx: number } | undefined> {
		try {
			if (process.platform === "darwin") return parseNetstat(await run("netstat", ["-ib", "-n"]));
			if (process.platform === "linux") return parseProcNetDev(await readFile("/proc/net/dev", "utf8"));
		} catch {
			// 不支持则不显示网速
		}
		return undefined;
	}
}
