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
  SEARXNG_ENGINES: z.string().default('youtube,dailymotion,odysee,bing videos,google videos,duckduckgo videos,brave.videos'),
  SEARXNG_SOURCE_ENGINES: z.string().default('google,bing'),
  SEARXNG_WEB_ENGINES: z.string().default('google,bing,brave,yahoo'),
  // Image search (see src/images.ts). Reddit and Pinterest have no SearXNG engine, but these
  // four index both, so their images still come back.
  SEARXNG_IMAGE_ENGINES: z.string().default('bing images,google images,duckduckgo images,brave.images'),
  // Extra engines that only deep dives use, chosen because ordinary searches rarely reach their sources.
  SEARXNG_DEEP_ENGINES: z.string().default('bilibili,acfun,privacywall videos,sepiasearch,wikicommons.videos'),
  SEARXNG_DEEP_WEB_ENGINES: z.string().default('yep,resulthunter,privacywall,hackernews'),
  SEARXNG_DAILY_BUDGET: number(2000, 0, 100000),
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
  SPECIALIST_SEARCHES: number(3, 0, 6),
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
  // With Brave configured it answers every search; SearXNG's standard engines fill in only when Brave fails or returns fewer results than this.
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
  // Existing YouTube captions (creator-made first, else auto-generated), fetched in the background for top results
  // without a transcript. Only caption text is read, never media. See docs/YOUTUBE_CAPTIONS.md.
  YOUTUBE_CAPTIONS: z.enum(['true','false']).default('false').transform(v => v === 'true'),
  YOUTUBE_CAPTIONS_SHORTLIST: number(5, 0, 20), YOUTUBE_CAPTIONS_DAILY_BUDGET: number(200, 0, 5000),
  // Python with the scene-worker "captions" extra; empty uses PAGE_TEXT_PYTHON.
  CAPTIONS_PYTHON: optional, YOUTUBE_CAPTIONS_PROXY: optional,
  // Used only while YouTube blocks direct caption requests; one credit per video. The free plan has 100 credits a month.
  SUPADATA_API_KEY: optional, SUPADATA_DAILY_BUDGET: number(3, 0, 10000),
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
  // Watchdog (src/watchdog-main.ts). Empty API URL: derived from HOST and PORT. The webhook receives a JSON POST
  // ({text, content}, which Slack and Discord accept) whenever a dependency's status changes.
  WATCHDOG_API_URL: z.union([z.literal(''), z.string().url()]).default(''),
  WATCHDOG_WEBHOOK_URL: z.union([z.literal(''), z.string().url()]).default(''),
  WATCHDOG_STALE_SECONDS: number(90, 30, 3600), WATCHDOG_QUEUE_SECONDS: number(300, 30, 3600),
  WATCHDOG_UPDATE_HOURS: number(24, 1, 720),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config { return configSchema.parse(process.env); }
