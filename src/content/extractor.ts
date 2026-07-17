/**
 * Content extraction utilities for web pages and PDFs.
 * 
 * Supports:
 * - HTML article extraction via @mozilla/readability + linkedom (lazy-loaded)
 * - PDF extraction via unpdf (lazy-loaded)
 * - Jina AI fallback for blocked/poor extraction (https://r.jina.ai/<url>)
 * 
 * Design:
 * - Pure helper functions that are easy to unit test
 * - Quality scoring for extraction results
 * - Automatic fallback decision based on quality thresholds
 * - Heavy DOM/PDF libs are imported dynamically inside `extractFromHtml`
 *   and `extractFromPdf` so they do NOT load at module-eval time.
 *   This shaves ~900 file opens off pi-bakery startup (STARTUP-1).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// NOTE: do NOT add static imports of @mozilla/readability, linkedom,
// turndown or unpdf here. Use `await import(...)` inside the functions
// that need them (extractFromHtml, extractFromPdf). See STARTUP-1.

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ExtractionResult {
	/** Extraction method used */
	method: 'readability' | 'pdf' | 'jina' | 'direct' | 'github' | 'youtube';
	/** Extracted content (markdown or plain text) */
	content: string;
	/** Title if available */
	title?: string;
	/** Author if available */
	author?: string;
	/** Published date if available */
	publishedDate?: string;
	/** URL that was extracted */
	url: string;
	/** Word count */
	wordCount: number;
	/** Quality score 0-100 */
	quality: number;
	/** Whether fallback was used */
	usedFallback: boolean;
}

export interface QualityMetrics {
	/** Content length in characters */
	contentLength: number;
	/** Word count */
	wordCount: number;
	/** Has meaningful title */
	hasTitle: boolean;
	/** Has article metadata (author/date) */
	hasMetadata: boolean;
	/** Readability text density score (0-1) */
	textDensity?: number;
}

// ─── Pure helper functions ─────────────────────────────────────────────────

/**
 * Detect if a URL likely points to a PDF.
 * Checks file extension and common URL patterns.
 */
export function isPdfUrl(url: string): boolean {
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname.toLowerCase();
		
		// Check file extension
		if (pathname.endsWith('.pdf')) return true;
		
		// Check common PDF URL patterns
		if (pathname.includes('/pdf/') || pathname.includes('.pdf/')) return true;
		
		// Check query parameters
		const params = urlObj.searchParams;
		if (params.has('pdf') || params.get('format') === 'pdf') return true;
		
		return false;
	} catch {
		return false;
	}
}

/**
 * Detect if content type indicates PDF.
 */
export function isPdfContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	return contentType.toLowerCase().includes('application/pdf');
}

/**
 * Calculate quality score for extracted content.
 * Returns 0-100 score based on content length, structure, and metadata.
 */
export function calculateQuality(metrics: QualityMetrics): number {
	let score = 0;
	
	// Content length score (0-40 points)
	// 0 words = 0, 100 words = 10, 500 words = 30, 1000+ words = 40
	if (metrics.wordCount >= 1000) score += 40;
	else if (metrics.wordCount >= 500) score += 30;
	else if (metrics.wordCount >= 100) score += 10 + (metrics.wordCount - 100) / 20;
	else if (metrics.wordCount >= 1) score += metrics.wordCount / 10;
	
	// Title score (0-20 points)
	if (metrics.hasTitle) score += 20;
	
	// Metadata score (0-20 points)
	if (metrics.hasMetadata) score += 20;
	
	// Text density score (0-20 points) - Readability specific
	if (metrics.textDensity !== undefined) {
		score += metrics.textDensity * 20;
	}
	
	return Math.min(100, Math.max(0, score));
}

/**
 * Decide whether to use fallback based on quality score.
 * Returns true if quality is below threshold.
 */
export function shouldUseFallback(quality: number, threshold: number = 50): boolean {
	return quality < threshold;
}

/**
 * Count words in text (simple whitespace split).
 */
export function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/** Resolve relative Markdown links/images produced from fetched HTML. */
export function resolveMarkdownLinks(markdown: string, pageUrl: string): string {
	return markdown.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (match, prefix: string, target: string, suffix: string) => {
		if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return match;
		try { return `${prefix}${new URL(target, pageUrl).toString()}${suffix}`; }
		catch { return match; }
	});
}

// ─── Extraction implementations ────────────────────────────────────────────

