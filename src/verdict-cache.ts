import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import type { Verdict } from './judge.js';

// Verdict memory: the final verdict for one candidate (after the Strong-judge stage) is kept for VERDICT_CACHE_HOURS and
// reused by a repeat search when the request, its contract, the judge setup, the address and the evidence the judge saw
// are all the same. A video otherwise moved 1-2 points between identical searches depending on which other videos shared
// its judging batch. New evidence (captions, scenes, comments, a page change) has a new fingerprint and is judged afresh.

export interface KeyParts { tier: string; version: string; models: string; request: string; contract: string; url: string; fingerprint: string }
export function verdictKey(p: KeyParts): string {
 const request = p.request.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
 return createHash('sha256').update(JSON.stringify([p.tier, p.version, p.models, request, p.contract, p.url, p.fingerprint])).digest('hex');
}

// Moment keys carry the run's candidate key ("r3m1"); stored relative ("m1") and given the new key on reuse.
export const portable = (v: Verdict): Verdict => ({...v, momentKeys: v.momentKeys.map(k => k.startsWith(v.key) ? k.slice(v.key.length) : k)});
export const restore = (v: Verdict, key: string): Verdict => ({...v, key, momentKeys: v.momentKeys.map(k => /^m\d+$/.test(k) ? `${key}${k}` : k)});

export async function recallVerdicts(db: DB, keys: string[]): Promise<Map<string, {verdict: Verdict; model: string}>> {
 if (!keys.length) return new Map();
 const rows = (await db.query(`SELECT key,verdict,model FROM judge_verdicts WHERE key=ANY($1::text[]) AND expires_at>now()`, [keys])).rows;
 return new Map(rows.map(r => [r.key, {verdict: r.verdict as Verdict, model: r.model}]));
}

// One statement for the whole batch; a newer verdict for the same key replaces the old one.
export async function rememberVerdicts(db: DB, entries: {key: string; verdict: Verdict; model: string}[], hours: number): Promise<void> {
 if (!entries.length || hours <= 0) return;
 await db.query(`INSERT INTO judge_verdicts(key,verdict,model,expires_at)
   SELECT e.key, e.verdict, e.model, now() + make_interval(hours => $2) FROM jsonb_to_recordset($1::jsonb) AS e(key text, verdict jsonb, model text)
   ON CONFLICT (key) DO UPDATE SET verdict=excluded.verdict, model=excluded.model, created_at=now(), expires_at=excluded.expires_at`,
   [JSON.stringify(entries), hours]);
 // Now and then, clear what has expired (the expiry index keeps this cheap).
 if (Math.random() < 0.05) await db.query('DELETE FROM judge_verdicts WHERE expires_at<now()').catch(() => {});
}
