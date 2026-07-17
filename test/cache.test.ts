import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentIdForUrl, getCachedContent, normalizeUrl, putCachedContent, sliceContent } from "../src/cache.ts";

test("cache normalizes URLs, persists content, and bounds slices", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-search-cache-"));
	const previous = process.env.PI_SEARCH_CACHE_DIR;
	process.env.PI_SEARCH_CACHE_DIR = directory;
	try {
		assert.equal(normalizeUrl("HTTPS://Example.COM:443/page#section"), "https://example.com/page");
		assert.equal(normalizeUrl("https://example.com/page?utm_source=newsletter&keep=yes"), "https://example.com/page?keep=yes");
		assert.equal(contentIdForUrl("https://example.com/page#a"), contentIdForUrl("https://example.com/page#b"));
		const record = putCachedContent({ url: "https://example.com/page#section", content: "abcdef", method: "direct" });
		assert.equal(getCachedContent({ url: "https://example.com/page" })?.content, "abcdef");
		assert.deepEqual(sliceContent(record.content, 2, 2), { text: "cd", start: 2, end: 4, fullLength: 6 });
		assert.equal(getCachedContent({ id: "../../etc/passwd" }), null);
	} finally {
		if (previous === undefined) delete process.env.PI_SEARCH_CACHE_DIR;
		else process.env.PI_SEARCH_CACHE_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("cache prunes entries exceeding its configured size", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-search-cache-"));
	const previousDirectory = process.env.PI_SEARCH_CACHE_DIR;
	const previousLimit = process.env.PI_SEARCH_CACHE_MAX_BYTES;
	process.env.PI_SEARCH_CACHE_DIR = directory;
	process.env.PI_SEARCH_CACHE_MAX_BYTES = "1";
	try {
		putCachedContent({ url: "https://example.com/oversized", content: "content larger than one byte" });
		assert.equal(getCachedContent({ url: "https://example.com/oversized" }), null);
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_SEARCH_CACHE_DIR;
		else process.env.PI_SEARCH_CACHE_DIR = previousDirectory;
		if (previousLimit === undefined) delete process.env.PI_SEARCH_CACHE_MAX_BYTES;
		else process.env.PI_SEARCH_CACHE_MAX_BYTES = previousLimit;
		rmSync(directory, { recursive: true, force: true });
	}
});
