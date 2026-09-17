# Watchdog: dependency monitoring

The watchdog (`src/watchdog-main.ts`) is a third supervised process next to the API and the worker. It checks every service, search engine, AI model, external API, runtime tool and package the search engine relies on. It records the results, shows them on the admin page and can post an alert when something changes.

It only detects and explains problems. It does not restart the API or worker, change settings, or upgrade anything; each problem's summary says what it breaks and how to fix it. The one exception is itself: under PM2 it exits when its own code, packages or `.env` change, and PM2 starts it again on the new version.

## Run it

```powershell
npm.cmd run migrate          # adds dependency_checks, dependency_events and service_heartbeats
npm.cmd run db:app-user      # grants the runtime login access to them
pm2 start ecosystem.config.cjs --only zenatlas-watchdog
pm2 save
```

Restart the API and worker once after upgrading (`pm2 restart zenatlas-api zenatlas-worker`, when no search is running) so they start sending heartbeats. Without PM2, run `npm.cmd run watchdog` in its own terminal.

For a one-off diagnosis, `npm.cmd run watchdog -- --once` runs every check now and prints the results. Name checks to run only those (`npm.cmd run watchdog -- --once gemini searxng`). This mode stores nothing and sends no alerts, and it exits with code 1 when something is failing, so it also works in scripts.

Run only one watchdog. Its schedule lives in the process, so two watchdogs would each run every check.

## What it checks

| Check | Every | What it looks at |
| --- | --- | --- |
| `api` | 1 min | `GET /health/ready` on the API (`WATCHDOG_API_URL`, or `HOST`/`PORT`) |
| `worker` | 1 min | The worker's heartbeat: missing, older than `WATCHDOG_STALE_SECONDS`, or 3+ failed loop cycles in a row |
| `job_queue` | 1 min | Discovery searches waiting longer than `WATCHDOG_QUEUE_SECONDS` (failing when nothing is running), jobs running over 15 minutes, 3+ failed discovery jobs in an hour |
| `database` | 5 min | Connection, migrations not yet applied, and tables the runtime login cannot write |
| `budgets` | 5 min | Today's use of every daily budget: warning at 90%, and failing when discovery budgets run out, since searches then only use the saved catalogue |
| `running_code` | 5 min | Source files, installed packages or `.env` changed after the API or worker started, so they still run the old version |
| `search_providers` | 5 min | At least one discovery provider is configured; providers failing 3+ searches in a row; Google Custom Search's end date (2027-01-01) |
| `searxng` | 5 min | SearXNG's `/config` answers, and every engine named in the five `SEARXNG_*ENGINES` settings is enabled there |
| `searxng_engines` | 5 min | Engines that failed their last 3+ real searches, with SearXNG's reason (CAPTCHA, rate limit, timeout); failing when half the video engines are down |
| `searxng_release` | `WATCHDOG_UPDATE_HOURS` | The running SearXNG version against the newest image on Docker Hub; warning when more than 30 days older |
| `gemini` | 30 min | The key is accepted and `JUDGE_MODEL`/`GEMINI_MODEL`, the fallbacks and the scene model are still offered for `generateContent`; models failing 3+ real calls in a row (daily quota, rate limits, overload); newer models in the same line |
| `embeddings` | 60 min | When `SEMANTIC_ENABLED`, one embedding with the expected dimensions |
| `youtube_api` | 60 min | One `videos.list` call for a well-known video (1 quota unit): key rejected, API not enabled, quota used up |
| `anilist` | 30 min | The real title query for "Cowboy Bebop" (1 AniList request): an API change, refusal or rate limit |
| `browser` | 60 min | When `PAGE_RENDERS` > 0, headless Chromium starts. A missing browser build after a Playwright update is named, with the install command |
| `page_text` | 60 min | When `PAGE_TEXT_PYTHON` is set, the trafilatura helper extracts a sample page |
| `node_runtime` | `WATCHDOG_UPDATE_HOURS` | Node satisfies `engines` in `package.json`; newer releases in the same major line, with a warning for security releases |
| `packages` | 15 min | Every direct package is installed at its `package-lock.json` version, and the lockfile matches `package.json` |
| `vulnerabilities` | at most 12 h | Every locked package against npm's advisory database (the one `npm audit` uses): failing for high or critical issues |
| `package_updates` | `WATCHDOG_UPDATE_HOURS` | Newer releases of the direct packages; a new major version is a warning |

A check with its feature turned off in `.env` reports `disabled`. Checks that call a metered API take from the same daily budget as searches: 24 YouTube quota units and 48 AniList requests a day. Listing Gemini models uses no generation quota.

The search code also records what it sees. Each SearXNG engine's failures and their reason, each provider's failures, and each Gemini model's failed calls go to `provider_health`. The watchdog reads them, so a problem that only shows up under real traffic, such as a spent daily quota, is still reported.

## Statuses and alerts

Each result is `ok`, `warning` (works, but needs attention), `failing` (the dependency is not working; the summary says what that breaks) or `disabled`.

A different result only becomes the status once it repeats. Most checks need two results in a row, and checks that read local state need one. An unconfirmed result is checked again within a minute. A failing check is checked every 5 minutes (hourly for the daily checks) so recovery is noticed quickly. When an update feed such as npm, Docker Hub or nodejs.org cannot be reached, the result is a warning retried hourly, since that says nothing about the dependency itself.

On every status change the watchdog logs `dependency_status_changed` (a JSON line in the PM2 log), stores an event (kept 30 days) and, when `WATCHDOG_WEBHOOK_URL` is set, posts one message listing the changes:

```json
{"text": "ZenAtlas watchdog\nGemini models FAILING (was ok): Gemini no longer offers ...", "content": "..."}
```

Slack incoming webhooks read `text`; Discord webhooks read `content`. A restarted watchdog continues from the stored statuses and does not repeat alerts.

## Where to look

- Admin page (`/admin`): the **System health** section lists each check (worst first), the three processes' heartbeats, and whether the watchdog itself is running.
- `GET /api/admin/dependencies` (administrator token): the same report as JSON, with each check's details and the last 50 status changes. `status` is `unmonitored` when the watchdog has not reported recently.
- `GET /api/admin/health` now includes `dependencies`, the number of checks in each status.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `WATCHDOG_API_URL` | empty | API address to check; empty uses `HOST` and `PORT` (`0.0.0.0` becomes `127.0.0.1`). Set it when the watchdog runs in another container |
| `WATCHDOG_WEBHOOK_URL` | empty | Slack or Discord incoming webhook for status changes |
| `WATCHDOG_STALE_SECONDS` | 90 | A heartbeat older than this means the process has stopped (processes report every 15 seconds) |
| `WATCHDOG_QUEUE_SECONDS` | 300 | How long a search may wait for the worker before it is reported |
| `WATCHDOG_UPDATE_HOURS` | 24 | Interval for the Node, package and SearXNG update checks |

## Adding a check

Add a `Check` to `CHECKS` in `src/dependencies.ts`. Give it a name, label, category, interval and a `run` that returns an observation. Every network call goes through `env.transport`, so tests can replace it (see `tests/watchdog.test.ts`). Write each summary for the person who has to fix the problem: say what is wrong, what it breaks, and the command or setting that fixes it. Never put a credential in it.
