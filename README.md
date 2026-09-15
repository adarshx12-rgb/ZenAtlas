# ZenAtlas search engine

A standalone TypeScript search service implementing `SEARCH_ENGINE_BUILD_INSTRUCTIONS.md`. **The supplied workspace had no website code**, framework, authentication, database, hosting configuration, or Git repository. This project therefore provides the backend and a working reference browser client; integrating your existing website remains pending.

## Try it now without Docker or credentials

Requires Node.js 24 or later.

```powershell
npm.cmd ci
npm.cmd run preview
```

Open **http://127.0.0.1:3000** and search for `Big Buck Bunny`, `Sintel`, or `Charge`. Choose **Catalogue only** for a fully local search. The preview uses persistent embedded PostgreSQL in `.data/preview`, with the same schema, retrieval, and API as the service. It loads three real, provenance-recorded video links from `data/curated.json`. It contains no synthetic footage, transcripts, or moments. This single-process preview is for development; it does not run external discovery or a separate worker. Restarting it rotates its temporary session keys.

## Run the service with PostgreSQL

1. Start Docker Desktop's Linux engine, or supply your own PostgreSQL connection. Docker was installed but its engine was stopped during implementation.
2. Copy `.env.example` to `.env`. Replace every required password/token placeholder. Use at least 32 random characters for `SESSION_SECRET` and `ADMIN_TOKEN`, and at least 20 for the database passwords. You can generate a value with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep `.env` private.
3. `POSTGRES_PASSWORD` and the password in `MIGRATION_DATABASE_URL` must match. `APP_DATABASE_PASSWORD` and the password in `DATABASE_URL` must match. URL-encode passwords in connection strings if necessary.
4. Start, migrate, create the restricted application login, and load the curated links:

```powershell
Copy-Item .env.example .env
# Edit .env before continuing; do not overwrite an existing configured .env.
docker compose up -d db
npm.cmd ci
npm.cmd run migrate
npm.cmd run db:app-user
npm.cmd run seed
npm.cmd run dev
```

In another terminal in this directory:

```powershell
npm.cmd run worker
```

Browse http://127.0.0.1:3000. `GET /health/live` checks the process; `GET /health/ready` checks database/schema access. The runtime uses a bounded pool of ten connections with connection/query deadlines. Run migrations with the separate owner connection; the `search_app` role has table data privileges and no database/schema creation authority.

## External discovery

**SearXNG is optional.** ZenAtlas also has direct Google Custom Search and Brave Search adapters. Configure any combination of providers. The worker now monitors source availability and can switch to verified working alternatives after repeated failures. See [source monitoring and provider setup](docs/SOURCE_HEALTH.md) for credentials, health intervals, domain review, commands, and Google API availability limits.

