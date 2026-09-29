# Query–video link building Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Video search builds each candidate's link to the request (screener → comments → captions → full transcripts → judge), spends caption fetches on the most promising videos, and widens the search before judging when the first round is weak.

**Architecture:** Two new pure modules (`link-potential.ts`, `transcript-passages.ts`) and one expansion module (`link-expansion.ts`) plug into the existing flow: discovery passes screener decisions into `applySignals`, which orders comments and caption fetches by link potential and gives the judge full transcripts; discovery runs one expansion round before judging when fewer than two candidates look strong.

**Tech Stack:** TypeScript (Node 24, tsx), node:test with the embedded Postgres test DB (`tests/helpers.ts`), zod config, OpenRouter models, YouTube Data API v3, Brave.

**Spec:** `docs/superpowers/specs/2026-09-29-link-building-design.md`

## Global Constraints

- Moderate budget: about +30 s and +$0.03 per quick video search.
- Never download YouTube media; captions only through the existing `fetchAndStore` routes (Supadata first, then YouTube).
- Quotes stay verbatim: transcript passages are cut from stored caption text, never reworded.
- Web and Docs tabs, Jev, the judge, the cascade and scene verification are not changed beyond what the judge reads.
- New settings live in `src/config.ts` with defaults: `LINK_MIN_POTENTIAL=0.25`, `LINK_CAPTIONS=10`, `LINK_CAPTIONS_MS=20000`, `LINK_TRANSCRIPT_CHARS=24000`, `LINK_BATCH_CHARS=60000`, `LINK_STRONG_MIN=2`, `LINK_EXPANSION_SEARCHES=4`, `LINK_UPLOAD_SCAN=1000`.
- Code style follows the surrounding files: one-line comments explaining why, terse names, no new dependencies.

## Review Focus

- A search with no screener result (screener down) must behave like today: default potential 0.3, original order.
- A video whose transcript is huge (3-hour podcast) must not blow the judge call: capped at 24k characters, batch split by 60k.
- Caption routes paused (Supadata out of credits and YouTube blocked) must not slow the search; it says captions were unavailable.
- A request naming a person who has no YouTube channel (e.g. "Einstein lecture") must not add junk: the upload scan only runs when the found channel's title matches the name.
- Expansion must run at most once and never on Web/Docs or searches without a contract.

---

### Task 1: Link settings and link potential

**Files:**
- Modify: `src/config.ts` (near `CAPTIONS_NOW`, line ~192)
- Create: `src/link-potential.ts`
- Test: `tests/link-potential.test.ts`

**Interfaces:**
- Produces: `linkPotential(input: LinkInput): LinkScore`, `requirementTerms(contract?: RequirementsContract, query?: string): string[]`, `creatorNames(contract?: RequirementsContract): string[]`, types `ScreenSignal = {choice:'promising'|'uncertain'|'mismatch'; confidence:number; probabilities:{promising:number;uncertain:number;mismatch:number}}`, `LinkInput = {screen?: ScreenSignal; channel?: string|null; creators: string[]; comments: string[]; terms: string[]}`, `LinkScore = {value:number; base:number; creator:boolean; comment:boolean; capped:boolean}`.

- [ ] **Step 1: Write the failing test** (`tests/link-potential.test.ts`)

```ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {linkPotential, requirementTerms, creatorNames} from '../src/link-potential.js';

const screen = (promising: number, uncertain: number, mismatch: number, choice: 'promising'|'uncertain'|'mismatch' = 'uncertain', confidence = 0.5) =>
 ({choice, confidence, probabilities: {promising, uncertain, mismatch}});

test('link potential starts from the screener and defaults without one', () => {
 assert.equal(linkPotential({screen: screen(0.6, 0.2, 0.2), creators: [], comments: [], terms: []}).value, 0.7);
 assert.equal(linkPotential({creators: [], comments: [], terms: []}).value, 0.3);
});

test('the named creator and a matching comment raise it; a confident mismatch caps it; it stays in [0,1]', () => {
 const base = {screen: screen(0.2, 0.4, 0.4), comments: [] as string[], terms: ['subscriber', 'playstation']};
 assert.equal(linkPotential({...base, channel: 'MrBeast', creators: ['Mr Beast']}).creator, true);
 assert.ok(Math.abs(linkPotential({...base, channel: 'MrBeast', creators: ['Mr Beast']}).value - 0.6) < 1e-9);
 assert.equal(linkPotential({...base, creators: [], comments: ['he gave the PlayStation to a subscriber!']}).comment, true);
 assert.equal(linkPotential({...base, creators: [], comments: ['a subscriber here']}).comment, false, 'one shared term is not enough');
 const bad = linkPotential({screen: screen(0.05, 0.05, 0.9, 'mismatch', 0.9), channel: 'MrBeast', creators: ['MrBeast'], comments: [], terms: []});
 assert.equal(bad.capped, true); assert.equal(bad.value, 0.1);
 assert.equal(linkPotential({screen: screen(1, 0, 0), channel: 'A', creators: ['A'], comments: ['subscriber playstation'], terms: ['subscriber', 'playstation']}).value, 1);
});

test('requirement terms and creator names come from the contract', () => {
 const contract: any = {entities: [{kind: 'person', name: 'MrBeast'}, {kind: 'product', name: 'PS5'}],
   requirements: [{id: 'R1', text: 'MrBeast buys ps5', evidence: 'Video shows MrBeast presenting a PS5 console', hardness: 'hard', scope: 'each', kind: 'subject'},
     {id: 'R2', text: 'soft thing', evidence: 'ignored', hardness: 'preferred', scope: 'each', kind: 'subject'}]};
 assert.deepEqual(creatorNames(contract), ['MrBeast']);
 const terms = requirementTerms(contract, 'mr beast buys ps5');
 assert.ok(terms.includes('console') && terms.includes('mrbeast') && !terms.includes('ignored'));
 assert.deepEqual(requirementTerms(undefined, 'find the cooking video'), ['find', 'cooking', 'video']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/link-potential.test.ts`
Expected: FAIL, cannot find module `../src/link-potential.js`.

- [ ] **Step 3: Add the settings** to `src/config.ts`, replacing the `CAPTIONS_NOW` lines:

```ts
  // Link building (docs/superpowers/specs/2026-09-29-link-building-design.md). Video searches fetch captions for up to
  // LINK_CAPTIONS candidates in link-potential order (none below LINK_MIN_POTENTIAL) within LINK_CAPTIONS_MS, give the
  // judge each transcript in full up to LINK_TRANSCRIPT_CHARS (batches split at LINK_BATCH_CHARS of transcript), and
  // search once more before judging when fewer than LINK_STRONG_MIN candidates look strong.
  LINK_MIN_POTENTIAL: z.coerce.number().min(0).max(1).default(0.25),
  LINK_CAPTIONS: number(10, 0, 30), LINK_CAPTIONS_MS: number(20000, 2000, 60000),
  LINK_TRANSCRIPT_CHARS: number(24000, 2400, 100000), LINK_BATCH_CHARS: number(60000, 10000, 400000),
  LINK_STRONG_MIN: number(2, 0, 10), LINK_EXPANSION_SEARCHES: number(4, 0, 8), LINK_UPLOAD_SCAN: number(1000, 0, 5000),
```

- [ ] **Step 4: Write `src/link-potential.ts`**

```ts
import type { RequirementsContract } from './requirements.js';
import { hardEach } from './requirements.js';
import { STOPWORDS } from './ranking.js';

// Link potential (docs/superpowers/specs/2026-09-29-link-building-design.md): how likely a candidate is to link to the
// request once more evidence is fetched, from what is already known. It orders comment and caption fetches; it never
// decides relevance.
export type ScreenSignal = {choice: 'promising'|'uncertain'|'mismatch'; confidence: number; probabilities: {promising: number; uncertain: number; mismatch: number}};
export interface LinkInput { screen?: ScreenSignal; channel?: string|null; creators: string[]; comments: string[]; terms: string[] }
export interface LinkScore { value: number; base: number; creator: boolean; comment: boolean; capped: boolean }

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(w => !STOPWORDS.has(w));

export function linkPotential(input: LinkInput): LinkScore {
 const p = input.screen?.probabilities;
 const base = p ? p.promising + 0.5 * p.uncertain : 0.3;
 const channel = fold(input.channel ?? '');
 const creator = !!channel && input.creators.some(name => fold(name).length >= 3 && fold(name) === channel);
 const terms = new Set(input.terms);
 const comment = input.comments.some(c => new Set(words(c).filter(w => terms.has(w))).size >= 2);
 const capped = input.screen?.choice === 'mismatch' && input.screen.confidence >= 0.8;
 const raw = base + (creator ? 0.2 : 0) + (comment ? 0.15 : 0);
 const value = +Math.min(1, Math.max(0, capped ? Math.min(raw, 0.1) : raw)).toFixed(4);
 return {value, base: +base.toFixed(4), creator, comment, capped};
}

// Words that show a requirement is met: the hard requirements' text and evidence, or the query's own words without a contract.
export function requirementTerms(contract?: RequirementsContract, query = ''): string[] {
 const source = contract ? hardEach(contract).flatMap(r => [r.text, r.evidence ?? '']).join(' ') : query;
 return [...new Set(contract ? words(source) : (source.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(w => !STOPWORDS.has(w)))];
}

// People and organisations the request names: the only channels link building ever searches on its own.
export function creatorNames(contract?: RequirementsContract): string[] {
 return (contract?.entities ?? []).filter(e => e.kind === 'person' || e.kind === 'organisation').map(e => e.name).filter(n => n.trim().length >= 3);
}
```

