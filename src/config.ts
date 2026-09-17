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
  SEARXNG_ENGINES: z.string().default('youtube,dailymotion,sepiasearch,odysee,bing videos,google videos,duckduckgo videos,brave.videos,wikicommons.videos'),
  SEARXNG_SOURCE_ENGINES: z.string().default('google,bing'),
  SEARXNG_WEB_ENGINES: z.string().default('google,bing,brave,yahoo'),
  // Extra engines that only deep dives use, chosen because ordinary searches rarely reach their sources.
  SEARXNG_DEEP_ENGINES: z.string().default('bilibili,acfun,privacywall videos'),
  SEARXNG_DEEP_WEB_ENGINES: z.string().default('yep,resulthunter,privacywall,hackernews'),
  SEARXNG_DAILY_BUDGET: number(2000, 0, 100000),
  DEEP_PLAN_SEARCHES: number(6, 1, 16), DEEP_PAGES: number(2, 1, 5), DEEP_FOLLOW_UPS: number(4, 0, 10), DEEP_ROUNDS: number(2, 1, 5),
  DEEP_RESULTS: number(40, 1, 80), DEEP_SEARCH_SECONDS: number(120, 20, 600),
  UNDERRATED_MAX_VIEWS: number(50000, 0, 1000000000),
  PLAN_SEARCHES: number(4, 1, 8), PAGE_CHECKS: number(20, 0, 40), PAGE_TIMEOUT_MS: number(6000, 1000, 20000),
  PAGE_RENDERS: number(0, 0, 20), PAGE_RENDER_TIMEOUT_MS: number(12000, 3000, 30000), PAGE_TEXT_PYTHON: optional,
  JUDGE_CANDIDATES: number(30, 1, 50),
  GOOGLE_SEARCH_API_KEY: optional, GOOGLE_SEARCH_ENGINE_ID: optional, BRAVE_SEARCH_API_KEY: optional,
  PROVIDER_TIMEOUT_MS: number(5000, 100, 15000), DISCOVERY_RESULTS: number(20, 1, 50),
  DISCOVERY_DAILY_BUDGET: number(100, 0, 10000), COVERAGE_MIN_RESULTS: number(5, 1, 100),
  COVERAGE_MIN_SOURCES: number(1, 1, 20),
  COVERAGE_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.03),
  SEARCH_TTL_SECONDS: number(1800, 60, 3600), DISCOVERY_CACHE_SECONDS: number(600, 60, 3600),
  SOURCE_REFRESH_HOURS: number(24, 1, 720),
  SOURCE_HEALTH_HOURS: number(6, 1, 168), SOURCE_HEALTH_RETRY_MINUTES: number(15, 1, 1440),
  SOURCE_HEALTH_FAILURES: number(3, 2, 10), SOURCE_HEALTH_DAILY_BUDGET: number(1000, 0, 100000),
  EMBEDDING_URL: optional, EMBEDDING_TOKEN: optional, EMBEDDING_MODEL: optional,
  EMBEDDING_DIMENSIONS: number(384, 1, 2000), EMBEDDING_DAILY_BUDGET: number(100, 0, 10000),
  SEMANTIC_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  YOUTUBE_API_KEY: optional, YOUTUBE_DAILY_UNITS: number(3000, 0, 1000000),
  SIGNAL_VIDEOS: number(10, 1, 25), SIGNAL_COMMENTS: number(100, 1, 100),
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
  // Watchdog (src/watchdog-main.ts). Empty API URL: derived from HOST and PORT. The webhook receives a JSON POST
  // ({text, content}, which Slack and Discord accept) whenever a dependency's status changes.
  WATCHDOG_API_URL: z.union([z.literal(''), z.string().url()]).default(''),
  WATCHDOG_WEBHOOK_URL: z.union([z.literal(''), z.string().url()]).default(''),
  WATCHDOG_STALE_SECONDS: number(90, 30, 3600), WATCHDOG_QUEUE_SECONDS: number(300, 30, 3600),
  WATCHDOG_UPDATE_HOURS: number(24, 1, 720),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config { return configSchema.parse(process.env); }
