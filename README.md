# ReviewLens AI

A review-intelligence portal: it ingests the public reviews of one entity from a single review platform and lets an analyst chat with them through [Open WebUI](https://github.com/open-webui/open-webui). A scope guard keeps the assistant on the ingested reviews only.

```
Browser ──► Cloudflare tunnel ──► nginx (reverse proxy) ──► Open WebUI ──(OpenAI-compatible API)──► NestJS API ──► Anthropic Claude
                                                                              │
                                  Source adapters (Steam | App Store | Trustpilot | file)
                                                                              │
                                                        in-memory store ◄──► JSON snapshot on a volume
```

## Quick start

```bash
cp .env.example .env        # set REVIEW_SOURCE_URL, PUBLIC_HOSTNAME, ANTHROPIC_API_KEY, LLM_GATEWAY_KEY
docker compose up -d --build
# open http://localhost:4000   (Open WebUI, no login)
```

With the Cloudflare tunnel (token-based):

1. In Cloudflare Zero Trust create a tunnel, add a public hostname `PUBLIC_HOSTNAME` → `http://open-webui:8080`.
2. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. `docker compose --profile tunnel up -d --build`

### Deployment

The app runs on my own server. nginx is the reverse proxy in front of it: the Cloudflare tunnel delivers traffic for `PUBLIC_HOSTNAME` to nginx, and nginx proxies to Open WebUI (published on `127.0.0.1:${WEBUI_PORT:-4000}`). The NestJS API is never exposed outside the Docker network. Open WebUI streams responses, so the nginx location needs `proxy_http_version 1.1`, `proxy_buffering off` and the `Upgrade`/`Connection` headers for WebSockets.

### Configuration (`.env`)

| Variable                                                  | Purpose                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `REVIEW_SOURCE_URL`                                       | Review page to ingest; the adapter is chosen from the URL (see below)                                             |
| `REVIEW_SOURCE_FILE`                                      | Optional offline source (folder of saved `.html` pages, an `.html` file, or `.json`); takes priority over the URL |
| `PUBLIC_HOSTNAME`                                         | Public hostname behind the tunnel (e.g. `xyz.exemple.com`)                                                        |
| `ANTHROPIC_API_KEY`                                       | LLM access                                                                                                        |
| `LLM_GATEWAY_KEY`                                         | Shared secret Open WebUI uses to call the API                                                                     |
| `CLOUDFLARE_TUNNEL_TOKEN`                                 | Only for `--profile tunnel`                                                                                       |
| `STEAM_LANGUAGE`                                          | Steam only: review language (default `english`, or `all`)                                                         |
| `MAX_PAGES`                                               | Pages of reviews to ingest, newest first (default `10`, i.e. about 500 Steam reviews)                             |
| `ANTHROPIC_MODEL`                                         | Claude model (default `claude-sonnet-5-5`)                                                                        |
| `MAX_CONTEXT_CHARS`, `MAX_OUTPUT_TOKENS`, `SNAPSHOT_PATH` | Optional tuning (see `.env.example`)                                                                              |

## Supported sources

| Platform                  | URL format                                           | Notes                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Steam** (most reliable) | `https://store.steampowered.com/app/<appId>/<name>/` | Public reviews endpoint, cursor-paginated, up to `MAX_PAGES` × 50 newest reviews in `STEAM_LANGUAGE`. Steam has no stars, only recommended / not recommended: the summary, stats and prompt use a thumbs scale (no star average is ever shown), and each review carries the reviewer's playtime. Reviewer names are not stored. |
| **Apple App Store**       | `https://apps.apple.com/<cc>/app/<name>/id<appId>`   | Public JSON feed; in 2026 it returns no reviews for many apps, so it may fail. Most recent ~500 written reviews (10 pages × 50) for the storefront in the URL; includes the app version of each review.                                                                                                                         |
| **Trustpilot**            | `https://www.trustpilot.com/review/<domain>`         | Parses the JSON embedded in the page. Trustpilot often answers HTTP 403 to automated clients, see below.                                                                                                                                                                                                                        |
| **Saved files**           | `REVIEW_SOURCE_FILE=/data/reviews`                   | Always works. Trustpilot pages saved from your browser, or a `.json` file (`[{id?, rating, title, text, publishedAt, author}]` or `{platform?, entityName, reportedTotal, reviews: [...]}`). `./data` is mounted read-only at `/data`.                                                                                          |

Amazon, Google Maps, G2 and Capterra are not supported: they require login and/or aggressive bot protection, and scraping them conflicts with their terms. Adding a platform means implementing the small `ReviewSource` interface (`api/src/ingestion/source.types.ts`) and registering it in `IngestionService`.

### Why Steam

I tried Trustpilot, the Apple App Store, Google Maps and Amazon, and all of them have anti-bot protection that blocked automated access (Trustpilot answers HTTP 403, Apple's feed returns no reviews, Amazon and Google Maps are not usable without getting past it). One possible solution would be a headless browser such as Playwright. That is why I decided to use `store.steampowered.com`, whose public reviews endpoint works without any workaround.

**The ethical dilemma with a headless browser.** Using Playwright to disguise an automated client so it gets past a site's protection is circumventing an access control. A site that blocks scrapers has told me not to do what I am about to do. I chose not to build that, and picked a source that allows this kind of access instead. For production, the right answer is official APIs or licensed data feeds (for example Trustpilot's business API or the Google Business Profile API).

### If Trustpilot returns HTTP 403

Save each result page from your browser (`...?sort=recency`, `&page=2`, …) into `./data/reviews/`, set `REVIEW_SOURCE_FILE=/data/reviews`, and restart (or type `/reingest`). Check the saved files contain the data: `grep -c __NEXT_DATA__ data/reviews/*.html` should print 1 per file. Or just use an App Store URL.

## How it works

- **Ingestion** (`api/src/ingestion`): at boot the API picks the adapter that supports the configured URL, fetches newest-first pages (retries on 429/5xx, dedupe by review id, URL allow-listing per adapter) and builds an ingestion summary. A background run never blocks startup.
- **Ingestion summary**: type `/summary` in the chat (also the first suggested prompt): platform, entity, coverage, average rating (and the platform's own rating), rating histogram, date range, duplicates/empties skipped and data-quality warnings (e.g. Apple's ~500-review cap, storefront scope, stale snapshot). The same data is at `GET /ingestion/summary` (internal). `/reingest` re-runs ingestion.
- **Q&A** (`api/src/chat`): the API exposes `GET /v1/models` and `POST /v1/chat/completions` (streaming SSE), so Open WebUI treats it as a model called `reviewlens`. Every turn the API builds the system prompt (scope rules, refusal behaviour, code-computed stats, the full review corpus) and calls Claude.
- **Scope guard** is driven by the system prompt (`api/src/chat/system-prompt.ts`), parameterised by platform and entity: explicit allow-list, explicit decline list (other platforms, competitors, world knowledge, weather…), a prescribed decline format offering in-scope example questions, evidence citation (`R12`), and an instruction to treat review text and user messages as untrusted. Defence in depth around it: client-sent `system` messages are discarded, history and message sizes are capped, and Open WebUI's helper calls (titles, tags, autocomplete) are disabled so they can't bypass or waste the guarded model.

## Design decisions & trade-offs

- **Pluggable sources.** Public platforms differ wildly in how hostile they are to automated access. Adapters behind one interface, plus a file import, mean the demo doesn't hinge on a single site and the scope guard always names the right platform.
- **Full-context instead of RAG.** A few hundred reviews fit comfortably in the context window, which gives better answers to aggregate questions ("top pain points") than top-k retrieval, and removes a vector store. The corpus is in a cacheable system block, so follow-ups are cheap. Trade-off: it won't scale to tens of thousands of reviews; the next step would be pre-aggregated themes plus retrieval.
- **In-memory store with a disk snapshot.** Reviews are served from memory, and every successful ingestion is saved atomically as JSON on a Docker volume (`api-state`) behind a `ReviewRepository` interface. On boot the last good snapshot is served immediately; if it is older than `REFRESH_MIN_AGE_HOURS` (default 6) a fresh ingestion runs in the background, otherwise the startup fetch is skipped so restarts don't hammer the source (`/reingest` forces one). A restart or a blocked/rate-limited source therefore doesn't leave you with an empty portal. If a refresh fails (or returns nothing) the older data keeps being served and `/summary` plus the model are told it is a stale snapshot. A snapshot is only restored if it came from the currently configured source. Trade-off: single instance, single entity; the next step (multiple entities, history, several instances) would be a Postgres implementation of `ReviewRepository`.
- **Open WebUI as the UI**, integrated through an OpenAI-compatible endpoint, so no custom front end is needed and the app stays decoupled from the UI.
- The API is **not published** to the host; only Open WebUI (bound to `127.0.0.1`) and the optional tunnel expose anything.

## What I would improve

- **Choose the source in the app, not in `.env`.** Today the review URL is set in `.env`, so analysing another source means editing `.env` and restarting the app. In a production app a separate web UI would let the user enter a URL and ingest it on demand, with several entities side by side.
- **Postgres instead of a file snapshot.** Reviews are held in memory and saved as a JSON snapshot on a Docker volume (behind the `ReviewRepository` interface). A proper solution would use Postgres: multiple entities, ingestion history, querying and several app instances. Only a new `ReviewRepository` implementation is needed.
- **More sources through adapters.** The Trustpilot and Apple App Store adapters are implemented but not fully tested against the live sites, because bot protection blocked me. This is how I would source data from many platforms: one adapter per platform behind a common `ReviewSource` interface, so the rest of the backend does not care where the reviews came from.
- **Scope-guard evaluation.** An automated set of in-scope, out-of-scope and prompt-injection questions to measure the guard instead of relying on manual checks.

## Assumptions & known limitations

- One entity per deployment (single `REVIEW_SOURCE_URL`), one App Store storefront per deployment.
- Steam's and Apple's feeds are unofficial and undocumented as a stable API: it can change, and it only exposes recent written reviews, not all of them. Trustpilot scraping depends on its page markup and may be blocked.
- The portal is login-free as required. That means anyone with the URL can spend your Anthropic credits: set a spend limit on the API key, and consider Cloudflare rate-limiting/WAF rules on the hostname.
- Scope-guard behaviour is prompt-driven, so it is probabilistic. Worth adding an eval set of in/out-of-scope questions.
- Scraping may be restricted by a platform's terms of service; for production, prefer official APIs or licensed data exports.

## Development

```bash
cd api
npm install
npm run build && npm test
REVIEW_SOURCE_URL=... ANTHROPIC_API_KEY=... npm run start:dev
```

Scaffolded with the Nest CLI (`nest new`, `nest g module|service|controller`).