- [ ] **Step 5: Run the test**, fix until it passes: `node --import tsx --test tests/link-potential.test.ts` → PASS.
  (If `requirementTerms(undefined,'find the cooking video')` differs because `STOPWORDS` contains `find`/`video`, change the expected array to what STOPWORDS leaves; the rule is "4+ letter words not in STOPWORDS".)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/link-potential.ts tests/link-potential.test.ts
git commit -m "Add link potential and the link-building settings"
```

### Task 2: Full transcripts as passages

**Files:**
- Create: `src/transcript-passages.ts`
- Modify: `src/retained-evidence.ts:10-24` (`retainedEvidence` gains an optional `terms` argument and a chars cap)
- Test: `tests/transcript-passages.test.ts`

**Interfaces:**
- Produces: `transcriptPassages(segments: {start:number;end:number;text:string}[], terms: string[], maxChars: number, passageChars?: number): {start:number;end:number;text:string}[]`; `retainedEvidence(db, ids, query, options?: {terms?: string[]; maxChars?: number})` returns the same shape as before, with transcripts = full passages when `options.maxChars` is given.

- [ ] **Step 1: Write the failing test**

```ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transcriptPassages} from '../src/transcript-passages.js';

const seg = (i: number, text: string) => ({start: i * 10, end: i * 10 + 10, text});

test('a short transcript becomes consecutive passages cut at line boundaries, in order', () => {
 const lines = Array.from({length: 30}, (_, i) => seg(i, `line ${i} ${'x'.repeat(90)}`));
 const out = transcriptPassages(lines, [], 24000, 1000);
 assert.ok(out.length >= 3);
 assert.equal(out.map(p => p.text).join(' '), lines.map(l => l.text).join(' '), 'every line kept verbatim, in order');
 for (const p of out) assert.ok(p.text.length <= 1000 + 100);
 assert.equal(out[0].start, 0); assert.equal(out.at(-1)!.end, 300);
});

test('a long transcript keeps the passages with the most requirement terms, up to the cap, in time order', () => {
 const lines = Array.from({length: 100}, (_, i) => seg(i, i === 70 ? 'he handed the playstation to a subscriber' : `filler words number ${i} ${'y'.repeat(80)}`));
 const out = transcriptPassages(lines, ['playstation', 'subscriber'], 2000, 1000);
 assert.ok(out.reduce((n, p) => n + p.text.length, 0) <= 2000 + 200);
 assert.ok(out.some(p => p.text.includes('playstation to a subscriber')));
 assert.deepEqual(out.map(p => p.start), [...out.map(p => p.start)].sort((a, b) => a - b));
});

test('no segments give no passages; one oversized line is truncated, never dropped', () => {
 assert.deepEqual(transcriptPassages([], ['a'], 24000), []);
 const out = transcriptPassages([seg(0, 'z'.repeat(5000))], [], 24000, 2400);
 assert.equal(out.length, 1); assert.equal(out[0].text.length, 2400);
});
```

- [ ] **Step 2: Run to verify it fails**: `node --import tsx --test tests/transcript-passages.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write `src/transcript-passages.ts`**

