import { fetchContent } from "./content/extractor.js";
import { configuredSearxngUrl, requireSearxng } from "./searxng.js";

export interface SearchOptions {
	searxngUrl?: string;
}

export interface WebSearchInput {
	query: string;
	max_results?: number;
}

export interface FetchContentInput {
	url: string;
	max_chars?: number;
}

export interface CompactOperationResult {
	text: string;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	score?: number;
	engines?: string[];
}

export const MAX_OUTPUT_CHARS = 50_000;
const WEB_SEARCH_KEYS = new Set(["query", "max_results"]);
const FETCH_CONTENT_KEYS = new Set(["url", "max_chars"]);

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = signal.reason instanceof Error ? signal.reason : new Error("Invocation aborted", { cause: signal.reason });
	error.name = "AbortError";
	throw error;
}

function truncateOneLine(text: string | undefined, max = 320): string | undefined {
	if (!text) return undefined;
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function roundScore(score: number | undefined): number | undefined {
	return score === undefined ? undefined : Math.round(score * 100) / 100;
}

function searchUrl(base: string): URL {
	return new URL("search", base.endsWith("/") ? base : `${base}/`);
}

export async function searchSearxng(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
	base = configuredSearxngUrl(),
): Promise<SearchResult[]> {
	const url = searchUrl(base);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("language", process.env.SEARCH_LANGUAGE || "en");
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: requestSignal(signal, 15_000),
	});
	if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
	const body = await readResponseTextBounded(response, 2 * 1024 * 1024);
	let data: { results?: Array<Record<string, unknown>> };
	try {
		data = JSON.parse(body) as typeof data;
	} catch {
		throw new Error("SearXNG returned invalid JSON");
	}
	if (data.results !== undefined && !Array.isArray(data.results)) throw new Error("SearXNG returned an invalid results list");
	return (data.results ?? []).slice(0, maxResults).map((result) => ({
		title: truncateOneLine(String(result.title ?? result.url ?? "Untitled"), 500) ?? "Untitled",
		url: String(result.url ?? ""),
		snippet: truncateOneLine(result.content ? String(result.content) : undefined),
		publishedDate: truncateOneLine(result.publishedDate ? String(result.publishedDate) : undefined, 100),
		score: typeof result.score === "number" && Number.isFinite(result.score) ? roundScore(result.score) : undefined,
		engines: Array.isArray(result.engines) ? result.engines.slice(0, 20).map(String) : undefined,
	})).filter((result) => Boolean(result.url));
}

export async function webSearch(
	input: unknown,
	options: SearchOptions = {},
	signal?: AbortSignal,
): Promise<CompactOperationResult> {
	const params = validateWebSearchInput(input);
	throwIfAborted(signal);
	const base = await requireSearxng(options.searxngUrl, signal);
	const results = await searchSearxng(params.query, params.max_results ?? 5, signal, base);
	throwIfAborted(signal);
	return { text: formatSearchSummary(params.query, results) };
}

export async function fetchExtractedContent(input: unknown, signal?: AbortSignal): Promise<CompactOperationResult> {
	const params = validateFetchContentInput(input);
	throwIfAborted(signal);
	const result = await fetchContent(params.url, { signal });
	throwIfAborted(signal);
	return { text: formatFetchSummary(result, params.max_chars ?? 12_000) };
}

function formatSearchSummary(query: string, results: SearchResult[]): string {
	const lines = [`## ${query} (searxng, ${results.length} results)`];
	if (!results.length) lines.push("No results.");
	results.forEach((result, index) => {
		lines.push("", `${index + 1}. ${result.title}`, `   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
		const metadata = [
			result.publishedDate ? `date: ${result.publishedDate}` : undefined,
			result.score !== undefined ? `score: ${result.score}` : undefined,
			result.engines?.length ? `engines: ${result.engines.join(", ")}` : undefined,
		].filter((value): value is string => Boolean(value));
		if (metadata.length) lines.push(`   [${metadata.join("; ")}]`);
	});
	return lines.join("\n").slice(0, MAX_OUTPUT_CHARS);
}

function formatFetchSummary(
	result: { url: string; title?: string; method: string; quality: number; content: string },
	maxChars: number,
): string {
	const header = [
		"Content fetched.",
		`URL: ${result.url}`,
		result.title ? `Title: ${result.title}` : undefined,
		`Method: ${result.method}`,
		`Quality: ${roundScore(result.quality)}`,
		`Full length: ${result.content.length} chars`,
		"",
	].filter((value): value is string => value !== undefined).join("\n");
	const full = `${header}\n${result.content}`;
	if (full.length <= maxChars) return full;
	const notice = `\n\n[Output truncated to ${maxChars} characters.]`;
	if (notice.length >= maxChars) return full.slice(0, maxChars);
	return `${full.slice(0, maxChars - notice.length)}${notice}`;
}

function validateWebSearchInput(input: unknown): WebSearchInput {
	const value = requireStrictObject(input, WEB_SEARCH_KEYS, "web_search");
	const { query, max_results: maxResults } = value;
	if (typeof query !== "string" || !query.trim()) throw new Error("query must be a non-empty string.");
	if (query.length > 2_000) throw new Error("query must not exceed 2000 characters.");
	if (maxResults !== undefined && (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > 20)) {
		throw new Error("max_results must be an integer from 1 to 20.");
	}
	return { query: query.trim(), max_results: maxResults as number | undefined };
}

function validateFetchContentInput(input: unknown): FetchContentInput {
	const value = requireStrictObject(input, FETCH_CONTENT_KEYS, "fetch_content");
	const { url, max_chars: maxChars } = value;
	if (typeof url !== "string" || !url.trim()) throw new Error("url must be a non-empty string.");
	if (url.length > 8_192) throw new Error("url must not exceed 8192 characters.");
	if (maxChars !== undefined && (!Number.isInteger(maxChars) || (maxChars as number) < 1 || (maxChars as number) > MAX_OUTPUT_CHARS)) {
		throw new Error(`max_chars must be an integer from 1 to ${MAX_OUTPUT_CHARS}.`);
	}
	return { url: url.trim(), max_chars: maxChars as number | undefined };
}

function requireStrictObject(input: unknown, allowed: ReadonlySet<string>, operation: string): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error(`${operation} input must be an object.`);
	const value = input as Record<string, unknown>;
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length) throw new Error(`${operation} input contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	return value;
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response is too large (${declared} bytes; limit ${maxBytes})`);
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel("response size limit exceeded");
				throw new Error(`Response exceeded ${maxBytes} byte limit`);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}
