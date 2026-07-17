# pi-search-extension

Private-first web discovery and content extraction for Pi.

## Pi tools

- `web_search` — SearXNG search with snippets and metadata; optional Brave fallback.
- `fetch_content` — bounded local URL/PDF extraction using Readability and `unpdf`; caches the full result.
- `get_cached_content` — reads bounded slices from the local content cache.

The intended agent workflow is `web_search` → `fetch_content` on useful results → `get_cached_content` for additional slices. Scraping a search engine's HTML is deliberately avoided because it is brittle and frequently blocked.

## Automatic local SearXNG

By default, the extension checks SearXNG during Pi's `session_start` hook. If the loopback endpoint is unavailable, it uses Podman (preferred) or Docker to start the bundled configuration on host port **8888**. The `web_search` tool and protocol provide repeat this readiness check, so search self-heals if the container stops after Pi starts. Active Pi sessions are tracked across processes; when the final Pi session exits normally, the managed container is stopped. The image is pulled automatically on first setup and is not embedded in the npm package.

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

# Defaults to <Pi working directory>/.pi-search-cache
export PI_SEARCH_CACHE_DIR=/path/to/cache
# Cache retention defaults: 30 days and 200 MiB.
export PI_SEARCH_CACHE_TTL_MS=2592000000
export PI_SEARCH_CACHE_MAX_BYTES=209715200

# fetch_content only permits public HTTP(S) URLs by default. This protects
# local services from untrusted URLs; enable local development targets explicitly.
# export PI_SEARCH_ALLOW_PRIVATE_URLS=true

# SearXNG language defaults to en.
export SEARCH_LANGUAGE=en
```

`fetch_content` supports cache refresh and maximum-age controls. Network downloads and Pi-visible output are bounded; redirects are revalidated and private-network destinations are rejected by default. Larger extracted documents remain available through cached slices.

## Install and test

```bash
npm install
npm test
npm run typecheck

pi install /absolute/path/to/pi-search-extension
# Development:
pi -e /absolute/path/to/pi-search-extension/extension.ts
```

Pi Protocol support is optional. When the separate pi-protocol extension is loaded, this package registers its three provides through the shared process fabric; normal Pi tools do not depend on that package. Protocol `web_search` invocations use the same automatic SearXNG readiness hook.

## Privacy

Direct extraction contacts only the requested URL. No Exa, OpenAI, Perplexity, Gemini, Tavily, Brave, or Jina request is made unless its corresponding backend/fallback is explicitly configured. SearXNG itself contacts whichever engines are enabled in its settings.