```ts
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
   cur = cur ? {start: cur.start, end: s.end, text: `${cur.text} ${text}`} : {start: s.start, end: s.end, text: text.slice(0, passageChars)};
 }
 if (cur) passages.push(cur);
 const total = passages.reduce((n, p) => n + p.text.length, 0);
 if (total <= maxChars) return passages;
 // Too long for the judge: keep the passages richest in requirement terms (earlier ones break ties), in time order.
 const score = (p: Passage) => { const t = p.text.toLowerCase(); return terms.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0); };
 const ranked = passages.map((p, i) => ({p, i, s: score(p)})).sort((a, b) => b.s - a.s || a.i - b.i);
 const kept: typeof ranked = [];
 let used = 0;
 for (const r of ranked) { if (used + r.p.text.length > maxChars) continue; kept.push(r); used += r.p.text.length; }
 return kept.sort((a, b) => a.i - b.i).map(r => r.p);
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Wire into `retainedEvidence`.** Change the signature to
`export async function retainedEvidence(db:DB,ids:string[],query:string,options:{terms?:string[];maxChars?:number}={})`.
When `options.maxChars` is set, read the segments of eligible videos and build passages instead of the ranked windows:

```ts
 if(options.maxChars){
   const segs=(await db.query(`SELECT t.content_id,t.start_seconds,t.end_seconds,t.text FROM transcript_segments t
     JOIN content c ON c.id=t.content_id JOIN sources s ON s.id=c.source_id
     WHERE t.content_id=ANY($1::uuid[]) AND (s.policy->>'transcripts')::boolean=true AND c.expires_at>now() AND c.availability<>'unavailable'
     AND s.status='active' AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
     ORDER BY t.content_id,t.start_seconds`,[ids])).rows;
   const full=new Map(ids.map(id=>[id,transcriptPassages(segs.filter(r=>r.content_id===id).map(r=>({start:Number(r.start_seconds),end:Number(r.end_seconds),text:r.text})),
     options.terms??[],options.maxChars!)]));
   for(const id of ids) transcriptsOf.set(id,full.get(id)!);
 }
