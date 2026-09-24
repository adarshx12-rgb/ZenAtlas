# Niche-first search — design

The user specified this on 2026-09-22. It is **not implemented**: the user will implement it
after their weekly limit resets. The source data is `data/niche-sources.json` (draft: 58 niches,
190 sites, 69 YouTube channels, all checked live on 2026-09-22).

## Goal

The engine must cover every field across its web, video and image tabs. For ordinary searches,
serve results from a curated set of top sites for the search's niche. Run the regular planned
search only when those sites don't produce enough confident results. This saves planner calls,
provider queries and judge calls on ordinary searches.

**Deep search is never limited.** It runs everything (see below).

## How a search flows

### Quick and auto searches

1. **Catalogue first, unchanged.** Discovery runs only when the local catalogue has fewer than
   `COVERAGE_MIN_RESULTS` strong results (`src/search.ts:77`).
2. **Skip niche-first** and run the regular discovery when any of these apply:
   - the search is discovery-style (fix 1);
   - no niche matches confidently (fix 3);
   - the matched niche has no entries in the search's language (fix 10);
   - the query contains its own `site:`;
   - `NICHE_FIRST` is not `on`.
3. **Niche lane.** For each matched niche (at most `NICHE_MAX_NICHES`, default 3), search that
   niche's sites for the tab being searched, in rank order (fix 8). The existing judge scores the
   results.
4. **Enough confident results: serve them and stop.** "Confident" is the bar that already decides
   what is shown: judge relevance 6 or higher with every intent check supported
   (`src/signals.ts:316`). "Enough" is `NICHE_MIN_RESULTS` (default: the same as
   `COVERAGE_MIN_RESULTS`, 5). Images use a different rule (fix 2).
5. **Otherwise run the regular discovery and merge.**
   - The niche lane's queries are passed to the planner as `avoid`.
   - Niche results already judged are kept and not judged again.
   - Partial niche results are merged with the regular results, never discarded.

### Deep searches: go all in

- **The regular deep pipeline runs in full:** planner, archives, specialists, follow-up rounds and
  every engine.
- **The niche lane runs alongside it:**
  - every matched niche (no cap, with the lower deep match threshold);
  - every site in each niche's list for the tab;
  - YouTube channel searches for the matched niches' channels (fix 5).
- **No early stop and no discovery-style bypass.** Everything is merged and judged together.
- **Daily budgets still apply.** A lane whose budget is exhausted reports `budget_exhausted` as
  it does today.

## Fixes for each known weakness

### 1. Discovery-style searches would favour mainstream sites

The engine's purpose includes finding "material that ordinary searches miss". Niche-first would
serve the biggest sites and stop.

- **Quick mode skips niche-first** when the query signals discovery. Initial terms: underrated,
  hidden gem(s), lesser-known, little-known, obscure, rare, niche, indie, independent, unknown,
  overlooked, forgotten, underground, alternative(s) to, similar to, inspiration, examples of,
  unusual, weird, deep cuts.
- **The terms live in the data file** as top-level `discovery_terms`, so they can grow without a
  code change.
- **The trace records the bypass reason.**
- **Deep mode** already searches everything, so it needs no bypass.

### 2. The "enough results" threshold

- **Only confident results count.** "Possible match" results (unverified quotes, capped at 5) and
  Closest-match results (scores 3–5) don't.
- **Per-tab minimums:**
  - web and videos: `NICHE_MIN_RESULTS` (5);
  - images: `NICHE_MIN_IMAGES` (default 24, half of a 48-result page). Image search is never
    judged (`src/images.ts`), so this counts niche-site images returned.
- **Automatic demotion of niches that keep falling back.** Say a niche falls back on more than
  `NICHE_DEMOTE_RATE` (default 70%) of its last `NICHE_DEMOTE_WINDOW` (default 50) quick searches.
  - It switches to **lane-only**: the niche lane runs alongside the regular search with no early
    stop.
  - It is flagged on the admin page.
  - This caps the double-cost case to niches where niche-first actually helps.
