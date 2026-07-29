# pi-search-extension

Private-first SearXNG search and bounded public web-content extraction for Pi.

## Protocol provides

### `pi-search-extension.web_search`

Runs one query through the configured SearXNG service:

```json
{ "target": "pi-search-extension.web_search", "input": { "query": "Pi coding agent", "max_results": 5 } }
```

`query` is required. Use parallel protocol calls for independent queries rather than passing a batch array. `max_results` defaults to 5 and accepts 1–20.

### `pi-search-extension.fetch_content`

Fetches one public HTTP(S) URL and locally extracts bounded HTML or PDF content:

```json
{ "target": "pi-search-extension.fetch_content", "input": { "url": "https://example.com", "max_chars": 12000 } }
```

`url` is required. `max_chars` limits the complete returned text, defaults to 12,000, and accepts 1–50,000.

Both provides are called through pi-protocol's generic `protocol` tool. This extension deliberately does not register duplicate top-level search tools. Unknown input fields are rejected rather than silently ignored.

## SearXNG

The extension expects an available SearXNG service. It does not create, remove, or stop containers automatically. This keeps extension startup side-effect free and avoids taking ownership of externally managed containers.

A loopback-only Compose service is bundled:

```bash
cd /path/to/pi-search-extension
podman compose up -d
# or: docker compose up -d
```

Verify it:

```bash
curl -fsS 'http://127.0.0.1:8888/healthz'
curl -fsS 'http://127.0.0.1:8888/search?q=pi+coding+agent&format=json'
```

Use `/search-status` inside Pi to check the configured endpoint. For another service, set:

```bash
export SEARXNG_URL=https://search.example.com
export SEARCH_LANGUAGE=en
```

The bundled SearXNG secret is suitable only for a loopback development service. Replace it before exposing the service beyond localhost.

## Extraction and privacy

- HTML responses are limited to 5 MiB.
- PDF responses are limited to 25 MiB.
- Redirect destinations are revalidated.
- DNS results are checked for non-public addresses and pinned to the actual connection, preventing DNS-rebinding access to local services.
- Private destinations are rejected unless `PI_SEARCH_ALLOW_PRIVATE_URLS=true` is explicitly configured.
- HTML extraction uses Readability and Turndown; PDF extraction uses `unpdf`.

Optional Jina fallback is controlled only by environment configuration, not by protocol request fields:

```bash
export JINA_ENABLED=true
```

When disabled, requested URLs are not sent to Jina. Jina responses are also size-bounded.

## Install and test

```bash
npm install
npm test
npm run typecheck

# Install the generic protocol tool once.
pi install npm:@kybernetria/pi-protocol
pi install /absolute/path/to/pi-search-extension
```

`@kybernetria/pi-protocol` is bundled as a library dependency so this package can register provides, but its Pi extension should be installed only once to expose the generic `protocol` tool.