```

(Restructure the function so `transcriptsOf` defaults to the existing ranked windows and is replaced by `full` when `maxChars` is set; scenes are unchanged.)

- [ ] **Step 6: Add a DB test** in `tests/transcript-passages.test.ts` using `database()`/`fixture()` and `importTranscript` (see `tests/quote-moments.test.ts` for the import call) asserting `retainedEvidence(db,[id],'q',{maxChars:24000})` returns every imported line in order, and without options returns the old windows.

- [ ] **Step 7: Run** `node --import tsx --test tests/transcript-passages.test.ts tests/quote-moments.test.ts` → PASS. **Commit**: `git commit -m "Give the judge whole transcripts as verbatim passages"`.

### Task 3: Evidence order, caption allocation and full transcripts in signals

**Files:**
- Modify: `src/signals.ts` (context type line 41; youtube task 175-207; captions task 246-256; candidate transcripts line 302; judge batching 324-338; cascade inspection 364-374)
- Modify: `src/captions.ts` (`fetchCaptionsNow` gains an ordered list; `MOMENT_QUERY` removed if unused)
- Test: `tests/signals.test.ts` (new tests at the end)

**Interfaces:**
- Consumes: Task 1 `linkPotential`, `requirementTerms`, `creatorNames`, `ScreenSignal`; Task 2 `retainedEvidence(..., {terms, maxChars})`.
- Produces: `SignalContext.screens?: Map<string, ScreenSignal>` keyed by canonical URL; `applySignals` result gains `links: Map<string, LinkScore>` keyed by result id; exported `judgeBatches<T extends {transcripts?: {text:string}[]}>(list: T[], size: number, maxChars: number): T[][]`.

- [ ] **Step 1: Failing tests** in `tests/signals.test.ts`:
  1. `judgeBatches` splits a list so no batch carries more than `maxChars` of transcript text or more than `size` items, keeps order, and never returns an empty batch.
  2. With `context.kind='videos'`, a contract, `screens` giving video B P(promising)=0.9 and A 0.1, a fake `captions` fetcher and `LINK_CAPTIONS=1`: only B is fetched; with `LINK_MIN_POTENTIAL=0.95` nothing is fetched; the fetch happens for a non-moment query.
  3. The judge candidate for a video with an imported 30-line transcript receives all 30 lines (joined across passages) when `LINK_TRANSCRIPT_CHARS` is large.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** (exact changes):
  - `SignalContext` adds `screens?: Map<string, ScreenSignal>`.
  - Compute once near the top: `const terms = requirementTerms(context?.contract, query), creators = creatorNames(context?.contract); const link = (r: Result) => linkPotential({screen: context?.screens?.get(r.canonical_url), channel: extra.get(r.id)?.details?.channelTitle ?? r.creator, creators, comments: extra.get(r.id)?.comments ?? [], terms});`
  - Comments: `const byPotential = [...eligible].sort((a, b) => link(b).value - link(a).value); const commented = new Set(byPotential.slice(0, config.SIGNAL_VIDEOS).map(r => r.id));`
  - Replace `captionsNowTask` with `linkCaptionsTask`, run **after** `youtubeTask` resolves (in parallel with nothing that needs it): order `results.filter(r => youtubeId(r.canonical_url))` by `link(r).value`, drop those below `config.LINK_MIN_POTENTIAL`, and call `fetchCaptionsNow(db, config, ordered, fetcher, config.LINK_CAPTIONS, config.LINK_CAPTIONS_MS)`; it runs when `context?.kind !== 'websites'` (no `MOMENT_QUERY` gate). Provider message: `Captions were fetched for ${imported} of ${tried} promising videos during this search.`; when `tried>0 && imported===0`, status `partial` with "Captions unavailable right now; videos were judged on titles, descriptions and comments."
  - `retainedEvidence(db, ids, query, {terms, maxChars: config.LINK_TRANSCRIPT_CHARS})` for both the main call (line 257) and the cascade inspection call (line 369).
  - `judgeAll` uses `judgeBatches(list, size, config.LINK_BATCH_CHARS)`.
  - `fetchCaptionsNow` keeps its signature; its `ids` already follow the order it is given, so passing the ordered list is enough (add a comment saying the caller's order is the priority).
  - Return `links: new Map(results.map(r => [r.id, link(r)]))`.

- [ ] **Step 4: Run** `node --import tsx --test tests/signals.test.ts tests/captions.test.ts tests/cascade.test.ts` → PASS. Then `npm test` → all pass (update any test that relied on `CAPTIONS_NOW` or `MOMENT_QUERY`).

- [ ] **Step 5: Commit** `git commit -m "Spend comments and captions on the most promising videos and give the judge whole transcripts"`.

### Task 4: Screener decisions into signals and link potential in the trace

**Files:**
- Modify: `src/discovery.ts:435-449` (keep `screened.decisions`), `:472-473` (pass `screens`), `:489-495` (pool entries get `link`)
- Modify: `src/learning.ts` only if the trace type needs the field (search `pool` type)
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Consumes: Task 3 `SignalContext.screens`, `applySignals(...).links`.
- Produces: trace pool entries carry `link?: LinkScore`.

- [ ] **Step 1: Failing test**: a discovery run with a fake screener returning `decisions` for two URLs puts `link.base` on those pool entries, and the higher one's comments are fetched first (fake YouTube client records the comment call order).
- [ ] **Step 2: Implement**: `let screens = new Map<string, ScreenSignal>();` then after screening `for (const d of screened.decisions ?? []) screens.set(d.url, {choice: d.choice, confidence: d.confidence, probabilities: d.probabilities});` pass `screens` in the context; add `...(id && signals.links.has(id) ? {link: signals.links.get(id)} : {})` to pool entries.
- [ ] **Step 3: Run** `node --import tsx --test tests/discovery.test.ts` then `npm test` → PASS. **Commit** `git commit -m "Carry screener decisions into link potential and record it in the trace"`.

### Task 5: Expansion before judging

**Files:**
- Create: `src/link-expansion.ts`
- Modify: `src/youtube.ts` (add `uploads(handle, max)` to `YouTubeData` and an optional method on `YouTubeClient`)
- Modify: `src/discovery.ts` (after screening, before `store(picks)`)
- Test: `tests/link-expansion.test.ts`

**Interfaces:**
- Consumes: Task 1 `linkPotential`, `creatorNames`, `requirementTerms`; the screener; `cleanDecision` from `src/refill.ts`; discovery's `run()` and `leads`.
- Produces:
  - `needsExpansion(potentials: number[], strongMin: number): boolean` — true when fewer than `strongMin` values are ≥ 0.5.
  - `makeLinkRewriter(db, config): LinkRewriter|undefined` with `type LinkRewriter = (query: string, requirements: {id:string;text:string}[], ran: string[]) => Promise<string[]>` (planner models, `refill_calls` budget, at most `LINK_EXPANSION_SEARCHES`, cleaned with `cleanDecision`).
  - `creatorSearch(name: string, terms: string[]): string` → `site:youtube.com "<name>" <up to 4 terms>`.
  - `YouTubeData.uploads(handle: string, max: number): Promise<{channel: string; items: {id:string; title:string; description:string}[]}|null>` — `channels?part=snippet,contentDetails&forHandle=@handle` (1 unit), then `playlistItems?part=snippet&playlistId=<uploads>&maxResults=50` pages until `max` (1 unit each); null when no channel.
  - `sameCreator(channelTitle: string, name: string): boolean` — folded equality, as in link potential.

- [ ] **Step 1: Failing tests** (`tests/link-expansion.test.ts`):
  - `needsExpansion([0.6,0.2],2)===true`, `needsExpansion([0.6,0.5],2)===false`, `needsExpansion([],2)===true`, `needsExpansion([0.1],0)===false`.
  - `creatorSearch('MrBeast',['playstation','subscriber','console','fans','extra'])==='site:youtube.com "MrBeast" playstation subscriber console fans'`.
  - `sameCreator('MrBeast','Mr Beast')`, `!sameCreator('MrBeast Gaming','MrBeast')`.
  - The rewriter, with a fake client answering `{complete:false,missing:'x',searches:['mrbeast ps5 giveaway fan','mr beast buys ps5 to a subscriber','']}` and ran `['mr beast buys ps5 to a subscriber']`, returns only `['mrbeast ps5 giveaway fan']`.
  - `YouTubeData.uploads` with a fake transport: resolves the handle, pages twice (50 + 20), stops at `max`, spends one budget unit per call, and returns null when `items` is empty.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `src/link-expansion.ts`** with the functions above. The rewriter's system prompt:

```ts
const SYSTEM = `A video search found too little for a request. Write up to N new video searches (YouTube-style titles or
phrases) that would find videos meeting the requirements the results have not shown, in the words video titles and
creators actually use rather than the request's own words (for "to a subscriber" try "giveaway to a fan", "surprising
a viewer"). Each must differ from the searches already run. Answer JSON {"complete": false, "missing": string, "searches": [string]}.`;
```

  (Replace N with `config.LINK_EXPANSION_SEARCHES` when building the prompt.)
- [ ] **Step 4: Wire into discovery** after the screener block and before the contract admission block:

```ts
 // Link expansion (spec 2026-09-29): too few strong candidates after screening, so look again before judging.
 if (contract && plan.kind !== 'websites' && !expanded && needsExpansion(picks.map(l => screenPotential(screens.get(l.item.url))), config.LINK_STRONG_MIN)
   && deadline - Date.now() > FOLLOW_UP_MIN_MS) { ...rewrite + creator site: search via run(); screen the new leads; if still weak and a creator is
   named and youtube.uploads exists, scan uploads, screen their titles, add promising ones as leads (provider 'creator_uploads'); log link_expansion }
