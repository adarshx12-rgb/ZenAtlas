import { z } from 'zod';

const number = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const optional = z.string().default('');
export const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default('127.0.0.1'), PORT: number(3000, 1, 65535),
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:3000'),
  SESSION_SECRET: z.string().min(32).refine(v => !v.startsWith('replace-'), 'Replace the session secret'),
  ADMIN_TOKEN: z.string().min(32).refine(v => !v.startsWith('replace-'), 'Replace the admin token'),
  SEARXNG_BASE_URL: optional, SEARXNG_TOKEN: optional,
  ANSWER_ENABLED: z.enum(['true','false']).default('true').transform(v => v === 'true'),
  ANSWER_WRITER_MODELS: z.string().default('google/gemini-3.5-flash-lite'),
  ANSWER_VERIFIER_MODELS: z.string().default('mistralai/mistral-medium-3.1,anthropic/claude-haiku-4.5'),
  SSJ1_ANSWER_WRITER_MODELS: z.string().default('google/gemini-2.5-flash-lite'),
  SSJ1_ANSWER_VERIFIER_MODELS: z.string().default('google/gemini-3.5-flash-lite,anthropic/claude-haiku-4.5'),
  ANSWER_DAILY_BUDGET: number(500, 0, 100000),
  ANSWER_TIMEOUT_MS: number(45000, 1000, 120000),
  ANSWER_SOURCES: number(8, 1, 12),
  SEARXNG_ENGINES: z.string().default('youtube,dailymotion,bing videos,duckduckgo videos,brave.videos,peertube'),
  SEARXNG_SOURCE_ENGINES: z.string().default('bing,duckduckgo web'),
  SEARXNG_WEB_ENGINES: z.string().default('duckduckgo web,bing,yahoo,github,stackoverflow'),
  // Image search (see src/images.ts). Reddit and Pinterest have no SearXNG engine, but these
  // four index both, so their images still come back.
  // Chosen by judged quality (output/searxng-image-quality-*.json, 2026-10-03, 8 queries x each engine's top 6): bing 96%
  // judged good, pinterest 81%, yandex 77%. deviantart (56%), wikicommons (49%) and ipernity (43%) were dropped. The strict
  // engines count only when an image's caption has every word of the query (flickr: 53% good overall, 80% then).
  SEARXNG_IMAGE_ENGINES: z.string().default('bing images,pinterest,yandex images'),
  SEARXNG_IMAGE_STRICT_ENGINES: z.string().default('flickr'),
  // Asked only when SearXNG has fewer than SEARXNG_IMAGE_MIN usable images: duckduckgo images cools down after a few searches.
  SEARXNG_IMAGE_FALLBACK_ENGINES: z.string().default('duckduckgo images'),
  SEARXNG_IMAGE_MIN: number(5, 0, 48),
  // Extra engines that only deep dives use, chosen because ordinary searches rarely reach their sources.
  SEARXNG_DEEP_ENGINES: z.string().default('bilibili,acfun,sepiasearch,wikicommons.videos'),
  // Research and book engines the Docs tab asks with the plain query (arXiv and Semantic Scholar have their own sources).
  SEARXNG_DOC_ENGINES: z.string().default('crossref,pubmed,europepmc,openalex,openairepublications,openlibrary,wikibooks'),
  SEARXNG_DEEP_WEB_ENGINES: z.string().default('yep,resulthunter,hackernews,vuhuv,360search,bing news,duckduckgo news,wikinews'),
  SEARXNG_DAILY_BUDGET: number(2000, 0, 100000),
  // Shared per-engine pacing and a deadline including time queued behind other searches.
  SEARXNG_MIN_INTERVAL_MS: number(1000, 0, 10000), SEARXNG_SEARCH_TIMEOUT_MS: number(15000, 100, 60000),
  SEARXNG_BLOCK_COOLDOWN_SECONDS: number(86400, 60, 1296000),
  SEARXNG_RATE_COOLDOWN_SECONDS: number(3600, 60, 86400),
  // Docs tab previews (src/doc-preview.ts). The converter is LibreOffice's soffice; empty previews PDFs only.
  DOC_PREVIEW_CONVERTER: optional, DOC_PREVIEW_CACHE_DIR: optional,
  DOC_PREVIEW_MAX_MB: number(25, 1, 200), DOC_PREVIEW_CACHE_MB: number(500, 10, 100000), DOC_PREVIEW_DAILY_BUDGET: number(500, 0, 100000),
  // Pages shown in a preview; the whole document opens at its source. 0 previews every page.
  DOC_PREVIEW_PAGES: number(5, 0, 1000),
  DEEP_PLAN_SEARCHES: number(6, 1, 16), DEEP_PAGES: number(2, 1, 5), DEEP_FOLLOW_UPS: number(4, 0, 10), DEEP_ROUNDS: number(2, 1, 5),
  DEEP_RESULTS: number(40, 1, 80), DEEP_SEARCH_SECONDS: number(120, 20, 600),
  // Shared candidate pool, selected only after all launched providers finish. Display limits apply after judging.
  DISCOVERY_CANDIDATES: number(60, 50, 250),
  JEV_SCREENING_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  JEV_MODEL: z.string().regex(/^~?typesafe\/jev-[\w.-]{1,80}$/).default('typesafe/jev-1.13'),
  JEV_SCREEN_CANDIDATES: number(120, 20, 120),
  JEV_SCREEN_TIMEOUT_MS: number(8000, 500, 15000),
  JEV_SCREEN_DAILY_BUDGET: number(600, 0, 100000),
  JEV_SCREEN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  JEV_EXPLORATION_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  JEV_EXPLORATION_PAGES: number(4, 0, 8), JEV_EXPLORATION_ROUNDS: number(2, 1, 3),
  JEV_EXPLORATION_CANDIDATES: number(40, 10, 40),
  JEV_EXPLORATION_TIMEOUT_MS: number(4000, 500, 10000),
  // Document hunting (src/doc-hunt.ts): after a Docs search, Jev looks inside up to DOC_HUNT_SITES discovered websites for
  // the requested document, visiting at most DOC_HUNT_VISITS pages over DOC_HUNT_ROUNDS rounds within DOC_HUNT_TIMEOUT_MS.
  DOC_HUNT_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  DOC_HUNT_SITES: number(6, 0, 12), DOC_HUNT_VISITS: number(14, 1, 40), DOC_HUNT_ROUNDS: number(3, 1, 5),
  DOC_HUNT_TIMEOUT_MS: number(20000, 5000, 60000), DOC_HUNT_MAX_DOCS: number(8, 1, 20),
  JEV_DOC_HUNT_DAILY_BUDGET: number(400, 0, 100000),
  // Free-document sources searched directly by the Docs tab (src/doc-sources.ts); calls per day across all of them.
  DOC_SOURCES_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  DOC_SOURCES_DAILY_BUDGET: number(1500, 0, 100000), SEMANTIC_SCHOLAR_API_KEY: optional,
  // Each source's time limit: they normally answer within 1.5 s, and one stalling (Zenodo, 12 s) held up the whole Docs tab.
  DOC_SOURCES_TIMEOUT_MS: number(5000, 500, 15000),
  DEEP_SOURCES: z.enum(['0', '1']).default('0').transform(v => v === '1'),
  DEEP_SOURCES_TIMEOUT_MS: number(4000, 100, 15000),
  DEEP_SOURCES_DAILY_BUDGET: number(200, 0, 100000),
  // The Library of Congress answers API clients with a Cloudflare challenge (403, 2026-10-08): off until it serves them.
  DEEP_SOURCES_LOC: z.enum(['0', '1']).default('0').transform(v => v === '1'),
  COURTLISTENER_API_KEY: optional, DATA_GOV_API_KEY: optional, EUROPEANA_API_KEY: optional, OPENALEX_API_KEY: optional,
  SEC_USER_AGENT: z.string().max(200).refine(v => !/[\r\n]/.test(v), 'Single-line User-Agent required').default(''),
  // Public malware and phishing host lists the Docs tab checks every link against (src/safety.ts), refreshed daily.
  DOC_BLOCKLISTS: z.string().default('https://urlhaus.abuse.ch/downloads/hostfile/,https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt')
    .refine(v => v.split(',').map(s => s.trim()).filter(Boolean).every(s => /^https:\/\/\S+$/.test(s)), 'Use comma-separated https URLs'),
  JEV_EXPLORATION_DAILY_BUDGET: number(200, 0, 100000),
  JEV_EXPLORATION_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.65),
  // Shared requirements contract, evidence inspection and gap-directed exploration. false reproduces the previous
  // pipeline (the evaluation baseline); GAP_EXPLORATION=false is the ablation without gap-directed exploration.
  REQUIREMENTS_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  GAP_EXPLORATION: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  GAP_ROUNDS: number(2, 1, 4), GAP_SEARCHES: number(4, 0, 8), GAP_TARGET_RESULTS: number(3, 1, 10),
  // Page and video visits per search for gap-directed exploration (quick searches use at most half).
  JEV_EXPLORATION_VISITS: number(12, 0, 30),
  // Jev pre-judge: settles confident, evidence-backed matches; rejections stay in shadow until JEV_JUDGE_REJECT=true.
  JEV_JUDGE_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  JEV_JUDGE_REJECT: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  JEV_JUDGE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  JEV_JUDGE_CONCURRENCY: number(12, 1, 24), JEV_JUDGE_TIMEOUT_MS: number(6000, 500, 20000),
  JEV_JUDGE_DAILY_BUDGET: number(3000, 0, 100000),
  // Web tab review (src/web-review.ts): pages read within WEB_REVIEW_READ_MS; Jev removes pages below WEB_JEV_ACCURACY_MIN
  // and, unless WEB_JEV_SETTLE, forwards even confident matches to the LLM judge.
  WEB_REVIEW_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  WEB_REVIEW_READ_MS: number(15000, 2000, 30000),
  WEB_JEV_ACCURACY_MIN: z.coerce.number().min(0).max(1).default(0.3),
  WEB_JEV_SETTLE: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  // Login-free preview (src/walled.ts): previews of results from login-walled sites, from official endpoints only. Reddit
  // post text and comments need a Reddit app (client credentials); without it Reddit previews show the title only.
  WALLED_PREVIEW_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  WALLED_PREVIEW_DAILY_BUDGET: number(3000, 0, 100000),
  REDDIT_CLIENT_ID: optional, REDDIT_CLIENT_SECRET: optional,
  // Judge council (src/council.ts): a Checker from another provider re-scores the top COUNCIL_CHECK_TOP; a Chair decides
  // where the two disagree by COUNCIL_DISAGREEMENT or more. Each seat: main model first, then its fallbacks. Web and Docs
  // skip the Checker for verdicts at COUNCIL_SURE_SCORE or above. The Checker stays gpt-5.6-terra: on labelled cases
  // (2026-09-26) it scored 93-99% against gpt-5.6-luna's 70-76%, and on 2026-09-27 luna's extra disputes cost more Chair
  // calls than its lower price saved. A gap of 2 sent about a third of checked pages to the Chair.
  // Which second stage re-checks the judge (docs/superpowers/specs/2026-09-27-judge-cascade-design.md): the cascade
  // (src/cascade.ts: one Strong judge on uncertain verdicts only) or the council below. council is kept as a way back.
  JUDGE_ARCHITECTURE: z.enum(['cascade', 'council']).default('cascade'),
  // Refill round (src/refill.ts): after the Web review the planner models name what the kept results lack and write up
  // to REFILL_MAX_SEARCHES targeted searches; the new pages are reviewed and merged. One round per search.
  REFILL_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // Images tab (src/image-review.ts): the judge looks at each thumbnail in the background; Openverse adds openly licensed
  // images with their licence and attribution.
  IMAGE_REVIEW_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  OPENVERSE_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  OPENVERSE_DAILY_BUDGET: number(200, 0, 10000),
  // Brave searches images across the whole web; SearXNG leans on IMAGE_FOCUS_SITE (its results come first in SearXNG's
  // share, and a second SearXNG search names the site on SEARXNG_IMAGE_FOCUS_ENGINES). IMAGE_BRAVE_SHARE is the percent of
  // each page Brave fills; either side fills what the other could not. Empty IMAGE_FOCUS_SITE turns the focus off.
  IMAGE_BRAVE_SHARE: number(60, 0, 100),
  // The judged Images page: IMAGE_POOL images are collected from every search, Jev screens them, and the best IMAGE_JUDGE_POOL
  // (after duplicates collapse) are judged; the page shows only judged images.
  IMAGE_POOL: number(120, 24, 200), IMAGE_JUDGE_POOL: number(36, 6, 60),
  IMAGE_FOCUS_SITE: z.string().regex(/^([a-z0-9-]+\.)+[a-z]{2,}$|^$/).default('picsart.com'),
  SEARXNG_IMAGE_FOCUS_ENGINES: z.string().default('bing images,yandex images'),
  REFILL_MAX_SEARCHES: number(2, 1, 3), REFILL_TIMEOUT_MS: number(8000, 1000, 30000), REFILL_DAILY_BUDGET: number(1000, 0, 100000),
  // Cascade: the Strong judge re-judges verdicts scored CASCADE_BORDER_LOW-HIGH, in conflict with Jev's quoted evidence,
  // or above the border without a grounded quote, plus JEV_SETTLED_AUDIT_RATE of Jev's settles. gpt-5.6-terra: 93-99% on
  // labelled cases (2026-09-26); with flash-lite scoring first it scored 100% labels at 60% of the council's cost.
  // 2026-09-28: switched to gpt-6-luna (~1/20 of terra's price). 2026-09-29: terra moved last for cost, after
  // mistral-medium-3.1 (98.9% labels, $0.003 a call, p90 10 s) and claude-haiku-4.5 (97.7%, $0.0085, p90 29 s).
  // Live, luna answers a batch of five in 22 s median and often 30-34 s, so a 35 s timeout sent whole searches to fallbacks.
  CASCADE_STRONG_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('openai/gpt-6-luna,mistralai/mistral-medium-3.1,anthropic/claude-haiku-4.5,openai/gpt-5.6-terra'),
  CASCADE_STRONG_TIMEOUT_MS: number(60000, 5000, 120000), CASCADE_STRONG_DAILY_BUDGET: number(1500, 0, 100000),
  CASCADE_BORDER_LOW: number(4, 0, 10), CASCADE_BORDER_HIGH: number(7, 0, 10),
  CASCADE_INSPECTION_LIMIT: number(3, 0, 10), CASCADE_INSPECTION_MS: number(8000, 500, 30000),
  JEV_SETTLED_AUDIT_RATE: z.coerce.number().min(0).max(1).default(0.1),
  COUNCIL_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // Chosen by the 2026-09-26 seat benchmarks (scripts/council-bench.ts): gpt-5.6-terra was most accurate (99% labels, 94%
  // ordered pairs) and steady at ~7 s; mistral-medium-3.1 (another provider, cheapest of the accurate ones) and
  // gpt-5.4-mini (~4 s) follow. Luna took 19-26 s live.
  COUNCIL_CHECKER_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('openai/gpt-5.6-terra,mistralai/mistral-medium-3.1,openai/gpt-5.4-mini'),
  COUNCIL_CHECKER_TIMEOUT_MS: number(35000, 5000, 120000), COUNCIL_CHAIR_TIMEOUT_MS: number(45000, 5000, 120000),
  COUNCIL_CHAIR_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('anthropic/claude-sonnet-5,google/gemini-3.1-pro-preview'),
  COUNCIL_CHECK_TOP: number(15, 5, 30), COUNCIL_DISAGREEMENT: number(3, 1, 5), COUNCIL_SURE_SCORE: number(8, 5, 11),
  // Video searches: a wider gap before a dispute, and the Chair only for disputes among the top candidates.
  COUNCIL_VIDEO_DISAGREEMENT: number(3, 1, 5), COUNCIL_VIDEO_CHAIR_TOP: number(5, 1, 30),
  COUNCIL_CHECKER_DAILY_BUDGET: number(1500, 0, 100000), COUNCIL_CHAIR_DAILY_BUDGET: number(400, 0, 100000),
  // Mode routing (src/mode-router.ts): format words, then Jev at MODE_JEV_CONFIDENCE, then MODE_ROUTER_MODEL pick the tab a
  // new search opens on, within MODE_ROUTER_TIMEOUT_MS; otherwise videos.
  MODE_ROUTER_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  MODE_JEV_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  MODE_ROUTER_MODEL: z.string().regex(/^[\w.\/:-]{0,100}$/).default('google/gemini-3.5-flash-lite'),
  MODE_ROUTER_TIMEOUT_MS: number(3000, 200, 10000),
  MODE_ROUTER_DAILY_BUDGET: number(2000, 0, 100000),
  // Query rewriting for the Web and Docs tabs (src/query-rewrite.ts): spelling fixed, topic named, two extra searches.
  // gemini-3.5-flash-lite passed 12/12 on 2026-09-27 at ~1.2 s; cheaper models missed niche aesthetics or were too slow.
  QUERY_REWRITE_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  QUERY_REWRITE_MODEL: z.string().regex(/^[\w.\/:-]{0,100}$/).default('google/gemini-3.5-flash-lite'),
  QUERY_REWRITE_TIMEOUT_MS: number(2500, 200, 10000),
  QUERY_REWRITE_DAILY_BUDGET: number(3000, 0, 100000),
  // Images tab planner (src/image-plan.ts): pictures the answer, then writes two searches; it spends QUERY_REWRITE_DAILY_BUDGET.
  // Benchmark 2026-10-03 (output/image-plan-bench-*.json; 10 requests, the lead search's top 12 Brave images judged):
  // flash-lite 73% judged good, gpt-6-luna 48% (its searches dropped the subject's name), the light rewrite 52%.
  IMAGE_PLAN_MODEL: z.string().regex(/^[\w.\/:-]{0,100}$/).default('google/gemini-3.5-flash-lite'),
  IMAGE_PLAN_TIMEOUT_MS: number(15000, 1000, 60000),
  // Model tiers (src/tiers.ts). TIER is set per search by tierConfig, never in .env. SSJ1_* are the lower-cost models
  // SSJ1 puts first; SSJ3's own models follow them as backups (chosen 2026-09-27, see docs/superpowers/specs).
  TIER: z.enum(['ssj3', 'ssj1']).default('ssj3'),
  SSJ1_JUDGE_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('google/gemini-2.5-flash-lite'),
  // SSJ1 Strong judge: gemini-3.5-flash-lite (97-98% labels, ~5 s, $0.005 a call on 2026-09-26), a step above SSJ1's
  // gemini-2.5-flash-lite Scorer; claude-haiku-4.5 (98%) behind it, then SSJ3's list.
  SSJ1_CASCADE_STRONG_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('google/gemini-3.5-flash-lite,anthropic/claude-haiku-4.5'),
  SSJ1_COUNCIL_CHECKER_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('openai/gpt-5.6-luna'),
  SSJ1_COUNCIL_CHAIR_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default('anthropic/claude-haiku-4.5'),
  SSJ1_CRITIC_MODEL: z.string().regex(/^[\w.\/:-]{1,100}$/).default('anthropic/claude-haiku-4.5'),
  SSJ1_CRITIC_REVIEW_MODEL: z.string().regex(/^[\w.\/:-]{1,100}$/).default('anthropic/claude-haiku-4.5'),
  SSJ1_MODE_ROUTER_MODEL: z.string().regex(/^[\w.\/:-]{0,100}$/).default('openai/gpt-4.1-nano'),
  SSJ1_QUERY_REWRITE_MODEL: z.string().regex(/^[\w.\/:-]{0,100}$/).default('openai/gpt-4.1-nano'),
  SPECIALIST_SEARCHES: number(3, 0, 6),
  // Field routing (src/field-routing.ts): each search names its field and up to FIELD_ROUTING_SITES specialist sites to
  // search alongside the open web; off until the field evaluation (scripts/field-eval.ts) shows it helps.
  FIELD_ROUTING_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  FIELD_ROUTING_SITES: number(2, 0, 4),
  ARCHIVE_DISCOVERY: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  ARCHIVE_COLLECTIONS: z.string().default('prelinger,ephemera').refine(v =>
    v.split(',').length <= 20 && v.split(',').every(s => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(s.trim())), 'Use comma-separated archive collection identifiers'),
  LIBRARY_OF_CONGRESS_DISCOVERY: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  ARCHIVE_DAILY_BUDGET: number(200, 0, 10000),
  UNDERRATED_MAX_VIEWS: number(50000, 0, 1000000000),
  PLAN_SEARCHES: number(4, 1, 8), PAGE_CHECKS: number(20, 0, 40), PAGE_TIMEOUT_MS: number(6000, 1000, 20000), PDF_MAX_BYTES: number(15*1024*1024, 1024*1024, 50*1024*1024),
  PAGE_RENDERS: number(0, 0, 20), PAGE_RENDER_TIMEOUT_MS: number(12000, 3000, 30000), PAGE_TEXT_PYTHON: optional,
  JUDGE_CANDIDATES: number(30, 1, 50),
  GOOGLE_SEARCH_API_KEY: optional, GOOGLE_SEARCH_ENGINE_ID: optional, BRAVE_SEARCH_API_KEY: optional,
  PROVIDER_TIMEOUT_MS: number(5000, 100, 15000), DISCOVERY_RESULTS: number(20, 1, 50),
  DISCOVERY_DAILY_BUDGET: number(100, 0, 10000),
  // Brave is a metered API, so it has its own daily limit rather than sharing DISCOVERY_DAILY_BUDGET, which also caps
  // discovery jobs, Reddit lookups and scheduled collections.
  BRAVE_DAILY_BUDGET: number(250, 0, 100000),
  // Retained for compatibility with existing environments; parallel retrieval no longer uses this threshold.
  BRAVE_MIN_RESULTS: number(10, 1, 20), COVERAGE_MIN_RESULTS: number(5, 1, 100),
  COVERAGE_MIN_SOURCES: number(1, 1, 20),
  COVERAGE_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.03),
  SEARCH_TTL_SECONDS: number(1800, 60, 3600), DISCOVERY_CACHE_SECONDS: number(600, 60, 3600),
  SOURCE_REFRESH_HOURS: number(24, 1, 720),
  SOURCE_HEALTH_HOURS: number(6, 1, 168), SOURCE_HEALTH_RETRY_MINUTES: number(15, 1, 1440),
  SOURCE_HEALTH_FAILURES: number(3, 2, 10), SOURCE_HEALTH_DAILY_BUDGET: number(1000, 0, 100000),
  // Unreviewed candidate domains number in the thousands, so they are only looked at this often, whatever the outcome.
  SOURCE_HEALTH_CANDIDATE_HOURS: number(168, 1, 720),
  EMBEDDING_URL: optional, EMBEDDING_TOKEN: optional, EMBEDDING_MODEL: optional,
  EMBEDDING_DIMENSIONS: number(384, 1, 2000), EMBEDDING_DAILY_BUDGET: number(100, 0, 10000),
  SEMANTIC_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  YOUTUBE_API_KEY: optional, YOUTUBE_DAILY_UNITS: number(3000, 0, 1000000),
  SIGNAL_VIDEOS: number(25, 1, 100), SIGNAL_COMMENTS: number(100, 1, 300),
  VIDEO_EVIDENCE_CHECKS: number(12, 0, 40),
  SCENE_AUTO_QUEUE: z.enum(['true','false']).default('true').transform(v => v === 'true'),
  SCENE_SHORTLIST: number(3, 0, 10),
  SCENE_SEARCH_LIMIT: number(2, 0, 3), SCENE_VERIFY_MS: number(90000, 1000, 300000),
  SCENE_AUTO_DAILY_JOBS: number(20, 0, 10000),
  // Watch requests start scene analysis right after screening (src/scene-early.ts); false waits for judging as before.
  SCENE_EARLY: z.enum(['true','false']).default('true').transform(v => v === 'true'),
  // Transcript-guided scene analysis (src/scene-window.ts): videos at least SCENE_WINDOW_MIN_SECONDS long whose transcript
  // Jev ties to the moment (confidence >= SCENE_WINDOW_CONFIDENCE) are analysed around that chunk, +-SCENE_WINDOW_PAD_SECONDS.
  SCENE_WINDOW_MIN_SECONDS: number(600, 60, 7200), SCENE_WINDOW_PAD_SECONDS: number(60, 0, 600),
  SCENE_WINDOW_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6), SCENE_WINDOW_DAILY_BUDGET: number(300, 0, 10000),
  // Existing YouTube captions (creator-made first, else auto-generated), fetched in the background for top results
  // without a transcript. Only caption text is read, never media. See docs/YOUTUBE_CAPTIONS.md.
  YOUTUBE_CAPTIONS: z.enum(['true','false']).default('false').transform(v => v === 'true'),
  YOUTUBE_CAPTIONS_SHORTLIST: number(5, 0, 20), YOUTUBE_CAPTIONS_DAILY_BUDGET: number(200, 0, 5000),
  // Python with the scene-worker "captions" extra; empty uses PAGE_TEXT_PYTHON.
  CAPTIONS_PYTHON: optional, YOUTUBE_CAPTIONS_PROXY: optional,
  // Link building (docs/superpowers/specs/2026-09-29-link-building-design.md). Video searches fetch captions for up to
  // LINK_CAPTIONS candidates in link-potential order (none below LINK_MIN_POTENTIAL) within LINK_CAPTIONS_MS, give the
  // judge each transcript in full up to LINK_TRANSCRIPT_CHARS (batches split at LINK_BATCH_CHARS of transcript), and
  // search once more before judging when fewer than LINK_STRONG_MIN candidates look strong.
  LINK_MIN_POTENTIAL: z.coerce.number().min(0).max(1).default(0.25),
  LINK_CAPTIONS: number(10, 0, 30), LINK_CAPTIONS_MS: number(20000, 2000, 60000),
  LINK_TRANSCRIPT_CHARS: number(24000, 2400, 100000), LINK_BATCH_CHARS: number(60000, 10000, 400000),
  LINK_STRONG_MIN: number(2, 0, 10), LINK_EXPANSION_SEARCHES: number(4, 0, 8), LINK_UPLOAD_SCAN: number(1000, 0, 5000),
  // Used only while YouTube blocks direct caption requests; one credit per video. The free plan has 100 credits a month.
  SUPADATA_API_KEY: optional, SUPADATA_DAILY_BUDGET: number(3, 0, 10000), SUPADATA_PER_MINUTE: number(30, 1, 600),
  OFFICIAL_YOUTUBE_CHANNELS: optional,
  REDDIT_SIGNALS: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // No key needed: a public AniList lookup gives the planner and judge an anime's official titles, synonyms and
  // details when the query confidently matches one, so search terms and relevance checks use the real title.
  ANILIST_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // A query naming only characters, not the show, can cost up to 7 AniList requests; a self-hosted, no-cost API
  // budgets more generously than paid providers.
  ANILIST_DAILY_BUDGET: number(2000, 0, 100000),
  GEMINI_API_KEY: optional, GEMINI_MODEL: z.string().regex(/^[\w.-]{1,100}$/).default('gemini-3.8-flash'),
  JUDGE_MODEL: z.string().regex(/^[\w.-]{0,100}$/).default(''),
  JUDGE_FALLBACK_MODELS: z.string().regex(/^[\w.,\s-]*$/).default(''),
  JUDGE_BATCH_SIZE: number(30, 1, 50),
  JUDGE_THINKING_LEVEL: z.enum(['model_default', 'minimal', 'low', 'medium', 'high']).default('low'),
  JUDGE_DAILY_BUDGET: number(200, 0, 100000), JUDGE_TIMEOUT_MS: number(20000, 1000, 60000),
  // Models that rank results, on the OpenAI-compatible endpoint, tried in order. Comma-separated
  // OpenRouter ids. They must accept images: website candidates are judged partly on a screenshot.
  // Empty leaves judging to Gemini.
  JUDGE_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default(''),
  // Learning loop: after each discovery search a critic model audits it (on the OpenRouter key), and once a week a
  // reviewer re-checks a sample of those audits. An audit spends at most two critic calls; the budget counts calls.
  CRITIC_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  CRITIC_MODEL: z.string().regex(/^[\w.\/:-]{1,100}$/).default('anthropic/claude-sonnet-5'),
  CRITIC_REVIEW_MODEL: z.string().regex(/^[\w.\/:-]{1,100}$/).default('anthropic/claude-sonnet-5'),
  CRITIC_DAILY_BUDGET: number(40, 0, 10000), CRITIC_TIMEOUT_MS: number(120000, 10000, 600000),
  CRITIC_PROBES: number(3, 0, 5), TRACE_RETENTION_DAYS: number(90, 1, 3650),
  // An OpenAI-compatible model endpoint (OpenRouter by default), used alongside Gemini. Nothing calls it until a
  // model names it, so an empty OPENROUTER_API_KEY leaves behaviour unchanged. An empty base URL means the default.
  OPENROUTER_BASE_URL: z.string().url().or(z.literal('')).default('https://openrouter.ai/api/v1')
    .transform(v => v || 'https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: optional,
  OPENROUTER_SITE_URL: z.string().url().or(z.literal('')).default(''),
  OPENROUTER_SITE_NAME: optional,
  // Models that plan searches, on the OpenAI-compatible endpoint: the first leads and the rest assist it.
  // Comma-separated OpenRouter ids, so slashes and colons are allowed. Empty leaves planning to Gemini.
  PLANNER_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default(''),
  // An assist must not hold up a search, so it is dropped when it does not answer within this; well under
  // JUDGE_TIMEOUT_MS, because a free model can hang for a minute.
  PLANNER_ASSIST_TIMEOUT_MS: number(6000, 500, 30000),
  // Models that draft a search's requirements contract, within PLANNER_ASSIST_TIMEOUT_MS. Empty: QUERY_REWRITE_MODEL.
  CONTRACT_MODELS: z.string().regex(/^[\w.,\/:\s-]*$/).default(''),
  // Hours the same request keeps its plan and requirements contract (0 plans every search afresh).
  PLAN_CACHE_HOURS: number(24, 0, 168),
  // Hours a final judge verdict is reused for the same request, judge setup and evidence (0 judges every search afresh).
  VERDICT_CACHE_HOURS: number(24, 0, 168),
  // Watchdog (src/watchdog-main.ts). Empty API URL: derived from HOST and PORT. The webhook receives a JSON POST
  // ({text, content}, which Slack and Discord accept) whenever a dependency's status changes.
  WATCHDOG_API_URL: z.union([z.literal(''), z.string().url()]).default(''),
  WATCHDOG_WEBHOOK_URL: z.union([z.literal(''), z.string().url()]).default(''),
  WATCHDOG_STALE_SECONDS: number(90, 30, 3600), WATCHDOG_QUEUE_SECONDS: number(300, 30, 3600),
  WATCHDOG_UPDATE_HOURS: number(24, 1, 720),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config { return configSchema.parse(process.env); }
