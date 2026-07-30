import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import { createHandlers } from "./protocol/handlers.js";
import { getSearxngStatus } from "./src/searxng.js";

const definition = parseProtocolManifest(
	readFileSync(fileURLToPath(new URL("./pi.protocol.json", import.meta.url)), "utf8"),
);

export default function piSearchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("search-status", {
		description: "Check the configured SearXNG search backend",
		handler: async (_args, ctx) => {
			const status = await getSearxngStatus(undefined, ctx.signal);
			ctx.ui.notify(`${status.message} ${status.url}`, status.healthy ? "info" : "warning");
		},
	});

	const fabric = ensureProtocolFabric();
	const registration = fabric.install(definition, { handlers: createHandlers() }, {
		packageId: "pi-search-extension",
		packageVersion: "0.3.0",
		sourcePath: fileURLToPath(new URL(".", import.meta.url)),
	});
	pi.on("session_shutdown", async () => { await registration.dispose(); });
}
