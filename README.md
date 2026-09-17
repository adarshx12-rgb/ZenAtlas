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

The implementation follows the official [SearXNG search API](https://docs.searxng.org/dev/search_api.html): JSON output must be enabled in `search.formats`; engine/filter support varies. `deploy/searxng/settings.yml` enables JSON and nine video engines (YouTube, Dailymotion, SepiaSearch/PeerTube, Odysee, Wikimedia Commons, and the Bing, Google, DuckDuckGo and Brave video searches); each returned results from the pinned image on 16 September 2026, while Vimeo and Rumble did not and are left out. Upstream engines change and rate-limit without notice. SearXNG is a metasearch service, not the persistent catalogue.

ZenAtlas asks each SearXNG engine in its own request (`engines=<one engine>`, no `categories`, because SearXNG adds every engine of a named category to an explicit engine list), so a slow or blocked engine cannot hold back the others, and it sends each engine one request at a time so parallel searches do not set off upstream rate limits or CAPTCHAs. A search stays `ok` while at least half of its engines answer; its provider message names the engines that did not (for example `8 of 9 search engines answered; Google Videos (blocked by a CAPTCHA) did not.`), and `/api/admin/health` keeps a `searxng:<engine>` failure counter per engine. A CAPTCHA or rate limit is reported and waited out (SearXNG suspends the engine for a while), never bypassed. `deploy/searxng/engines/bing_videos.py` is a patched copy of the image's Bing Videos engine, mounted by `compose.discovery.yml`: upstream discards a whole result page when one card lacks its metadata block, and the copy skips that card instead. The overlay sets `PYTHONPYCACHEPREFIX`, because the image's precompiled bytecode would otherwise ignore the mounted file. Remove the mount when upstream fixes the engine or when you change `SEARXNG_IMAGE`.

Discovery takes up to 100 leads per engine and keeps the best `DISCOVERY_RESULTS` (`src/ranking.ts`, `rankDiscovery`): leads are scored on how many query words appear in their title (or, at half weight, description/channel), with a small bonus for the engine's own order and for leads several providers agree on. Quoted phrases and `-exclusions` are enforced. Leads containing no query word are dropped when others do match. Each further result from the same site is penalised, so one platform cannot fill the page. SearXNG's channel, duration, publication date and thumbnail URL are retained when valid. The reference client shows channel, duration and date; it does not load third-party thumbnails, because its Content-Security-Policy only allows same-origin images.

Configure your self-hosted instance with `SEARXNG_BASE_URL`. For a host process and the optional local container, use `http://127.0.0.1:8080`. `SEARXNG_TOKEN` is optional bearer authentication for **your reverse proxy**; it is not claimed to be a native SearXNG API-key setting.

An optional Compose overlay is included:

```powershell
# First set SEARXNG_IMAGE to an actual verified image@sha256:... reference,
# SEARXNG_SECRET to a random secret, and SEARXNG_BASE_URL in .env.
docker compose -f compose.yml -f compose.discovery.yml up -d db searxng
```

Select an immutable digest from the [official container registry referenced by SearXNG](https://docs.searxng.org/admin/installation-docker.html) and record it with your deployment. The overlay intentionally requires a digest selection; no unverified SearXNG tag or successfully tested live deployment is claimed. The database image is version-pinned to `pgvector/pgvector:0.8.6-pg18-bookworm`, a tag listed in the [pgvector installation documentation](https://github.com/pgvector/pgvector#docker). Container startup remains unverified on this machine. For production, pin the resolved database and Node image digests too.

Start the worker, then use **Fresh discovery**. Local results return immediately, with a search ID and durable job ID. The worker publishes the best leads of each engine's answer as it arrives (only leads matching at least half of the query's words; the remaining slots are filled once every engine has answered), and polling appends them, so results appear while slower engines are still searching. Provider failure is a partial response with readable status; local results survive. Repeating a normalized query reuses its active or recent completed job for 10 minutes by default. Refresh respects this cooldown and all budgets. Each provider makes at most two HTTP attempts per job, with bounded backoff, and a maximum of 20 discovered entries by default. A rate-limit response is not retried immediately.

SearXNG is distributed under [AGPL-3.0](https://github.com/searxng/searxng/blob/master/LICENSE). Keep the license/notices and corresponding source for the exact version you deploy or distribute. If modifying a network-served SearXNG instance, review and satisfy the license's source-offer requirements. This separate HTTP client does not establish a licensing conclusion for your whole platform. Provider terms, permitted metadata retention, and access restrictions still require source-specific review.

## Source review and background collection

Unknown domains enter `candidate`; discovery alone never activates them. Candidates can appear as temporary external links, but their content is not added to the searchable catalogue. Their domain/provenance records expire after 30 days. Sources already approved for metadata retention can persist individual discovered items. Discovery grants no transcript, embed, media, or download capability.

The minimum activation review is: relevant individual content; an identifiable publisher/access method; no evident spam/duplicate source; permission to retain the proposed metadata; a retention period; and an explicit connector decision. Record this evidence in `review_note`. Unsupported sites can be approved as `link_only`, with no automated collection; uncertain sites stay candidates. (A fresh search may open individual result pages once to check their relevance, as described under page checks below; nothing from them is stored.) This build deliberately has **no universal crawler and no approval based on discovery traffic alone**: nothing gets activated just because a domain appeared or was visited often. An administrator can, however, record a `review_note`-backed decision once for a domain *pattern* (`source_policy_rules`, see [docs/SOURCE_HEALTH.md](docs/SOURCE_HEALTH.md)) and have it apply automatically to every current and future matching domain — the review is still explicit and human-authored, it just isn't repeated per instance.

The easiest way to review sources is the admin page at **http://127.0.0.1:3000/admin** (use the same address as `PUBLIC_ORIGIN`; changes from other origins such as `localhost` are refused). Sign in with `ADMIN_TOKEN`. It lists every website with its status, discovery appearances, saved videos and health; filters by status or name; adds websites; approves, pauses or rejects one website or up to 100 selected at once; and manages trust rules. Every change asks for a review note, as the policy files do. The page uses the protected HTTP source endpoints in [docs/API.md](docs/API.md). The same actions are available from the server-side CLI using the restricted service database connection:

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

No production transcript was available during this build. The reference client only offers timestamp navigation for supported YouTube watch URLs and never shows a generic download button.

### AI planning, viewer signals, page checks and AI relevance

Discovery has two depths (`depth` in the search API, `src/discovery.ts`). Both run every step below and show results as each engine answers; the AI ranking then reorders a search's finds, adds reasons, and removes the ones it rejected.

- **Quick** (default): the query as typed starts at once, the AI-planned searches follow, all on the standard engines' first result pages. Typically 25–50 seconds, with the first results after a few seconds.
- **Deep dive** (2–3 minutes): the results page shows **Dig deeper** under the result count once a quick search has finished (not in catalogue-only mode). It calls `POST /api/search/:id/deep` and goes down the rabbit hole for underrated sources that ordinary searches miss:
  - the AI plans up to `DEEP_PLAN_SEARCHES` different searches aimed at lesser-known, independent and niche sources (specific titles, scenes and creators, enthusiast jargon, other languages, small platforms, archives and communities), avoiding the searches the quick search already ran;
  - every search also runs on `SEARXNG_DEEP_ENGINES` and `SEARXNG_DEEP_WEB_ENGINES` (by default Bilibili, AcFun, PrivacyWall Videos; Yep, ResultHunter, PrivacyWall and Hacker News), and on result pages 2 to `DEEP_PAGES` that ordinary searches never reach;
  - up to `DEEP_ROUNDS` rounds then follow leads: the AI reads the finds so far and the Reddit threads about the request and suggests up to `DEEP_FOLLOW_UPS` new searches for titles, names, creators and communities that appear in them. Rounds stop when time runs short or leads stop turning up anything new;
  - searching stops starting new requests after `DEEP_SEARCH_SECONDS`, then the checks and AI ranking run on the new finds (up to `DEEP_RESULTS`, plus room for each follow-up round). They appear in their own **Deep dive finds** section after the quick results, which stay as they were, and underrated finds rank first among equally relevant ones.

  A deep dive only runs when someone asks for it.

The steps:

- **Anime recognition** (`src/anilist.ts`, `ANILIST_ENABLED`, no key needed): before planning, one public [AniList](https://anilist.co) GraphQL search checks whether the query confidently names a specific anime — most of a matched title's own words appear in the query (a short, canonical title against a longer request), or most of the query's words appear in the title (a verbose or compound title, such as an arc-specific entry, that adds words no query would include); a query like "attack on titan season 4 episode 28" first tries as typed, then, since AniList's own search is title-literal, a narrower retry with the season/episode markers and descriptive words removed. A confident match's official English, romaji and native titles, synonyms, genres, format, episode count, studios and season are given to the planner (to search under the show's real names) and the judge (to recognise fan-subbed, dubbed or renamed uploads of it); it is catalogue data, not instructions, and never the user's own text. Capped by `ANILIST_DAILY_BUDGET`; a miss adds no notice, since most searches are not about anime.
- **Planning** (`src/planner.ts`, needs `GEMINI_API_KEY`): one request classifies the search as videos, websites or both, writes up to `PLAN_SEARCHES` queries from different angles (expert terms, synonyms, `site:` queries for platforms and showcases where such work is published), and lists up to five checkable criteria. The user's own query always runs too. Without a key, or if planning fails, the query runs as typed, on web engines when it mentions websites and on video engines otherwise.
- **Searching**: every planned query runs in parallel on every provider. For SearXNG, video queries use `SEARXNG_ENGINES` and web queries use `SEARXNG_WEB_ENGINES` (Google, Bing, Brave and Yahoo answered on 16 September 2026; DuckDuckGo showed a CAPTCHA, Qwant denied access and Mojeek returned nothing). SearXNG requests are capped by `SEARXNG_DAILY_BUDGET`; paid Google/Brave requests by `DISCOVERY_DAILY_BUDGET` and only take first pages. Each lead is scored against the words of the query that found it (operators such as `site:` are ignored), leads found by several queries rank higher, and up to `DISCOVERY_RESULTS` results are kept.
- **Page checks** (`src/pages.ts`): for up to `PAGE_CHECKS` results found by web queries, the worker reads the site's `robots.txt` once (skipping the page if it is disallowed or `robots.txt` cannot be read) and then fetches the page once, through the same public-address and redirect protections as other requests, with a `PAGE_TIMEOUT_MS` deadline and a 1.5 MiB limit. It extracts the title, description, visible text and front-end libraries named in the source (three.js, React Three Fiber, Babylon.js, Spline, PlayCanvas, model-viewer, WebGL, GSAP, Lottie, Rive, Framer, Anime.js, PixiJS, Theatre.js, Locomotive Scroll, Lenis, Barba.js, background video, canvas). Results show badges such as `3D: three.js` or `Motion: GSAP`. Page text is only passed to the AI judgement and is not stored. A missing library name proves nothing, because many sites bundle their code.
  - **Main text** (optional, `PAGE_TEXT_PYTHON`): one long-lived Python helper (`scene-worker/src/zenatlas_scenes/pagetext.py`, trafilatura) extracts the page's main content, so the judge reads the article or hero copy instead of menus and cookie banners. The helper never fetches anything; it only parses HTML the worker already fetched. If it is missing or fails, the visible text is used.
  - **Browser check** (optional, `PAGE_RENDERS`): the first `PAGE_RENDERS` pages that robots.txt allowed and that answered the plain request are also opened in sandboxed headless Chromium (Playwright), at most three at a time, within `PAGE_RENDER_TIMEOUT_MS`. It records the scripts the page loads, library globals it sets (`__THREE__`, `gsap`, `lottie`, `PIXI` and similar), whether it creates a WebGL context, and a 640×400 JPEG of the first screen after a short scroll; video downloads, service workers, downloads and pop-ups are blocked. All browser traffic (subresources, redirects, WebSockets, loopback) goes through a local proxy (`src/egress.ts`) that resolves each host once and only connects to public addresses on ports 80 and 443, so a page cannot reach private or metadata services. The screenshot is sent to the AI judge as visual evidence and shown as the result's thumbnail. It is stored in `page_previews` with the discovery job, served only to that search's owner (`GET /api/search/:id/previews/:result`), hidden once the source is rejected, paused or down, and deleted after `SEARCH_TTL_SECONDS` + `DISCOVERY_CACHE_SECONDS`.

Video results then get viewer signals:

- **YouTube** (official Data API v3, `YOUTUBE_API_KEY`): video length, channel, live status and view count for every YouTube result, and up to `SIGNAL_COMMENTS` top comments for the first `SIGNAL_VIDEOS` of them (videos whose comments are turned off are skipped). Timestamps viewers wrote (`4:05 the twist!`) are grouped into moments with evidence type `viewer_timestamp`; each moment cites the stored comment excerpts, and a database trigger rejects moments whose cited timestamps fall outside them. Clock times such as `10:30 pm`, ratios and times beyond the video length are ignored, and long timestamp lists count for less than a single pointed comment. Only sources whose policy sets `"viewer_signals": true` are checked (off by default; enable it for YouTube on the admin page). Comment excerpts are kept at most 30 days and are deleted, with their moments, when the permission is revoked. Each API request costs one quota unit, capped by `YOUTUBE_DAILY_UNITS`.
- **Reddit**: one `site:reddit.com` search through SearXNG's `SEARXNG_SOURCE_ENGINES` per discovery. A thread counts as discussing a video when it contains the video ID, most of the video title's own (non-query) words, or the channel name. Reddit itself is not scraped.
- **AI judgement** (`GEMINI_API_KEY`, `JUDGE_MODEL`, `src/judge.ts`): structured requests score the top `JUDGE_CANDIDATES` results 0–10 against the request and the plan's criteria, from their title, channel, description, comments, viewer moments, Reddit mentions and page check, and give a short reason. The model also says whether a result comes from a lesser-known source (an independent creator, small channel, niche community or small site, never a well-known site, channel or brand); a result scored 7 or higher from such a source, and with fewer than `UNDERRATED_MAX_VIEWS` views if it is a YouTube video, gets the `Underrated find` badge. The model may only pick moments it was given; unknown results and invented moment IDs are discarded. Results the model skips are asked again once in batches of ten. Results scored 2 or lower are dropped. Uploads that look like unofficial full copies of films or TV episodes are scored down, and channels listed in `OFFICIAL_YOUTUBE_CHANNELS` are labelled and preferred for scene requests. Calls are capped by `JUDGE_DAILY_BUDGET`; candidate text, including comments, is sent to Google.

Each step is optional and independent: without keys, or when a step fails or runs out of budget, discovery keeps its keyword ranking and the search response reports that step as `partial`, `unavailable` or `budget_exhausted` (anime recognition excepted, since a miss is the normal case for most searches). Results carry `badges` (for example `Livestream replay`, `Official channel`, `Discussed on Reddit`, `Underrated find`) and `judgement` (`relevance`, `reason`, `model`). Choose **Viewer timestamps** in the evidence filter to search stored viewer moments in catalogue mode. Review the [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies) and your Gemini terms before production use.

Each quick search uses at least two Gemini requests (planning and judging) and each deep dive at least four (planning, one per follow-up round, and judging), more when a model falls back, `JUDGE_BATCH_SIZE` splits the judgement, or skipped results are asked again. **Gemini's free tier allows only 20 requests per day per Flash model**, so a free key runs out after a handful of searches; the models in `JUDGE_FALLBACK_MODELS` are then tried in turn (a model whose daily quota is spent is set aside for an hour), and when every model is only held back by a per-minute limit, the request waits for the suggested delay (up to 30 seconds) and tries once more. When no model answers, the search continues without that step and says so; the worker logs `planner_failed`, `deep_leads_failed` or `judge_failed` with the error code. Use a paid Gemini tier for regular use.

### Video scene analysis with Gemini

`scene-worker/` is a separate Python background worker. It sends one registered, accessible media version to Gemini through the Google Gen AI SDK, validates the structured scenes that come back, and stores accepted scenes in PostgreSQL (migration `006_video_scenes.sql`: `media_versions`, `scene_analyses`, `video_scenes`). `GET /api/search` matches scene descriptions, tags and quoted subtitles together with transcript windows and returns each scene as a `video_analysed` moment. The Node worker never claims `scene_analysis` jobs, and catalogue search needs no Gemini credentials. The embedded `npm run preview` database is single-process, so the Python worker requires a PostgreSQL server.

**Permission.** Analysis runs only for sources whose policy sets `"video_analysis": true` (default `false`), because media is sent to Google. Revoking it deletes that source's analyses; revoking transcript permission deletes analyses that were given subtitles.

**Media access.** There is no generic downloader. A version is either:

- `--youtube`: the content's canonical public YouTube watch URL, passed to Gemini by URL (a Gemini preview feature for public videos). Before each run, YouTube oEmbed must confirm public availability. The duration must already be known in the content metadata; the worker never estimates it.
- `--file`: an authorised file under `SCENE_MEDIA_ROOT`. PyAV decodes a frame and reads the duration, and SHA-256 fingerprints the bytes. The file is uploaded through the Gemini Files API and deleted from it after the request.

**Version identity and offsets.** A version stores its key, fingerprint, duration, `timeline_offset_seconds` (content time = media time + offset), the operator's `offset_basis`, and an optional subtitle file with its own offset (media time = cue time + subtitle offset). These columns are immutable in the database. Registering another version supersedes the current one and marks its scenes stale; a changed canonical URL does the same. Each scene keeps media and content timestamps, and triggers reject scenes that disagree with the offset, exceed the media or content duration, or cite transcript segments from another version or time range. Do not register a different release (a re-edit or remaster, for example) with offset 0 unless you have checked that the timelines match.

**Subtitles.** When the source permits transcripts, the worker reuses, in order: retained `transcript_segments` whose `content_version` equals the version key; the registered SRT/WebVTT file; then faster-whisper, only if `SCENE_TRANSCRIBE_FALLBACK=true`, the optional `transcribe` extra is installed, and the local file has an audio track. Otherwise the model receives the video alone. Scene dialogue is quoted from those cues by timestamp, never written by the model, and subtitle text is sent as delimited, untrusted data.

**Validation and failures.** The model returns `MM:SS` scenes under a JSON schema, and the worker revalidates them strictly. A timestamp may move at most one second (the output granularity) to fit the media. Scenes outside the media or content, overlapping scenes, and scenes citing non-overlapping cues are rejected; a response in which most scenes fail is discarded entirely. Invalid, truncated, blocked or "could not watch" responses store nothing. Network errors, rate limits and invalid output are retried at most three times. Inaccessible media (a missing or changed file, a private or removed video, or a provider processing failure) is recorded on the version with an explicit code. Search results show it through `scene_analysis`, while ordinary link results stay available.

**Coverage and cost.** Each run submits the whole media at 1 frame per second and low media resolution. Sampled frames do not guarantee that brief events were seen; the analysed span is stored as `inspected_ranges`. Clip offsets are not used because Google's documentation does not state which timeline clipped timestamps refer to. Media longer than `SCENE_MAX_MEDIA_SECONDS` (45 minutes by default) fails with `media_too_long`. Results are cached by media version, model, sampling settings and subtitle identity, so an unchanged job completes without a model call. `SCENE_ANALYSIS_DAILY_BUDGET` caps Gemini requests; an exhausted budget defers the job to the next day without using an attempt.

Setup, from the repository root so `.env` is read:

```powershell
py -3.12 -m venv scene-worker\.venv
scene-worker\.venv\Scripts\python -m pip install -e "scene-worker[test]"   # [transcribe,test] adds faster-whisper; [pages] adds trafilatura for page checks
npm.cmd run migrate
npm.cmd run db:app-user
# Set GEMINI_API_KEY and SCENE_MEDIA_ROOT in .env, and approve video_analysis in the reviewed source policy.
scene-worker\.venv\Scripts\python -m zenatlas_scenes register CONTENT_UUID --version-key YOUR-VERSION --file sample.mp4 --offset 0 --offset-basis "How the timeline was verified"
scene-worker\.venv\Scripts\python -m zenatlas_scenes enqueue MEDIA_VERSION_UUID
scene-worker\.venv\Scripts\python -m zenatlas_scenes work --once
scene-worker\.venv\Scripts\python -m zenatlas_scenes status CONTENT_UUID
```

Run `work` without `--once` under a supervisor for continuous processing. `check-media MEDIA_VERSION_UUID` rechecks access without calling Gemini. `GEMINI_MODEL` (default `gemini-3.8-flash`, listed as Google's stable Flash model in September 2026) sets the model for newly queued jobs, and `enqueue --model` overrides it per job.

**Sample video status.** No `GEMINI_API_KEY` was available during this build, so no live Gemini analysis has run and no model-generated scenes have been stored. The curated Big Buck Bunny and Sintel YouTube links passed the live oEmbed check on 16 September 2026, but the curated metadata has no verified durations, so `--youtube` registration refuses them until a verified duration is imported. For a local sample, use a copy you are authorised to process and establish its offset against the catalogue URL.

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
| `SEARXNG_ENGINES` | The nine video engines above; each must be enabled in the instance |
| `PROVIDER_TIMEOUT_MS`, `DISCOVERY_RESULTS` | 5000 ms per attempt (`.env.example` uses 12000 because video engines are slower; SearXNG is asked to finish 2 s earlier), 20 ranked results per search (30 in `.env.example`) |
| `DISCOVERY_DAILY_BUDGET` | 100 searches per adapter/day; also caps scheduled collections |
| `COVERAGE_MIN_RESULTS`, `COVERAGE_MIN_SCORE` | 5 sufficiently matching records; normalized lexical/moment score at least 0.03 |
| `COVERAGE_MIN_SOURCES` | 1 (3 in `.env.example`); auto mode also runs discovery when those strong matches come from fewer sites |
| `SEARCH_TTL_SECONDS`, `DISCOVERY_CACHE_SECONDS` | 1800-second snapshots; 600-second discovery reuse |
| `SOURCE_REFRESH_HOURS` | 24-hour initial collection schedule |
| `SEMANTIC_ENABLED` | `false`; lexical search remains independent |
| `EMBEDDING_URL`, `EMBEDDING_TOKEN`, `EMBEDDING_MODEL` | Optional embedding service and model/version |
| `EMBEDDING_DIMENSIONS`, `EMBEDDING_DAILY_BUDGET` | 384 dimensions; 100 query/content embeddings combined per day |
| `SEARXNG_IMAGE`, `SEARXNG_SECRET` | Optional Compose image selection and SearXNG instance secret |
| `YOUTUBE_API_KEY`, `YOUTUBE_DAILY_UNITS` | Optional official YouTube Data API key for viewer signals; 3000 quota units/day |
| `SIGNAL_VIDEOS`, `SIGNAL_COMMENTS`, `OFFICIAL_YOUTUBE_CHANNELS` | 10 YouTube results checked per discovery, 100 comments each; comma-separated official channel IDs |
| `REDDIT_SIGNALS` | `true`; Reddit thread lookup through SearXNG |
| `ANILIST_ENABLED`, `ANILIST_DAILY_BUDGET` | `true`; no key needed. 300 AniList lookups/day (up to two requests each) |
| `SEARXNG_WEB_ENGINES`, `SEARXNG_DAILY_BUDGET` | `google,bing,brave,yahoo` for planned web searches; 2000 SearXNG requests/day |
| `SEARXNG_DEEP_ENGINES`, `SEARXNG_DEEP_WEB_ENGINES` | Extra engines for deep dives only: `bilibili,acfun,privacywall videos`; `yep,resulthunter,privacywall,hackernews` (each must be enabled in the instance) |
| `DEEP_PLAN_SEARCHES`, `DEEP_PAGES`, `DEEP_RESULTS` | 6 AI-planned searches per deep dive; result pages 1–2 per search; 40 new results before follow-ups |
| `DEEP_FOLLOW_UPS`, `DEEP_ROUNDS`, `DEEP_SEARCH_SECONDS` | Up to 4 follow-up searches per round, 2 rounds; 120 seconds of searching before the checks |
| `UNDERRATED_MAX_VIEWS` | 50000; YouTube videos with more views never get the `Underrated find` badge |
| `PLAN_SEARCHES` | 4 searches per request, including the user's own query |
| `PAGE_CHECKS`, `PAGE_TIMEOUT_MS` | 20 web results page-checked per search; 6000 ms per request |
| `PAGE_RENDERS`, `PAGE_RENDER_TIMEOUT_MS` | 0 (off; up to 20) of those also opened in headless Chromium; 12000 ms per page. Needs `npx playwright install --only-shell chromium` |
| `PAGE_TEXT_PYTHON` | Empty (off); Python interpreter with `scene-worker[pages]` installed, for trafilatura main-content text |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | AI relevance judgement (Node) and the scene worker; `gemini-3.8-flash` |
| `JUDGE_MODEL` | Empty (uses `GEMINI_MODEL`); model for AI search planning and judging |
| `JUDGE_FALLBACK_MODELS` | Empty; comma-separated models tried when the judging model is overloaded (5xx), rate-limited or times out. A model that fails that way is tried last for the next 5 minutes (1 minute after a rate limit) |
| `JUDGE_CANDIDATES`, `JUDGE_BATCH_SIZE` | 30 results judged per search; 30 per AI request (smaller batches run in parallel: faster, but more requests per minute) |
| `JUDGE_THINKING_LEVEL` | `low` (`minimal`, `medium`, `high`, or `model_default` to omit it); low roughly halved judgement time in testing |
| `JUDGE_DAILY_BUDGET`, `JUDGE_TIMEOUT_MS` | 200 judgement calls/day (each model attempt counts); 20000 ms per attempt |
| `GEMINI_TIMEOUT_SECONDS` | Scene worker only (parsed in `scene-worker/src/zenatlas_scenes/config.py`); 600-second requests |
| `SCENE_MEDIA_ROOT`, `SCENE_MAX_MEDIA_SECONDS`, `SCENE_MAX_UPLOAD_BYTES` | Absolute authorised media directory; 2700 seconds; 2 GiB |
| `SCENE_ANALYSIS_DAILY_BUDGET`, `SCENE_LEASE_SECONDS`, `SCENE_POLL_SECONDS` | 20 Gemini requests/day; 900-second job lease; 5-second polling |
| `SCENE_TRANSCRIBE_FALLBACK`, `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE` | `false`; `small`; `cpu`; `int8` |

Additional fixed protections: 120 API requests/IP/minute, 30 writes/IP/minute, 20 discovery requests/session/day, 500 query characters, 50 results/page, at most 250 snapshot results, 1 MiB upstream responses, at most two public-fetch redirects, and 16 KiB API request bodies. IPs are HMAC-hashed in quota records. Query strings are not written to application logs. Database budgets expire after two days, feedback after 90 days, searches after their TTL, and completed job payloads after one hour when no live snapshot references them. The worker performs cleanup; operating without a worker does not physically purge expired data. At present query contents are retained in search/job records within those windows for retrieval/polling.

## Verification and deployment

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run evaluate
scene-worker\.venv\Scripts\python -m pytest scene-worker\tests
```

The Python integration tests start a temporary PostgreSQL server (`pgserver`), apply the repository migrations and runtime grants, run the worker as `search_app`, and query the real HTTP search API. Gemini is replaced by labelled fake replies, so these tests do not show live model quality.

Tests execute real PostgreSQL SQL via an isolated PGlite instance. External adapters are explicitly mocked; network guard tests use local HTTP test servers. They are not evidence of live SearXNG results, container startup, or production PostgreSQL concurrency/performance. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the actual results, limits, and remaining checks.

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers hosting, credentials, migration, backups, health checks, production checks, and rollback. The application is not deployed to public infrastructure and no paid service was provisioned.
