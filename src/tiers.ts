import { z } from 'zod';
import type { Config } from './config.js';

// Model tiers. SSJ3 is the full model architecture; SSJ1 runs the same roles (planner, Jev, judge, council, critic,
// router, query rewrite, cascade) on lower-cost models. A search carries its tier, and tierConfig gives it the settings to run
// with: every role builds its model client from the config it is handed, so no role knows about tiers. Work stored and
// shared by every search (scene analysis, transcripts, embeddings) always uses the base settings.
export const TIERS = ['ssj3', 'ssj1'] as const;
export type Tier = typeof TIERS[number];
// Missing or unknown (a typo, a retired tier in an old link) means SSJ3: a search never fails over its tier.
export const tierSchema = z.enum(TIERS).catch('ssj3');

const list = (s: string) => s.split(',').map(m => m.trim()).filter(Boolean);
// The SSJ1 models first, then SSJ3's as backups, so an SSJ1 search costs more rather than failing when one is down.
const first = (cheap: string, full: string) => [...new Set([...list(cheap), ...list(full)])].join(',');

export function tierConfig(config: Config, tier: Tier): Config {
 if (tier === 'ssj3') return config;
 return {...config, TIER: 'ssj1',
   JUDGE_MODELS: first(config.SSJ1_JUDGE_MODELS, config.JUDGE_MODELS),
   CASCADE_STRONG_MODELS: first(config.SSJ1_CASCADE_STRONG_MODELS, config.CASCADE_STRONG_MODELS),
   COUNCIL_CHECKER_MODELS: first(config.SSJ1_COUNCIL_CHECKER_MODELS, config.COUNCIL_CHECKER_MODELS),
   COUNCIL_CHAIR_MODELS: first(config.SSJ1_COUNCIL_CHAIR_MODELS, config.COUNCIL_CHAIR_MODELS),
   CRITIC_MODEL: config.SSJ1_CRITIC_MODEL, CRITIC_REVIEW_MODEL: config.SSJ1_CRITIC_REVIEW_MODEL,
   MODE_ROUTER_MODEL: config.SSJ1_MODE_ROUTER_MODEL, QUERY_REWRITE_MODEL: config.SSJ1_QUERY_REWRITE_MODEL,
   IDENTIFY_MODEL: config.SSJ1_IDENTIFY_MODEL};
}
