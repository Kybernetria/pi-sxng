import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createProtocolFabric, ensureProtocolFabric, registerProtocolManifest, type PiProtocolManifest } from "@kybernetria/pi-protocol";
import piSearchExtension from "../extension.ts";
import { createHandlers, PROTOCOL_PROVIDE_NAMES } from "../protocol/handlers.ts";
import { fetchExtractedContent, webSearch } from "../src/operations.ts";

const expectedProvides = ["web_search", "fetch_content"];
const manifest = JSON.parse(readFileSync(new URL("../pi.protocol.json", import.meta.url), "utf8")) as PiProtocolManifest;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
	dependencies: Record<string, string>;
	bundledDependencies: string[];
	pi: { extensions: string[] };
};

test("manifest exposes the exact strict protocol contracts", () => {
	assert.equal(manifest.version, packageJson.version);
	assert.deepEqual(manifest.provides.map((provide) => provide.name), expectedProvides);
	assert.deepEqual([...PROTOCOL_PROVIDE_NAMES], expectedProvides);
	assert.deepEqual(Object.keys(createHandlers()), expectedProvides);
	assert.deepEqual(manifest.provides[0].inputSchema.required, ["query"]);
	assert.deepEqual(Object.keys(manifest.provides[0].inputSchema.properties ?? {}), ["query", "max_results"]);
	assert.deepEqual(manifest.provides[1].inputSchema.required, ["url"]);
	assert.deepEqual(Object.keys(manifest.provides[1].inputSchema.properties ?? {}), ["url", "max_chars"]);
	assert.deepEqual(manifest.provides.map((provide) => provide.outputSchema.required), [["text"], ["text"]]);
	assert.match(packageJson.dependencies["@kybernetria/pi-protocol"], /^\^1\.0\.10$/);
	assert.ok(packageJson.bundledDependencies.includes("@kybernetria/pi-protocol"));
	assert.deepEqual(packageJson.pi.extensions, ["./extension.ts"]);
});

test("extension registers one status command and two provides", () => {
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerCommand(name: string) { commands.push(name); },
		on(name: string) { events.push(name); },
	};
	piSearchExtension(pi as never);
	assert.deepEqual(commands, ["search-status"]);
	assert.deepEqual(events, []);
	assert.deepEqual(
		ensureProtocolFabric().describeNode("pi-search-extension")?.provides.map((provide) => provide.name),
		expectedProvides,
	);
	ensureProtocolFabric().unregister("pi-search-extension");
});

test("protocol invocations preserve input and AbortSignal", async () => {
	const fabric = createProtocolFabric();
	const controller = new AbortController();
	const seen: Array<{ kind: string; input: unknown; signal?: AbortSignal }> = [];
	registerProtocolManifest(fabric, {
		manifest,
		handlers: createHandlers({
			webSearch: async (input, _options, signal) => {
				seen.push({ kind: "search", input, signal });
				return { text: "search" };
			},
			fetchContent: async (input, signal) => {
				seen.push({ kind: "fetch", input, signal });
				return { text: "fetch" };
			},
		}),
	});
	const search = await fabric.invoke({ nodeId: "pi-search-extension", provide: "web_search", input: { query: "pi" }, abortSignal: controller.signal });
	const fetch = await fabric.invoke({ nodeId: "pi-search-extension", provide: "fetch_content", input: { url: "https://example.com" }, abortSignal: controller.signal });
	assert.deepEqual(search, { ok: true, nodeId: "pi-search-extension", provide: "web_search", output: { text: "search" } });
	assert.equal(fetch.ok, true);
	assert.deepEqual(seen.map(({ kind, input }) => ({ kind, input })), [
		{ kind: "search", input: { query: "pi" } },
		{ kind: "fetch", input: { url: "https://example.com" } },
	]);
	assert.ok(seen.every(({ signal }) => signal === controller.signal));
});

test("fabric and domain reject malformed requests before network access", async () => {
	const fabric = createProtocolFabric();
	registerProtocolManifest(fabric, { manifest, handlers: createHandlers() });
	const missing = await fabric.invoke({ nodeId: "pi-search-extension", provide: "web_search", input: {} });
	assert.deepEqual(missing, { ok: false, error: { code: "INVALID_INPUT", message: "input.query is required" } });
	const wrongType = await fabric.invoke({ nodeId: "pi-search-extension", provide: "fetch_content", input: { url: 42 } });
	assert.deepEqual(wrongType, { ok: false, error: { code: "INVALID_INPUT", message: "input.url must be string" } });

	await assert.rejects(webSearch({ query: "   " }), /non-empty/);
	await assert.rejects(webSearch({ query: "ok", limit: 5 }), /unknown field: limit/);
	await assert.rejects(webSearch({ query: "ok", max_results: 21 }), /1 to 20/);
	await assert.rejects(webSearch({ queries: ["a"] }), /unknown field: queries/);
	await assert.rejects(fetchExtractedContent({ url: "", max_chars: 12_000 }), /non-empty/);
	await assert.rejects(fetchExtractedContent({ url: "https:\/\/example.com", force_jina: true }), /unknown field: force_jina/);
	await assert.rejects(fetchExtractedContent({ url: "https:\/\/example.com", max_chars: 50_001 }), /1 to 50000/);
});
