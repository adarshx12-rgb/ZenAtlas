# Implementation and verification record

Implemented locally on September 15–16, 2026. The workspace originally contained only the build brief and skill bundles. No existing website repository or deployment credentials were present.

## Actually verified

- `npm install` installed the dependencies and generated the lockfile from the npm registry; its audit reported zero known vulnerabilities at that time. `npm ci` is the documented reproducible setup command.
- `npm run build`: passed. An evaluation-script typing issue was corrected during the check.
- `npm test`: **9 tests passed**, no failures or skips, approximately 8.3 seconds in the final recorded regression run. Tests execute PostgreSQL SQL/PLpgSQL with isolated embedded PGlite databases. They do not use a running Docker/PostgreSQL server.
- `npm run evaluate`: seven synthetic development queries completed, covering the four requested intents, a phrase, an exclusion, and a shorter query. Mean precision@10 is 0.10, recall@10 1.0, MRR 1.0 and nDCG@10 1.0. Each query has one intended relevant fixture, so precision includes nine empty slots. Individual elapsed search times were 7.92–19.17 ms on this tiny local dataset. These are **not** production latency measurements or human-judged relevance evidence. Exact output is in `evaluation/latest-development-report.json`.
- `npm run preview`: a persistent embedded PostgreSQL catalogue served real curated links at http://127.0.0.1:3000. No synthetic transcript/footage fixtures were loaded into the preview.
- Playwright CLI opened the actual reference client, searched `Big Buck Bunny` in catalogue mode, and observed the stored official YouTube link with `metadata match` and `Rights: unknown`. Clicking Useful displayed `Feedback saved`.
- Browser network evidence: `GET /api/session` → 200; `GET /api/search?q=Big+Buck+Bunny&mode=catalogue&evidence=any&limit=20` → 200; `POST /api/feedback` → 204. This is an actual browser → API → embedded PostgreSQL flow, with no mocked HTTP search endpoint.
- Desktop/mobile screenshots are in `output/playwright/catalogue-search.png` and `output/playwright/catalogue-mobile.png`. An initial favicon 404 was fixed by adding a local SVG favicon.
- Official SearXNG API/settings/container documentation, PostgreSQL full-text documentation and pgvector documentation were consulted. The three curated YouTube watch-page titles were retrieved, with provenance recorded. Playback, rights and timestamps were not verified or fabricated.

## Automated coverage

The integration/security tests cover:

1. Idempotent migrations, stored lexical matches, nullable metadata, language/evidence filters, and stable pagination as new content is inserted.
2. Signed-cookie search ownership, admin denial, cross-origin write rejection, private feedback reads, and one vote per session/content.
3. Valid retained transcript import, full overlapping chunk coverage, duration validation, atomic rollback of invalid import, and stale-evidence invalidation in old snapshots.
4. Deduplication by normalized URL/provider identity without merging equal titles; sparse metadata refresh preserves known values; explicit deletion blocks provider aliases from re-ingesting removed content.
5. Shared durable discovery jobs, reuse of recently completed jobs, later catalogue retrieval, candidate-domain review status, and provider outages preserving local results.
6. Daily job-budget exhaustion and lexical fallback when optional semantic configuration is absent.
7. Worker lease expiry/reclaim, stale-completion fencing, expiration hiding and cleanup.
8. Private IPv4/IPv6/metadata addresses, unsafe schemes and URL credentials, provider redirect refusal, bounded response sizes and content types, malformed SearXNG result filtering, phrase/exclusion preservation, and partial-engine status.
9. The same browser request controller rejects superseded responses in an explicit race test.

External discovery tests use a named mock adapter. HTTP security tests use controlled local servers on ephemeral ports; they do not contact metadata services. The DNS pinning implementation is present, but no external DNS-rebinding infrastructure was used. Multi-process queue contention and a live approved feed still need deployment-level checks.

## Gemini scene worker (September 16, 2026)

Actually run:

- `scene-worker\.venv\Scripts\python -m pytest scene-worker\tests`: **96 passed** in about 10 seconds. Environment: Python 3.12.10, google-genai 2.23.0, psycopg 3.3.5, pydantic 2.13.5, PyAV 18.1.0, faster-whisper 1.2.1, pgserver 0.1.4 (PostgreSQL 16.2).
- The integration tests use a real PostgreSQL server. They apply the repository migrations and `db:app-user` through Node, run the worker as `search_app`, and register versions through the CLI. They query stored scenes over HTTP from `src/main.ts`, checking content times, media times, version keys and offsets. Also covered: a changed file recorded as `inaccessible`/`fingerprint_mismatch`; invalid, unviewable and mostly invalid replies retried and then failed with zero scenes stored; source policy denial; budget deferral; lease loss; reuse of retained transcripts across an offset; speech-to-text fallback; and media without audio.
- `npm run build` passed. `npm test`: **19 passed**, including three scene tests: search, evidence filtering and snapshot revocation; database triggers for offsets, durations, immutability and transcript evidence; and policy revocation, including a check that the Node worker never claims scene jobs.
- Inspection of the installed SDK confirmed `VideoMetadata.fps`, `FileData`, `response_json_schema`, `MediaResolution`, `FileState`, `FinishReason` and `ClientError`/`ServerError.code`. Google's documentation, read on this date, lists `gemini-3.8-flash` as the stable Flash model and supports only some JSON Schema keywords for structured output. It does not state which timeline clipped-video timestamps use, so the worker submits whole media.
- Live YouTube oEmbed checks: Big Buck Bunny (`aqz-KE-bpKQ`) and Sintel (`eRsGyueVLvQ`) returned 200. Nonexistent IDs returned 404 and 400; both are now recorded as `not_found`.
- Live faster-whisper `tiny` (CPU, int8) on a generated 440 Hz tone clip returned no cues, so it did not invent speech. The run took 27 seconds including the model download. A clip without an audio track raised `IndexError`; speech-to-text is now selected only when PyAV finds an audio stream, with a regression test.
- Browser check with Playwright CLI against a throwaway PostgreSQL database. TEST FIXTURE scenes were stored by the real pipeline from a labelled fake reply. A catalogue search for `harbour` showed the scene card: content time 9s–16s, tags, quoted subtitle, version key and +4s offset. A YouTube version that failed the live check against an ID YouTube does not serve showed the explicit notice that the media could not be accessed and the video was not found. Browser console errors: 0. The rendered cards were checked through the page accessibility snapshot; no screenshot of the cards was kept.