/**
 * Extract content from HTML using Readability + Turndown.
 * Returns null if extraction fails or produces low-quality results.
 */
export async function extractFromHtml(
	html: string,
	url: string,
): Promise<ExtractionResult | null> {
	try {
		// Lazy-load heavy DOM libs on first use (STARTUP-1).
		const [{ Readability }, { parseHTML }, turndownModule] = await Promise.all([
			import('@mozilla/readability'),
			import('linkedom'),
			import('turndown'),
		]);
		const TurndownService = turndownModule.default;

		// Parse HTML with linkedom
		const { document } = parseHTML(html);
		
		// Extract article with Readability
		const reader = new Readability(document as any, {
			// Increase length threshold to get more content
			charThreshold: 100,
		});
		const article = reader.parse();
		
		if (!article || !article.content) {
			return null;
		}
		
		// Convert HTML to markdown with Turndown
		const turndown = new TurndownService({
			headingStyle: 'atx',
			codeBlockStyle: 'fenced',
		});
		
		// Parse the article content back to get clean HTML for Turndown
		const { document: contentDoc } = parseHTML(article.content);
		const markdown = resolveMarkdownLinks(turndown.turndown(contentDoc.toString()), url);
		
		const wordCount = countWords(markdown);
		const hasTitle = !!(article.title && article.title.length > 0);
		const hasMetadata = !!(article.byline || article.publishedTime);
		
		// Calculate text density heuristic: ratio of text to HTML length
		// Higher density means less markup/noise
		const textDensity = article.content ? markdown.length / article.content.length : 0;
		
		const quality = calculateQuality({
			contentLength: markdown.length,
			wordCount,
			hasTitle,
			hasMetadata,
			textDensity,
		});
		
		return {
			method: 'readability',
			content: markdown,
			title: article.title || undefined,
			author: article.byline || undefined,
			publishedDate: article.publishedTime || undefined,
			url,
			wordCount,
			quality,
			usedFallback: false,
		};
	} catch (error) {
		console.error('[content-extractor] HTML extraction failed:', error);
		return null;
	}
}

/**
 * Extract text from PDF content (Buffer or Uint8Array).
 */
