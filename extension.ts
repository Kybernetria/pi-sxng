import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebSearchTools } from "./src/tools.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_ID = "pi-search-extension";
const FABRIC_KEY = Symbol.for("pi-protocol.minimal.fabric");

type ProtocolFabricLike = {
	unregister(nodeId: string): void;
	register(input: { node: Record<string, unknown>; handlers: Record<string, unknown> }): void;
};

type ProtocolManifest = Record<string, unknown> & {
	provides: Array<Record<string, unknown> & { execution: Record<string, unknown> }>;
};

export default function piSearchExtension(pi: ExtensionAPI): void {
	let sessionLease: string | undefined;
	registerWebSearchTools(pi);
	registerSearchCommands(pi);
	// Registration is retried at session_start so extension load order does not
	// matter. Pi tools remain usable when the optional protocol extension is absent.
	registerProtocolNode();
	pi.on("session_start", async (_event, ctx) => {
		registerProtocolNode();
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

function registerProtocolNode(): void {
	const fabric = (globalThis as Record<PropertyKey, unknown>)[FABRIC_KEY] as ProtocolFabricLike | undefined;
	if (!fabric || typeof fabric.register !== "function" || typeof fabric.unregister !== "function") return;

	const manifest = JSON.parse(readFileSync(join(__dirname, "pi.protocol.json"), "utf8")) as ProtocolManifest;
	const { provides, ...nodeFields } = manifest;
	const node = {
		...nodeFields,
		provides: provides.map((provide) => ({ ...provide, execution: { ...provide.execution } })),
	};
	fabric.unregister(NODE_ID);
	fabric.register({ node, handlers: createHandlers() });
}
