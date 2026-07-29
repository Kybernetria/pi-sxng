const DEFAULT_URL = "http://127.0.0.1:8888";

export interface SearxngStatus {
	url: string;
	healthy: boolean;
	message: string;
}

export function configuredSearxngUrl(override?: string): string {
	const configured = override || process.env.SEARXNG_URL || DEFAULT_URL;
	try {
		const parsed = new URL(configured);
		const authority = configured.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
		const hasExplicitPort = authority.startsWith("[") ? /\]:\d+$/.test(authority) : /:\d+$/.test(authority);
		if (!hasExplicitPort && !parsed.port && isLoopbackSearxng(configured)) {
			parsed.port = new URL(DEFAULT_URL).port;
			return parsed.toString();
		}
	} catch {
		// Keep the original value so status and search calls report the invalid URL.
	}
	return configured;
}

export function isLoopbackSearxng(value: string): boolean {
	try {
		const parsed = new URL(value);
		const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname);
	} catch {
		return false;
	}
}

function healthEndpoint(base: string): URL {
	return new URL("healthz", base.endsWith("/") ? base : `${base}/`);
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function probeSearxng(url = configuredSearxngUrl(), signal?: AbortSignal): Promise<boolean> {
	try {
		const response = await fetch(healthEndpoint(url), {
			headers: { Accept: "text/plain" },
			signal: combinedSignal(signal, 2_500),
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

export async function getSearxngStatus(override?: string, signal?: AbortSignal): Promise<SearxngStatus> {
	const url = configuredSearxngUrl(override);
	const healthy = await probeSearxng(url, signal);
	return {
		url,
		healthy,
		message: healthy
			? "SearXNG is ready."
			: `SearXNG is unavailable. Start the bundled Compose service or configure SEARXNG_URL.`,
	};
}

export async function requireSearxng(override?: string, signal?: AbortSignal): Promise<string> {
	const status = await getSearxngStatus(override, signal);
	if (!status.healthy) throw new Error(`${status.message} Checked ${status.url}`);
	return status.url;
}
