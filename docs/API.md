# Search API

Base URL for local development: `http://127.0.0.1:3000`. Production should expose these routes on the existing website's origin through its backend/reverse proxy. CORS is disabled.

## Identity and request rules

Call `GET /api/session` before starting concurrent requests. It establishes a signed, HTTP-only, SameSite=Strict cookie (`creator_session`). Send that cookie on search, polling, cancellation and feedback requests. IDs do not grant access: search ownership is checked server-side. A session is anonymous, not a verified platform account.

For `POST`, `PATCH`, `DELETE`, and `PUT`, send `X-Requested-With: CreatorSearch`; JSON writes also need `Content-Type: application/json`. Browser Origin must match `PUBLIC_ORIGIN`. Admin endpoints additionally require `Authorization: Bearer ADMIN_TOKEN`. Admin credentials belong only in administrative tools, never in the search client. The one browser tool that holds the token is the separate admin page (`/admin`), which keeps it in that tab's `sessionStorage` until **Sign out** or the tab closes, renders all data as text, and runs under the same `script-src 'self'` Content-Security-Policy.

Limits: 120 API requests per IP/minute; 30 writes per IP/minute; 20 discovery requests per session/day; a shared daily discovery job/provider budget. Exceeding request limits returns 429; exhausted discovery budgets retain available catalogue results with a provider notice. Unknown filters and malformed bodies return 400. Public responses never include private provider URLs, stack traces or raw upstream errors.

## GET /api/search

| Parameter | Meaning |
| --- | --- |
| `q` | Required, 2–500 characters after NFC/whitespace normalization |
| `mode` | `catalogue`, `auto` (default), or `refresh` |
| `limit` | Integer 1–50, default 20 |
| `language` | Optional ISO-like code such as `en` or `hi`; unknown-language records do not match a language filter |
| `source` | Optional source UUID |
| `after` | Optional UTC ISO date-time publication cutoff; unknown dates are excluded |
| `evidence` | `any` (default), `transcript_supported`, `video_analysed`, `viewer_timestamp`; requires a matching evidence window |
| `depth` | `quick` (default): the query as typed, keyword-ranked. `deep`: AI-planned searches, page, comment and Reddit checks, and AI ranking; a deep search always runs discovery unless `mode` is `catalogue` |
| `cursor` | Opaque signed cursor; keep every original query/filter/mode/limit/depth parameter unchanged |

The TypeScript response contract is in `src/types.ts`:

```typescript
interface SearchResponse {
  query: string;
  search_id: string;
  status: 'complete' | 'discovering' | 'partial' | 'cancelled';
  depth: 'quick' | 'deep';
  stage: 'queued' | 'searching' | 'checking' | null; // set while status is 'discovering'
  results: Result[];                // one page, catalogue results first, then discoveries
  next_cursor: string | null;
  has_more: boolean;
  discovered: Result[];             // every discovered result so far, in display order
  catalogue_total: number;          // catalogue results in the snapshot; later positions are discoveries
  discovery_job_id: string | null;
  providers: {
    provider: string;
    status: 'ok' | 'partial' | 'unavailable' | 'disabled' | 'budget_exhausted';
    message: string;
  }[];
  ranking_version: string;
}
```

Each result includes an internal ID, title, canonical URL, source ID/name, nullable metadata, availability (`unknown`, `available`, `unavailable`), rights status, origin (`catalogue` or `discovery`), evidence label, and zero or more matching moments. A moment includes start/end seconds, an extractive summary, evidence references, analysis version and inspected ranges. Timestamp units are seconds. Empty evidence is `metadata_match`; unknown metadata stays null. Availability is hidden for `unavailable` records. Rights status is not inferred from public searchability.

