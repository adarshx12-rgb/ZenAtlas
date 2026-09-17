# Discovery providers, source monitoring and verified replacements

ZenAtlas supports **Google Custom Search, Brave Search and SearXNG independently**. Any configured provider can supply catalogue discovery or replacement-domain candidates. Each provider has its own daily budget and deadline; one provider's failure preserves other results. No search-engine HTML scraping or CAPTCHA bypass is implemented.

## Configure discovery

Set any combination in `.env`:

| Provider | Required variables | Reference |
| --- | --- | --- |
| Google Custom Search | `GOOGLE_SEARCH_API_KEY`, `GOOGLE_SEARCH_ENGINE_ID` | [Official API overview](https://developers.google.com/custom-search/v1/overview), [request contract](https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list) |
| Brave Search | `BRAVE_SEARCH_API_KEY` | [Official Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) |
| SearXNG | `SEARXNG_BASE_URL`; optional reverse-proxy token | [Official search API](https://docs.searxng.org/dev/search_api.html) |

Google's documentation states that Custom Search JSON API is closed to new customers and existing customers must transition by **January 1, 2027**. The Google adapter is therefore for eligible existing accounts; it is not a new-account onboarding promise. No credentials or subscriptions are provisioned by ZenAtlas. Confirm your provider's result-storage terms before persisting its metadata.

Google requests at most ten results per call; Brave at most twenty. Both adapters return provider cursors but the background workflow intentionally processes one page per job. Query text is preserved. Final catalogue filters remain enforced locally; the adapters do not promise identical language/date/video filters across engines. Google and Brave currently return general web leads, so a result URL is not proof of a video, playable media, or an inspected scene. Unknown metadata remains null.

For SearXNG, content searches use `SEARXNG_ENGINES`. Replacement-domain searches use `SEARXNG_SOURCE_ENGINES` (default `google,bing`). Each engine is asked in its own request. Those engines must actually be enabled and accessible in the instance. The supplied container settings enable Google and Bing for these searches alongside the video engines listed in the README; upstream availability is not guaranteed.

## Run monitoring

With PostgreSQL and `.env` configured, apply the new migration and runtime grants, then restart the API and worker:

```powershell
npm.cmd run migrate
npm.cmd run db:app-user
npm.cmd run dev
# Another terminal:
npm.cmd run worker
```

The **production worker** checks all registered non-rejected sources, including link-only sources, candidates and paused sources. Paused/candidate sources are monitored but never automatically activated. The credential-free preview still does not run the production worker. Monitoring uses durable database jobs; keep the worker under a process/container supervisor for continuous operation. A machine shutdown or stopped worker stops checks; reopening a browser does not substitute for a worker.

Defaults:

- Healthy/unknown sites: schedule a check every **6 hours** (`SOURCE_HEALTH_HOURS`).
- Suspected outage: retry after **15 minutes** (`SOURCE_HEALTH_RETRY_MINUTES`).
- Mark down after **3 consecutive failed checks** (`SOURCE_HEALTH_FAILURES`), rather than three immediate HTTP attempts.
- At most **1000 logical health probes/day** and 1000 scheduled health jobs/day (`SOURCE_HEALTH_DAILY_BUDGET`). Each logical probe is bounded to two redirects; a HEAD-not-supported response permits a bounded GET fallback that only reads response headers.

The worker uses HTTPS HEAD requests with pinned, validated DNS addresses; supported HEAD failures fall back to GET headers. Public-network URL, redirect and deadline protections apply to every hop. Credentials are never sent to source sites. A 2xx response on the expected domain establishes HTTP reachability, not identity, content quality or media availability. 401/403/429 mean access-limited or rate-limited (`blocked`), not a confirmed outage. Timeouts, network errors and unsuccessful endpoints accumulate failed checks. A successful check clears the streak. Cross-domain redirects propose alternatives; a redirect alone does not approve the destination.

Health states are separate from administrative status and collection failure counts. A confirmed-down source is temporarily excluded from search results without deleting its catalogue. If its active endpoint later recovers, its unexpired eligible records become searchable again.

## Scale review with trust rules instead of reviewing every domain

Discovery can surface far more candidate domains than an administrator can reasonably review one by one. `source_policy_rules` lets you review a **pattern** once (e.g. an exact domain or a `*.domain` wildcard covering every subdomain) and have it apply automatically, forever, to every matching source — both new discoveries and any matching `candidate` sources already sitting in the database.

```powershell
npm.cmd run admin -- policy-rule "*.youtube.com" examples/policy-rule.json
npm.cmd run admin -- policy-rules
npm.cmd run admin -- policy-rule-delete "*.youtube.com"
```

The rule file uses the same shape as `examples/source-policy.json`, including its own `review_note`; the reviewed decision is the pattern, not any single domain. A rule is checked the moment a brand-new domain is first discovered (`src/catalogue.ts`'s `ingest`), and — when the rule is created or edited — retroactively against every source still sitting at the default `candidate` status. A source a human has already moved off `candidate` (via `policy`) is never touched by a later rule change. Rules are not only for approval: a pattern can just as well be set to `"status":"rejected"` to blocklist a known spam or scraper network the instant it's discovered.

Every discovery hit also increments that source's `discovery_appearances` counter, whether or not a rule classified it. For domains no rule covers, this powers a small, prioritized human-review queue instead of a firehose:

```powershell
npm.cmd run admin -- review-queue 5
```

This lists `candidate` sources that have appeared in discovery results at least 5 times, most-frequent first — so review time goes to domains that have already proven they matter, and each approval is best turned into a new rule (covering that whole publisher going forward) rather than a one-off `policy` call, so the queue actually shrinks over time instead of growing with the catalogue. Deliberately not automated: flipping a source's `metadata` (permanent content retention) purely from traffic volume. Popularity doesn't establish permission to retain a domain's content or rule out spam/duplication — that's still a human (or a rule the human wrote) making the call, per the activation review above.

## Add a source and known alternatives

The domain names below are examples, not sites tested or configured by this build.

```powershell
npm.cmd run admin -- add-source https://original.example.org "Example source"
npm.cmd run admin -- sources
```

Activate metadata collection with the existing reviewed source-policy command. Add a known alternative using a copy of `examples/alternative.json` with real URLs and an actual review:

```powershell
npm.cmd run admin -- alternative SOURCE_UUID my-alternative.json
npm.cmd run admin -- alternatives SOURCE_UUID
npm.cmd run admin -- check-source SOURCE_UUID
```

`verified` means an administrator has confirmed the same operator/site identity **and** that its collection/retention policy applies. Suitable evidence includes the source operator's authenticated domain-migration announcement or your established ownership relationship. Store the review and optional evidence URL. Merely sharing a name, top-level-domain variation, visual design, or search-engine ranking is not sufficient. The code records this review; it does not independently prove the truth of an administrator's claim. Use `candidate` until checked, or `rejected` for an unsuitable domain.

A JSON-feed alternative must have its own explicit `feed_url` on the replacement domain. The worker must observe that endpoint responding successfully before switching. A healthy homepage alone does not establish a feed URL or its schema. Feed contents are schema-validated by the normal collection adapter afterwards.

## Automatic failover

For the requested `xyz.io` → `xyz.cx` pattern:

1. Register the original source. If you already know the official mirror, record it as a verified alternative.
2. The worker confirms repeated failures of the currently active domain.
3. It checks up to three verified alternatives per cycle, rotating toward the least recently checked.
4. It switches only to a verified alternative that responds successfully on that exact domain and, for feed sources, has an explicit responding feed endpoint.
5. The source keeps its original ID, original `domain`, policies and history; `active_domain` becomes the working replacement. The worker records a switch event and continues checking that endpoint.
6. Collection is scheduled immediately. If discovery is configured and budget remains, a `site:replacement-domain` discovery job finds actual content URLs there.

The worker does **not** replace `.io` with `.cx` in every stored link. The new site's content paths may differ. Old-domain URLs are hidden while that domain is no longer active, and remain retained until their source retention expires. New discovered/feed URLs are indexed normally. If an approved feed supplies the same provider content ID on the new domain, its actual returned URL can update that content record; prior transcript moments are marked stale and the previous URL is recorded in provenance. No timestamp evidence is silently carried across a changed URL.

If there is no working verified alternative, the worker searches the configured engines for candidates once per source/day. Found domains are stored in a bounded review list, never automatically approved by name similarity. Without a discovery provider, known verified alternatives still work; the job reports `discovery_not_configured` for finding unknown alternatives. The source remains down and continues health checks until recovery or a verified alternative is available.

## Inspect and manage

`GET /api/admin/health` includes source health, active domains and recent switch events. The protected routes are:

- `POST /api/admin/sources`: `{ "url": "https://...", "name": "..." }`.
- `GET /api/admin/sources/:id/alternatives`: candidate/reviewed alternatives.
- `POST /api/admin/sources/:id/alternatives`: same schema as `examples/alternative.json`.

These require the existing administrator bearer token and write-origin/header protections. Public users cannot register a mirror or force a switch. Health events expire after 90 days; unverified alternative candidates after 30 days. Verified alternative reviews remain with the source. Source health writes and job completion share a transaction and validate the worker lease so stale/restarted workers cannot increment the same completed check twice or overwrite a later switch.

## Verification boundary

Regression tests use controlled provider responses and probes to test transient failure, recovery, repeated outage, blocked responses, verified failover, stale-worker fencing, candidate discovery, domain identity, and old-URL hiding. The existing SSRF tests apply to the shared transport. No user websites or provider credentials were supplied, so no real `xyz.io`/`xyz.cx` equivalence, provider-account access, or production uptime is claimed.