- **Worst-case cost** of a search that falls back is today's cost plus one small niche pass: at
  most one query per site in the niche, and judging at most `JUDGE_BATCH_SIZE` extra candidates.

### 3. Matching searches to niches

**Primary matcher: embeddings** (`src/embeddings.ts`).
- Embed each niche's `name` and `covers` once, and cache the result. Re-embed only when the data
  file changes.
- Embed the whole query once per search, cached by `contentHash`. The whole query gives the
  context that settles ambiguity: "python list comprehension" versus "python shedding skin".
- **Budget:** `EMBEDDING_DAILY_BUDGET` is 100 today, which is too low for one embedding per
  search. Raise it, or let the keyword matcher take over once it is spent.

**Match rule.**
- A niche matches when cosine similarity is at least `NICHE_MATCH_THRESHOLD`. Deep mode uses
  `NICHE_MATCH_THRESHOLD_DEEP`, which is lower.
- Several niches within `NICHE_MATCH_MARGIN` of the best all match. This is how searches that span
  niches work, e.g. "nutrition for runners" or "AI in radiology".
- In quick mode, if more niches match than `NICHE_MAX_NICHES`, the search is too broad: skip
  niche-first.
- Tune all of these on `evaluation/real-queries.json`; don't guess them.

**Negative phrases per niche.** A new `not_for` field lists phrases a niche must not take. For
example, medicine: "medical dramas, doctor memes, hospital TV shows". If the query is closer to a
niche's `not_for` phrases than to its `covers`, the niche is rejected. This handles searches with
the right topic but the wrong intent.

**Keyword fallback** (embeddings unconfigured, failing or out of budget).
- Match on a new per-niche `keywords` field.
- Words listed in the top-level `ambiguous_terms` count only alongside a second keyword from the
  same niche. Examples: python, java, jaguar, mercury, apple, ruby, rust, shell, swift, crane,
  bass, mouse, virus, cookies.

**Misroutes stay visible.** The trace records the matched niches with their similarity scores, so
the critic's audit can catch a wrong match.

### 4. The diversity rule and the "routes never boost" principle