Scene moments (`evidence_type: "video_analysed"`) come from the Gemini scene worker and add `scene`: `media_version` (the registered version key), `media_start_seconds`/`media_end_seconds` on the analysed file's own timeline, `timeline_offset_seconds`, `model`, `tags`, and `dialogue`/`dialogue_source` when subtitle cues were quoted. `start_seconds`/`end_seconds` always use the content URL's timeline (media time + offset). `evidence_refs` holds the analysis ID followed by any retained transcript segment IDs; `inspected_ranges` is the analysed span. When the source permits video analysis, a result can include `scene_analysis`: `{status, media_version, message}` for its current media version, where `status` is `pending`, `complete`, `inaccessible`, `failed` or `not_permitted` and `message` is a fixed readable sentence, never a raw provider error. Scenes from superseded versions, changed subtitles or revoked permissions are removed from new searches and existing snapshots.

Viewer moments (`evidence_type: "viewer_timestamp"`) group timestamps that viewers wrote in public YouTube comments. `summary` joins the cited comment excerpts with ` · `, `evidence_refs` are the stored excerpt IDs (each timestamp lies inside the moment), and `inspected_ranges` is empty because no media was inspected. Discovery results can also include `badges` (short labels such as `Live now`, `Livestream replay`, `Official channel`, `Discussed on Reddit`, `3D: three.js`, `Motion: GSAP`) and `judgement`: `{relevance (0-10), reason, model}` from the AI relevance check. Search `providers` may then list `planner`, `youtube`, `reddit`, `pages` and `judge` with their own status (deep searches only). A `searxng` status stays `ok` while at least half of its engines answered; its message then names the engines that did not.

An unapproved candidate result has a temporary ID that does not correspond to persistent content. Feedback returns 409 for it until it is retained as an approved catalogue record. Searchability does not imply playback, embeddability, accessible media, or permission to reuse.

`catalogue` does not call discovery. `auto` discovers when too few local records exceed the configured relevance threshold. `refresh` requests discovery subject to cooldown/budgets. High raw result count alone is not adequate coverage. Optional semantic provider failure does not break lexical retrieval.

## GET /api/search/:id

Poll the owning session's search to retrieve its first page, its discovered results and discovery status. It is also the job-progress endpoint; the shared job itself has no public unowned route. The reference client polls every 1.5 seconds while `status` is `discovering` (at most 150 seconds for a quick search and 330 for a deep one), and keeps polling through up to five failed requests in a row. Resume manually while the search is unexpired if necessary. Discovery is labelled delayed after two minutes (five for a deep search); lack of an active worker cannot leave the UI claiming an empty successful search.

While discovery runs, `discovered` grows as the worker stores the best leads of each engine's answer; new unique results are appended after the frozen local ranking and after earlier discoveries. `stage` is `searching` while engines answer and `checking` while a deep search checks pages and comments and ranks with AI. When a quick search completes, remaining results are appended and nothing already listed moves. When a deep search completes, listed entries take its judgement, badges and moments, the discovered part is reordered by its ranking, and discoveries its judge rejected are removed; catalogue results keep their place. Render `discovered` in the given order and update cards whose data changed. To retrieve later catalogue pages, use `/api/search` with its original parameters and the returned cursor, while `catalogue_total` exceeds what is loaded. Client code should preserve the current page cursor across first-page polls, retain displayed cards and ignore stale query responses. New searches can rank newly retained content normally.

## POST /api/search/:id/deep

Continues the owner's search as a deep dive and returns a new search (a `SearchResponse` with a new `search_id` and `depth: "deep"`). The new search starts with every result of the original, including discoveries, and follows a deep discovery job for the same query and filters; asking again reuses that job while it runs and for the discovery cache period. Poll the new ID. Deepening a deep search returns it unchanged. A `catalogue`-mode search returns 400 `discovery_disabled`. The request needs the `X-Requested-With` header, counts as a write, and uses the same discovery budgets as `/api/search`; when a budget is exhausted the response is `partial` with a notice and keeps the original results. Page the new search with `depth=deep` added to the original parameters.

