import type { DB } from './db.js';
import type { Config } from './config.js';
import { searchInput, type Moment, type ProviderStatus, type Result } from './types.js';
import { SearXNG } from './providers.js';
import { discoveryQuery, sameWord, STOPWORDS, tokens } from './ranking.js';
import { UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { YouTubeData, youtubeId, type VideoDetails, type ViewerComment, type YouTubeClient } from './youtube.js';
import { GeminiJudge, type Judge, type JudgeCandidate, type JudgeContext, type JudgeResult, type Verdict } from './judge.js';
import { PageChecker, type PageCheck, type PageEvidence } from './pages.js';
import type { SearchTarget } from './planner.js';

export const VIEWER_ANALYSIS_VERSION = 'viewer-comments-v1';
const MOMENTS_PER_VIDEO = 3;
const WINDOW_SECONDS = 30;
const LEAD_IN_SECONDS = 5;

export interface TimestampMention { commentId: string; seconds: number; excerpt: string; likes: number; weight: number }
export interface MomentCluster { start: number; end: number; score: number; mentions: TimestampMention[] }
export interface Discussion { title: string; url: string; snippet: string|null }
export interface SignalDeps { youtube?: YouTubeClient; judge?: Judge; pages?: PageCheck; discussions?: (query: string) => Promise<Discussion[]> }
// What the search plan wanted, and which kind of search found each result (by result id).
// underrated: rank relevant results from lesser-known sources higher.
export interface SignalContext extends JudgeContext { targets: Map<string,SearchTarget>; underrated?: boolean }
export const UNDERRATED_BADGE = 'Underrated find';
const RETRY_BATCH = 10;

// h:mm:ss or m:ss, not part of a longer number, ratio or clock time such as "10:30 pm".
const STAMP = /(?<![\w:.])(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?![\w:])(?!\s*[ap]\.?m\b)/gi;

export function formatSeconds(total: number) {
 const s = Math.floor(total), h = Math.floor(s/3600), m = Math.floor(s%3600/60), r = String(s%60).padStart(2, '0');
 return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function timestampMentions(comment: ViewerComment, duration: number|null): TimestampMention[] {
 const found: {seconds: number; excerpt: string}[] = [];
 for (const line of comment.text.split(/\r?\n/)) {
   const excerpt = line.trim().slice(0, 280);
   for (const m of line.matchAll(STAMP)) {
     const minutes = Number(m[2]);
     if (m[1] !== undefined && minutes > 59) continue;
     const seconds = Number(m[1] ?? 0)*3600 + minutes*60 + Number(m[3]);
     if (seconds > 0 && (duration === null || seconds <= duration)) found.push({seconds, excerpt});
   }
 }
 // A long list of timestamps (chapters, "best parts") says less about each entry than one pointed comment.
 const weight = (1 + Math.log10(1 + comment.likes)) / Math.sqrt(Math.max(1, found.length));
 return [...new Map(found.map(f => [f.seconds, f])).values()]
   .map(f => ({commentId: comment.id, seconds: f.seconds, excerpt: f.excerpt, likes: comment.likes, weight}));
}

export function clusterMentions(mentions: TimestampMention[], duration: number, limit = MOMENTS_PER_VIDEO): MomentCluster[] {
 const groups: TimestampMention[][] = [];
 for (const m of [...mentions].sort((a, b) => a.seconds - b.seconds)) {
   const last = groups.at(-1);
   if (last && m.seconds - last[0].seconds <= WINDOW_SECONDS) last.push(m); else groups.push([m]);
 }
 return groups.map((group, g) => {
   const byComment = new Map<string,TimestampMention>();
   for (const m of group) if ((byComment.get(m.commentId)?.weight ?? -1) < m.weight) byComment.set(m.commentId, m);
   const distinct = [...byComment.values()];
   // Stop before the next group's lead-in so neighbouring moments do not overlap.
   const last = group.at(-1)!.seconds, next = groups[g + 1]?.[0].seconds ?? Infinity;
   return {start: Math.max(0, group[0].seconds - LEAD_IN_SECONDS),
     end: Math.min(duration, last + WINDOW_SECONDS, Math.max(last, next - LEAD_IN_SECONDS)),
     score: distinct.reduce((sum, m) => sum + m.weight, 0), mentions: distinct.sort((a, b) => b.likes - a.likes).slice(0, 3)};
 }).sort((a, b) => b.score - a.score || a.start - b.start).slice(0, limit);
}

export function discussionsFor(db: DB, config: Config, deps: SignalDeps) {
 return deps.discussions ?? (config.REDDIT_SIGNALS && config.SEARXNG_BASE_URL ? (q: string) => redditDiscussions(db, config, q) : undefined);
}

export async function redditDiscussions(db: DB, config: Config, query: string): Promise<Discussion[]> {
 if (!await takeBudget(db, 'reddit_signals', config.DISCOVERY_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
 const adapter = new SearXNG({...config, SEARXNG_ENGINES: config.SEARXNG_SOURCE_ENGINES});
 const q = `site:reddit.com ${query}`.slice(0, 500);
 const page = await adapter.search(q, searchInput.parse({q}));
 return page.results.filter(r => /(^|\.)reddit\.com$/.test(new URL(r.url).hostname)).slice(0, 10)
   .map(r => ({title: r.title, url: r.url, snippet: r.description}));
}

// Threads found by searching the query mention the query's own words, so only the rest of a title can tie a thread to a video.
export function matchDiscussions(title: string, videoId: string|null, channel: string|null, discussions: Discussion[], queryTerms: string[] = []) {
 const titleWords = [...new Set(tokens(title).filter(t => t.length >= 3 && !STOPWORDS.has(t) && !queryTerms.some(q => sameWord(q, t))))];
 const channelWords = tokens(channel);
 return discussions.filter(d => {
   const text = `${d.title} ${d.snippet ?? ''} ${d.url}`;
   if (videoId && text.includes(videoId)) return true;
   const words = tokens(text);
   const overlap = titleWords.filter(w => words.some(t => sameWord(w, t))).length;
   if (titleWords.length >= 2 && overlap/titleWords.length >= 0.6) return true;
   return channelWords.join('').length >= 4 && ` ${words.join(' ')} `.includes(` ${channelWords.join(' ')} `);
 });
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
 let next = 0;
 await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => { while (next < items.length) await fn(items[next++]); }));
}

async function storeMoments(db: DB, contentId: string, duration: number, comments: ViewerComment[]) {
 const clusters = clusterMentions(comments.flatMap(c => timestampMentions(c, duration)), duration);
 return db.transaction(async tx => {
   // Deleting the old evidence also deletes the moments that cited it (trigger), so each check replaces the last.
   await tx.query('DELETE FROM viewer_timestamps WHERE content_id=$1', [contentId]);
   const stored: {cluster: MomentCluster; moment: Moment}[] = [];
   for (const cluster of clusters) {
     const refs: string[] = [];
     for (const m of cluster.mentions) refs.push((await tx.query(`INSERT INTO viewer_timestamps(content_id,provider,provider_comment_id,seconds,excerpt,like_count,expires_at)
       SELECT $1,'youtube',$2,$3,$4,$5,least(expires_at,now()+interval '30 days') FROM content WHERE id=$1 RETURNING id`,
       [contentId, m.commentId, m.seconds, m.excerpt, m.likes])).rows[0].id);
     const summary = cluster.mentions.map(m => m.excerpt).join(' · ').slice(0, 1000);
     const id = (await tx.query(`INSERT INTO moments(content_id,start_seconds,end_seconds,summary,evidence_refs,evidence_type,analysis_method,analysis_version,inspected_ranges)
       VALUES($1,$2,$3,$4,$5,'viewer_timestamp','viewer_comments',$6,'[]') RETURNING id`,
       [contentId, cluster.start, cluster.end, summary, refs, VIEWER_ANALYSIS_VERSION])).rows[0].id;
     stored.push({cluster, moment: {id, start_seconds: cluster.start, end_seconds: cluster.end, summary, evidence_type: 'viewer_timestamp',
       analysis_version: VIEWER_ANALYSIS_VERSION, inspected_ranges: [], evidence_refs: refs}});
   }
   return stored;
 });
}

interface Extra { details?: VideoDetails; page?: PageEvidence; stored: {cluster: MomentCluster; moment: Moment}[]; comments: string[]; discussions: Discussion[]; badges: string[] }
// A structured worker log line with the upstream error code, never the raw error or request.
export function logFailure(event: string, error: unknown) {
 console.error(JSON.stringify({event, code: error instanceof UpstreamError ? error.code : 'error', status: (error as UpstreamError)?.status ?? null}));
}
const unavailable = (provider: string, error: unknown, message: string): ProviderStatus =>
 error instanceof UpstreamError && error.code === 'budget_exhausted'
   ? {provider, status: 'budget_exhausted', message: `The daily ${provider} limit has been reached.`}
   : {provider, status: 'unavailable', message};

// Enriches ranked discovery results with YouTube details and viewer timestamps, Reddit mentions and an AI relevance
// judgement, then re-orders them. Every step is optional and a failing step leaves the others' results intact.
// previews: first-screen captures of checked web pages by result id, kept only as long as the searches that show them.
export async function applySignals(db: DB, config: Config, query: string, results: Result[], deps: SignalDeps = {}, context?: SignalContext) {
 const providers: ProviderStatus[] = [];
 const previews = new Map<string,Buffer>();
 if (!results.length) return {results, providers, previews};
 const rows = (await db.query(`SELECT c.id,c.duration,(s.policy->>'viewer_signals')::boolean AS viewer_signals FROM content c
   JOIN sources s ON s.id=c.source_id WHERE c.id=ANY($1::uuid[]) AND s.status='active'`, [results.map(r => r.id)])).rows;
 const stored = new Map(rows.map(r => [r.id, r]));
 const official = new Set(config.OFFICIAL_YOUTUBE_CHANNELS.split(',').map(s => s.trim()).filter(Boolean));
 const extra = new Map<string,Extra>();
 const info = (id: string) => extra.get(id) ?? extra.set(id, {stored: [], comments: [], discussions: [], badges: []}).get(id)!;

 const youtube = deps.youtube ?? (config.YOUTUBE_API_KEY ? new YouTubeData(db, config) : undefined);
 // Details (one request per 50 videos) cover every permitted video; comments only the first SIGNAL_VIDEOS.
 const eligible = results.filter(r => youtubeId(r.canonical_url) && stored.get(r.id)?.viewer_signals).slice(0, 50);
 const commented = new Set(eligible.slice(0, config.SIGNAL_VIDEOS).map(r => r.id));
 const youtubeTask = async (): Promise<ProviderStatus|null> => {
   if (!youtube || !eligible.length) return null;
   try {
     const details = await youtube.videos(eligible.map(r => youtubeId(r.canonical_url)!));
     let failed = 0;
     await mapLimit(eligible, 5, async r => {
       const d = details.get(youtubeId(r.canonical_url)!);
       if (!d) return;
       const e = info(r.id); e.details = d;
       if (d.live === 'live') e.badges.push('Live now');
       else if (d.live === 'upcoming') e.badges.push('Upcoming livestream');
       else if (d.wasLive) e.badges.push('Livestream replay');
       if (official.has(d.channelId)) e.badges.push('Official channel');
       try {
         await db.query('UPDATE content SET duration=coalesce(duration,$2),published_at=coalesce(published_at,$3),creator=coalesce(creator,$4) WHERE id=$1',
           [r.id, d.duration, d.publishedAt, d.channelTitle || null]);
         if (!commented.has(r.id) || d.commentCount === null || d.commentCount === 0) return;
         const comments = await youtube.comments(d.id, config.SIGNAL_COMMENTS);
         e.comments = [...comments].sort((a, b) => b.likes - a.likes).slice(0, 15).map(c => c.text.replace(/\s+/g, ' ').slice(0, 240));
         const duration = stored.get(r.id)?.duration ?? d.duration;
         // Without a known length, a moment could later conflict with the real duration, so none is stored.
         if (duration) e.stored = await storeMoments(db, r.id, duration, comments);
       } catch { failed++; }
     });
     return failed ? {provider: 'youtube', status: 'partial', message: 'Some YouTube comments could not be read.'}
       : {provider: 'youtube', status: 'ok', message: 'YouTube details and viewer comments checked.'};
   } catch (error) { return unavailable('youtube', error, 'YouTube details are unavailable right now.'); }
 };
 const discussions = discussionsFor(db, config, deps);
 const redditTask = async (): Promise<{threads: Discussion[]; status: ProviderStatus|null}> => {
   if (!discussions) return {threads: [], status: null};
   try { return {threads: await discussions(query), status: {provider: 'reddit', status: 'ok', message: 'Reddit discussions checked.'}}; }
   catch (error) { return {threads: [], status: unavailable('reddit', error, 'Reddit discussions are unavailable right now.')}; }
 };
 const pages = config.PAGE_CHECKS > 0 ? (deps.pages ?? new PageChecker(config)) : undefined;
 const webResults = context ? results.filter(r => context.targets.get(r.id) === 'web' && !youtubeId(r.canonical_url)).slice(0, config.PAGE_CHECKS) : [];
 const pageTask = async (): Promise<ProviderStatus|null> => {
   if (!pages || !webResults.length) return null;
   let checked = 0, rendered = 0;
   await mapLimit(webResults, 8, async r => {
     const evidence = await pages.check(r.canonical_url);
     const e = info(r.id); e.page = evidence; e.badges.push(...evidence.badges);
     if (evidence.status === 'checked') checked++;
     if (evidence.rendered) rendered++;
     if (evidence.screenshot) previews.set(r.id, evidence.screenshot);
   });
   // Blocked or script-only pages are common, so only a total failure is reported as a problem.
   return checked ? {provider: 'pages', status: 'ok', message: `${checked} of ${webResults.length} result pages were checked${rendered ? `, ${rendered} in a browser` : ''}.`}
     : {provider: 'pages', status: 'unavailable', message: 'Result pages could not be checked; websites are ranked from search snippets.'};
 };
 const [youtubeStatus, reddit, pageStatus] = await Promise.all([youtubeTask(), redditTask(), pageTask()]);
 for (const status of [youtubeStatus, reddit.status, pageStatus]) if (status) providers.push(status);

 const terms = discoveryQuery(query).terms;
 const pool = results.slice(0, config.JUDGE_CANDIDATES);
 const keys = new Map(pool.map((r, i) => [r.id, `r${i + 1}`]));
 for (const r of pool) {
   const d = extra.get(r.id)?.details;
   const matched = matchDiscussions(r.title, youtubeId(r.canonical_url), d?.channelTitle ?? r.creator, reddit.threads, terms);
   if (matched.length) { const e = info(r.id); e.discussions = matched.slice(0, 3); e.badges.push('Discussed on Reddit'); }
 }

 const judge = deps.judge ?? (config.GEMINI_API_KEY ? new GeminiJudge(db, config) : undefined);
 let verdicts: Map<string,Verdict>|null = null;
 const modelOf = new Map<string,string>();
 if (judge) {
   const candidates: JudgeCandidate[] = pool.map(r => {
     const e = extra.get(r.id), d = e?.details, key = keys.get(r.id)!, duration = d?.duration ?? r.duration;
     const page = e?.page;
     return {key, kind: youtubeId(r.canonical_url) || context?.targets.get(r.id) !== 'web' ? 'video' : 'website',
       site: new URL(r.canonical_url).hostname, title: r.title, channel: d?.channelTitle || r.creator,
       official: !!e?.badges.includes('Official channel'), duration: duration ? formatSeconds(duration) : null,
       live: e?.badges.find(b => /live/i.test(b)) ?? null,
       description: (d?.description || r.description || '').replace(/\s+/g, ' ').slice(0, 500) || null,
       comments: e?.comments ?? [], views: d?.views ?? null,
       moments: (e?.stored ?? []).map((s, j) => ({key: `${key}m${j + 1}`,
         at: formatSeconds(Math.min(...s.cluster.mentions.map(m => m.seconds))), viewers_said: s.cluster.mentions.map(m => m.excerpt)})),
       discussions: (e?.discussions ?? []).map(t => t.title),
       ...(page ? {page: {status: page.status, title: page.title, description: page.description, text: page.text, libraries: page.libraries,
         screenshot: previews.has(r.id)}} : {})};
   });
   const screenshots = new Map([...previews].flatMap(([id, image]) => keys.has(id) ? [[keys.get(id)!, image] as const] : []));
   // Smaller batches in parallel answer faster, and a failed batch only leaves its own results unjudged.
   const judgeAll = (list: JudgeCandidate[], size: number) => Promise.allSettled(
     Array.from({length: Math.ceil(list.length/size)}, (_, b) => list.slice(b*size, (b + 1)*size)).map(batch =>
       judge.judge(query, batch, context ? {kind: context.kind, criteria: context.criteria, anime: context.anime} : undefined, screenshots).then(out => ({batch, out}))));
   const byKey = new Map<string,Verdict>();
   const collect = (settled: PromiseSettledResult<{batch: JudgeCandidate[]; out: JudgeResult}>[]) => {
     for (const s of settled) if (s.status === 'fulfilled') for (const [key, v] of s.value.out.verdicts) { byKey.set(key, v); modelOf.set(key, s.value.out.model); }
   };
   const settled = await judgeAll(candidates, config.JUDGE_BATCH_SIZE);
   collect(settled);
   // Lighter fallback models often skip candidates in long batches; the skipped ones are asked once more in short batches.
   const skipped = settled.flatMap(s => s.status === 'fulfilled' ? s.value.batch.filter(c => !byKey.has(c.key)) : []);
   if (skipped.length) collect(await judgeAll(skipped, RETRY_BATCH));
   const failed = settled.flatMap(s => s.status === 'rejected' ? [s.reason] : []);
   if (failed.length < settled.length) {
     verdicts = new Map(pool.flatMap(r => { const v = byKey.get(keys.get(r.id)!); return v ? [[r.id, v] as const] : []; }));
     providers.push(failed.length ? {provider: 'judge', status: 'partial', message: 'Some results could not be checked by AI and are listed after checked ones.'}
       : {provider: 'judge', status: 'ok', message: 'Results were checked for relevance by AI.'});
   } else {
     logFailure('judge_failed', failed[0]);
     providers.push(unavailable('judge', failed[0], 'AI relevance checking is unavailable right now; results use keyword ranking.'));
   }
 }

 const scored = results.map((r, i) => {
   const e = extra.get(r.id), v = verdicts?.get(r.id), d = e?.details;
   const clusters = e?.stored ?? [];
   const chosen = (v ? clusters.filter((_, j) => v.momentKeys.includes(`${keys.get(r.id)}m${j + 1}`))
     : clusters.filter(s => terms.some(term => s.cluster.mentions.some(m => tokens(m.excerpt).some(t => sameWord(term, t))))))
     .map(s => s.moment);
   const base = 1/(1 + i/10);
   // A clearly relevant result the judge places at a lesser-known source is an underrated find, unless its video is widely watched.
   const underrated = !!v?.lesserKnown && v.relevance >= 7 && (d?.views ?? 0) < config.UNDERRATED_MAX_VIEWS;
   const score = (verdicts ? (v ? v.relevance/10*1.5 + base*0.3 : base*0.3 - 0.5)
     : base + 0.1*chosen.length + (e?.discussions.length ? 0.1 : 0) + (e?.badges.includes('Official channel') ? 0.1 : 0))
     + (underrated && context?.underrated ? 0.3 : 0);
   const badges = [...(e?.badges ?? []), ...(underrated ? [UNDERRATED_BADGE] : [])];
   return {score, dropped: !!v && v.relevance <= 2, result: {...r,
     duration: r.duration ?? d?.duration ?? null, published_at: r.published_at ?? d?.publishedAt ?? null, creator: r.creator ?? (d?.channelTitle || null),
     moments: [...r.moments, ...chosen].sort((a, b) => a.start_seconds - b.start_seconds),
     badges: badges.length ? [...new Set(badges)] : r.badges,
     ...(previews.has(r.id) ? {preview: true} : {}),
     judgement: v ? {relevance: v.relevance, reason: v.reason, model: modelOf.get(keys.get(r.id)!) ?? ''} : (r.judgement ?? null)}};
 });
 const kept = scored.filter(s => !s.dropped);
 const ranked = (kept.length ? kept : scored).sort((a, b) => b.score - a.score).map(s => s.result);
 const shown = new Set(ranked.map(r => r.id));
 for (const id of previews.keys()) if (!shown.has(id)) previews.delete(id);
 return {results: ranked, providers, previews};
}