- **Niche membership never changes a result's score.** It decides only which searches run first
  and when to stop. The scoring principle at `src/specialists.ts:8` ("never confer trust or boost
  a result's score") stays true. Update that comment and `docs/DISCOVERY_QUALITY.md` to say this
  explicitly.
- **The same-site penalty in `rankDiscovery` (`src/ranking.ts`) would fight a page filled from 2–3
  sites.** For niche-lane results in quick mode, replace it with a per-site cap,
  `NICHE_MAX_PER_SITE` (default 4). Three sites can fill a page; one site can't take all of it.
- **Deep mode keeps the normal penalty**, since many more sources are in play.

### 5. YouTube channels

**Match channels by ID, never by handle.**
- Resolve each handle once to its channel ID and store it in the data file as `channel_id`. Use
  `channels.list?forHandle=`, which costs 1 unit.
- Handles can be taken by lookalikes: `@RickStevesEurope` is a 29-subscriber lookalike of
  `@RickStevesEuropeOfficial`.
- The watchdog re-checks that each ID still resolves and that the channel name is unchanged.

**Quick mode spends no YouTube quota.**
- Search SearXNG's YouTube engine with the query plus the channel name, and keep results from that
  channel. Confirm SearXNG returns the channel name.
- A YouTube result from any lane whose `channelId` belongs to a matched niche's channel counts
  toward "enough results". The channel ID already comes back from `YouTubeData.videos`, at no
  extra cost.
- Such results may show an "Official channel" label. The label is display-only, never a score
  change.

**Deep mode uses the YouTube API.**
- One `search.list?channelId=` call per matched channel, at 100 units each.
- These come from a separate budget, `NICHE_YOUTUBE_DAILY_UNITS`, so channel searches can't starve
  the video-detail lookups that share `YOUTUBE_DAILY_UNITS`.

### 6. Sites that block automated requests

- **Never bypass bot protection**, matching the engine's stance on CAPTCHAs and rate limits.
- **Per-entry `page_check: false`** for sites that refuse the page renderer. The judge then checks
  against the title and snippet, which it already accepts as quote sources (`src/judge.ts:53`).
- **The initial candidates are Appendix A.** Confirm them with the Playwright renderer first, since
  it may read some that a plain request couldn't.
- **The watchdog tracks page-check success per site.** A site that starts failing has page checks
  switched off automatically and is flagged.
- **Later, not v1:** an official-API adapter could replace the snippet for blocked sites that offer
  one (Stack Exchange, Wikipedia, the Met).

### 7. Paywalls

- **Per-entry `access`**, one of:
  - `free`;
  - `metered`: some free reads;
  - `subscription`;
  - `paid_licence`: free to browse, paid to use (stock media and music).
- **Results show a label** for everything except `free`.
- **An optional "free to open" filter** hides `subscription` results. It is off by default.
- **No effect on ranking.**

### 8. How search providers handle `site:`

**A capability table per provider** records support for `site:`, for `OR` across several sites,
and for `site:` with a path.
- Confirm the table live after the reset: Brave, Google, and each SearXNG engine in
  `SEARXNG_ENGINES` and `SEARXNG_IMAGE_ENGINES`.
- The watchdog re-probes weekly, checking that returned URLs are actually on the requested site.

**Querying:**
- Where `OR` works, one query covers a niche's sites.
- Otherwise, query sites in rank order and stop once there are enough results. The ranks then
  decide the spend.
- Path entries (`bbc.com/sport`, `nytimes.com/wirecutter`, `vogue.com/fashion-shows`,
  `medlineplus.gov/druginfo`, `pixabay.com/music`, `bbc.com/news`, `bbc.com/sport/football`) use
  `site:domain/path` where supported. Otherwise they use `site:domain` and filter results by path.
- Off-site results from an engine that ignored `site:` are kept as ordinary results. They are never
  counted as niche results.

**Budgets and images.**
- Queries count against the existing provider budgets (`BRAVE_DAILY_BUDGET` and the others).
- The image niche lane goes through `SEARXNG_IMAGE_ENGINES` with `site:`. Engines that ignore
  `site:` are left out of that lane.

### 9. Upkeep

**Where things live.** The reviewed source of truth is `data/niche-sources.json`, versioned in
git. Runtime statistics go in the database.

**Watchdog check "niche sources", daily:**
- sites: DNS plus HTTP, where 401, 403 and 429 count as alive;
- channels: the ID still resolves and the name is unchanged.

**Re-ranking from the engine's own results.**
- Learning loop step 1 already records every admitted candidate with the judge's verdict. From
  that, compute each site's relevant share per niche over a rolling 30 days.
- Monthly, propose re-ranks within each niche. Flag sites below a floor for review.
- Proposals appear on the admin page. Nothing is reordered or removed without approval.
- This is the niche part of learning loop step 2 (`docs/LEARNING.md`). Build it once and share it.

**Growing the list.**
- The critic's `missing_sources` findings that pass their `site:` probe become proposed additions
  to that niche.
- Searches that matched no niche are logged and clustered weekly into proposed new niches.

### 10. Language and region

- **Entries get `language`** (default `en`) and an optional `region`. `region: "IN"` is already
  set on three entries.
- **Niche-first runs only when the niche has entries in the search's language.** Otherwise the
  search goes straight to regular discovery, so a Hindi query isn't served English sites.
- **Region-specific entries rank first** when the search's region matches. That needs a region
  setting; today the engine only has language.
- **Other languages are added** through the proposal flow in fix 9.

## Data file changes

Add to `data/niche-sources.json`:
- **Top level:** `discovery_terms`, `ambiguous_terms`.
- **Per niche:** `keywords`, `not_for`.
- **Per entry:** `access`, `page_check`, `language`, and `channel_id` for YouTube entries.

`status` moves from `draft` to `reviewed` once the user has reviewed the ranks.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `NICHE_FIRST` | `off` | `off`, `shadow` (run and record, serve nothing) or `on` |
| `NICHE_MAX_NICHES` | 3 | Niches per quick search |
| `NICHE_MIN_RESULTS` | 5 | Confident results that end a quick web or video search |
| `NICHE_MIN_IMAGES` | 24 | Niche images that end a quick image search |
| `NICHE_MAX_PER_SITE` | 4 | Per-site cap for niche results in quick mode |
| `NICHE_MATCH_THRESHOLD`, `NICHE_MATCH_THRESHOLD_DEEP`, `NICHE_MATCH_MARGIN` | tuned | Niche matching |
| `NICHE_DEMOTE_RATE`, `NICHE_DEMOTE_WINDOW` | 0.7, 50 | Automatic demotion to lane-only |
| `NICHE_YOUTUBE_DAILY_UNITS` | set at implementation | YouTube budget for deep-mode channel searches |

## Trace additions

Record for every search:
- matched niches with their similarity scores;
- the bypass reason;
- the niche queries run;
- the niche lane's confident-result count;
- whether fallback ran;
- judge calls and provider queries split by lane.

## Proving it before it becomes the default

1. **Shadow mode** (`NICHE_FIRST=shadow`). The niche lane runs alongside the regular search and
   records what it would have served. This measures hit and fallback rates on real traffic.
2. **Replay `evaluation/real-queries.json`** with and without niche-first, as the relevance-v4 A/B
   did. That test is the warning here: precision rose from about 33% to 76%, but relevant results
   fell from 40 to 13.

   Proposed gates for `on` (the user can adjust them):
   - relevant results found fall by no more than 10%;
   - no graded query drops to zero results;
   - judge calls per quick search fall by at least 30%.
3. **The critic keeps auditing** live traffic after launch.

## Out of scope for v1

- Blocking NSFW, piracy, malware and scam sites (parked by the user on 2026-09-22).
- Official-API adapters for blocked sites.
- Instant-answer cards.
- The Wikipedia and Wikidata knowledge layer.

## To confirm after the reset

- `site:`, `OR` and path support per provider and engine.
- Which Appendix A sites the Playwright renderer can read.
- Channel IDs for all 69 handles.
- Whether SearXNG's YouTube engine returns the channel name.
- The matching thresholds and minimums, tuned on the graded query set.
- Whether the web tab's providers are the same as video discovery's.

## Appendix A — sites that refused a plain request on 2026-09-22

The status is the response to a plain browser-like `fetch`. These sites are live, but page checks
may fail on them.

- **403:** britannica.com, verywellmind.com, exrx.net, math.stackexchange.com, allaboutbirds.org,
  extension.umn.edu, stackoverflow.com, alternativeto.net, notebookcheck.net,
  electronics.stackexchange.com, polycount.com, artstation.com, shutterstock.com, pond5.com,
  pexels.com, artlist.io, pixabay.com/music, premiumbeat.com, shotdeck.com, gamefaqs.gamespot.com,
  pcgamingwiki.com, smarthistory.org, artic.edu, loc.gov, britishpathe.com, europeana.eu,
  tripadvisor.com, seriouseats.com, allrecipes.com, investopedia.com, coingecko.com, justia.com,
  apnews.com, sports-reference.com, fbref.com, basketball-reference.com, edmunds.com,
  merriam-webster.com, dictionary.cambridge.org, indeed.com, glassdoor.com,
  nytimes.com/wirecutter, dezeen.com, allmusic.com, discogs.com, genius.com, gearspace.com
- **429:** examine.com, metmuseum.org
- **401:** unsplash.com, reuters.com
- **406:** radiopaedia.org
- **202 (challenge page):** sciencephoto.com, dribbble.com
