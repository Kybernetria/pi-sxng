import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchContent } from "./content/extractor.js";
import { getCachedContent, putCachedContent, sliceContent } from "./cache.js";
import { ensureSearxng } from "./searxng.js";

export interface SearchOptions {
	searxngUrl?: string;
	braveApiKey?: string;
}

export type SearchResult = {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	score?: number;
	engines?: string[];
};

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";
const MAX_TOOL_CHARS = 50_000;

function truncate(text: string | undefined, max = 320): string | undefined {
	if (!text) return undefined;
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function roundScore(score: number | undefined): number | undefined {
	return score === undefined ? undefined : Math.round(score * 100) / 100;
}

function compactResults(results: SearchResult[]): SearchResult[] {
	return results.map((result) => ({
		title: result.title,
		url: result.url,
		snippet: truncate(result.snippet),
		publishedDate: result.publishedDate,
		score: roundScore(result.score),
		engines: result.engines,
	}));
}

function formatSearchSummary(
	searches: Array<{ query: string; provider: string; results: SearchResult[] }>,
	errors: Array<{ query: string; error: string }> = [],
): string {
	const lines: string[] = [];
	for (const search of searches) {
		lines.push(`## ${search.query} (${search.provider}, ${search.results.length} results)`);
		if (!search.results.length) lines.push("No results.");
		search.results.forEach((result, index) => {
			lines.push("", `${index + 1}. ${result.title}`, `   ${result.url}`);
			if (result.snippet) lines.push(`   ${result.snippet}`);
			const metadata = [
				result.publishedDate ? `date: ${result.publishedDate}` : undefined,
				result.score !== undefined ? `score: ${result.score}` : undefined,
				result.engines?.length ? `engines: ${result.engines.join(", ")}` : undefined,
			].filter(Boolean);
			if (metadata.length) lines.push(`   [${metadata.join("; ")}]`);
		});
		lines.push("");
	}
	if (errors.length) {
		lines.push("## Failed queries");
		for (const failure of errors) lines.push(`- ${failure.query}: ${failure.error}`);
	}
	return lines.join("\n").trim();
}

function formatFetchSummary(args: {
	id: string;
	url: string;
	title?: string;
	method?: string;
	quality?: number;
	fullLength: number;
	cached?: boolean;
	preview: string;
	end: number;
}): string {
	const continuation = args.end < args.fullLength
		? `\n\n[Showing characters 0-${args.end} of ${args.fullLength}. Continue with get_cached_content using id "${args.id}" and start=${args.end}.]`
		: "";
	return [
		args.cached ? "Cached content found." : "Content fetched and cached.",
		`ID: ${args.id}`,
		`URL: ${args.url}`,
		args.title ? `Title: ${args.title}` : undefined,
		args.method ? `Method: ${args.method}` : undefined,
		args.quality !== undefined ? `Quality: ${roundScore(args.quality)}` : undefined,
		`Full length: ${args.fullLength} chars`,
		"",
		args.preview + continuation,
	].filter((value) => value !== undefined).join("\n");
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function searchUrl(base: string): URL {
	const normalized = base.endsWith("/") ? base : `${base}/`;
	return new URL("search", normalized);
}

export async function searchSearxng(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
	base = process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL,
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
	const data = await response.json() as { results?: Array<Record<string, unknown>> };
	return (data.results ?? []).slice(0, maxResults).map((result) => ({
		title: String(result.title ?? result.url ?? "Untitled"),
		url: String(result.url ?? ""),
		snippet: result.content ? String(result.content) : undefined,
		publishedDate: result.publishedDate ? String(result.publishedDate) : undefined,
		score: typeof result.score === "number" ? result.score : undefined,
		engines: Array.isArray(result.engines) ? result.engines.map(String) : undefined,
	})).filter((result) => Boolean(result.url));
}

export async function searchBrave(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
	key = process.env.BRAVE_API_KEY,
): Promise<SearchResult[]> {
	if (!key) throw new Error("BRAVE_API_KEY is not configured");
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(maxResults, 20)));
	const response = await fetch(url, {
		headers: { Accept: "application/json", "X-Subscription-Token": key },
		signal: requestSignal(signal, 15_000),
	});
	if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
	const data = await response.json() as { web?: { results?: Array<Record<string, unknown>> } };
	return (data.web?.results ?? []).map((result) => ({
		title: String(result.title ?? result.url ?? "Untitled"),
		url: String(result.url ?? ""),
		snippet: result.description ? String(result.description) : undefined,
		publishedDate: result.age ? String(result.age) : undefined,
	})).filter((result) => Boolean(result.url));
}

