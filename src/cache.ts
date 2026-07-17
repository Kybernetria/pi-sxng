import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface CachedContentRecord {
	id: string;
	url: string;
	title?: string;
	content: string;
	method?: string;
	quality?: number;
	wordCount?: number;
	createdAt: string;
}

type CacheIndex = { byUrl: Record<string, string> };

const DEFAULT_MAX_CACHE_BYTES = 200 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

function cachePaths(): { cacheDir: string; contentDir: string; indexFile: string; lockDir: string } {
	const cacheDir = process.env.PI_SEARCH_CACHE_DIR || join(process.cwd(), ".pi-search-cache");
	return { cacheDir, contentDir: join(cacheDir, "content"), indexFile: join(cacheDir, "index.json"), lockDir: join(cacheDir, ".lock") };
}

function ensureCache(): ReturnType<typeof cachePaths> {
	const paths = cachePaths();
	mkdirSync(paths.contentDir, { recursive: true, mode: 0o700 });
	if (!existsSync(paths.indexFile)) atomicWrite(paths.indexFile, JSON.stringify({ byUrl: {} }, null, 2));
	return paths;
}

function atomicWrite(path: string, content: string): void {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, content, { mode: 0o600 });
	renameSync(temporary, path);
}

/** Serialize index updates between concurrent Pi processes. */
function withCacheLock<T>(operation: () => T): T {
	const { lockDir } = ensureCache();
	const deadline = Date.now() + 5_000;
	while (true) {
		try {
			mkdirSync(lockDir, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockDir).mtimeMs > 30_000) rmSync(lockDir, { recursive: true, force: true });
			} catch { /* lock was released concurrently */ }
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the content-cache lock");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		return operation();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

function readIndex(): CacheIndex {
	const { indexFile } = ensureCache();
	try {
		const parsed = JSON.parse(readFileSync(indexFile, "utf8")) as Partial<CacheIndex>;
		return { byUrl: parsed.byUrl && typeof parsed.byUrl === "object" ? parsed.byUrl : {} };
	} catch {
		return { byUrl: {} };
	}
}

function writeIndex(index: CacheIndex): void {
	const { indexFile } = ensureCache();
	atomicWrite(indexFile, JSON.stringify(index, null, 2));
}

function configuredPositiveNumber(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function pruneCache(index: CacheIndex): void {
	const { contentDir } = ensureCache();
	const ttlMs = configuredPositiveNumber("PI_SEARCH_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
	const maxBytes = configuredPositiveNumber("PI_SEARCH_CACHE_MAX_BYTES", DEFAULT_MAX_CACHE_BYTES);
	const now = Date.now();
	const records: Array<{ path: string; size: number; createdAt: number }> = [];

	for (const entry of readdirSync(contentDir)) {
		if (!/^content_[a-f0-9]{16}\.json$/.test(entry)) continue;
		const path = join(contentDir, entry);
		try {
			const stat = statSync(path);
			const record = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedContentRecord>;
			const createdAt = Date.parse(record.createdAt ?? "") || stat.mtimeMs;
			if (ttlMs === 0 || now - createdAt > ttlMs) {
				rmSync(path, { force: true });
				continue;
			}
			records.push({ path, size: stat.size, createdAt });
		} catch {
			rmSync(path, { force: true });
		}
	}

	let total = records.reduce((sum, record) => sum + record.size, 0);
	for (const record of records.sort((a, b) => a.createdAt - b.createdAt)) {
		if (total <= maxBytes) break;
		rmSync(record.path, { force: true });
		total -= record.size;
	}
	const retained = new Set(readdirSync(contentDir).map(entry => entry.slice(0, -5)));
	for (const [url, id] of Object.entries(index.byUrl)) {
		if (!retained.has(id)) delete index.byUrl[url];
	}
}

export function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.hostname = parsed.hostname.toLowerCase();
		if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
		for (const key of [...parsed.searchParams.keys()]) {
			if (/^utm_/i.test(key) || /^(?:fbclid|gclid|dclid|mc_cid|mc_eid)$/i.test(key)) parsed.searchParams.delete(key);
		}
		return parsed.toString();
	} catch {
		return url.trim();
	}
}

export function contentIdForUrl(url: string): string {
	return `content_${createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16)}`;
}

function validContentId(id: string): boolean {
	return /^content_[a-f0-9]{16}$/.test(id);
}

export function putCachedContent(input: Omit<CachedContentRecord, "id" | "createdAt"> & { id?: string }): CachedContentRecord {
	return withCacheLock(() => {
		const { contentDir } = ensureCache();
		const normalizedUrl = normalizeUrl(input.url);
		const id = input.id || contentIdForUrl(normalizedUrl);
		if (!validContentId(id)) throw new Error("Invalid cached content id");
		const record: CachedContentRecord = { ...input, url: normalizedUrl, id, createdAt: new Date().toISOString() };
		atomicWrite(join(contentDir, `${id}.json`), JSON.stringify(record, null, 2));
		const index = readIndex();
		index.byUrl[normalizedUrl] = id;
		pruneCache(index);
		writeIndex(index);
		return record;
	});
}

export function getCachedContent(args: { id?: string; url?: string; maxAgeMs?: number }): CachedContentRecord | null {
	const { contentDir } = ensureCache();
	const index = args.url ? readIndex() : undefined;
	const normalizedUrl = args.url ? normalizeUrl(args.url) : undefined;
	const id = args.id || (normalizedUrl ? index?.byUrl[normalizedUrl] ?? index?.byUrl[args.url!] : undefined);
	if (!id || !validContentId(id)) return null;
	const path = join(contentDir, `${id}.json`);
	if (!existsSync(path)) return null;
	try {
		const record = JSON.parse(readFileSync(path, "utf8")) as CachedContentRecord;
		if (!record || record.id !== id || typeof record.url !== "string" || typeof record.content !== "string") return null;
		if (args.maxAgeMs !== undefined) {
			const createdAt = Date.parse(record.createdAt);
			if (!Number.isFinite(createdAt) || Date.now() - createdAt > Math.max(0, args.maxAgeMs)) return null;
		}
		return record;
	} catch {
		return null;
	}
}

export function sliceContent(content: string, start = 0, maxChars = 20_000): { text: string; start: number; end: number; fullLength: number } {
	const safeStart = Math.max(0, Math.min(Math.trunc(start), content.length));
	const safeMax = Math.max(1, Math.min(Math.trunc(maxChars), 50_000));
	const end = Math.min(content.length, safeStart + safeMax);
	return { text: content.slice(safeStart, end), start: safeStart, end, fullLength: content.length };
}
