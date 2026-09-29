// Full transcripts for the judge (docs/superpowers/specs/2026-09-29-link-building-design.md): caption lines grouped in
// order into passages of about passageChars, cut only between lines so quotes stay verbatim and map to timestamps.
// Keyword-ranked windows missed paraphrases ("one of his fans" for "a subscriber"); reading the whole transcript does not.
export type Passage = {start: number; end: number; text: string};

export function transcriptPassages(segments: Passage[], terms: string[], maxChars: number, passageChars = 2400): Passage[] {
 const passages: Passage[] = [];
 let cur: Passage|null = null;
 for (const s of segments) {
   const text = s.text.replace(/\s+/g, ' ').trim();
   if (!text) continue;
   if (cur && cur.text.length + 1 + text.length > passageChars) { passages.push(cur); cur = null; }
   // A single line longer than a passage is cut, never dropped.
   cur = cur ? {start: cur.start, end: s.end, text: `${cur.text} ${text}`} : {start: s.start, end: s.end, text: text.slice(0, passageChars)};
 }
 if (cur) passages.push(cur);
 if (passages.reduce((n, p) => n + p.text.length, 0) <= maxChars) return passages;
 // Too long for the judge: keep the passages richest in requirement terms (earlier ones break ties), in time order.
 const score = (p: Passage) => { const t = p.text.toLowerCase(); return terms.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0); };
 const ranked = passages.map((p, i) => ({p, i, s: score(p)})).sort((a, b) => b.s - a.s || a.i - b.i);
 const kept: typeof ranked = [];
 let used = 0;
 for (const r of ranked) if (used + r.p.text.length <= maxChars) { kept.push(r); used += r.p.text.length; }
 return kept.sort((a, b) => a.i - b.i).map(r => r.p);
}

// Judge batches of at most size candidates and maxChars of transcript text, in order. Whole transcripts
// (spec 2026-09-29-link-building) would otherwise make one call too long for the judge's time limit.
// Used by the first judge (src/signals.ts) and the cascade's Strong judge (src/cascade.ts).
export function judgeBatches<T extends {transcripts?: {text: string}[]}>(list: T[], size: number, maxChars: number): T[][] {
 const out: T[][] = [];
 let batch: T[] = [], chars = 0;
 for (const item of list) {
   const own = (item.transcripts ?? []).reduce((n, t) => n + t.text.length, 0);
   if (batch.length && (batch.length >= size || chars + own > maxChars)) { out.push(batch); batch = []; chars = 0; }
   batch.push(item); chars += own;
 }
 if (batch.length) out.push(batch);
 return out;
}