export async function extractFromPdf(
	pdfData: Buffer | Uint8Array,
	url: string,
): Promise<ExtractionResult> {
	try {
		// Lazy-load unpdf on first use (STARTUP-1).
		const { extractText } = await import('unpdf');
		// unpdf returns { text: string[], totalPages }
		const result = await extractText(pdfData);
		const textArray = Array.isArray(result.text) ? result.text : [result.text || ''];
		const text = textArray.join('\n\n');
		
		const wordCount = countWords(text);
		const quality = calculateQuality({
			contentLength: text.length,
			wordCount,
			hasTitle: false,
			hasMetadata: false,
			// Successfully extracted PDF text is dense by definition.
			textDensity: 1,
		});
		
		return {
			method: 'pdf',
			content: text,
			url,
			wordCount,
			quality,
			usedFallback: false,
		};
	} catch (error) {
		throw new Error(`PDF extraction failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Extract content via Jina AI reader (https://r.jina.ai/<url>).
 * This is a fallback for when direct extraction fails or produces poor results.
 */
export async function extractViaJina(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractionResult> {
	const jinaUrl = `https://r.jina.ai/${url}`;
	
	try {
		const response = await fetch(jinaUrl, {
			headers: {
				'Accept': 'text/plain',
				'X-Return-Format': 'markdown',
			},
			signal: timeoutSignal(signal, 30_000),
		});
		
		if (!response.ok) {
			throw new Error(`Jina API returned ${response.status}`);
		}
		
		const content = await response.text();
		const wordCount = countWords(content);
		
		// Extract title from first line if it looks like a heading
		let title: string | undefined;
		const firstLine = content.split('\n')[0];
		if (firstLine.startsWith('# ')) {
			title = firstLine.slice(2).trim();
		}
		
		const quality = calculateQuality({
			contentLength: content.length,
			wordCount,
			hasTitle: !!title,
			hasMetadata: false,
		});
		
		return {
			method: 'jina',
			content,
			title,
			url,
			wordCount,
			quality,
			usedFallback: true,
		};
	} catch (error) {
		throw new Error(`Jina extraction failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Direct extraction: simple regex-based cleanup (fallback for non-article pages).
 * Strips scripts, styles, nav, but keeps basic HTML structure.
 */
export function extractDirect(html: string, url: string): ExtractionResult {
	const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
	const title = titleMatch?.[1]?.replace(/&[^;]+;/g, ' ').trim() || undefined;
	
	let content = html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<nav[\s\S]*?<\/nav>/gi, '')
		.replace(/<header[\s\S]*?<\/header>/gi, '')
		.replace(/<footer[\s\S]*?<\/footer>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&[^;]+;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	
	const wordCount = countWords(content);
	const quality = calculateQuality({
		contentLength: content.length,
		wordCount,
		hasTitle: !!title,
		hasMetadata: false,
	});
	
	return {
		method: 'direct',
		content,
		title,
		url,
		wordCount,
		quality,
		usedFallback: false,
	};
}

// ─── Main extraction pipeline ──────────────────────────────────────────────

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function privateAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		const [a, b] = address.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19);
	}
	if (version !== 6) return false;
	const [left, right = ""] = address.toLowerCase().split("::", 2);
	const expand = (part: string) => part ? part.split(":").flatMap(word => word.includes(".")
		? word.split(".").reduce<number[]>((words, octet, index, all) => index % 2 ? [...words.slice(0, -1), (words.at(-1)! << 8) | Number(octet)] : [...words, Number(octet)], [])
		: [Number.parseInt(word, 16)]) : [];
	const leftWords = expand(left);
	const rightWords = expand(right);
	const words = [...leftWords, ...Array(Math.max(0, 8 - leftWords.length - rightWords.length)).fill(0), ...rightWords];
	if (words.length !== 8) return false;
	if (words.every(word => word === 0) || words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true;
	if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80) return true;
	const embeddedV4 = words.slice(0, 6).every(word => word === 0) || words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
	return embeddedV4 && privateAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
}

/** Reject schemes and destinations that would let a web-fetch tool reach local services. */
export async function validatePublicUrl(value: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported");
	if (url.username || url.password) throw new Error("URLs with embedded credentials are not supported");
	if (/^(?:1|true|yes|on)$/i.test(process.env.PI_SEARCH_ALLOW_PRIVATE_URLS ?? "")) return url;
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost")) throw new Error("Private-network URLs are disabled; set PI_SEARCH_ALLOW_PRIVATE_URLS=true to enable them");
	if (isIP(host)) {
		if (privateAddress(host)) throw new Error("Private-network URLs are disabled; set PI_SEARCH_ALLOW_PRIVATE_URLS=true to enable them");
		return url;
	}
	const addresses = await lookup(host, { all: true, verbatim: true });
	if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
		throw new Error("Private-network URLs are disabled; set PI_SEARCH_ALLOW_PRIVATE_URLS=true to enable them");
	}
	return url;
}

async function fetchPublicUrl(url: string, init: Omit<RequestInit, "redirect">): Promise<{ response: Response; url: string }> {
	let current = (await validatePublicUrl(url)).toString();
	for (let redirects = 0; redirects <= 5; redirects++) {
		const response = await fetch(current, { ...init, redirect: "manual" });
		if (response.status < 300 || response.status >= 400) return { response, url: current };
		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location) throw new Error(`Redirect HTTP ${response.status} did not include a Location header`);
		if (redirects === 5) throw new Error("Too many redirects");
		current = (await validatePublicUrl(new URL(location, current).toString())).toString();
	}
	throw new Error("Too many redirects");
}

export interface FetchContentOptions {
	/** Quality threshold for fallback decision (0-100, default 50) */
	qualityThreshold?: number;
	/** Force Jina fallback even if primary extraction succeeds */
	forceJina?: boolean;
	/** Allow Jina fallback. Default: process.env.JINA_ENABLED === "true" */
	allowJina?: boolean;
	/** Timeout in milliseconds (default 15000) */
	timeout?: number;
	/** Pi cancellation signal */
	signal?: AbortSignal;
	/** Maximum HTML response size (default 5 MiB) */
	maxHtmlBytes?: number;
	/** Maximum PDF response size (default 25 MiB) */
	maxPdfBytes?: number;
}

/**
 * Fetch and extract content from a URL.
 * Automatically detects content type and uses appropriate extraction method.
 * Falls back to Jina if primary extraction produces poor quality results.
 */
// ─── GitHub helpers ───────────────────────────────────────────────────────

const GITHUB_NON_CODE = new Set([
	"issues", "pull", "pulls", "discussions", "releases", "wiki",
	"actions", "settings", "security", "projects", "graphs",
	"compare", "commits", "tags", "branches", "stargazers",
	"watchers", "network", "forks",
]);

export interface GitHubUrlInfo {
	owner: string;
	repo: string;
	ref?: string;
	path?: string;
	type: "root" | "tree" | "blob";
}

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		if (host !== "github.com" && host !== "www.github.com") return null;
		const segs = parsed.pathname.split("/").filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
		if (segs.length < 2) return null;
		const [owner, repoRaw, action, ref, ...rest] = segs;
		const repo = repoRaw.replace(/\.git$/, "");
		if (action && GITHUB_NON_CODE.has(action.toLowerCase())) return null;
		if (!action) return { owner, repo, type: "root" };
		if (action !== "blob" && action !== "tree") return null;
		if (!ref) return null;
		return { owner, repo, ref, path: rest.join("/") || undefined, type: action as "blob" | "tree" };
	} catch { return null; }
}

export async function extractGitHub(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractionResult | null> {
	const info = parseGitHubUrl(url);
	if (!info) return null;

	const headers: Record<string, string> = { "User-Agent": "PiBakery/1.0", Accept: "application/vnd.github+json" };
	if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

	try {
		// ── blob: fetch raw file ───────────────────────────────────────────
		if (info.type === "blob" && info.ref && info.path) {
			const rawUrl = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.ref}/${info.path}`;
			const resp = await fetch(rawUrl, { headers: { "User-Agent": "PiBakery/1.0" }, signal: timeoutSignal(signal, 20_000) });
			if (!resp.ok) return null;
			const text = await resp.text();
			const wc = countWords(text);
			return { method: "github" as const, content: text, title: info.path.split("/").pop(), url, wordCount: wc, quality: Math.min(100, 30 + wc / 20), usedFallback: false };
		}

		// ── root/tree: fetch tree listing + key files ──────────────────────
		const ref = info.ref ?? "HEAD";
		const treeUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/git/trees/${ref}?recursive=1`;
		const treeResp = await fetch(treeUrl, { headers, signal: timeoutSignal(signal, 20_000) });
		if (!treeResp.ok) return null;
		const treeData = await treeResp.json() as { tree?: Array<{ path?: string; type?: string }> };
		const entries = (treeData.tree ?? []).filter(e => e.type === "blob" && e.path);
		const listing = entries.slice(0, 200).map(e => e.path!).join("\n");

		// Fetch README if present
		const readmePath = entries.find(e => /^readme(\.md|\.txt)?$/i.test(e.path ?? ""))?.path;
		let readmeText = "";
		if (readmePath) {
			try {
				const raw = await fetch(`https://raw.githubusercontent.com/${info.owner}/${info.repo}/${ref}/${readmePath}`, { headers: { "User-Agent": "PiBakery/1.0" }, signal: timeoutSignal(signal, 15_000) });
				if (raw.ok) readmeText = (await raw.text()).slice(0, 6000);
			} catch { /* non-fatal */ }
		}

		const content = `# ${info.owner}/${info.repo}\n\n## File tree\n\`\`\`\n${listing}\n\`\`\`\n${readmeText ? `\n## README\n\n${readmeText}` : ""}`;
		const wc = countWords(content);
		return { method: "github" as const, content, title: `${info.owner}/${info.repo}`, url, wordCount: wc, quality: Math.min(100, 40 + wc / 30), usedFallback: false };
	} catch { return null; }
}

