import type { DB } from './db.js';
export async function takeBudget(db: DB, bucket: string, limit: number, window: 'minute'|'day' = 'day'): Promise<boolean> {
 if (limit <= 0) return false;
 const result = await db.query(`INSERT INTO budgets(bucket,window_start,used) VALUES($1,date_trunc($2,now()),1)
 ON CONFLICT(bucket,window_start) DO UPDATE SET used=budgets.used+1 WHERE budgets.used<$3 RETURNING used`,[bucket,window,limit]);
 return result.rows.length > 0;
}
