import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_URL = "http://127.0.0.1:8888";
const CONTAINER_NAME = "pi-search-searxng";
const DEFAULT_IMAGE = "docker.io/searxng/searxng:latest";
const SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "searxng-settings.yml");
const LEASE_DIR = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-search-sessions-${process.getuid?.() ?? "user"}`);

type ExecTarget = Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] };
type CommandResult = { stdout: string; stderr: string; code: number | null };

let startupPromise: Promise<SearxngStatus> | undefined;

export interface SearxngStatus {
	url: string;
	healthy: boolean;
	managed: boolean;
	runtime?: string;
	message: string;
}

export function configuredSearxngUrl(override?: string): string {
	const configured = override || process.env.SEARXNG_URL || DEFAULT_URL;
	try {
		const parsed = new URL(configured);
		const authority = configured.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
		const hasExplicitPort = authority.startsWith("[") ? /\]:\d+$/.test(authority) : /:\d+$/.test(authority);
		// A local URL without a port should still target the bundled service,
		// rather than privileged host port 80. Preserve an explicit :80.
		if (!hasExplicitPort && !parsed.port && isLoopbackSearxng(configured)) {
			parsed.port = new URL(DEFAULT_URL).port;
			return parsed.toString();
		}
	} catch { /* preserve invalid input for the caller's diagnostic */ }
	return configured;
}

export function autoStartEnabled(): boolean {
	return !/^(?:0|false|no|off)$/i.test(process.env.PI_SEARCH_AUTO_START ?? "true");
}

export function stopWithPiEnabled(): boolean {
	return !/^(?:0|false|no|off)$/i.test(process.env.PI_SEARCH_STOP_WITH_PI ?? "true");
}

/** Register one active Pi session across processes. */
export function createSessionLease(): string {
	mkdirSync(LEASE_DIR, { recursive: true, mode: 0o700 });
	const path = join(LEASE_DIR, `${process.pid}-${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
	return path;
}

export function removeSessionLease(path: string | undefined): void {
	if (!path || dirname(path) !== LEASE_DIR) return;
	rmSync(path, { force: true });
}

export function countActiveSessionLeases(): number {
	if (!existsSync(LEASE_DIR)) return 0;
	let entries: string[];
	try {
		entries = requireDirectoryEntries(LEASE_DIR);
	} catch {
		return 0;
	}
	let active = 0;
	for (const entry of entries) {
		const path = join(LEASE_DIR, entry);
		try {
			const lease = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
			if (!Number.isInteger(lease.pid) || !isProcessAlive(lease.pid!)) {
				rmSync(path, { force: true });
				continue;
			}
			active++;
		} catch {
			rmSync(path, { force: true });
		}
	}
	return active;
}

export function isLoopbackSearxng(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
	} catch {
		return false;
	}
}

function healthEndpoint(base: string): URL {
	return new URL("healthz", base.endsWith("/") ? base : `${base}/`);
}

