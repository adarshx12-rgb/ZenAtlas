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
  SEARXNG_CATEGORIES: z.string().default('videos'),
  SEARXNG_SOURCE_ENGINES: z.string().default('google,bing'),
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
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config { return configSchema.parse(process.env); }
