import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProtocolNamespace, ensureProtocolFabric, parseProtocolManifest, registerProtocolManifest } from "@kybernetria/pi-protocol";
import { createHandlers } from "./protocol/handlers.js";
import { getSearxngStatus } from "./src/searxng.js";

const manifest = parseProtocolManifest(
	readFileSync(fileURLToPath(new URL("./pi.protocol.json", import.meta.url)), "utf8"),
);
const protocol = createProtocolNamespace(manifest);

export default function piSearchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("search-status", {
		description: "Check the configured SearXNG search backend",
		handler: async (_args, ctx) => {
			const status = await getSearxngStatus(undefined, ctx.signal);
			ctx.ui.notify(`${status.message} ${status.url}`, status.healthy ? "info" : "warning");
		},
	});

	const fabric = ensureProtocolFabric();
	fabric.unregister(protocol.nodeId);
	registerProtocolManifest(fabric, { manifest, handlers: createHandlers() });
}
