import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ensureProtocolFabric,
	registerProtocolManifest,
	type PiProtocolManifest,
} from "@kybernetria/pi-protocol";
import manifestJson from "./pi.protocol.json" with { type: "json" };
import { createHandlers } from "./protocol/handlers.js";
import {
	autoStartEnabled,
	createSessionLease,
	ensureSearxng,
	getSearxngStatus,
	removeSessionLease,
	stopManagedSearxng,
	stopSearxngIfUnused,
} from "./src/searxng.js";

const NODE_ID = "pi-search-extension";
const manifest = manifestJson as unknown as PiProtocolManifest;

export default function piSearchExtension(pi: ExtensionAPI): void {
	let sessionLease: string | undefined;
	registerSearchCommands(pi);

	const fabric = ensureProtocolFabric();
	fabric.unregister(NODE_ID);
	registerProtocolManifest(fabric, {
		manifest,
		handlers: createHandlers({ searchOptions: { searxngTarget: pi } }),
	});

	pi.on("session_start", async (_event, ctx) => {
		removeSessionLease(sessionLease);
		sessionLease = createSessionLease();
		if (!autoStartEnabled()) return;
		try {
			await ensureSearxng(pi, { signal: ctx.signal });
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Search setup: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});
	pi.on("session_shutdown", async (event) => {
		removeSessionLease(sessionLease);
		sessionLease = undefined;
		// Reload/new/resume/fork immediately create a replacement session. Only a
		// real quit can mean this was the final active Pi process.
		if (event.reason === "quit") await stopSearxngIfUnused(pi);
	});
}

function registerSearchCommands(pi: ExtensionAPI): void {
	pi.registerCommand("search-status", {
		description: "Check the configured SearXNG search backend",
		handler: async (_args, ctx) => {
			const status = await getSearxngStatus(pi, undefined, ctx.signal);
			ctx.ui.notify(`${status.message} ${status.url}`, status.healthy ? "info" : "warning");
		},
	});
	pi.registerCommand("search-setup", {
		description: "Create/start the bundled local SearXNG container",
		handler: async (_args, ctx) => {
			try {
				const status = await ensureSearxng(pi, { signal: ctx.signal, force: true });
				ctx.ui.notify(`${status.message} ${status.url}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("search-stop", {
		description: "Stop the managed local SearXNG container now",
		handler: async (_args, ctx) => {
			try {
				const stopped = await stopManagedSearxng(pi, ctx.signal);
				ctx.ui.notify(stopped ? "SearXNG stopped." : "No managed SearXNG container was found.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
