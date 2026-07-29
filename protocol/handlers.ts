import type { ProtocolHandler, ProtocolInvocationContext } from "@kybernetria/pi-protocol/core";
import { fetchExtractedContent, webSearch, type CompactOperationResult, type SearchOptions } from "../src/operations.js";

export const PROTOCOL_PROVIDE_NAMES = ["web_search", "fetch_content"] as const;
export type ProtocolProvideName = (typeof PROTOCOL_PROVIDE_NAMES)[number];

type SearchOperation = (input: unknown, options?: SearchOptions, signal?: AbortSignal) => Promise<CompactOperationResult>;
type FetchOperation = (input: unknown, signal?: AbortSignal) => Promise<CompactOperationResult>;

export interface HandlerDependencies {
	webSearch?: SearchOperation;
	fetchContent?: FetchOperation;
	searchOptions?: SearchOptions;
}

export function createHandlers(dependencies: HandlerDependencies = {}): Record<ProtocolProvideName, ProtocolHandler> {
	const search = dependencies.webSearch ?? webSearch;
	const fetch = dependencies.fetchContent ?? fetchExtractedContent;
	return {
		web_search(input: unknown, context?: ProtocolInvocationContext) {
			return search(input, dependencies.searchOptions, context?.abortSignal);
		},
		fetch_content(input: unknown, context?: ProtocolInvocationContext) {
			return fetch(input, context?.abortSignal);
		},
	};
}
