import { fetchContent } from "./content/extractor.js";
import { ensureSearxng, type SearxngExecTarget } from "./searxng.js";

export interface SearchOptions {
	searxngUrl?: string;
	braveApiKey?: string;
	searxngTarget?: SearxngExecTarget;
}

export interface WebSearchInput {
	query?: string;
	queries?: string[];
	max_results?: number;
	provider?: "searxng" | "brave";
}

export interface FetchContentInput {
	url: string;
	quality_threshold?: number;
	force_jina?: boolean;
	max_chars?: number;
}

export interface CompactOperationResult {
	ok: true;
	isError: false;
	text: string;
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
export const MAX_OUTPUT_CHARS = 50_000;

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
	return lines.join("\n").trim().slice(0, MAX_OUTPUT_CHARS);
}

function formatFetchSummary(args: {
	url: string;
	title?: string;
	method?: string;
	quality?: number;
	content: string;
	maxChars: number;
}): string {
	const preview = args.content.slice(0, args.maxChars);
	const truncated = preview.length < args.content.length
		? `\n\n[Showing the first ${preview.length} of ${args.content.length} characters. Increase max_chars to return more (up to ${MAX_OUTPUT_CHARS}).]`
		: "";
	return [
		"Content fetched.",
		`URL: ${args.url}`,
		args.title ? `Title: ${args.title}` : undefined,
		args.method ? `Method: ${args.method}` : undefined,
		args.quality !== undefined ? `Quality: ${roundScore(args.quality)}` : undefined,
		`Full length: ${args.content.length} chars`,
		"",
		preview + truncated,
	].filter((value) => value !== undefined).join("\n").slice(0, MAX_OUTPUT_CHARS);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function searchUrl(base: string): URL {
	const normalized = base.endsWith("/") ? base : `${base}/`;
	return new URL("search", normalized);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error && signal.reason.name === "AbortError") throw signal.reason;
	const error = new Error("Invocation aborted", { cause: signal.reason });
	error.name = "AbortError";
	throw error;
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
	provider: WebSearchInput["provider"],
	signal: AbortSignal | undefined,
	options: SearchOptions,
): Promise<{ query: string; provider: string; results: SearchResult[] }> {
	const braveKey = options.braveApiKey ?? process.env.BRAVE_API_KEY;
	const providers = provider ? [provider] : ["searxng", braveKey ? "brave" : undefined].filter(Boolean) as string[];
	const errors: string[] = [];
	for (const candidate of providers) {
		try {
			throwIfAborted(signal);
			const results = candidate === "searxng"
				? await searchSearxng(query, maxResults, signal, options.searxngUrl)
				: await searchBrave(query, maxResults, signal, braveKey);
			if (!provider && results.length === 0 && providers.length > 1) {
				errors.push(`${candidate}: no results`);
				continue;
			}
			return { query, provider: candidate, results };
		} catch (error) {
			throwIfAborted(signal);
			errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`all providers failed (${errors.join("; ")})`);
}

export async function webSearch(
	input: unknown,
	options: SearchOptions = {},
	signal?: AbortSignal,
): Promise<CompactOperationResult> {
	const params = validateWebSearchInput(input);
	throwIfAborted(signal);
	const queries = params.queries?.length ? params.queries : params.query ? [params.query] : [];
	if (!queries.length) throw new Error("Provide query or queries.");
	if (params.provider !== "brave") {
		try {
			await ensureSearxng(options.searxngTarget ?? {}, { url: options.searxngUrl, signal });
		} catch (error) {
			throwIfAborted(signal);
			if (params.provider === "searxng" || !(options.braveApiKey ?? process.env.BRAVE_API_KEY)) throw error;
		}
	}
	const settled = await Promise.allSettled(
		queries.map((query) => doSearch(query, params.max_results ?? 5, params.provider, signal, options)),
	);
	throwIfAborted(signal);
	const searches: Array<{ query: string; provider: string; results: SearchResult[] }> = [];
	const errors: Array<{ query: string; error: string }> = [];
	settled.forEach((result, index) => {
		if (result.status === "fulfilled") searches.push({ ...result.value, results: compactResults(result.value.results) });
		else errors.push({ query: queries[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
	});
	if (!searches.length) throw new Error(`web_search failed: ${errors.map((item) => `${item.query}: ${item.error}`).join("; ")}`);
	return { ok: true, isError: false, text: formatSearchSummary(searches, errors) };
}

export async function fetchExtractedContent(
	input: unknown,
	signal?: AbortSignal,
): Promise<CompactOperationResult> {
	const params = validateFetchContentInput(input);
	throwIfAborted(signal);
	const result = await fetchContent(params.url, {
		qualityThreshold: params.quality_threshold ?? 50,
		forceJina: Boolean(params.force_jina),
		signal,
	});
	throwIfAborted(signal);
	return {
		ok: true,
		isError: false,
		text: formatFetchSummary({
			url: result.url,
			title: result.title,
			method: result.method,
			quality: result.quality,
			content: result.content,
			maxChars: params.max_chars ?? 12_000,
		}),
	};
}

function validateWebSearchInput(input: unknown): WebSearchInput {
	if (!isRecord(input)) throw new Error("web_search input must be an object.");
	const { query, queries, max_results: maxResults, provider } = input;
	if (query !== undefined && (typeof query !== "string" || query.length < 1)) throw new Error("query must be a non-empty string.");
	if (queries !== undefined && (!Array.isArray(queries) || queries.length < 1 || queries.length > 5 || queries.some((item) => typeof item !== "string" || item.length < 1))) {
		throw new Error("queries must contain 1 to 5 non-empty strings.");
	}
	if (maxResults !== undefined && (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > 20)) {
		throw new Error("max_results must be an integer from 1 to 20.");
	}
	if (provider !== undefined && provider !== "searxng" && provider !== "brave") throw new Error("provider must be searxng or brave.");
	return { query: query as string | undefined, queries: queries as string[] | undefined, max_results: maxResults as number | undefined, provider };
}

function validateFetchContentInput(input: unknown): FetchContentInput {
	if (!isRecord(input)) throw new Error("fetch_content input must be an object.");
	const { url, quality_threshold: qualityThreshold, force_jina: forceJina, max_chars: maxChars } = input;
	if (typeof url !== "string" || url.length < 1) throw new Error("url must be a non-empty string.");
	if (qualityThreshold !== undefined && (typeof qualityThreshold !== "number" || !Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 100)) {
		throw new Error("quality_threshold must be a number from 0 to 100.");
	}
	if (forceJina !== undefined && typeof forceJina !== "boolean") throw new Error("force_jina must be a boolean.");
	if (maxChars !== undefined && (!Number.isInteger(maxChars) || (maxChars as number) < 1 || (maxChars as number) > MAX_OUTPUT_CHARS)) {
		throw new Error(`max_chars must be an integer from 1 to ${MAX_OUTPUT_CHARS}.`);
	}
	return { url, quality_threshold: qualityThreshold as number | undefined, force_jina: forceJina as boolean | undefined, max_chars: maxChars as number | undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
