// How much of the transcript evidence reaches the judge (docs/superpowers/specs/2026-09-29-link-building-design.md):
// for the Sonnet-labelled chunk/requirement pairs in output/transcript-support-labels-2026-09-29.json, the share of
// supporting chunks whose words the judge sees, with the old three ranked windows and with whole transcripts (cap 24k).
import { readFileSync } from 'node:fs';
import { readConfig } from '../src/config.js';
import { connect } from '../src/db.js';
import { retainedEvidence } from '../src/retained-evidence.js';
import { requirementTerms } from '../src/link-potential.js';

const config = readConfig();
const db = connect(config.DATABASE_URL);
const pairs = (JSON.parse(readFileSync('output/transcript-support-labels-2026-09-29.json', 'utf8')) as any[]).filter(p => !p.failed);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
// A chunk counts as seen when at least 80% of its words appear, in order-insensitive bag terms, in what the judge reads.
const seen = (chunk: string, visible: string) => { const bag = new Set(words(visible)), w = words(chunk); return w.length > 0 && w.filter(x => bag.has(x)).length / w.length >= 0.8; };
let supporting = 0, oldSeen = 0, newSeen = 0, oldChars = 0, newChars = 0, videos = 0;
for (const p of pairs) {
 const row = (await db.query(`SELECT id FROM content WHERE canonical_url=$1`, [p.url])).rows[0];
 if (!row) continue;
 const contract = {requirements: p.reqs.map((r: any) => ({...r, hardness: 'hard', scope: 'each', kind: 'subject'}))} as any;
 const old = (await retainedEvidence(db, [row.id], p.query)).get(row.id)!.transcripts.map(t => t.text).join(' ');
 const full = (await retainedEvidence(db, [row.id], p.query, {terms: requirementTerms(contract, p.query), maxChars: config.LINK_TRANSCRIPT_CHARS})).get(row.id)!.transcripts.map(t => t.text).join(' ');
 videos++; oldChars += old.length; newChars += full.length;
 for (const c of p.chunks) if (c.supports.length) { supporting++; oldSeen += +seen(c.text, old); newSeen += +seen(c.text, full); }
}
console.log(JSON.stringify({videos, supporting_chunks: supporting, old_windows_seen: +(oldSeen / supporting).toFixed(3), full_transcripts_seen: +(newSeen / supporting).toFixed(3),
 mean_chars_old: Math.round(oldChars / videos), mean_chars_full: Math.round(newChars / videos)}, null, 1));
await db.close();