export async function probeSearxng(url = configuredSearxngUrl(), signal?: AbortSignal): Promise<boolean> {
	try {
		const timeout = AbortSignal.timeout(2_500);
		const response = await fetch(healthEndpoint(url), {
			headers: { Accept: "text/plain" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function stopSearxngIfUnused(target: ExecTarget, signal?: AbortSignal): Promise<boolean> {
	if (!stopWithPiEnabled() || countActiveSessionLeases() > 0) return false;
	return stopManagedSearxng(target, signal);
}

export async function stopManagedSearxng(target: ExecTarget, signal?: AbortSignal): Promise<boolean> {
	const runtime = await findRuntime(target, signal);
	if (!runtime) return false;
	const inspected = await run(target, runtime, ["container", "inspect", CONTAINER_NAME], signal, 10_000);
	if (inspected.code !== 0) return false;
	const stopped = await run(target, runtime, ["stop", "--time", "10", CONTAINER_NAME], signal, 30_000);
	if (stopped.code !== 0) throw new Error(`${runtime} could not stop ${CONTAINER_NAME}: ${commandError(stopped)}`);
	return true;
}

export async function getSearxngStatus(target: ExecTarget, override?: string, signal?: AbortSignal): Promise<SearxngStatus> {
	const url = configuredSearxngUrl(override);
	if (await probeSearxng(url, signal)) return { url, healthy: true, managed: isLoopbackSearxng(url), message: "SearXNG is ready." };
	if (!isLoopbackSearxng(url)) return { url, healthy: false, managed: false, message: "Configured remote SearXNG endpoint is unavailable; it will not be managed locally." };
	const runtime = await findRuntime(target, signal);
	return {
		url,
		healthy: false,
		managed: true,
		runtime,
		message: runtime ? `SearXNG is not responding; ${runtime} is available.` : "SearXNG is not responding and neither Podman nor Docker is available.",
	};
}

export function ensureSearxng(
	target: ExecTarget,
	options: { url?: string; signal?: AbortSignal; force?: boolean } = {},
): Promise<SearxngStatus> {
	if (!startupPromise) {
		startupPromise = ensureSearxngOnce(target, options).finally(() => { startupPromise = undefined; });
	}
	return startupPromise;
}

async function ensureSearxngOnce(
	target: ExecTarget,
	options: { url?: string; signal?: AbortSignal; force?: boolean },
): Promise<SearxngStatus> {
	const url = configuredSearxngUrl(options.url);
	if (await probeSearxng(url, options.signal)) return { url, healthy: true, managed: isLoopbackSearxng(url), message: "SearXNG is ready." };
	if (!options.force && !autoStartEnabled()) {
		throw new Error(`SearXNG is unavailable at ${url} and PI_SEARCH_AUTO_START is disabled`);
	}
	if (!isLoopbackSearxng(url)) {
		throw new Error(`Remote SearXNG is unavailable at ${url}; automatic container startup is limited to loopback URLs`);
	}

	const parsed = new URL(url);
	if (parsed.pathname !== "/" && parsed.pathname !== "") {
		throw new Error(`Cannot automatically manage SearXNG with URL path ${parsed.pathname}`);
	}
	const hostPort = parsed.port || "80";
	const runtime = await findRuntime(target, options.signal);
	if (!runtime) throw new Error("SearXNG is unavailable and neither Podman nor Docker was found");

	const inspected = await run(target, runtime, ["container", "inspect", CONTAINER_NAME], options.signal, 15_000);
	if (inspected.code === 0) {
		const started = await run(target, runtime, ["start", CONTAINER_NAME], options.signal, 60_000);
		if (started.code !== 0 && !/already running/i.test(`${started.stdout}\n${started.stderr}`)) {
			throw new Error(`${runtime} could not start ${CONTAINER_NAME}: ${commandError(started)}`);
		}
	} else {
		const image = process.env.PI_SEARCH_SEARXNG_IMAGE || DEFAULT_IMAGE;
		const created = await run(target, runtime, [
			"run", "-d", "--name", CONTAINER_NAME, "--restart", "unless-stopped",
			"-p", `127.0.0.1:${hostPort}:8080`,
			"-v", `${SETTINGS_PATH}:/etc/searxng/settings.yml:ro,Z`,
			image,
		], options.signal, 180_000);
		if (created.code !== 0) throw new Error(`${runtime} could not create ${CONTAINER_NAME}: ${commandError(created)}`);
	}

	for (let attempt = 0; attempt < 30; attempt++) {
		if (await probeSearxng(url, options.signal)) {
			return { url, healthy: true, managed: true, runtime, message: `SearXNG is ready (managed by ${runtime}).` };
		}
		await delay(1_000, options.signal);
	}
	throw new Error(`${CONTAINER_NAME} started with ${runtime}, but SearXNG did not become ready at ${url}`);
}

async function findRuntime(target: ExecTarget, signal?: AbortSignal): Promise<string | undefined> {
	const preferred = process.env.PI_SEARCH_CONTAINER_RUNTIME;
	const candidates = preferred ? [preferred] : ["podman", "docker"];
	for (const runtime of candidates) {
		const result = await run(target, runtime, ["--version"], signal, 5_000);
		if (result.code === 0) return runtime;
	}
	return undefined;
}

async function run(target: ExecTarget, command: string, args: string[], signal: AbortSignal | undefined, timeout: number): Promise<CommandResult> {
	if (typeof target.exec === "function") {
		try {
			const result = await target.exec(command, args, { signal, timeout });
			return { stdout: result.stdout, stderr: result.stderr, code: result.code };
		} catch (error) {
			return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1 };
		}
	}
	return spawnCommand(command, args, signal, timeout);
}

function spawnCommand(command: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ stdout, stderr: String(error), code: 1 });
			return;
		}
		child.stdout.on("data", chunk => { stdout += String(chunk); });
		child.stderr.on("data", chunk => { stderr += String(chunk); });
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr, code });
		};
		const abort = () => { child.kill("SIGTERM"); };
		const timer = setTimeout(() => { stderr += `\nTimed out after ${timeoutMs}ms`; child.kill("SIGTERM"); }, timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", error => { stderr += String(error); finish(1); });
		child.on("close", finish);
	});
}

function commandError(result: CommandResult): string {
	return (result.stderr || result.stdout || `exit code ${result.code}`).trim();
}

function requireDirectoryEntries(path: string): string[] {
	return readdirSync(path);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
	});
}
