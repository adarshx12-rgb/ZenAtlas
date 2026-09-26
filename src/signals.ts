import type { DB } from './db.js';
import type { Config } from './config.js';
import { searchInput, type Moment, type ProviderStatus, type Result } from './types.js';
import { SearXNG } from './providers.js';
import { discoveryQuery, sameWord, STOPWORDS, tokens } from './ranking.js';
import { UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { YouTubeData, youtubeId, type VideoDetails, type ViewerComment, type YouTubeClient } from './youtube.js';
import { makeJudge, type Judge, type JudgeCandidate, type JudgeContext, type JudgeResult, type Verdict } from './judge.js';
import { PageChecker, type PageCheck, type PageEvidence } from './pages.js';
import type { SearchTarget } from './planner.js';
import {PublicVideoEvidence,selectComments,type VideoEvidenceAdapter,type VideoEvidence} from './video-evidence.js';
import {importTranscript} from './moments.js';
import {retainedEvidence,queueSceneShortlist} from './retained-evidence.js';
import {queueCaptions} from './captions.js';
import { decide, detectFormat, inspect, type Decision, type Finding } from './evidence.js';
import { hardEach, type RequirementsContract } from './requirements.js';
import { accessKind, accessLabel, fullCopyAccess } from './access.js';

export const VIEWER_ANALYSIS_VERSION = 'viewer-comments-v1';
const MOMENTS_PER_VIDEO = 3;
const WINDOW_SECONDS = 30;
const LEAD_IN_SECONDS = 5;

export interface TimestampMention { commentId: string; seconds: number; excerpt: string; likes: number; weight: number }
export interface MomentCluster { start: number; end: number; score: number; mentions: TimestampMention[] }
export interface Discussion { title: string; url: string; snippet: string|null }
export interface SignalDeps { youtube?: YouTubeClient; judge?: Judge; pages?: PageCheck; videoEvidence?:VideoEvidenceAdapter; discussions?: (query: string) => Promise<Discussion[]> }
// What the search plan wanted, and which kind of search found each result (by result id).
// underrated is retained for callers; obscurity is a badge, never a ranking boost.
// contract: the search's shared requirements; findings: evidence already gathered for these candidates (exploration).
export interface SignalContext extends JudgeContext { targets: Map<string,SearchTarget>; underrated?: boolean;
 contract?: RequirementsContract; findings?: Finding[] }
export const UNDERRATED_BADGE = 'Underrated find';
// Uncertain verdicts remain in the trace, never as filler in the main results.
const UNVERIFIED_SCORE = 5;
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

interface Extra { details?: VideoDetails; page?: PageEvidence; video?:VideoEvidence; stored: {cluster: MomentCluster; moment: Moment}[]; comments: string[]; discussions: Discussion[]; badges: string[] }
// A structured worker log line with the upstream error code, never the raw error or request.
export function logFailure(event: string, error: unknown) {
 console.error(JSON.stringify({event, code: error instanceof UpstreamError ? error.code : 'error', status: (error as UpstreamError)?.status ?? null}));
}
const unavailable = (provider: string, error: unknown, message: string): ProviderStatus =>
 error instanceof UpstreamError && error.code === 'budget_exhausted'
   ? {provider, status: 'budget_exhausted', message: `The daily ${provider} limit has been reached.`}
   : {provider, status: 'unavailable', message};

// Enriches ranked discovery results with YouTube details and viewer timestamps, Reddit mentions and an AI relevance
// judgement, then re-orders them. Enrichment failures are optional; configured relevance checks must pass for display.
// previews: first-screen captures of checked web pages by result id, kept only as long as the searches that show them.
export interface Judged { id: string; relevance: number|null; reason: string|null; basis: 'metadata'|'viewer_claims'|'direct_evidence'|null }
export async function applySignals(db: DB, config: Config, query: string, results: Result[], deps: SignalDeps = {}, context?: SignalContext) {
 const providers: ProviderStatus[] = [];
 const previews = new Map<string,Buffer>();
 const findings: Finding[] = [], decisions = new Map<string,Decision>(), jevRecords = new Map<string,unknown>();
 if (!results.length) return {results, closest: [] as Result[], providers, previews, judged: [] as Judged[], findings, decisions, jev: jevRecords};
 const rows = (await db.query(`SELECT c.id,c.duration,(s.policy->>'viewer_signals')::boolean AS viewer_signals,
   (s.policy->>'transcripts')::boolean AS transcripts FROM content c
   JOIN sources s ON s.id=c.source_id WHERE c.id=ANY($1::uuid[]) AND s.status='active' AND s.health_status<>'down'
   AND c.expires_at>now() AND c.availability<>'unavailable'
   AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain`, [results.map(r => r.id)])).rows;
 const stored = new Map(rows.map(r => [r.id, r]));
 const official = new Set(config.OFFICIAL_YOUTUBE_CHANNELS.split(',').map(s => s.trim()).filter(Boolean));
 const extra = new Map<string,Extra>();
 const info = (id: string) => extra.get(id) ?? extra.set(id, {stored: [], comments: [], discussions: [], badges: []}).get(id)!;

 const youtube = deps.youtube ?? (config.YOUTUBE_API_KEY ? new YouTubeData(db, config) : undefined);
 // Details (one request per 50 videos) cover every permitted video; comments only the first SIGNAL_VIDEOS.
 const eligible = results.filter(r => youtubeId(r.canonical_url) && stored.get(r.id)?.viewer_signals);
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
         await db.query(`UPDATE content SET duration=coalesce(duration,$2),published_at=coalesce(published_at,$3),creator=coalesce(creator,$4),
           language=coalesce(language,$5) WHERE id=$1`,
           [r.id, d.duration, d.publishedAt, d.channelTitle || null, d.language ?? null]);
         if (!commented.has(r.id) || d.commentCount === null || d.commentCount === 0) return;
         const comments = await youtube.comments(d.id, config.SIGNAL_COMMENTS);
         e.comments = selectComments(comments,query);
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
 const webResults = context ? results.filter(r => !youtubeId(r.canonical_url)).slice(0, config.PAGE_CHECKS) : [];
 const pageTask = async (): Promise<ProviderStatus|null> => {
   if (!pages || !webResults.length) return null;
   let checked = 0, rendered = 0;
   await mapLimit(webResults, 8, async r => {
     const evidence = await pages.check(r.canonical_url).catch((): PageEvidence =>
       ({status: 'unavailable', title: null, description: null, text: null, libraries: [], badges: []}));
     const e = info(r.id); e.page = evidence; e.badges.push(...evidence.badges);
     if (evidence.status === 'checked') checked++;
     if (evidence.rendered) rendered++;
     if (evidence.screenshot) previews.set(r.id, evidence.screenshot);
   });
   // Blocked or script-only pages are common, so only a total failure is reported as a problem.
   return checked ? {provider: 'pages', status: 'ok', message: `${checked} of ${webResults.length} result pages were checked${rendered ? `, ${rendered} in a browser` : ''}.`}
     : {provider: 'pages', status: 'unavailable', message: 'Result pages could not be checked; websites are ranked from search snippets.'};
 };
 const adapter=deps.videoEvidence??new PublicVideoEvidence();
 const adapterTask=async()=>{
   const candidates=results.filter(r=>!youtubeId(r.canonical_url)&&stored.has(r.id)).slice(0,config.VIDEO_EVIDENCE_CHECKS);
   await mapLimit(candidates,4,async r=>{
     const policy=stored.get(r.id)!;
     const evidence=await adapter.check(r.canonical_url,{viewer_signals:policy.viewer_signals===true,transcripts:policy.transcripts===true},r.language).catch(()=>null);
     if(!evidence) return;
     const e=info(r.id); e.video=evidence; e.comments=selectComments(evidence.comments,query);
     if(evidence.caption && policy.transcripts===true) {
       try {await importTranscript(db,{content_id:r.id,language:evidence.caption.language,origin:evidence.caption.origin,
         content_version:evidence.caption.version,timing_quality:'provided',retention_permitted:true,segments:evidence.caption.segments});}
       catch {evidence.captionStatus='unavailable';}
     }
   });
 };
 const [youtubeStatus, reddit, pageStatus] = await Promise.all([youtubeTask(), redditTask(), pageTask(),adapterTask()]);
 for (const status of [youtubeStatus, reddit.status, pageStatus]) if (status) providers.push(status);
 const retained=await retainedEvidence(db,results.map(r=>r.id),query);
 for(const provider of ['peertube','archive']) {
   const checks=[...extra.values()].flatMap(e=>e.video?.provider===provider?[e.video]:[]);
   if(checks.length) providers.push({provider:`${provider}_evidence`,status:checks.some(e=>e.commentStatus==='available'||e.captionStatus==='available')?'ok':'partial',
     message:`${checks.filter(e=>e.commentStatus==='available').length} comment/review samples and ${checks.filter(e=>e.captionStatus==='available').length} caption tracks available across ${checks.length} checked results.`});
 }

 // Deterministic evidence for every candidate, from what was actually fetched; earlier findings (exploration) are kept.
 const contract = context?.contract;
 if (contract) {
   const earlier = context?.findings ?? [];
   for (const r of results) {
     const e = extra.get(r.id), d = e?.details;
     const fresh = inspect(contract, {url: r.canonical_url, title: r.title, description: r.description, published_at: r.published_at,
       page: e?.page, video: d ? {publishedAt: d.publishedAt, official: !!e?.badges.includes('Official channel'), channel: d.channelTitle} : undefined});
     const prior = earlier.filter(f => f.url === r.canonical_url);
     // A fresh inspection supersedes an earlier provisional or unknown finding for the same requirement.
     findings.push(...fresh, ...prior.filter(p => !fresh.some(f => f.requirement_id === p.requirement_id && (f.location.key ?? '') === (p.location.key ?? '')
       && (p.provisional || p.status === 'unknown' || !f.provisional))));
   }
 }
 const findingsOf = (url: string) => findings.filter(f => f.url === url);

 const terms = discoveryQuery(query).terms;
 const pool = results.slice(0, config.JUDGE_CANDIDATES);
 const keys = new Map(pool.map((r, i) => [r.id, `r${i + 1}`]));
 for (const r of pool) {
   const d = extra.get(r.id)?.details;
   const matched = matchDiscussions(r.title, youtubeId(r.canonical_url), d?.channelTitle ?? r.creator, reddit.threads, terms);
   if (matched.length) { const e = info(r.id); e.discussions = matched.slice(0, 3); e.badges.push('Discussed on Reddit'); }
 }

 const judge = deps.judge ?? makeJudge(db, config);
 let verdicts: Map<string,Verdict>|null = null;
 const modelOf = new Map<string,string>();
 if (judge) {
   const candidates: JudgeCandidate[] = pool.map(r => {
     const e = extra.get(r.id), d = e?.details, key = keys.get(r.id)!, duration = d?.duration ?? r.duration;
     const page = e?.page;
     return {key, kind: youtubeId(r.canonical_url) || context?.kind==='videos' || context?.targets.get(r.id) !== 'web' ? 'video' : 'website',
       site: new URL(r.canonical_url).hostname, url:r.canonical_url, title: r.title, channel: d?.channelTitle || r.creator,
       official: !!e?.badges.includes('Official channel'), duration: duration ? formatSeconds(duration) : null,
       live: e?.badges.find(b => /live/i.test(b)) ?? null,
       description: (d?.description || r.description || '').replace(/\s+/g, ' ').slice(0, 500) || null,
       comments: e?.comments ?? [], views: d?.views ?? null,
       transcripts:retained.get(r.id)?.transcripts??[],
       scenes:(retained.get(r.id)?.scenes??[]).map(s=>({start:s.start_seconds,end:s.end_seconds,description:s.summary,inspected_ranges:s.inspected_ranges})),
       ...(e?.video?{evidence_status:{comments:e.video.commentStatus,captions:e.video.captionStatus}}:{}),
       moments: (e?.stored ?? []).map((s, j) => ({key: `${key}m${j + 1}`,
         at: formatSeconds(Math.min(...s.cluster.mentions.map(m => m.seconds))), viewers_said: s.cluster.mentions.map(m => m.excerpt)})),
       discussions: (e?.discussions ?? []).map(t => t.title),
       ...(page ? {page: {status: page.status, title: page.title, description: page.description, text: page.text, libraries: page.libraries,
         screenshot: previews.has(r.id)}} : {}),
       ...(contract ? {description_source: d?.description ? 'api' as const : 'search' as const,
         inspected: {format: detectFormat(r.canonical_url, page).format, published: page?.meta?.published ?? d?.publishedAt?.slice(0, 10) ?? null,
           publisher: page?.meta?.publisher ?? page?.meta?.site_name ?? null, access: accessKind(r.canonical_url)}} : {})};
   });
   const listed = contract ? hardEach(contract).map(r => ({id: r.id, text: r.text, evidence: r.evidence})) : [];
   const requirements = listed.length ? listed : undefined;
   // The planner's "websites" is a guess, and told as such to a judge it rejects every video, even ones presenting the
   // requested tools or sites. Mixed keeps the websites preference without excluding them.
   const wanted = context?.kind === 'websites' ? 'mixed' as const : context?.kind ?? 'videos';
   const screenshots = new Map([...previews].flatMap(([id, image]) => keys.has(id) ? [[keys.get(id)!, image] as const] : []));
   // Smaller batches in parallel answer faster, and a failed batch only leaves its own results unjudged.
   const judgeAll = (list: JudgeCandidate[], size: number) => Promise.allSettled(
     Array.from({length: Math.ceil(list.length/size)}, (_, b) => list.slice(b*size, (b + 1)*size)).map(batch =>
       judge.judge(query, batch, context ? {kind: wanted, criteria: context.criteria, anime: context.anime, ...(requirements ? {requirements} : {})} : undefined,
         screenshots).then(out => ({batch, out}))));
   const byKey = new Map<string,Verdict>();
   const idOf = new Map([...keys].map(([id, key]) => [key, id]));
   const collect = (settled: PromiseSettledResult<{batch: JudgeCandidate[]; out: JudgeResult}>[]) => {
     for (const s of settled) if (s.status === 'fulfilled') {
       for (const [key, record] of s.value.out.jev ?? []) if (idOf.has(key)) jevRecords.set(idOf.get(key)!, record);
       for (const [key, v] of s.value.out.verdicts) {
         if (!s.value.batch.some(c => c.key === key)) continue;
         byKey.set(key, v); modelOf.set(key, v.reason.startsWith('Jev: ') ? config.JEV_MODEL : s.value.out.model);
       }
     }
   };
   const settled = await judgeAll(candidates, Math.min(config.JUDGE_BATCH_SIZE,12));
   collect(settled);
   // Lighter fallback models often skip candidates in long batches; the skipped ones are asked once more in short batches.
   const skipped = settled.flatMap(s => s.status === 'fulfilled' ? s.value.batch.filter(c => !byKey.has(c.key)) : []);
   if (skipped.length) collect(await judgeAll(skipped, RETRY_BATCH));
   const failed = settled.flatMap(s => s.status === 'rejected' ? [s.reason] : []);
   if (failed.length < settled.length) {
     verdicts = new Map(pool.flatMap(r => { const v = byKey.get(keys.get(r.id)!); return v ? [[r.id, v] as const] : []; }));
     providers.push(byKey.size < candidates.length ? {provider: 'judge', status: 'partial', message: 'Some results could not be checked by AI and were excluded.'}
       : {provider: 'judge', status: 'ok', message: 'Results were checked for relevance by AI.'});
   } else {
     logFailure('judge_failed', failed[0]);
     providers.push(unavailable('judge', failed[0], 'AI relevance checking is unavailable right now; unchecked discovery results were excluded.'));
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
   // Integer relevance dominates every tie-break. Arrival order, popularity and obscurity never
   // promote a weaker match. Unjudged candidates retain the deterministic lexical fallback order.
   const score = v ? v.relevance : -1;
   const evidence = e?.page?.status === 'checked' || chosen.length || r.evidence !== 'metadata_match' ? 1 : 0;
   const badges = [...(e?.badges ?? []), ...(underrated ? [UNDERRATED_BADGE] : [])];
   const evidenceData=retained.get(r.id);
   // With a contract, the decision on hard requirements (inspected evidence first, grounded judge quotes second)
   // decides what is shown; the judge's intent ceiling still bounds relevance.
   const decision = contract ? decide(contract, findingsOf(r.canonical_url), v?.requirementChecks) : null;
   if (decision) decisions.set(r.id, decision);
   const access = contract?.deliverable.completeness === 'full' ? accessKind(r.canonical_url) : null;
   if (access && fullCopyAccess(access) && decision?.requirements.some(q => q.status === 'supported' &&
     contract!.requirements.find(x => x.id === q.id)?.kind === 'completeness')) badges.push(accessLabel(access)!);
   const weak = !v || v.relevance <= UNVERIFIED_SCORE || !!v.intentChecks?.some(c=>c.status!=='supported');
   // Without a judge (lexical mode) nothing can be verified, so results stay listed with their uncertainties unless
   // inspected evidence contradicts them.
   const dropped = decision ? (judge ? decision.status !== 'verified' || weak : decision.status === 'excluded') : !!judge && weak;
   const basis:'metadata'|'viewer_claims'|'direct_evidence'=evidenceData?.transcripts.length||evidenceData?.scenes.length||e?.page?.status==='checked'?'direct_evidence':e?.comments.length?'viewer_claims':'metadata';
   return {score, evidence, base, dropped, decision, result: {...r,
     evidence_coverage:{comments:e?.video?.commentStatus??(e?.comments.length?'available':'unavailable'),
       captions:e?.video?.captionStatus??(evidenceData?.transcripts.length?'available':'unavailable'),
       transcript_passages:evidenceData?.transcripts.length??0,analysed_scenes:evidenceData?.scenes.length??0,basis},
     duration: r.duration ?? d?.duration ?? null, published_at: r.published_at ?? d?.publishedAt ?? null, creator: r.creator ?? (d?.channelTitle || null),
     language: r.language ?? d?.language ?? null,
     moments: [...r.moments, ...chosen].sort((a, b) => a.start_seconds - b.start_seconds),
     badges: badges.length ? [...new Set(badges)] : r.badges,
     ...(previews.has(r.id) ? {preview: true} : {}),
     judgement: v ? {relevance: decision && decision.status !== 'verified' ? Math.min(v.relevance, decision.status === 'excluded' ? 4 : UNVERIFIED_SCORE) : v.relevance,
       reason: v.reason, model: modelOf.get(keys.get(r.id)!) ?? '',
       ...(v.intentChecks?{intent_checks:v.intentChecks}:{})} : null,
     ...(decision ? {requirements: decision.requirements, uncertainties: [...decision.notes,
       ...decision.requirements.filter(q => q.status === 'unknown').map(q => `Not confirmed: ${q.text}`)]} : {})}};
 });
 const order = (a: typeof scored[number], b: typeof scored[number]) => b.score - a.score || (a.score >= 0 ? b.evidence - a.evidence : 0) || b.base - a.base;
 const kept = scored.filter(s => !s.dropped);
 const rejected=scored.length-kept.length;
 if(rejected) providers.push({provider:'relevance_filter',status:'ok',message:kept.length
   ? `${rejected} weak, uncertain or unchecked candidates were excluded. Fewer results may be shown.`
   : 'No sufficiently supported matches were found. Weak, uncertain and unchecked candidates were excluded.'});
 const ranked = kept.sort(order).map(s => s.result);
 // Optional leads are retained separately and fetched only through the closest-matches endpoint.
 // Explicit mismatches and unchecked results never qualify, even for this broader view.
 // With a contract, uncertain candidates (hard requirements unconfirmed, none contradicted) are the closest matches.
 const closest: Result[] = scored.filter(s=>s.dropped && s.decision?.status!=='excluded' && s.score>=3 &&
   (s.score<=UNVERIFIED_SCORE || s.decision?.status==='uncertain') &&
   !s.result.judgement?.intent_checks?.some(c=>c.status==='mismatch')).sort(order).slice(0,20).map(s=>({
     ...s.result, moments:[], evidence:'metadata_match', preview:false,
     badges:[...new Set([...(s.result.badges??[]),'Closest match'])],
   }));
 const shown = new Set(ranked.map(r => r.id));
 for (const id of previews.keys()) if (!shown.has(id)) previews.delete(id);
 // With nothing verified, the closest candidates are the videos worth watching: they are queued for inspection too, so a
 // later search can confirm or reject what only watching can settle (actions, their order, sound).
 const queued=await queueSceneShortlist(db,config,ranked.length?ranked:closest,query,ranked.length?6:3).catch(()=>0);
 const unwatched=!ranked.length && closest.some(r=>r.duration!==null) && !closest.some(r=>(r.evidence_coverage?.analysed_scenes??0)>0);
 if(unwatched) providers.push({provider:'video_inspection',status:'ok',message:queued
   ? `No candidate video has been watched yet, so what happens in them (actions, their order, sound) is unverified. ${queued} were queued for inspection; search again in a few minutes to check them.`
   : 'No candidate video has been watched, and video inspection is not available for them right now, so what happens in them (actions, their order, sound) is unverified.'});
 else if(queued) providers.push({provider:'scene_analysis',status:'partial',message:`${queued} videos queued for scene analysis; these pending analyses are not evidence in this ranking.`});
 const captioned=await queueCaptions(db,config,ranked).catch(()=>0);
 if(captioned) providers.push({provider:'youtube_captions',status:'partial',message:`${captioned} videos queued for caption fetching; their transcripts help later searches, not this one.`});
 // Every candidate's verdict, rejected ones included, for the search's learning trace.
 const judged: Judged[] = scored.map(s => ({id: s.result.id, relevance: s.result.judgement?.relevance ?? null, reason: s.result.judgement?.reason ?? null,
   basis: s.result.judgement ? s.result.evidence_coverage?.basis ?? null : null}));
 return {results: ranked, closest, providers, previews, judged, findings, decisions, jev: jevRecords};
}