// ─── YouTube helpers ────────────────────────────────────────────────────────

const YOUTUBE_RE = /(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export function parseYouTubeVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		// Reject playlists and channels
		if (parsed.pathname === "/playlist" || parsed.pathname.startsWith("/channel/") || parsed.pathname.startsWith("/user/") || parsed.pathname.startsWith("/@")) return null;
	} catch { return null; }
	const m = url.match(YOUTUBE_RE);
	return m ? m[1] : null;
}

export async function extractYouTube(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractionResult | null> {
	const videoId = parseYouTubeVideoId(url);
	if (!videoId) return null;

	const lines: string[] = [];

	// oEmbed for title/author
	try {
		const oEmbed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: timeoutSignal(signal, 10_000) });
		if (oEmbed.ok) {
			const data = await oEmbed.json() as { title?: string; author_name?: string };
			if (data.title) lines.push(`# ${data.title}`);
			if (data.author_name) lines.push(`**Channel:** ${data.author_name}`);
			lines.push(`**URL:** ${url}`);
			lines.push("");
		}
	} catch { /* non-fatal */ }

	// Transcript (captions) via timedtext API — works for videos with auto-captions
	try {
		const tcResp = await fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`, { signal: timeoutSignal(signal, 15_000) });
		if (tcResp.ok) {
			const raw = await tcResp.json() as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
			const words = (raw.events ?? []).flatMap(e => (e.segs ?? []).map(s => s.utf8 ?? "")).join(" ").replace(/\s+/g, " ").trim();
			if (words.length > 100) {
				lines.push("## Transcript");
				lines.push("");
				lines.push(words.slice(0, 10000));
			}
		}
	} catch { /* non-fatal */ }

	if (lines.length === 0) return null;
	const content = lines.join("\n");
	const wc = countWords(content);
	return { method: "youtube" as const, content, title: lines[0]?.replace(/^# /, ""), url, wordCount: wc, quality: Math.min(100, 30 + wc / 15), usedFallback: false };
}

// ─── Main dispatch ─────────────────────────────────────────────────────────

export async function readResponseBounded(response: Response, maxBytes: number): Promise<Buffer> {
	const safeMax = Math.max(1, Math.trunc(maxBytes));
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > safeMax) {
		throw new Error(`Response is too large (${declaredLength} bytes; limit ${safeMax})`);
	}
	if (!response.body) return Buffer.alloc(0);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
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
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
}

export async function fetchContent(
	url: string,
	options: FetchContentOptions = {},
): Promise<ExtractionResult> {
	const {
		qualityThreshold = 50,
		forceJina = false,
		allowJina = process.env.JINA_ENABLED === "true",
		timeout = 15_000,
		signal,
		maxHtmlBytes = 5 * 1024 * 1024,
		maxPdfBytes = 25 * 1024 * 1024,
	} = options;
	const combinedSignal = timeoutSignal(signal, timeout);
	await validatePublicUrl(url);

	// Jina is third-party. Only use it when explicitly enabled/forced.
	if (forceJina) {
		return extractViaJina(url, signal);
	}

	// Prefer purpose-built local extractors for supported URLs.
	const github = await extractGitHub(url, combinedSignal);
	if (github) return github;
	const youtube = await extractYouTube(url, combinedSignal);
	if (youtube) return youtube;

	// Check if URL looks like a PDF
	const isPdf = isPdfUrl(url);
	
	try {
		// Fetch the URL
		const { response, url: finalUrl } = await fetchPublicUrl(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; PiBakery/1.0)',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8',
			},
			signal: combinedSignal,
		});
		
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		
		const contentType = response.headers.get('content-type');
		
		// Handle PDF content
		if (isPdf || isPdfContentType(contentType)) {
			const buffer = await readResponseBounded(response, maxPdfBytes);
			const result = await extractFromPdf(buffer, finalUrl);
			
			// Check if we should fallback to Jina for poor PDF extraction
			if (allowJina && shouldUseFallback(result.quality, qualityThreshold)) {
				try { return await extractViaJina(url, signal); }
				catch { return result; }
			}
			
			return result;
		}
		
		// Handle HTML content
		const html = (await readResponseBounded(response, maxHtmlBytes)).toString("utf8");
		
		// Try Readability extraction first
		const readabilityResult = await extractFromHtml(html, finalUrl);
		
		if (readabilityResult && !shouldUseFallback(readabilityResult.quality, qualityThreshold)) {
			return readabilityResult;
		}
		
		// Readability failed or poor quality - try Jina only when enabled.
		if (allowJina) {
			try { return await extractViaJina(url, signal); }
			catch { /* use best local result below */ }
		}
		if (readabilityResult) return { ...readabilityResult, usedFallback: false };
		return extractDirect(html, finalUrl);
	} catch (error) {
		if (allowJina) {
			try { return await extractViaJina(url, signal); }
			catch (jinaError) {
				throw new Error(
					`All extraction methods failed. Primary: ${error instanceof Error ? error.message : String(error)}, ` +
					`Jina: ${jinaError instanceof Error ? jinaError.message : String(jinaError)}`
				);
			}
		}
		throw new Error(`Local extraction failed: ${error instanceof Error ? error.message : String(error)}. Set JINA_ENABLED=true to allow third-party fallback.`);
	}
}
