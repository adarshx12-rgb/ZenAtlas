import { z } from 'zod';
import type { DB } from './db.js';
import { sourcePolicy, storedPolicy } from './admin.js';

// A rule pattern is either an exact domain or a *.domain wildcard covering that domain and every subdomain.
const patternInput = z.string().min(3).max(255).trim().toLowerCase()
 .regex(/^(\*\.)?(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/,'Pattern must be a domain or a *.domain wildcard');

export function domainMatchesPattern(domain: string, pattern: string): boolean {
 if (pattern.startsWith('*.')) { const base = pattern.slice(2); return domain === base || domain.endsWith('.' + base); }
 return domain === pattern;
}

// Applying a rule only ever touches sources still at the default 'candidate' status, so it can never
// silently overwrite a human's own review (setSourcePolicy always moves status off 'candidate').
export async function setPolicyRule(db: DB, rawPattern: string, raw: unknown) {
 const pattern = patternInput.parse(rawPattern);
 const policy = sourcePolicy.parse(raw);
 return db.transaction(async tx => {
   const rule = (await tx.query(`INSERT INTO source_policy_rules(pattern,policy,review_note) VALUES($1,$2,$3)
     ON CONFLICT(pattern) DO UPDATE SET policy=$2,review_note=$3,updated_at=now() RETURNING *`,
     [pattern, JSON.stringify(policy), policy.review_note])).rows[0];
   const candidates = (await tx.query(`SELECT id,domain FROM sources WHERE status='candidate' FOR UPDATE`)).rows;
   const matched = candidates.filter(c => domainMatchesPattern(c.domain, pattern));
   for (const c of matched) {
     await tx.query(`UPDATE sources SET status=$2,policy=$3,adapter=$4,feed_url=$5,
       provenance=provenance||jsonb_build_object('auto_policy_rule',$6::text,'reviewed_at',now())
       WHERE id=$1`,[c.id,policy.status,storedPolicy(policy),policy.adapter,policy.feed_url,pattern]);
   }
   return { rule, applied_to_existing: matched.length };
 });
}

export async function listPolicyRules(db: DB) {
 return (await db.query('SELECT * FROM source_policy_rules ORDER BY pattern')).rows;
}

export async function deletePolicyRule(db: DB, rawPattern: string) {
 const pattern = rawPattern.trim().toLowerCase();
 return (await db.query('DELETE FROM source_policy_rules WHERE pattern=$1 RETURNING id',[pattern])).rows.length > 0;
}

// Longest/most specific pattern wins when more than one rule matches a domain.
export async function findMatchingRule(db: DB, domain: string) {
 const rules = (await db.query('SELECT * FROM source_policy_rules')).rows;
 const matches = rules.filter(r => domainMatchesPattern(domain, r.pattern));
 return matches.sort((a, b) => b.pattern.length - a.pattern.length)[0] ?? null;
}

// Candidates no rule has claimed, ranked by how often discovery has actually surfaced them,
// so a human only ever looks at the domains that have already proven they matter.
export async function reviewQueue(db: DB, minAppearances = 3, limit = 50) {
 return (await db.query(`SELECT id,domain,discovery_appearances,discovery_last_seen_at,created_at
   FROM sources WHERE status='candidate' AND discovery_appearances>=$1
   ORDER BY discovery_appearances DESC,discovery_last_seen_at DESC LIMIT $2`,[minAppearances,limit])).rows;
}