Search snapshots expire after `SEARCH_TTL_SECONDS`; another session or expired ID receives 404. Invalid/tampered/mismatched cursors return 400. Revoked/deleted content is removed from API results; source-policy changes invalidate snapshots. Therefore a page may contain fewer than `limit` results after revocation.

## DELETE /api/search/:id

Stops the owner's subscription to discovery updates, returning `{"status":"cancelled"}`. Shared collection work continues for other subscribers and catalogue maintenance. Disconnecting the browser does not delete durable jobs. Expiration is enforced independently of polling.

## Feedback

`POST /api/feedback`:

```json
{"search_id":"SEARCH_UUID","content_id":"CONTENT_UUID","useful":true}
```

The IDs above are placeholders. Feedback requires a result in the caller's active search and an eligible retained content record. Repeated votes update one `(owner, content_id)` row, returning 204. Personal ranking impact is bounded; there is no anonymous global learning signal. `GET /api/feedback` returns only the caller's last 100 records. `DELETE /api/feedback` deletes their feedback, returning 204. Account authentication and anti-Sybil controls are required before adding global learned signals.

## Administration

- `GET /api/admin/sources`: sources including candidates and policies, each with `saved_videos` (retained content count); bearer token required. Optional query: `status` (`all` default, `candidate`, `active`, `paused`, `rejected`), `q` (case-insensitive substring of the domain or name), `sort` (`newest` default, `seen` for most discovery appearances, `domain`), `limit` (1–500, default 200) and `offset`. The `X-Total-Count` response header gives the number of matching sources.
- `GET /api/admin/sources/summary`: `{statuses:{active,candidate,...},rules,saved_videos}` counts.
- `POST /api/admin/sources/bulk`: `{ids:[up to 100 source IDs],policy}` applies one `examples/source-policy.json`-shaped policy to each source through the same path as `PATCH`; returns `{updated}`.
- `GET /api/admin/rules`, `POST /api/admin/rules` (`{pattern,policy}`; see trust rules in [SOURCE_HEALTH.md](SOURCE_HEALTH.md), returns the rule and `applied_to_existing`), `DELETE /api/admin/rules/:id` (204; sources the rule already classified keep their status).
- `POST /api/admin/sources`: register a domain with `{url,name?}`. Returns its source ID and current status; registration starts as a candidate.
- `GET /api/admin/sources/:id/alternatives`: reviewed and proposed alternative domains.
- `POST /api/admin/sources/:id/alternatives`: record `url`, `status` (`candidate`, `verified`, `rejected`), `review_note`, optional `evidence_url`, and optional `feed_url`. Requires administrator access. A verified alternative can be used automatically after confirmed outage and a successful health probe.
- `PATCH /api/admin/sources/:id`: body follows `examples/source-policy.json`; validates a review note, status, retention period, metadata/transcript/`video_analysis` permissions, adapter and optional feed URL. `video_analysis` defaults to `false`; revoking it deletes the source's scene analyses.
- `GET /api/admin/health`: provider failure counters, queue status counts, current media-version scene analysis status counts and oldest queued timestamp. It exposes operational information only to administrators.

The health endpoint also returns source health states, original and active domains, and recent switch events. See [SOURCE_HEALTH.md](SOURCE_HEALTH.md) for failover semantics. Confirmed-down sources and content on superseded domains are excluded from both new searches and existing snapshots.

Collection imports, transcript imports, embedding requests and content deletion are available through the server-side CLI; there is no public arbitrary-fetch or arbitrary-analysis route. `GET /health/live` and `GET /health/ready` return minimal process/database readiness status.

## Error envelope

```json
{"error":{"code":"service_unavailable","message":"Search is temporarily unavailable. Please retry."}}
```

Validation is 400 (a private, local or non-http(s) address is `unsafe_url`), ownership/nonexistent/expired search is 404, origin/admin failures are 403, a feedback result not retained is 409, quotas are 429, and an unavailable database/service is 503. An external provider failure with usable catalogue access is a 200 search response with partial status, not a genuine no-results success.
