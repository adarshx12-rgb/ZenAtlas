import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { discoveryQuery, sameWord, STOPWORDS, tokens } from './ranking.js';

const ORIGIN = 'https://graphql.anilist.co';

export interface AnimeMatch {
 id: number; title: string; romaji: string|null; english: string|null; native: string|null;
 synonyms: string[]; genres: string[]; format: string|null; episodes: number|null; status: string|null;
 studios: string[]; seasonYear: number|null; averageScore: number|null; siteUrl: string;
}
export interface AnimeClient { lookup(query: string): Promise<AnimeMatch|null> }

// A compact shape for prompts: AniList's own catalogue data, but still free text from the web, so callers still
// tell the model to treat it as data, not instructions.
export function animeSummary(anime: AnimeMatch) {
 return {title: anime.title, romaji: anime.romaji, english: anime.english, native: anime.native,
   synonyms: anime.synonyms, genres: anime.genres, format: anime.format, episodes: anime.episodes,
   status: anime.status, studios: anime.studios, season_year: anime.seasonYear};
}

const QUERY = `query($search: String) {
 Page(perPage: 5) {
   media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
     id siteUrl
     title { romaji english native }
     synonyms genres format episodes status seasonYear averageScore
     studios(isMain: true) { nodes { name } }
   }
 }
}`;
const media = z.object({
 id: z.number(), siteUrl: z.string(),
 title: z.object({romaji: z.string().nullable(), english: z.string().nullable(), native: z.string().nullable()}),
 synonyms: z.array(z.string()).default([]), genres: z.array(z.string()).default([]),
 format: z.string().nullable().default(null), episodes: z.number().nullable().default(null),
 status: z.string().nullable().default(null), seasonYear: z.number().nullable().default(null),
 averageScore: z.number().nullable().default(null),
 studios: z.object({nodes: z.array(z.object({name: z.string()}))}).default({nodes: []}),
});
const response = z.object({data: z.object({Page: z.object({media: z.array(media).default([])})}).nullable().optional()});

// Confident either way: most of a name variant's own words appear in the query (a short, canonical title such as
// "Naruto" matched against a longer request; a single-word title only counts when the query is little more than
// that title, so a common word inside an unrelated request such as a recipe is not mistaken for a match), or most
// of the query's words appear in some name (a verbose or compound title, such as an arc-specific entry whose own
// title already reads "<Series> <Arc name> Arc", that adds words no reasonable query would include).
function confident(query: string, top: z.infer<typeof media>): boolean {
 const queryTerms = discoveryQuery(query).terms;
 if (!queryTerms.length) return false;
 const names = [top.title.romaji, top.title.english, top.title.native, ...top.synonyms].filter((n): n is string => !!n);
 const titleWords = names.map(name => [...new Set(tokens(name).filter(w => w.length >= 2 && !STOPWORDS.has(w)))]);
 if (titleWords.some(words => {
   if (!words.length) return false;
   const matched = words.filter(w => queryTerms.some(t => sameWord(w, t))).length;
   return words.length >= 2 ? matched/words.length >= 0.7 : matched === words.length && queryTerms.length <= 2;
 })) return true;
 const explained = queryTerms.filter(t => titleWords.some(words => words.some(w => sameWord(w, t)))).length;
 return queryTerms.length >= 2 && explained/queryTerms.length >= 0.6;
}

// Words that describe a video rather than name the anime, dropped from a query's end for the fallback search below.
const NOISE = new Set(['season','seasons','episode','episodes','ep','eps','arc','dub','dubbed','sub','subbed','subtitled',
 'english','japanese','movie','film','ova','ona','special','specials','scene','scenes','clip','clips','compilation',
 'full','part','opening','ending','op','ed','trailer','recap','best','top','moments','highlights','review','explained']);

// AniList's search matches title text closely, so a natural request like "attack on titan season 4 episode 28"
// often matches nothing. This drops "season 4"/"episode 28"-style pairs anywhere and trailing descriptive words,
// stopping at the first remaining word, for a second, narrower attempt. Returns null when there is nothing to trim.
function coreTitle(query: string): string|null {
 const stripped = query.replace(/\b(?:season|s)\s*\d+\b/gi, ' ').replace(/\b(?:episode|ep|e)\s*\d+\b/gi, ' ').replace(/\s+/g, ' ').trim();
 const words = stripped.toLowerCase().split(/\s+/).filter(Boolean);
 while (words.length > 1 && (NOISE.has(words.at(-1)!) || /^\d+$/.test(words.at(-1)!))) words.pop();
 const core = words.join(' ');
 return core.length >= 2 && core !== query.trim().toLowerCase() ? core : null;
}

export class AniListClient implements AnimeClient {
 constructor(private db: DB, private config: Config, private transport = fetchJSON) {}
 async lookup(query: string): Promise<AnimeMatch|null> {
   const direct = await this.search(query);
   if (direct) return direct;
   const core = coreTitle(query);
   // The narrower attempt only refines a genuine miss; its own failure (for example a spent budget) does not
   // turn an already-decided "no match" into an error.
   if (!core) return null;
   try { return await this.search(core); } catch { return null; }
 }
 private async search(query: string): Promise<AnimeMatch|null> {
   if (!await takeBudget(this.db, 'anilist_calls', this.config.ANILIST_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
   const payload = await this.transport(ORIGIN, {method: 'POST', trustedOrigin: ORIGIN,
     timeoutMs: this.config.PROVIDER_TIMEOUT_MS, redirects: 0, body: {query: QUERY, variables: {search: query.slice(0, 200)}}});
   const parsed = response.safeParse(payload);
   if (!parsed.success) throw new UpstreamError('malformed_response');
   const [top] = parsed.data.data?.Page.media ?? [];
   if (!top || !confident(query, top)) return null;
   return {id: top.id, title: top.title.english ?? top.title.romaji ?? top.title.native ?? 'Unknown',
     romaji: top.title.romaji, english: top.title.english, native: top.title.native,
     synonyms: top.synonyms, genres: top.genres, format: top.format, episodes: top.episodes, status: top.status,
     studios: top.studios.nodes.map(n => n.name), seasonYear: top.seasonYear, averageScore: top.averageScore, siteUrl: top.siteUrl};
 }
}
