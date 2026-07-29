import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export interface ExtractionResult {
	method: "readability" | "pdf" | "jina" | "direct";
	content: string;
	title?: string;
	author?: string;
	publishedDate?: string;
	url: string;
	wordCount: number;
	quality: number;
	usedFallback: boolean;
}

export interface QualityMetrics {
	contentLength: number;
	wordCount: number;
	hasTitle: boolean;
	hasMetadata: boolean;
	textDensity?: number;
}

export interface FetchContentOptions {
	qualityThreshold?: number;
	allowJina?: boolean;
	timeout?: number;
	signal?: AbortSignal;
	maxHtmlBytes?: number;
	maxPdfBytes?: number;
}

type ResponseLike = {
	headers: { get(name: string): string | null };
	body: ReadableStream<Uint8Array> | null;
};

type ResolvedDestination = { url: URL; address: string; family: 4 | 6 };
type BoundedResponse = {
	status: number;
	ok: boolean;
	headers: { get(name: string): string | null };
	body: Buffer;
	url: string;
};

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
	["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 96], ["100::", 64], ["2001:db8::", 32],
	["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");

export function isPdfUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const pathname = url.pathname.toLowerCase();
		return pathname.endsWith(".pdf") || pathname.includes("/pdf/") || pathname.includes(".pdf/") ||
			url.searchParams.has("pdf") || url.searchParams.get("format") === "pdf";
	} catch {
		return false;
	}
}

export function isPdfContentType(contentType: string | null): boolean {
	return contentType?.toLowerCase().includes("application/pdf") ?? false;
}

export function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

export function calculateQuality(metrics: QualityMetrics): number {
	let score = 0;
	if (metrics.wordCount >= 1_000) score += 40;
	else if (metrics.wordCount >= 500) score += 30;
	else if (metrics.wordCount >= 100) score += 10 + (metrics.wordCount - 100) / 20;
	else if (metrics.wordCount >= 1) score += metrics.wordCount / 10;
	if (metrics.hasTitle) score += 20;
	if (metrics.hasMetadata) score += 20;
	if (metrics.textDensity !== undefined) score += Math.max(0, Math.min(1, metrics.textDensity)) * 20;
	return Math.min(100, Math.max(0, score));
}

export function shouldUseFallback(quality: number, threshold = 50): boolean {
	return quality < threshold;
}

export function resolveMarkdownLinks(markdown: string, pageUrl: string): string {
	return markdown.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (match, prefix: string, target: string, suffix: string) => {
		if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return match;
		try {
			return `${prefix}${new URL(target, pageUrl).toString()}${suffix}`;
		} catch {
			return match;
		}
	});
}

export async function extractFromHtml(html: string, url: string): Promise<ExtractionResult | null> {
	try {
		const [{ Readability }, { parseHTML }, turndownModule] = await Promise.all([
			import("@mozilla/readability"),
			import("linkedom"),
			import("turndown"),
		]);
		const { document } = parseHTML(html);
		const article = new Readability(document as never, { charThreshold: 100 }).parse();
		if (!article?.content) return null;
		const turndown = new turndownModule.default({ headingStyle: "atx", codeBlockStyle: "fenced" });
		const { document: contentDocument } = parseHTML(article.content);
		const markdown = resolveMarkdownLinks(turndown.turndown(contentDocument.toString()), url);
		const wordCount = countWords(markdown);
		const quality = calculateQuality({
			contentLength: markdown.length,
			wordCount,
			hasTitle: Boolean(article.title),
			hasMetadata: Boolean(article.byline || article.publishedTime),
			textDensity: article.content ? markdown.length / article.content.length : 0,
		});
		return {
			method: "readability",
			content: markdown,
			title: article.title || undefined,
			author: article.byline || undefined,
			publishedDate: article.publishedTime || undefined,
			url,
			wordCount,
			quality,
			usedFallback: false,
		};
	} catch {
		return null;
	}
}