Not verified:

- **No live Gemini request was made** because no `GEMINI_API_KEY` was available. Model output quality, real timestamp accuracy, YouTube URL input, API acceptance of the `fps` setting, Files API upload and processing, cost and latency are all unverified. No model-generated scene exists in any database.
- No real speech was transcribed and evaluated, and no person has reviewed scene timestamps against video.
- The Python worker has no container image, and concurrent workers were not tested against a production server.

## Streamed quick search and deep dive (September 17, 2026)

Actually run, on the local PM2-supervised API and worker with the Compose PostgreSQL and SearXNG (image 2026.9.16+f725cc793):

- `npm run build` passed. `npm test`: **61 passed**, including results shown while a slow engine is still searching, engine failure messages and per-engine health counters, one request at a time per engine, and the full dig-deeper flow (ownership, request header, job reuse, judge ordering and removal, catalogue-mode refusal).
- SearXNG, queried one engine at a time: Google and Google Videos answered with a CAPTCHA (suspended by SearXNG), Brave web was rate-limited, DuckDuckGo Videos and Dailymotion timed out now and then, and Bing Videos failed on some queries with an XPath error. The error came from result cards without a `vrhdata` block. With the patched engine mounted (and `PYTHONPYCACHEPREFIX` set, because the image's unchecked bytecode ignored the mount at first), Bing Videos returned 20–39 results for all five test queries, including two that had failed.
- Earlier requests passed `categories` together with `engines`; SearXNG then queried the whole category (a `dailymotion`-only request returned 167 results from every video engine), so Reddit lookups also hit Brave. Requests now name one engine and no category.
- Live quick search `astronaut spacewalk scenes in films`: first results after 1.9 s, complete after 3.5 s with 30 results, all nine video engines answering. Before this change, a comparable search took about 18 s and always showed "Some discovery engines are unavailable."
- Live deep dive from that search: planning, YouTube details and comments, Reddit and AI judgement all `ok`; complete after about 30 s. Google Videos was reported as the one engine blocked by a CAPTCHA, with status `ok`.
- Playwright browser check (`rocket launch scenes in movies`): the quick search showed 15 results at 3.7 s and completed at 5.2 s with 30 results, no notice, and **Dig deeper** visible. The deep dive grew to 60 results while searching, then showed the checking stage, and finished at 38 s with 27 results, each with an AI reason. The button stayed hidden in catalogue-only mode. Console errors were two thumbnail 404s; one image no longer exists at YouTube.

Not verified: behaviour with several workers sharing one deep job's progress, and a deep dive whose Gemini or YouTube quota is exhausted mid-run (covered only by the existing mocked tests).

## Remaining integrations and boundaries

| Milestone | Delivered | Remaining |
| --- | --- | --- |
| 1. Catalogue/API/UI | Versioned schema, lexical search, typed API, curated links, working reference client | Connect the actual existing website and its account system; neither was supplied |
| 2. Discovery | Configurable SearXNG adapter, bounded jobs/polling, deduplication, persistence, partial statuses | Run a real self-hosted instance and verify engine access; no configured endpoint supplied |
| 3. Catalogue growth | Durable schedule, reviewed sources, protected CLI/API, JSON-feed adapter, backoff/expiry | Configure approved real feeds and deployment supervision; unsupported websites remain link-only/candidates |
| 4. Meaning/moments | Optional pgvector migration/provider contract/RRF, extractive full-transcript windows, Gemini scene worker with validated, versioned, offset-aware scenes, subtitle reuse and optional faster-whisper | Live embedding integration; real retained transcripts; a live Gemini run with human timestamp review; model-based story reasoning |
| 5. Feedback/evaluation | Private deduplicated feedback, bounded personal ranking, versioned rules, development metrics and held-out template | Independent human judgments and separately verified timing quality before learned global ranking |

Docker CLI 29.7.2 is installed, but its Linux-engine pipe was absent. No containers were started, no public deployment occurred, and no live embedding/SearXNG call or paid model inference was made. A SearXNG immutable image digest still needs selection; the overlay explicitly requires it rather than inventing a working version. No claim of universal web coverage, automatic quality improvement, accurate visual moments, or free unlimited operation is made.

## Startup and next checks

The immediate local path is `npm run preview`. Production setup is in `README.md`; the API contract is in `docs/API.md`; migration, supervision, real-provider checks, backups and rollback are in `docs/DEPLOYMENT.md`.