The implementation follows the official [SearXNG search API](https://docs.searxng.org/dev/search_api.html): JSON output must be enabled in `search.formats`; engine/filter support varies. `deploy/searxng/settings.yml` enables JSON and selects the YouTube engine. SearXNG is a metasearch service, not the persistent catalogue.

Configure your self-hosted instance with `SEARXNG_BASE_URL`. For a host process and the optional local container, use `http://127.0.0.1:8080`. `SEARXNG_TOKEN` is optional bearer authentication for **your reverse proxy**; it is not claimed to be a native SearXNG API-key setting.

An optional Compose overlay is included:

```powershell
# First set SEARXNG_IMAGE to an actual verified image@sha256:... reference,
# SEARXNG_SECRET to a random secret, and SEARXNG_BASE_URL in .env.
docker compose -f compose.yml -f compose.discovery.yml up -d db searxng
```

Select an immutable digest from the [official container registry referenced by SearXNG](https://docs.searxng.org/admin/installation-docker.html) and record it with your deployment. The overlay intentionally requires a digest selection; no unverified SearXNG tag or successfully tested live deployment is claimed. The database image is version-pinned to `pgvector/pgvector:0.8.6-pg18-bookworm`, a tag listed in the [pgvector installation documentation](https://github.com/pgvector/pgvector#docker). Container startup remains unverified on this machine. For production, pin the resolved database and Node image digests too.

Start the worker, then use **Fresh discovery**. Local results return immediately, with a search ID and durable job ID. Polling appends unique eligible links. Provider failure is a partial response with readable status; local results survive. Repeating a normalized query reuses its active or recent completed job for 10 minutes by default. Refresh respects this cooldown and all budgets. Each provider makes at most two HTTP attempts per job, with bounded backoff, and a maximum of 20 discovered entries by default. A rate-limit response is not retried immediately.

SearXNG is distributed under [AGPL-3.0](https://github.com/searxng/searxng/blob/master/LICENSE). Keep the license/notices and corresponding source for the exact version you deploy or distribute. If modifying a network-served SearXNG instance, review and satisfy the license's source-offer requirements. This separate HTTP client does not establish a licensing conclusion for your whole platform. Provider terms, permitted metadata retention, and access restrictions still require source-specific review.

## Source review and background collection

Unknown domains enter `candidate`; discovery alone never activates them. Candidates can appear as temporary external links, but their content is not added to the searchable catalogue. Their domain/provenance records expire after 30 days. Sources already approved for metadata retention can persist individual discovered items. Discovery grants no transcript, embed, media, or download capability.

The minimum activation review is: relevant individual content; an identifiable publisher/access method; no evident spam/duplicate source; permission to retain the proposed metadata; a retention period; and an explicit connector decision. Record this evidence in `review_note`. Unsupported sites can be approved as `link_only`, with no automated page scraping; uncertain sites stay candidates. This build deliberately has **no automatic approval policy or universal crawler**.

Use the protected HTTP source endpoints in [docs/API.md](docs/API.md), or the server-side CLI using the restricted service database connection:

```powershell
npm.cmd run admin -- sources
npm.cmd run admin -- policy SOURCE_UUID examples/source-policy.json
npm.cmd run admin -- import your-permitted-items.json
npm.cmd run admin -- transcript your-authorised-transcript.json
npm.cmd run admin -- enrich CONTENT_UUID
npm.cmd run admin -- delete-content CONTENT_UUID
```

Edit the example policy with an actual review first. To collect an owner-approved public JSON feed, use the contract in `examples/feed.json` and set `adapter=json_feed` with `feed_url`. Items must belong to that source's domain. One page of at most 100 items is processed per job; an opaque `next_cursor` survives restarts. A feed marks removals using `availability=unavailable`; omission is not proof of deletion. New or refreshed metadata gets a source-specific expiration. Unknown fields remain null; a sparse refresh preserves existing known metadata. Stale records are hidden immediately and physically deleted by the worker. Link-only records expire without being silently verified by a generic crawler.

The database schedules at most ten due sources per pass within a daily budget. Jobs have unique keys, `SKIP LOCKED` claims, 90-second recoverable leases, completion fencing, and three-attempt terminal failure. Empty feeds back off; source failures reduce reliability, back off checks, and pause the source after five failures. Policies and deletion actions invalidate cached search snapshots to remove revoked data. Keep the worker supervised and monitor its queue age via `/api/admin/health`.

Independent health jobs check all non-rejected domains, including link-only sources. After three failed checks, the worker tries verified mirrors or searches configured providers for candidates. HTTP access restrictions are tracked separately. Only verified, reachable alternatives can replace an active endpoint; existing content paths are never guessed. New settings and the administrative commands are documented in [docs/SOURCE_HEALTH.md](docs/SOURCE_HEALTH.md).

Explicit content deletion retains a minimal URL/provider-identity removal record to prevent rediscovery from restoring the item. Retention expiry simply erases expired metadata; it is distinct from an explicit removal. Review removal records as part of your own retention policy.

## Meaning, transcripts and evidence

Keyword search uses PostgreSQL English full-text search with GIN indexes and `websearch_to_tsquery`; quoted phrases, `OR`, and `-exclusions` retain their search semantics. Input normalization retains names, punctuation and ordinary negation text. English lexical search does not reason about conversational negation or complex visual/story intent; these need evaluation and richer analysis. Language filters are supported, while language-specific stemming beyond English is not implemented.

`src/moments.ts` accepts **actual** ordered timestamped segments only from an active source that permits transcript retention. It validates positive ranges and known duration, retains language/origin/version/timing quality, and produces overlapping extractive windows over the **entire supplied transcript**. Search globally ranks matching windows. Each moment contains its exact evidence IDs and inspected transcript ranges. These broad passages preserve neighbouring context, but they do not implement model-based narrative setup/payoff reasoning or verify silent events. No model credentials are needed for this extractive mode.

Visual/audio analysis is an interface only (`VisualAnalysisProvider`); no media fetching, visual model, invented findings, automatic transcript acquisition, or download capability is supplied. No production transcript was available during this build. The reference client only offers timestamp navigation for supported YouTube watch URLs and never shows a generic download button.

### Optional embeddings

```powershell
npm.cmd run migrate -- --vectors
npm.cmd run db:app-user
```

Set `SEMANTIC_ENABLED=true`, `EMBEDDING_URL`, `EMBEDDING_MODEL`, and dimensions. The configurable private endpoint must accept `POST {"input":"text","model":"version"}` and return `{"embedding":[...finite numbers...]}` with exactly `EMBEDDING_DIMENSIONS` entries. Optional `EMBEDDING_TOKEN` is server-only. This is an explicit provider-neutral adapter contract; it is **not** a claim of compatibility with every embedding vendor's API. Choose/configure a compatible service before enabling it.

Background enrichment caches metadata vectors by content hash and model. Import/seed records can be queued through the `enrich` CLI. Query embedding has a 1.5-second maximum request window; failures preserve lexical retrieval. Lexical, moment and semantic **ranks** are combined by reciprocal rank fusion (`k=60`) in `src/ranking.ts`. Semantic-only expansion is disabled for explicit phrase/exclusion/OR operators to preserve those constraints. Initial vectors use exact cosine search, constrained by model and dimension; add and measure a dimension-specific HNSW index when catalogue scale justifies it.

No live embedding endpoint or pgvector server was available; that optional integration needs live verification. Ranking version `rules-v1` uses small reliability/diversity factors and a capped personal feedback factor. Anonymous feedback never changes global rankings. No large model is trained or retrained. See [evaluation/README.md](evaluation/README.md) for the development benchmark, separate timing evaluation and required held-out human review.

## API and existing website integration

See [docs/API.md](docs/API.md) for the full contract. Main route:

```text
GET /api/search?q=bedroom&mode=auto&limit=20
GET /api/search/SEARCH_UUID
```

`public/app.js` is the working integration example: it establishes a signed anonymous session, calls only the backend, cancels/ignores superseded requests, displays source/evidence labels, and appends results without clearing current cards. A maximum of 40 discovery polls runs per query. API searches expire after 30 minutes; cursors are signed, scoped to the original filters and session, and retain snapshot order. New discoveries append to existing snapshots. This preserves pagination at the cost of not reranking already displayed results; a subsequent new search ranks the enriched catalogue normally.

To connect the existing website, route its same-origin `/api/*` traffic to this backend and replace its search handlers using this contract. Connect an authenticated user ID on the server if your platform has accounts; do not accept a browser-supplied owner ID. The current signed-cookie identity provides session isolation, not user-account authentication or cross-device saves. There are no private saved-media features to migrate. Do not expose internal database, SearXNG or embedding endpoints to the browser.

## Configuration

All names are in `.env.example` and parsed in `src/config.ts`:

| Variables | Purpose / default |
| --- | --- |
| `DATABASE_URL`, `MIGRATION_DATABASE_URL` | Runtime and migration-owner PostgreSQL connections |
| `POSTGRES_PASSWORD`, `APP_DATABASE_PASSWORD` | Local database setup only |
| `HOST`, `PORT`, `PUBLIC_ORIGIN` | Bind address and exact browser origin; `127.0.0.1`, `3000`, `http://127.0.0.1:3000` |
| `SESSION_SECRET`, `ADMIN_TOKEN` | Required random session signing/admin secrets |
| `SEARXNG_BASE_URL`, `SEARXNG_TOKEN` | Optional private discovery endpoint/proxy credential |
| `SEARXNG_ENGINES`, `SEARXNG_CATEGORIES` | `youtube`, `videos`; must match the instance |
| `PROVIDER_TIMEOUT_MS`, `DISCOVERY_RESULTS` | 5000 ms per attempt, 20 results |
| `DISCOVERY_DAILY_BUDGET` | 100 searches per adapter/day; also caps scheduled collections |
| `COVERAGE_MIN_RESULTS`, `COVERAGE_MIN_SCORE` | 5 sufficiently matching records; normalized lexical/moment score at least 0.03 |
| `SEARCH_TTL_SECONDS`, `DISCOVERY_CACHE_SECONDS` | 1800-second snapshots; 600-second discovery reuse |
| `SOURCE_REFRESH_HOURS` | 24-hour initial collection schedule |
| `SEMANTIC_ENABLED` | `false`; lexical search remains independent |
| `EMBEDDING_URL`, `EMBEDDING_TOKEN`, `EMBEDDING_MODEL` | Optional embedding service and model/version |
| `EMBEDDING_DIMENSIONS`, `EMBEDDING_DAILY_BUDGET` | 384 dimensions; 100 query/content embeddings combined per day |
| `SEARXNG_IMAGE`, `SEARXNG_SECRET` | Optional Compose image selection and SearXNG instance secret |

Additional fixed protections: 120 API requests/IP/minute, 30 writes/IP/minute, 20 discovery requests/session/day, 500 query characters, 50 results/page, at most 250 snapshot results, 1 MiB upstream responses, at most two public-fetch redirects, and 16 KiB API request bodies. IPs are HMAC-hashed in quota records. Query strings are not written to application logs. Database budgets expire after two days, feedback after 90 days, searches after their TTL, and completed job payloads after one hour when no live snapshot references them. The worker performs cleanup; operating without a worker does not physically purge expired data. At present query contents are retained in search/job records within those windows for retrieval/polling.

## Verification and deployment

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run evaluate
```

Tests execute real PostgreSQL SQL via an isolated PGlite instance. External adapters are explicitly mocked; network guard tests use local HTTP test servers. They are not evidence of live SearXNG results, container startup, or production PostgreSQL concurrency/performance. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the actual results, limits, and remaining checks.

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers hosting, credentials, migration, backups, health checks, production checks, and rollback. The application is not deployed to public infrastructure and no paid service was provisioned.
