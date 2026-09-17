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
 // "Episode N - Title" strings from streaming catalogues (best effort: often partial or empty, especially for
 // older or very long-running shows), used to hint at which episode a specific scene belongs to.
 episodeTitles: string[];
}
export interface AnimeClient { lookup(query: string): Promise<AnimeMatch|null> }

// Connector words common in fan queries ("Goku vs Cell") that would otherwise credit an episode title for a
// coincidental match on the connector rather than on a character or event the query actually named.
const WEAK_TERMS = new Set(['vs', 'versus']);

// Episode titles whose own words relate to the query, as a loose hint toward the specific episode, season or arc a
// request about a scene or moment belongs to. Thematic episode titles rarely spell out a scene's exact keywords
// (a "Gohan" episode need not mention "Cell"), so this is meant to help the model's own knowledge of the show, not
// to pick the episode by itself: capped generously rather than to a single best guess.
export function matchingEpisodes(anime: AnimeMatch, query: string, limit = 15): string[] {
 const terms = discoveryQuery(query).terms.filter(t => !WEAK_TERMS.has(t));
 if (!terms.length || !anime.episodeTitles.length) return [];
 return anime.episodeTitles.map(title => ({title, score: tokens(title).filter(w => terms.some(t => sameWord(w, t))).length}))
   .filter(e => e.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(e => e.title);
}

// A compact shape for prompts: AniList's own catalogue data, but still free text from the web, so callers still
// tell the model to treat it as data, not instructions. matching_episode_titles is included only when the query
// singles some out, so an ordinary series-level match does not bloat the prompt with irrelevant episodes.
export function animeSummary(anime: AnimeMatch, query?: string) {
 const episodes = query ? matchingEpisodes(anime, query) : [];
 return {title: anime.title, romaji: anime.romaji, english: anime.english, native: anime.native,
   synonyms: anime.synonyms, genres: anime.genres, format: anime.format, episodes: anime.episodes,
   status: anime.status, studios: anime.studios, season_year: anime.seasonYear,
   ...(episodes.length ? {matching_episode_titles: episodes} : {})};
}

const QUERY = `query($search: String) {
 Page(perPage: 5) {
   media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
     id siteUrl
     title { romaji english native }
     synonyms genres format episodes status seasonYear averageScore
     studios(isMain: true) { nodes { name } }
     streamingEpisodes { title }
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
 streamingEpisodes: z.array(z.object({title: z.string()})).default([]),
});
const response = z.object({data: z.object({Page: z.object({media: z.array(media).default([])})}).nullable().optional()});

// A request naming characters or an event ("gohan ssj2 vs cell") rather than the show never matches on title, since
// the title text shares no words with it. Each significant query word is searched as a character name in parallel;
// character-name search is noisy on ordinary English words (for example "best", "fight" or "zero" each coincide
// with a real, sometimes popular character), so a show only counts when at least two independently searched words
// each name a character best known for it, and only characters clearing a modest popularity floor are counted.
const CHARACTER_QUERY = `query($search: String) {
 Page(perPage: 1) {
   characters(search: $search) {
     favourites
     media(perPage: 1, sort: POPULARITY_DESC) {
       nodes {
         id siteUrl
         title { romaji english native }
         synonyms genres format episodes status seasonYear averageScore
         studios(isMain: true) { nodes { name } }
         streamingEpisodes { title }
       }
     }
   }
 }
}`;
const characterResponse = z.object({data: z.object({Page: z.object({characters: z.array(z.object({
 favourites: z.number().default(0), media: z.object({nodes: z.array(media).default([])}).default({nodes: []}),
})).default([])})}).nullable().optional()});
const CHARACTER_FAVOURITES_FLOOR = 100;
const CHARACTER_TERMS_TRIED = 5;
const CHARACTER_VOTES_NEEDED = 2;

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

function toAnimeMatch(top: z.infer<typeof media>): AnimeMatch {
 return {id: top.id, title: top.title.english ?? top.title.romaji ?? top.title.native ?? 'Unknown',
   romaji: top.title.romaji, english: top.title.english, native: top.title.native,
   synonyms: top.synonyms, genres: top.genres, format: top.format, episodes: top.episodes, status: top.status,
   studios: top.studios.nodes.map(n => n.name), seasonYear: top.seasonYear, averageScore: top.averageScore, siteUrl: top.siteUrl,
   episodeTitles: [...new Set(top.streamingEpisodes.map(e => e.title))].slice(0, 500)};
}

export class AniListClient implements AnimeClient {
 constructor(private db: DB, private config: Config, private transport = fetchJSON) {}
 async lookup(query: string): Promise<AnimeMatch|null> {
   const direct = await this.search(query);
   if (direct) return direct;
   // Later, narrower attempts only refine an already-decided miss; their own failure (for example a spent budget)
   // does not turn that miss into an error.
   const core = coreTitle(query);
   if (core) { const viaCore = await this.search(core).catch(() => null); if (viaCore) return viaCore; }
   return this.byCharacters(query).catch(() => null);
 }
 // One title search exactly as searches send it, for the watchdog: errors are thrown, not treated as a miss.
 probe(title: string): Promise<AnimeMatch|null> { return this.search(title); }
 private async search(query: string): Promise<AnimeMatch|null> {
   if (!await takeBudget(this.db, 'anilist_calls', this.config.ANILIST_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
   const payload = await this.transport(ORIGIN, {method: 'POST', trustedOrigin: ORIGIN,
     timeoutMs: this.config.PROVIDER_TIMEOUT_MS, redirects: 0, body: {query: QUERY, variables: {search: query.slice(0, 200)}}});
   const parsed = response.safeParse(payload);
   if (!parsed.success) throw new UpstreamError('malformed_response');
   const [top] = parsed.data.data?.Page.media ?? [];
   return top && confident(query, top) ? toAnimeMatch(top) : null;
 }
 private async searchCharacter(term: string): Promise<{media: z.infer<typeof media>; favourites: number}|null> {
   if (!await takeBudget(this.db, 'anilist_calls', this.config.ANILIST_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
   const payload = await this.transport(ORIGIN, {method: 'POST', trustedOrigin: ORIGIN,
     timeoutMs: this.config.PROVIDER_TIMEOUT_MS, redirects: 0, body: {query: CHARACTER_QUERY, variables: {search: term.slice(0, 100)}}});
   const parsed = characterResponse.safeParse(payload);
   if (!parsed.success) throw new UpstreamError('malformed_response');
   const top = parsed.data.data?.Page.characters[0];
   const show = top?.media.nodes[0];
   return top && show ? {media: show, favourites: top.favourites} : null;
 }
 // Fired in parallel, not one at a time, so a query with nothing to find this way costs one round trip, not several.
 private async byCharacters(query: string): Promise<AnimeMatch|null> {
   const terms = discoveryQuery(query).terms.filter(t => t.length >= 3 && !WEAK_TERMS.has(t)).slice(0, CHARACTER_TERMS_TRIED);
   if (terms.length < CHARACTER_VOTES_NEEDED) return null;
   const hits = await Promise.all(terms.map(term => this.searchCharacter(term).catch(() => null)));
   const votes = new Map<number, {media: z.infer<typeof media>; count: number}>();
   for (const hit of hits) {
     if (!hit || hit.favourites < CHARACTER_FAVOURITES_FLOOR) continue;
     const entry = votes.get(hit.media.id) ?? {media: hit.media, count: 0};
     entry.count++; votes.set(hit.media.id, entry);
   }
   const [best] = [...votes.values()].sort((a, b) => b.count - a.count);
   return best && best.count >= CHARACTER_VOTES_NEEDED ? toAnimeMatch(best.media) : null;
 }
}
