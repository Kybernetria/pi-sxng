import assert from "node:assert/strict";
import test from "node:test";
import {
	calculateQuality,
	countWords,
	isPdfContentType,
	isPdfUrl,
	readResponseBounded,
	resolveMarkdownLinks,
	validatePublicUrl,
} from "../src/content/extractor.ts";

test("content extraction helpers are deterministic", () => {
	assert.equal(isPdfUrl("https://example.com/report.pdf?download=1"), true);
	assert.equal(isPdfContentType("application/pdf; charset=binary"), true);
	assert.equal(countWords(" one  two\nthree "), 3);
	assert.equal(calculateQuality({ contentLength: 0, wordCount: 1_000, hasTitle: true, hasMetadata: true }), 80);
	assert.equal(
		resolveMarkdownLinks("[next](../next) ![image](/a.png)", "https://example.com/docs/page"),
		"[next](https://example.com/next) ![image](https://example.com/a.png)",
	);
});

test("bounded response reader accepts small bodies and rejects large ones", async () => {
	const small = new Response("hello", { headers: { "content-length": "5" } });
	assert.equal((await readResponseBounded(small, 5)).toString(), "hello");
	const declaredLarge = new Response("hello", { headers: { "content-length": "100" } });
	await assert.rejects(readResponseBounded(declaredLarge, 5), /too large/);
	const streamedLarge = new Response("abcdef");
	await assert.rejects(readResponseBounded(streamedLarge, 5), /exceeded/);
});

test("URL validation rejects unsafe schemes, credentials, and non-public ranges", async () => {
	await assert.rejects(validatePublicUrl("file:///etc/passwd"), /Only http and https/);
	await assert.rejects(validatePublicUrl("http://127.0.0.1:8080"), /Private-network/);
	await assert.rejects(validatePublicUrl("http://[::1]:8080"), /Private-network/);
	await assert.rejects(validatePublicUrl("http://[::ffff:127.0.0.1]"), /Private-network/);
	await assert.rejects(validatePublicUrl("http://224.0.0.1"), /Private-network/);
	await assert.rejects(validatePublicUrl("http://192.0.2.1"), /Private-network/);
	await assert.rejects(validatePublicUrl("http://localhost:8080"), /Private-network/);
	await assert.rejects(validatePublicUrl("http://user:password@example.com"), /embedded credentials/);
	assert.equal((await validatePublicUrl("https://8.8.8.8/")).hostname, "8.8.8.8");
});