```

  where `screenPotential(s) = linkPotential({screen: s, creators: [], comments: [], terms: []}).base`, new leads get `round = rounds + 1`, and a provider note reports the searches run and leads added.
- [ ] **Step 5: Run** `node --import tsx --test tests/link-expansion.test.ts tests/discovery.test.ts` then `npm test` → PASS. **Commit** `git commit -m "Search again before judging when no candidate looks strong, including the named creator's channel"`.

### Task 6: Measure

**Files:**
- Create: `scripts/link-coverage.ts` (reads `output/transcript-support-labels-2026-09-29.json`; for each pair, what share of supporting chunks' text is inside (a) the old top-3 windows ×2,400 chars and (b) `transcriptPassages` under 24k)
- Output: `output/link-building-probe-<date>.json`

- [ ] **Step 1:** Write and run the coverage script: `node --env-file=.env --import tsx scripts/link-coverage.ts`; record both shares.
- [ ] **Step 2:** Restart PM2 api+worker; run the four probe queries on SSJ3 quick through the local API (as the earlier probe scripts in `output/` do); record shown results, `basis` counts, link expansion lines, time and `model_cost` per search; compare with the earlier traces of the same queries.
- [ ] **Step 3:** Commit the script: `git commit -m "Measure transcript coverage and probe link building live"`.
