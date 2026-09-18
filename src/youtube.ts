import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';

// Official YouTube Data API v3. Each videos.list or commentThreads.list call costs one quota unit.
const ORIGIN = 'https://www.googleapis.com';

export interface VideoDetails {
 id: string; title: string; description: string; channelId: string; channelTitle: string;
 publishedAt: string|null; duration: number|null; live: 'none'|'live'|'upcoming'; wasLive: boolean;
 // commentCount is null when the video's comments are turned off (YouTube then omits the count).
 views?: number|null; commentCount?: number|null;
 // The spoken language, narrowed to its primary subtag, or null when the uploader declared none.
 language?: string|null;
}
export interface ViewerComment { id: string; text: string; likes: number }
export interface YouTubeClient {
 videos(ids: string[]): Promise<Map<string,VideoDetails>>;
 comments(videoId: string, max: number): Promise<ViewerComment[]>;
}

export function youtubeId(url: string): string|null {
 const u = new URL(url);
 const id = u.searchParams.get('v');
 return u.hostname === 'www.youtube.com' && u.pathname === '/watch' && id && /^[\w-]{11}$/.test(id) ? id : null;
}
// YouTube reports a BCP-47 tag, which may carry a region ("hi-IN") or a script. Searches filter by
// language alone, so only the primary subtag is kept; anything that is not a language tag is dropped.
export function primaryLanguage(tag: string|undefined): string|null {
 const first = (tag ?? '').trim().toLowerCase().split('-')[0];
 return /^[a-z]{2,3}$/.test(first) ? first : null;
}
export function isoSeconds(value: string|undefined): number|null {
 const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value ?? '');
 if (!m) return null;
 const total = Number(m[1] ?? 0)*86400 + Number(m[2] ?? 0)*3600 + Number(m[3] ?? 0)*60 + Number(m[4] ?? 0);
 return total > 0 && total <= 604800 ? total : null;
}

const videoList = z.object({items: z.array(z.object({
 id: z.string(),
 snippet: z.object({title: z.string(), description: z.string().default(''), channelId: z.string(),
   channelTitle: z.string().default(''), publishedAt: z.string().optional(), liveBroadcastContent: z.string().optional(),
   defaultAudioLanguage: z.string().optional(), defaultLanguage: z.string().optional()}),
 contentDetails: z.object({duration: z.string().optional()}).optional(),
 liveStreamingDetails: z.object({actualStartTime: z.string().optional()}).optional(),
 statistics: z.object({viewCount: z.string().regex(/^\d{1,15}$/).optional(), commentCount: z.string().regex(/^\d{1,15}$/).optional()}).optional(),
})).max(50).default([])});
const commentList = z.object({items: z.array(z.object({
 id: z.string(),
 snippet: z.object({topLevelComment: z.object({snippet: z.object({
   textOriginal: z.string().optional(), textDisplay: z.string().optional(), likeCount: z.number().int().nonnegative().default(0)})})}),
})).max(100).default([])});

export class YouTubeData implements YouTubeClient {
 constructor(private db: DB, private config: Config, private transport = fetchJSON) {}
 private async get(path: string, params: Record<string,string>) {
   if (!await takeBudget(this.db, 'youtube_units', this.config.YOUTUBE_DAILY_UNITS)) throw new UpstreamError('budget_exhausted');
   const url = new URL(`/youtube/v3/${path}`, ORIGIN);
   url.search = new URLSearchParams({...params, key: this.config.YOUTUBE_API_KEY}).toString();
   return this.transport(url.href, {trustedOrigin: ORIGIN, timeoutMs: this.config.PROVIDER_TIMEOUT_MS, redirects: 0, maxBytes: 2*1024*1024});
 }
 async videos(ids: string[]) {
   const found = new Map<string,VideoDetails>();
   for (let i = 0; i < ids.length; i += 50) {
     const data = videoList.parse(await this.get('videos', {part: 'snippet,contentDetails,liveStreamingDetails,statistics', id: ids.slice(i, i+50).join(','), maxResults: '50'}));
     for (const v of data.items) {
       const published = v.snippet.publishedAt ? new Date(v.snippet.publishedAt) : null;
       const live = v.snippet.liveBroadcastContent;
       found.set(v.id, {id: v.id, title: v.snippet.title, description: v.snippet.description, channelId: v.snippet.channelId,
         channelTitle: v.snippet.channelTitle, publishedAt: published && Number.isFinite(published.getTime()) ? published.toISOString() : null,
         duration: isoSeconds(v.contentDetails?.duration), live: live === 'live' || live === 'upcoming' ? live : 'none',
         wasLive: !!v.liveStreamingDetails?.actualStartTime, views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : null,
         // The audio language is what a viewer hears; the title's own language is the weaker fallback.
         language: primaryLanguage(v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage),
         commentCount: v.statistics ? (v.statistics.commentCount ? Number(v.statistics.commentCount) : null) : undefined});
     }
   }
   return found;
 }
 async comments(videoId: string, max: number) {
   const data = commentList.parse(await this.get('commentThreads', {part: 'snippet', videoId, order: 'relevance',
     maxResults: String(max), textFormat: 'plainText'}));
   return data.items.map(t => {
     const s = t.snippet.topLevelComment.snippet;
     return {id: t.id, text: (s.textOriginal ?? s.textDisplay ?? '').slice(0, 5000), likes: s.likeCount};
   }).filter(c => c.text.trim());
 }
}