async function doSearch(
	query: string,
	maxResults: number,
	provider: string | undefined,
	signal: AbortSignal | undefined,
	options: SearchOptions,
): Promise<{ query: string; provider: string; results: SearchResult[] }> {
	const braveKey = options.braveApiKey ?? process.env.BRAVE_API_KEY;
	const providers = provider ? [provider] : ["searxng", braveKey ? "brave" : undefined].filter(Boolean) as string[];
	const errors: string[] = [];
	for (const candidate of providers) {
		try {
			const results = candidate === "searxng"
				? await searchSearxng(query, maxResults, signal, options.searxngUrl)
				: candidate === "brave"
					? await searchBrave(query, maxResults, signal, braveKey)
					: (() => { throw new Error(`Unknown provider '${candidate}'`); })();
			// An empty metasearch response is often a backend/configuration failure.
			if (!provider && results.length === 0 && providers.length > 1) {
				errors.push(`${candidate}: no results`);
				continue;
			}
			return { query, provider: candidate, results };
		} catch (error) {
			if (signal?.aborted) throw error;
			errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`all providers failed (${errors.join("; ")})`);
}

export function registerWebSearchTools(pi: ExtensionAPI, options: SearchOptions = {}): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web through a local/private SearXNG instance, with optional Brave fallback. Returns up to 20 compact results per query, including snippets and source metadata.",
		promptSnippet: "Search the web via local-first SearXNG with optional Brave fallback",
		promptGuidelines: [
			"Use web_search to discover current or external sources; then use fetch_content on the most relevant result URLs rather than scraping search-result HTML.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ minLength: 1 })),
			queries: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 })),
			max_results: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 20 })),
			provider: Type.Optional(Type.String({ description: 'Optional forced provider: "searxng" or "brave"', enum: ["searxng", "brave"] })),
		}),
		async execute(_id, params, signal) {
			const queries = params.queries?.length ? params.queries : params.query ? [params.query] : [];
			if (!queries.length) throw new Error("Provide query or queries.");
			if (params.provider !== "brave") {
				try {
					await ensureSearxng(pi, { url: options.searxngUrl, signal });
				} catch (error) {
					// Preserve the configured Brave fallback when local container setup fails.
					if (params.provider === "searxng" || !(options.braveApiKey ?? process.env.BRAVE_API_KEY)) throw error;
				}
			}
			const settled = await Promise.allSettled(
				queries.map((query) => doSearch(query, params.max_results ?? 5, params.provider, signal, options)),
			);
			const searches: Array<{ query: string; provider: string; results: SearchResult[] }> = [];
			const errors: Array<{ query: string; error: string }> = [];
			settled.forEach((result, index) => {
				if (result.status === "fulfilled") searches.push({ ...result.value, results: compactResults(result.value.results) });
				else errors.push({ query: queries[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
			});
			if (!searches.length) throw new Error(`web_search failed: ${errors.map((item) => `${item.query}: ${item.error}`).join("; ")}`);
			return {
				details: { ok: true, searches, errors },
				content: [{ type: "text" as const, text: formatSearchSummary(searches, errors) }],
			};
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch and locally extract readable URL/PDF content. Full content is cached; output is capped at 50,000 characters. Jina is opt-in via JINA_ENABLED=true or force_jina=true.",
		promptSnippet: "Extract readable content from a URL or PDF and cache the full result",
		promptGuidelines: [
			"Use fetch_content after web_search to inspect promising sources, and use get_cached_content with the returned id for later slices.",
		],
		parameters: Type.Object({
			url: Type.String({ minLength: 1 }),
			quality_threshold: Type.Optional(Type.Number({ default: 50, minimum: 0, maximum: 100 })),
			force_jina: Type.Optional(Type.Boolean({ default: false })),
			max_chars: Type.Optional(Type.Integer({ default: 12000, minimum: 1, maximum: MAX_TOOL_CHARS })),
			refresh: Type.Optional(Type.Boolean({ default: false, description: "Ignore any cached copy and fetch again" })),
			cache_max_age_minutes: Type.Optional(Type.Number({ minimum: 0, description: "Treat older cache entries as stale" })),
		}),
		async execute(_id, params, signal) {
			const existing = !params.refresh && !params.force_jina
				? getCachedContent({ url: params.url, maxAgeMs: params.cache_max_age_minutes === undefined ? undefined : params.cache_max_age_minutes * 60_000 })
				: null;
			if (existing) {
				const slice = sliceContent(existing.content, 0, params.max_chars ?? 12000);
				return {
					details: { ok: true, cached: true, id: existing.id, url: existing.url, title: existing.title, method: existing.method, quality: existing.quality, preview: slice.text, full_length: slice.fullLength },
					content: [{ type: "text" as const, text: formatFetchSummary({ id: existing.id, url: existing.url, title: existing.title, method: existing.method, quality: existing.quality, fullLength: slice.fullLength, end: slice.end, cached: true, preview: slice.text }) }],
				};
			}
			const result = await fetchContent(params.url, {
				qualityThreshold: params.quality_threshold ?? 50,
				forceJina: Boolean(params.force_jina),
				signal,
			});
			const record = putCachedContent({ url: result.url, title: result.title, content: result.content, method: result.method, quality: result.quality, wordCount: result.wordCount });
			const slice = sliceContent(record.content, 0, params.max_chars ?? 12000);
			return {
				details: { ok: true, cached: false, id: record.id, url: record.url, title: record.title, method: result.method, quality: result.quality, preview: slice.text, full_length: slice.fullLength },
				content: [{ type: "text" as const, text: formatFetchSummary({ id: record.id, url: record.url, title: record.title, method: result.method, quality: result.quality, fullLength: slice.fullLength, end: slice.end, preview: slice.text }) }],
			};
		},
	});

	pi.registerTool({
		name: "get_cached_content",
		label: "Get Cached Content",
		description: "Retrieve cached content by id or URL with offset slicing. Output is capped at 50,000 characters.",
		promptSnippet: "Read another bounded slice of content previously cached by fetch_content",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ minLength: 1 })),
			url: Type.Optional(Type.String({ minLength: 1 })),
			start: Type.Optional(Type.Integer({ default: 0, minimum: 0 })),
			max_chars: Type.Optional(Type.Integer({ default: 20000, minimum: 1, maximum: MAX_TOOL_CHARS })),
		}),
		async execute(_id, params) {
			if (!params.id && !params.url) throw new Error("Provide id or url.");
			const record = getCachedContent({ id: params.id, url: params.url });
			if (!record) throw new Error("No cached content found for id/url.");
			const slice = sliceContent(record.content, params.start ?? 0, params.max_chars ?? 20000);
			const continuation = slice.end < slice.fullLength
				? `\n\n[Showing characters ${slice.start}-${slice.end} of ${slice.fullLength}. Continue with start=${slice.end}.]`
				: "";
			return {
				details: { ok: true, id: record.id, url: record.url, title: record.title, start: slice.start, end: slice.end, full_length: slice.fullLength },
				content: [{ type: "text" as const, text: slice.text + continuation }],
			};
		},
	});
}
