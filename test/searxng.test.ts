import assert from "node:assert/strict";
import test from "node:test";
import {
	autoStartEnabled,
	configuredSearxngUrl,
	countActiveSessionLeases,
	createSessionLease,
	isLoopbackSearxng,
	removeSessionLease,
	stopWithPiEnabled,
} from "../src/searxng.ts";

test("SearXNG lifecycle configuration is local and enabled by default", () => {
	const previousUrl = process.env.SEARXNG_URL;
	const previousAutoStart = process.env.PI_SEARCH_AUTO_START;
	const previousStopWithPi = process.env.PI_SEARCH_STOP_WITH_PI;
	try {
		delete process.env.SEARXNG_URL;
		delete process.env.PI_SEARCH_AUTO_START;
		delete process.env.PI_SEARCH_STOP_WITH_PI;
		assert.equal(configuredSearxngUrl(), "http://127.0.0.1:8888");
		assert.equal(configuredSearxngUrl("http://localhost"), "http://localhost:8888/");
		assert.equal(configuredSearxngUrl("http://localhost:80"), "http://localhost:80");
		assert.equal(autoStartEnabled(), true);
		assert.equal(stopWithPiEnabled(), true);
		assert.equal(isLoopbackSearxng("http://localhost:9999"), true);
		assert.equal(isLoopbackSearxng("https://search.example.com"), false);
		assert.equal(isLoopbackSearxng("https://127.0.0.1:8888"), false);

		process.env.PI_SEARCH_AUTO_START = "false";
		process.env.PI_SEARCH_STOP_WITH_PI = "false";
		assert.equal(autoStartEnabled(), false);
		assert.equal(stopWithPiEnabled(), false);
	} finally {
		if (previousUrl === undefined) delete process.env.SEARXNG_URL;
		else process.env.SEARXNG_URL = previousUrl;
		if (previousAutoStart === undefined) delete process.env.PI_SEARCH_AUTO_START;
		else process.env.PI_SEARCH_AUTO_START = previousAutoStart;
		if (previousStopWithPi === undefined) delete process.env.PI_SEARCH_STOP_WITH_PI;
		else process.env.PI_SEARCH_STOP_WITH_PI = previousStopWithPi;
	}
});

test("session leases track concurrent Pi sessions", () => {
	const baseline = countActiveSessionLeases();
	const first = createSessionLease();
	const second = createSessionLease();
	try {
		assert.equal(countActiveSessionLeases(), baseline + 2);
		removeSessionLease(first);
		assert.equal(countActiveSessionLeases(), baseline + 1);
	} finally {
		removeSessionLease(first);
		removeSessionLease(second);
	}
	assert.equal(countActiveSessionLeases(), baseline);
});
