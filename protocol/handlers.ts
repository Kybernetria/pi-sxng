import type { ProtocolHandler, ProtocolInvocationContext } from "@kybernetria/pi-protocol";
import {
	fetchExtractedContent,
	webSearch,
	type CompactOperationResult,
	type SearchOptions,
} from "../src/operations.js";

export const PROTOCOL_PROVIDE_NAMES = ["web_search", "fetch_content"] as const;
export type ProtocolProvideName = (typeof PROTOCOL_PROVIDE_NAMES)[number];

type SearchOperation = (
	input: unknown,
	options?: SearchOptions,
	signal?: AbortSignal,
) => Promise<CompactOperationResult>;
type FetchOperation = (input: unknown, signal?: AbortSignal) => Promise<CompactOperationResult>;

export interface CreateSearchProtocolHandlersOptions {
	searchOptions?: SearchOptions;
	webSearch?: SearchOperation;
	fetchContent?: FetchOperation;
}

/** Create direct protocol handlers without constructing intermediary Pi tools. */
export function createHandlers(
	options: CreateSearchProtocolHandlersOptions = {},
): Record<ProtocolProvideName, ProtocolHandler> {
	const search = options.webSearch ?? webSearch;
	const fetch = options.fetchContent ?? fetchExtractedContent;
	return {
		web_search(input: unknown, context?: ProtocolInvocationContext) {
			return search(input ?? {}, options.searchOptions, context?.abortSignal);
		},
		fetch_content(input: unknown, context?: ProtocolInvocationContext) {
			return fetch(input ?? {}, context?.abortSignal);
		},
	};
}
