import assert from "node:assert/strict";
import test from "node:test";
import { configuredSearxngUrl, isLoopbackSearxng } from "../src/searxng.ts";

test("SearXNG URL configuration defaults to the bundled Compose port", () => {
	const previous = process.env.SEARXNG_URL;
	try {
		delete process.env.SEARXNG_URL;
		assert.equal(configuredSearxngUrl(), "http://127.0.0.1:8888");
		assert.equal(configuredSearxngUrl("http://localhost"), "http://localhost:8888/");
		assert.equal(configuredSearxngUrl("http://localhost:80"), "http://localhost:80");
		assert.equal(configuredSearxngUrl("http://[::1]"), "http://[::1]:8888/");
		process.env.SEARXNG_URL = "https://search.example.com";
		assert.equal(configuredSearxngUrl(), "https://search.example.com");
	} finally {
		if (previous === undefined) delete process.env.SEARXNG_URL;
		else process.env.SEARXNG_URL = previous;
	}
});

test("loopback detection normalizes IPv4, hostnames, and bracketed IPv6", () => {
	assert.equal(isLoopbackSearxng("http://localhost:9999"), true);
	assert.equal(isLoopbackSearxng("http://127.0.0.1:8888"), true);
	assert.equal(isLoopbackSearxng("http://[::1]:8888"), true);
	assert.equal(isLoopbackSearxng("https://127.0.0.1:8888"), false);
	assert.equal(isLoopbackSearxng("https://search.example.com"), false);
});
