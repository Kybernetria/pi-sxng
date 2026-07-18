import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	createProtocolFabric,
	ensureProtocolFabric,
	registerProtocolManifest,
	type PiProtocolManifest,
} from "@kybernetria/pi-protocol";
import piSearchExtension from "../extension.ts";
import { createHandlers, PROTOCOL_PROVIDE_NAMES } from "../protocol/handlers.ts";
import { fetchExtractedContent, webSearch } from "../src/operations.ts";

const expectedProvides = ["web_search", "fetch_content"];
const manifest = JSON.parse(readFileSync(new URL("../pi.protocol.json", import.meta.url), "utf8")) as PiProtocolManifest;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	dependencies: Record<string, string>;
	bundledDependencies: string[];
	pi: { extensions: string[] };
};

test("manifest and handlers expose exactly the two protocol provides", () => {
	assert.deepEqual(manifest.provides.map((provide) => provide.name), expectedProvides);
	assert.deepEqual([...PROTOCOL_PROVIDE_NAMES], expectedProvides);
	assert.deepEqual(Object.keys(createHandlers()), expectedProvides);
	assert.deepEqual(
		manifest.provides.map((provide) => provide.execution),
		[
			{ type: "handler", handler: "web_search" },
			{ type: "handler", handler: "fetch_content" },
		],
	);
	assert.match(packageJson.dependencies["@kybernetria/pi-protocol"], /^\^1\./);
	assert.ok(packageJson.bundledDependencies.includes("@kybernetria/pi-protocol"));
	assert.deepEqual(packageJson.pi.extensions, ["./extension.ts"]);
});

test("extension registers lifecycle commands and provides, but no direct search tools", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		registerCommand(name: string) { commands.push(name); },
		on(name: string) { events.push(name); },
	};

	piSearchExtension(pi as never);
	assert.deepEqual(tools, []);
	assert.deepEqual(commands, ["search-status", "search-setup", "search-stop"]);
	assert.deepEqual(events, ["session_start", "session_shutdown"]);
	const registeredNode = ensureProtocolFabric().describeNode("pi-search-extension");
	assert.deepEqual(registeredNode?.provides.map((provide) => provide.name), expectedProvides);
	ensureProtocolFabric().unregister("pi-search-extension");

	const fabric = createProtocolFabric();
	registerProtocolManifest(fabric, { manifest, handlers: createHandlers({
		webSearch: async () => ({ ok: true, isError: false, text: "search" }),
		fetchContent: async () => ({ ok: true, isError: false, text: "fetch" }),
	}) });
	assert.deepEqual(fabric.registry().provides.map((provide) => provide.globalId), [
		"pi-search-extension.web_search",
		"pi-search-extension.fetch_content",
	]);
});

test("protocol invocations call domain operations and preserve the AbortSignal", async () => {
	const fabric = createProtocolFabric();
	const controller = new AbortController();
	const seen: Array<{ kind: string; input: unknown; signal?: AbortSignal }> = [];
	registerProtocolManifest(fabric, {
		manifest,
		handlers: createHandlers({
			webSearch: async (input, _options, signal) => {
				seen.push({ kind: "search", input, signal });
				return { ok: true, isError: false, text: "compact search output" };
			},
			fetchContent: async (input, signal) => {
				seen.push({ kind: "fetch", input, signal });
				return { ok: true, isError: false, text: "compact fetch output" };
			},
		}),
	});

	const search = await fabric.invoke({
		nodeId: "pi-search-extension",
		provide: "web_search",
		input: { query: "pi protocol" },
		abortSignal: controller.signal,
	});
	const fetch = await fabric.invoke({
		nodeId: "pi-search-extension",
		provide: "fetch_content",
		input: { url: "https://example.com" },
		abortSignal: controller.signal,
	});

	assert.equal(search.ok, true);
	assert.equal(fetch.ok, true);
	assert.deepEqual(seen.map(({ kind, input }) => ({ kind, input })), [
		{ kind: "search", input: { query: "pi protocol" } },
		{ kind: "fetch", input: { url: "https://example.com" } },
	]);
	assert.ok(seen.every(({ signal }) => signal === controller.signal));
});

test("domain operations retain bounded input validation", async () => {
	await assert.rejects(webSearch({ query: "", max_results: 5 }), /query must be a non-empty string/);
	await assert.rejects(webSearch({ queries: ["a", "b", "c", "d", "e", "f"] }), /1 to 5/);
	await assert.rejects(webSearch({ query: "ok", max_results: 21 }), /1 to 20/);
	await assert.rejects(fetchExtractedContent({ url: "", max_chars: 12_000 }), /url must be a non-empty string/);
	await assert.rejects(fetchExtractedContent({ url: "https://example.com", max_chars: 50_001 }), /1 to 50000/);
});
