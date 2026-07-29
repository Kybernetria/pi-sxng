import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createProtocolFabric, ensureProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import piSearchExtension from "../extension.ts";
import { createHandlers, PROTOCOL_PROVIDE_NAMES } from "../protocol/handlers.ts";
import { fetchExtractedContent, webSearch } from "../src/operations.ts";

const expectedProvides = ["web_search", "fetch_content"];
const definition = parseProtocolManifest(readFileSync(new URL("../pi.protocol.json", import.meta.url), "utf8"), { allowLegacyV02: false });
const manifest = definition.manifest;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
	dependencies: Record<string, string>;
	piProtocol: { generated: string };
	pi: { extensions: string[] };
};

test("manifest exposes the exact strict protocol contracts", () => {
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.node.id, "pi-search-extension");
	assert.deepEqual(manifest.provides.map((provide) => provide.name), expectedProvides);
	assert.deepEqual([...PROTOCOL_PROVIDE_NAMES], expectedProvides);
	assert.deepEqual(Object.keys(createHandlers()), expectedProvides);
	assert.deepEqual(manifest.provides[0].inputSchema.required, ["query"]);
	assert.deepEqual(Object.keys(manifest.provides[0].inputSchema.properties ?? {}), ["max_results", "query"]);
	assert.deepEqual(manifest.provides[1].inputSchema.required, ["url"]);
	assert.deepEqual(Object.keys(manifest.provides[1].inputSchema.properties ?? {}), ["max_chars", "url"]);
	assert.deepEqual(manifest.provides.map((provide) => provide.outputSchema.required), [["text"], ["text"]]);
	assert.match(packageJson.dependencies["@kybernetria/pi-protocol"], /^file:/);
	assert.equal(packageJson.piProtocol.generated, "protocol.generated.ts");
	assert.deepEqual(packageJson.pi.extensions, ["./extension.ts"]);
});

test("extension registers one status command and two provides", async () => {
	const commands: string[] = [];
	const events: string[] = [];
	let shutdown: (() => Promise<void>) | undefined;
	const pi = {
		registerCommand(name: string) { commands.push(name); },
		on(name: string, callback: () => Promise<void>) { events.push(name); shutdown = callback; },
	};
	piSearchExtension(pi as never);
	assert.deepEqual(commands, ["search-status"]);
	assert.deepEqual(events, ["session_shutdown"]);
	assert.deepEqual(
		ensureProtocolFabric().describeNode("pi-search-extension")?.provides.map((provide) => provide.name),
		expectedProvides,
	);
	await shutdown?.();
});

test("protocol invocations preserve input and AbortSignal", async () => {
	const fabric = createProtocolFabric();
	const controller = new AbortController();
	const seen: Array<{ kind: string; input: unknown; signal?: AbortSignal }> = [];
	fabric.install(definition, {
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
	assert.ok(seen.every(({ signal }) => signal instanceof AbortSignal && !signal.aborted));
});

test("fabric and domain reject malformed requests before network access", async () => {
	const fabric = createProtocolFabric();
	fabric.install(definition, { handlers: createHandlers() });
	const missing = await fabric.invoke({ nodeId: "pi-search-extension", provide: "web_search", input: {} });
	assert.deepEqual(missing, { ok: false, error: { code: "INPUT_INVALID", message: "Input does not satisfy the protocol contract" } });
	const wrongType = await fabric.invoke({ nodeId: "pi-search-extension", provide: "fetch_content", input: { url: 42 } });
	assert.deepEqual(wrongType, { ok: false, error: { code: "INPUT_INVALID", message: "Input does not satisfy the protocol contract" } });

	await assert.rejects(webSearch({ query: "   " }), /non-empty/);
	await assert.rejects(webSearch({ query: "ok", limit: 5 }), /unknown field: limit/);
	await assert.rejects(webSearch({ query: "ok", max_results: 21 }), /1 to 20/);
	await assert.rejects(webSearch({ queries: ["a"] }), /unknown field: queries/);
	await assert.rejects(fetchExtractedContent({ url: "", max_chars: 12_000 }), /non-empty/);
	await assert.rejects(fetchExtractedContent({ url: "https:\/\/example.com", force_jina: true }), /unknown field: force_jina/);
	await assert.rejects(fetchExtractedContent({ url: "https:\/\/example.com", max_chars: 50_001 }), /1 to 50000/);
});
