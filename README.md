# pi-search-extension

Private-first web discovery and content extraction for Pi.

## Pi Protocol provides

- `pi-search-extension.web_search` — SearXNG search with snippets and metadata; optional Brave fallback.
- `pi-search-extension.fetch_content` — bounded local URL/PDF extraction using Readability and `unpdf`.

Agents call both capabilities through pi-protocol's generic `protocol` tool. This extension does **not** register top-level `web_search` or `fetch_content` Pi tools. The intended workflow is `pi-search-extension.web_search` → `pi-search-extension.fetch_content` on useful results. Scraping a search engine's HTML is deliberately avoided because it is brittle and frequently blocked.

Example calls:

```json
{ "target": "pi-search-extension.web_search", "input": { "query": "Pi coding agent", "max_results": 5 } }
{ "target": "pi-search-extension.fetch_content", "input": { "url": "https://example.com", "max_chars": 12000 } }
```

## Automatic local SearXNG

By default, the extension checks SearXNG during Pi's `session_start` hook. If the loopback endpoint is unavailable, it uses Podman (preferred) or Docker to start the bundled configuration on host port **8888**. The `web_search` protocol provide repeats this readiness check, so search self-heals if the container stops after Pi starts. Active Pi sessions are tracked across processes; when the final Pi session exits normally, the managed container is stopped. The image is pulled automatically on first setup and is not embedded in the npm package.

Useful Pi commands:

```text
/search-status
/search-setup
/search-stop
```

Set `PI_SEARCH_AUTO_START=false` to disable automatic startup, or `PI_SEARCH_STOP_WITH_PI=false` to leave the container running after the final Pi session exits. Set `PI_SEARCH_CONTAINER_RUNTIME=podman` or `docker` to force a runtime. Automatic management is intentionally refused for non-loopback `SEARXNG_URL` values. A hard-killed Pi process cannot run its shutdown hook; stale session leases are cleaned up by later Pi sessions.

A loopback-only Compose definition is also bundled for manual administration:

```bash
podman compose up -d       # requires podman-compose or a Compose provider
# or: docker compose up -d
```

Manual setup without Compose:

```bash
docker run -d --name searxng -p 127.0.0.1:8888:8080 \
  -v "$PWD/deploy/searxng-settings.yml:/etc/searxng/settings.yml:ro" \
  searxng/searxng:latest
```

Verify JSON search:

```bash
curl -fsS 'http://127.0.0.1:8888/search?q=pi+coding+agent&format=json'
```

The bundled secret is acceptable only for a loopback development service. Replace it before exposing SearXNG beyond localhost.

## Configuration

```bash
# Default shown; setting it explicitly is optional.
export SEARXNG_URL=http://127.0.0.1:8888
export PI_SEARCH_AUTO_START=true
export PI_SEARCH_STOP_WITH_PI=true
# export PI_SEARCH_CONTAINER_RUNTIME=podman

# Optional API fallback. Brave is neither required nor open source.
export BRAVE_API_KEY=...

# Optional third-party extraction fallback; disabled by default.
export JINA_ENABLED=true

# fetch_content only permits public HTTP(S) URLs by default. This protects
# local services from untrusted URLs; enable local development targets explicitly.
# export PI_SEARCH_ALLOW_PRIVATE_URLS=true

# SearXNG language defaults to en.
export SEARCH_LANGUAGE=en
```

Network downloads and Pi-visible output are bounded; redirects are revalidated and private-network destinations are rejected by default. Use `max_chars` to control how much extracted content is returned, up to 50,000 characters.

## Install and test

```bash
npm install
npm test
npm run typecheck

pi install /absolute/path/to/pi-search-extension
# Development (load the required generic protocol tool, then this node):
pi \
  -e /absolute/path/to/pi-search-extension/node_modules/@kybernetria/pi-protocol/extension.ts \
  -e /absolute/path/to/pi-search-extension/extension.ts
```

`@kybernetria/pi-protocol` is a required, bundled runtime dependency. The package loads pi-protocol's extension (which supplies the generic `protocol` tool) and registers exactly two handler-backed provides with the canonical fabric APIs. Protocol `web_search` invocations use the same automatic SearXNG readiness behavior as session startup. Loading `extension.ts` directly for development requires its npm dependencies to be installed first.

## Privacy

Direct extraction contacts only the requested URL. No Exa, OpenAI, Perplexity, Gemini, Tavily, Brave, or Jina request is made unless its corresponding backend/fallback is explicitly configured. SearXNG itself contacts whichever engines are enabled in its settings.
