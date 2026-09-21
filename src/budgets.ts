import type { DB } from './db.js';
import type { Config } from './config.js';
export async function takeBudget(db: DB, bucket: string, limit: number, window: 'minute'|'day' = 'day'): Promise<boolean> {
 if (limit <= 0) return false;
 const result = await db.query(`INSERT INTO budgets(bucket,window_start,used) VALUES($1,date_trunc($2,now()),1)
 ON CONFLICT(bucket,window_start) DO UPDATE SET used=budgets.used+1 WHERE budgets.used<$3 RETURNING used`,[bucket,window,limit]);
 return result.rows.length > 0;
}
// The daily limit for a search provider's `discovery:<name>` bucket. SearXNG is self-hosted and Brave has its own
// setting; every other provider shares DISCOVERY_DAILY_BUDGET. Both places that spend the bucket must use this,
// or the one with the lower limit would starve the other.
export function providerBudget(config: Config, provider: string): number {
 return provider === 'searxng' ? config.SEARXNG_DAILY_BUDGET : provider === 'brave' ? config.BRAVE_DAILY_BUDGET : config.DISCOVERY_DAILY_BUDGET;
}
