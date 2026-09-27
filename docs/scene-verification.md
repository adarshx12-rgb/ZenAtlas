# Scene verification in an active search

The planner's requirements and Jev/judge relevance shortlist now start scene work before the remaining cascade review and final ranking. Up to two videos are admitted per search. Missing captions are fetched during discovery; retained transcripts guide one Jev call that selects up to three intervals, with a 30-second margin. Interval instructions include requirement and retained cue identifiers. Captions locate possible events; they do not verify visible action.

OpenRouter receives the complete canonical YouTube URL plus instructions to inspect those intervals on the original timeline. There is no dependency on clipping or video offsets in OpenRouter. Short videos, missing or music-only captions, unreliable locations, and requests requiring more than three independently located requirements use whole-video analysis. Lyrics cannot establish the location of visual action; the locator can decline them and request the whole video.

The Python worker listens for queue notifications and recovers missed notifications with one-second polling. It uses two slots by default, with background jobs allowed to occupy only one. A short transaction enforces the shared concurrency limit across processes. Interactive requests take priority; expired requests return to background priority. Existing jobs are attached to the search instead of duplicated. Provider-attempt and job-admission budgets remain separate and bounded.

Active YouTube calls have a maximum 45-second provider timeout, further limited by the remaining verification deadline. Provider fallbacks share that deadline. This bounds waiting but cannot guarantee provider processing time or completion under load. A request that misses the search window can still be processed later as background work.

A separate Node scene-review lane watches linked jobs without occupying discovery. On completion, it reloads permitted evidence for the current media version and rejudges only the affected candidate through Jev/judge and the bounded strong-review cascade. Verified candidates enter the ranked results; uncertain candidates remain closest matches; contradicted candidates are removed. Search revisions are tied to the discovery run and update existing subscribed searches. The browser keeps polling during scene verification, refreshes closest matches, and shows confirmed timestamps without another search.

Only accepted scene observations count toward retained coverage. Responses outside requested intervals are rejected; requested intervals themselves are never stored as proof of complete inspection. Partial observation coverage cannot prove whole-video absence of music, speech, or another excluded property. Source-policy revocation, superseded versions, cancelled subscriptions and stale worker leases remain enforced.

The UI distinguishes waiting, analysing, completed, unavailable, failed, budget-deferred and timed-out checks. The watchdog checks the Python worker heartbeat, slot health, queue age and budget deferrals.

## Rollout

Apply migration `014_scene_verification.sql` before restarting the API, Node worker, watchdog and Python scene worker. Existing rows retain their default background priority. This repository change does not apply the migration or restart running services.

| Setting | Default | Purpose |
| --- | --- | --- |
| `SCENE_SEARCH_LIMIT` | `2` | Videos linked to one active search |
| `SCENE_VERIFY_MS` | `90000` | Scene verification deadline, starting at admission |
| `SCENE_CONCURRENCY` | `2` | Global scene capacity; configure consistently across worker instances |
| `SCENE_AUTO_DAILY_JOBS` | `20` | Daily automatic job admission budget |
| `SCENE_ANALYSIS_DAILY_BUDGET` | `20` | Daily provider attempts; fallbacks consume attempts too |

The `.env.example` values are defaults, not changes to a running installation's `.env`. Existing single-window settings remain available for the legacy background helper. Real provider latency, accuracy and cost require a live benchmark after rollout; fixture-based tests establish coordination and validation behavior only.
