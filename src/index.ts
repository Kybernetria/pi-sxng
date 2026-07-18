/** Domain operations backing the pi-search-extension protocol provides. */

export {
	fetchExtractedContent,
	searchBrave,
	searchSearxng,
	webSearch,
	MAX_OUTPUT_CHARS,
} from "./operations.js";
export type {
	CompactOperationResult,
	FetchContentInput,
	SearchOptions,
	SearchResult,
	WebSearchInput,
} from "./operations.js";
export type { ExtractionResult, QualityMetrics } from "./content/extractor.js";