export async function extractFromPdf(pdfData: Buffer | Uint8Array, url: string): Promise<ExtractionResult> {
	try {
		const { extractText } = await import("unpdf");
		const result = await extractText(pdfData);
		const content = (Array.isArray(result.text) ? result.text : [result.text || ""]).join("\n\n");
		const wordCount = countWords(content);
		return {
			method: "pdf",
			content,
			url,
			wordCount,
			quality: calculateQuality({ contentLength: content.length, wordCount, hasTitle: false, hasMetadata: false, textDensity: 1 }),
			usedFallback: false,
		};
	} catch (error) {
		throw new Error(`PDF extraction failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function extractDirect(html: string, url: string): ExtractionResult {
	const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/&[^;]+;/g, " ").trim() || undefined;
	const content = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<(?:nav|header|footer)[\s\S]*?<\/(?:nav|header|footer)>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&[^;]+;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const wordCount = countWords(content);
	return {
		method: "direct",
		content,
		title,
		url,
		wordCount,
		quality: calculateQuality({ contentLength: content.length, wordCount, hasTitle: Boolean(title), hasMetadata: false }),
		usedFallback: false,
	};
}

export async function validatePublicUrl(value: string): Promise<URL> {
	return (await resolvePublicDestination(value)).url;
}

async function resolvePublicDestination(value: string): Promise<ResolvedDestination> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported");
	if (url.username || url.password) throw new Error("URLs with embedded credentials are not supported");

	const hostname = normalizeHostname(url.hostname);
	if (hostname === "localhost" || hostname.endsWith(".localhost")) throw privateUrlError();
	const literalFamily = isIP(hostname);
	const addresses = literalFamily
		? [{ address: hostname, family: literalFamily as 4 | 6 }]
		: await lookupAll(hostname);
	if (!addresses.length) throw new Error(`Could not resolve ${hostname}`);
	if (!privateUrlsAllowed() && addresses.some(({ address, family }) => NON_PUBLIC_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6"))) {
		throw privateUrlError();
	}
	return { url, address: addresses[0].address, family: addresses[0].family as 4 | 6 };
}

function lookupAll(hostname: string): Promise<Array<{ address: string; family: number }>> {
	return new Promise((resolve, reject) => {
		dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
			if (error) reject(error);
			else resolve(addresses);
		});
	});
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function privateUrlsAllowed(): boolean {
	return /^(?:1|true|yes|on)$/i.test(process.env.PI_SEARCH_ALLOW_PRIVATE_URLS ?? "");
}

function privateUrlError(): Error {
	return new Error("Private-network URLs are disabled; set PI_SEARCH_ALLOW_PRIVATE_URLS=true to enable them");
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function pinnedAgent(destination: ResolvedDestination): Agent {
	const expectedHostname = normalizeHostname(destination.url.hostname);
	const lookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
		if (normalizeHostname(hostname) !== expectedHostname) {
			callback(Object.assign(new Error("Unexpected hostname during pinned connection"), { code: "ENOTFOUND" }));
			return;
		}
		if (options.all) callback(null, [{ address: destination.address, family: destination.family }]);
		else callback(null, destination.address, destination.family);
	}) as unknown as LookupFunction;
	return new Agent({ connect: { lookup } });
}

async function fetchBounded(
	value: string,
	init: { headers?: Record<string, string>; signal?: AbortSignal },
	limitFor: (url: string, contentType: string | null) => number,
): Promise<BoundedResponse> {
	let current = value;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const destination = await resolvePublicDestination(current);
		const dispatcher = pinnedAgent(destination);
		try {
			const response = await undiciFetch(destination.url, {
				headers: init.headers,
				signal: init.signal,
				redirect: "manual",
				dispatcher,
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				await response.body?.cancel();
				if (!location) throw new Error(`Redirect HTTP ${response.status} did not include a Location header`);
				if (redirects === 5) throw new Error("Too many redirects");
				current = new URL(location, destination.url).toString();
				continue;
			}
			const contentType = response.headers.get("content-type");
			const body = await readResponseBounded(response as unknown as ResponseLike, limitFor(current, contentType));
			return { status: response.status, ok: response.ok, headers: response.headers, body, url: destination.url.toString() };
		} finally {
			await dispatcher.close();
		}
	}
	throw new Error("Too many redirects");
}

export async function readResponseBounded(response: ResponseLike, maxBytes: number): Promise<Buffer> {
	const safeMax = Math.max(1, Math.trunc(maxBytes));
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > safeMax) {
		throw new Error(`Response is too large (${declaredLength} bytes; limit ${safeMax})`);
	}
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > safeMax) {
				await reader.cancel("response size limit exceeded");
				throw new Error(`Response exceeded ${safeMax} byte limit`);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

async function extractViaJina(url: string, signal: AbortSignal): Promise<ExtractionResult> {
	const response = await fetchBounded(`https://r.jina.ai/${url}`, {
		headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
		signal,
	}, () => 5 * 1024 * 1024);
	if (!response.ok) throw new Error(`Jina API returned ${response.status}`);
	const content = response.body.toString("utf8");
	const wordCount = countWords(content);
	const firstLine = content.split("\n", 1)[0];
	const title = firstLine.startsWith("# ") ? firstLine.slice(2).trim() : undefined;
	return {
		method: "jina",
		content,
		title,
		url,
		wordCount,
		quality: calculateQuality({ contentLength: content.length, wordCount, hasTitle: Boolean(title), hasMetadata: false }),
		usedFallback: true,
	};
}

export async function fetchContent(url: string, options: FetchContentOptions = {}): Promise<ExtractionResult> {
	const {
		qualityThreshold = 50,
		allowJina = /^(?:1|true|yes|on)$/i.test(process.env.JINA_ENABLED ?? ""),
		timeout = 15_000,
		signal,
		maxHtmlBytes = 5 * 1024 * 1024,
		maxPdfBytes = 25 * 1024 * 1024,
	} = options;
	const combinedSignal = timeoutSignal(signal, timeout);
	try {
		const response = await fetchBounded(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; PiSearch/1.0)",
				Accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
			},
			signal: combinedSignal,
		}, (current, contentType) => isPdfUrl(current) || isPdfContentType(contentType) ? maxPdfBytes : maxHtmlBytes);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const contentType = response.headers.get("content-type");
		if (isPdfUrl(response.url) || isPdfContentType(contentType)) return extractFromPdf(response.body, response.url);

		const html = response.body.toString("utf8");
		const readability = await extractFromHtml(html, response.url);
		if (readability && !shouldUseFallback(readability.quality, qualityThreshold)) return readability;
		if (allowJina) {
			try {
				return await extractViaJina(url, combinedSignal);
			} catch {
				// Preserve the best local result if the optional third-party service fails.
			}
		}
		return readability ?? extractDirect(html, response.url);
	} catch (error) {
		if (allowJina) {
			try {
				return await extractViaJina(url, combinedSignal);
			} catch (jinaError) {
				throw new Error(`All extraction methods failed. Primary: ${message(error)}; Jina: ${message(jinaError)}`);
			}
		}
		throw new Error(`Local extraction failed: ${message(error)}. Set JINA_ENABLED=true to allow third-party fallback.`);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
