import type { Config } from './config.js';
import type { DB } from './db.js';
import type { FieldRoute } from './field-routing.js';
import type { SourceRow } from './doc-sources.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { publicURL } from './urls.js';
import { deepCircuit, interleave, remaining, SourceCircuit, within } from './deep-runtime.js';

export type DeepTab = 'web'|'docs';
export interface DeepConnector {
 name: string; fields: string[]; tabs: DeepTab[]; domains: string[];
 // What the source holds and where from, for the field router choosing which sources fit a request.
 about: string;
 search(query: string): Promise<SourceRow[]>;
}
type Request = (name: string, url: string, options?: Parameters<typeof fetchJSON>[1]) => Promise<unknown>;
// External payloads are deliberately narrowed at their boundary; invalid rows do not poison valid siblings.
type RecordValue = Record<string, any>;
const obj = (v: unknown): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const arr = (v: unknown): RecordValue[] => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const first = (v: unknown): string => Array.isArray(v) ? v.filter(x => typeof x === 'string').join('; ') : str(v);
const urlWith = (base: string, params: Record<string, string>) => { const u = new URL(base); u.search = new URLSearchParams(params).toString(); return u.href; };
function row(engine: string, url: unknown, title: unknown, snippet: unknown = null, published: unknown = null): SourceRow[] {
 try {
   const u = publicURL(str(url));
   if (!str(title).trim() || u.href.length > 2048) return [];
   return [{engine: `deep:${engine}`, url: u.href, title, snippet, published}];
 } catch { return []; }
}
export function topRows(rows: SourceRow[], limit = 5): SourceRow[] {
 return [...new Map(rows.map(r => [r.url, r])).values()].slice(0, limit);
}

// catalog.data.gov's CKAN API was retired (404, 2026-10-08).
export const CKAN_PORTALS = [
 {domain: 'data.gov.uk', endpoint: 'https://ckan.publishing.service.gov.uk/api/3/action/package_search', record: 'https://www.data.gov.uk/dataset/'},
 {domain: 'open.canada.ca', endpoint: 'https://open.canada.ca/data/api/3/action/package_search', record: 'https://open.canada.ca/data/en/dataset/'},
] as const;

// Kept separately for fixture testing, including the modern EU portal's SPARQL response.
export function parseDeepRows(name: string, value: unknown, portal = CKAN_PORTALS[0].record as string): SourceRow[] {
 const d = obj(value), r = (url: unknown, title: unknown, snippet?: unknown, date?: unknown) => row(name, url, title, snippet, date);
 const payload: Record<string, unknown> = {europe_pmc: d.resultList?.result, clinical_trials: d.studies, openalex: d.results,
   doaj: d.results, courtlistener: d.results, sec_edgar: d.hits?.hits, govinfo: d.results, federal_register: d.results,
   ckan: d.result?.results, eu_data: d.results?.bindings, loc: d.results, europeana: d.items, open_library: d.docs,
   huggingface: value, stack_exchange: d.items, gdelt: d.articles};
 if (!Array.isArray(payload[name])) throw new UpstreamError('malformed_response');
 switch (name) {
   case 'europe_pmc': return arr(d.resultList?.result).flatMap(p => r(p.pmcid ? `https://europepmc.org/articles/${encodeURIComponent(p.pmcid)}` :
     p.id && p.source ? `https://europepmc.org/article/${encodeURIComponent(p.source)}/${encodeURIComponent(p.id)}` : '', p.title, p.abstractText ?? p.authorString, p.firstPublicationDate));
   case 'clinical_trials': return arr(d.studies).flatMap(p => { const m = obj(p.protocolSection), id = obj(m.identificationModule), desc = obj(m.descriptionModule);
     return r(/^NCT\d+$/.test(str(id.nctId)) ? `https://clinicaltrials.gov/study/${id.nctId}` : '', id.officialTitle ?? id.briefTitle, desc.briefSummary,
       m.statusModule?.studyFirstSubmitDate); });
   case 'openalex': return arr(d.results).flatMap(p => r(p.best_oa_location?.pdf_url ?? p.primary_location?.pdf_url ?? p.primary_location?.landing_page_url ?? p.doi ?? p.id,
     p.display_name ?? p.title, p.abstract_inverted_index ? Object.entries(obj(p.abstract_inverted_index)).flatMap(([w, positions]) =>
       Array.isArray(positions) ? positions.filter(Number.isInteger).map((i: number) => [i, w] as const) : []).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ') : null, p.publication_date));
   case 'doaj': return arr(d.results).flatMap(p => { const b = obj(p.bibjson), link = arr(b.link).find(l => l.type === 'fulltext');
     return r(link?.url ?? (p.id ? `https://doaj.org/article/${encodeURIComponent(p.id)}` : ''), b.title, b.abstract, b.year ? `${b.year}-01-01` : null); });
   case 'courtlistener': return arr(d.results).flatMap(p => r(str(p.absolute_url).startsWith('/') ? `https://www.courtlistener.com${p.absolute_url}` : '',
     p.caseName, p.snippet ?? arr(p.opinions).map(o => str(o.snippet)).join(' '), p.dateFiled));
   case 'sec_edgar': return arr(d.hits?.hits).flatMap(p => { const s = obj(p._source), id = str(p._id).split(':'), cik = str(s.ciks?.[0]).replace(/^0+/, '');
     const accession = str(s.adsh || id[0]).replace(/-/g, ''), file = id.slice(1).join(':');
     return r(/^\d+$/.test(cik) && /^\d+$/.test(accession) && /^[\w.-]+$/.test(file) ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${file}` : '',
       `${first(s.display_names)} ${str(s.form)} ${str(s.file_date)}`.trim(), first(s.file_description ?? s.root_forms), s.file_date); });
   case 'govinfo': return arr(d.results).flatMap(p => r(p.packageId ? `https://www.govinfo.gov/content/pkg/${encodeURIComponent(p.packageId)}/pdf/${encodeURIComponent(p.granuleId || p.packageId)}.pdf` : '',
     p.title, p.collectionName ?? p.collectionCode, p.dateIssued));
   case 'federal_register': return arr(d.results).flatMap(p => r(p.pdf_url ?? p.html_url, p.title, p.abstract, p.publication_date));
   case 'ckan': {
     if (d.success === false) throw new UpstreamError('upstream_failure');
     return arr(d.result?.results).flatMap(p => r(arr(p.resources).find(x => /\.(pdf|csv|xlsx?|docx?|pptx?|epub)(?:\?|$)/i.test(str(x.url)))?.url ??
       (p.id || p.name ? portal + encodeURIComponent(p.id || p.name) : ''), p.title, p.notes, p.metadata_modified));
   }
   case 'eu_data': return arr(d.results?.bindings).flatMap(p => r(p.download?.value ?? p.dataset?.value, p.title?.value, p.description?.value));
   case 'loc': return arr(d.results).flatMap(p => r(p.url ?? p.id, p.title, first(p.description), p.date));
   case 'europeana': {
     if (d.success === false) throw new UpstreamError('upstream_failure');
     return arr(d.items).flatMap(p => r(p.id ? `https://www.europeana.eu/item${str(p.id).startsWith('/') ? '' : '/'}${p.id}` : '', first(p.title), first(p.dcDescription ?? p.dataProvider), first(p.year)));
   }
   case 'open_library': return arr(d.docs).flatMap(p => r(/^\/(works|books)\/[\w]+$/.test(str(p.key)) ? `https://openlibrary.org${p.key}` : '',
     p.title, first(p.author_name), p.first_publish_year ? `${p.first_publish_year}-01-01` : null));
   case 'huggingface': return arr(value).flatMap(p => r(/^[\w.-]+\/[\w.-]+$/.test(str(p.id)) ? `https://huggingface.co/${portal === 'datasets' ? 'datasets/' : ''}${p.id}` : '',
     p.id, first(p.tags), p.lastModified ?? p.createdAt));
   case 'stack_exchange': {
     if (d.error_id) throw new UpstreamError('upstream_failure');
     return arr(d.items).flatMap(p => r(p.link, p.title, p.body ?? first(p.tags), typeof p.creation_date === 'number' ? new Date(p.creation_date * 1000).toISOString() : null));
   }
   case 'gdelt': return arr(d.articles).flatMap(p => r(p.url, p.title, p.domain, str(p.seendate).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')));
   default: return [];
 }
}

export function deepRegistry(config: Config, request: Request): DeepConnector[] {
 const entries: DeepConnector[] = [];
 const add = (name: string, fields: string[], domains: string[], about: string, search: DeepConnector['search'], enabled = true) => {
   if (enabled) entries.push({name, fields, domains, about, tabs: ['web', 'docs'], search: async q => topRows(await search(q))});
 };
 const get = async (name: string, base: string, params: Record<string, string>, options?: Parameters<typeof fetchJSON>[1]) =>
   parseDeepRows(name, await request(name, urlWith(base, params), options));
 // Sources that need every word in a title or name: when the keywords find nothing, their first three words once more.
 const fewer = (search: DeepConnector['search']): DeepConnector['search'] => async q => {
   const rows = await search(q), words = q.split(/\s+/).filter(Boolean);
   return rows.length || words.length <= 3 ? rows : search(words.slice(0, 3).join(' '));
 };
 // Stable registry priority is field-specific: specialist sources precede broad catalogues.
 add('europe_pmc', ['medicine', 'science', 'nature'], ['europepmc.org'], 'biomedical and life-science research papers and abstracts (worldwide)', q => get('europe_pmc', 'https://www.ebi.ac.uk/europepmc/webservices/rest/search', {query: q, format: 'json', pageSize: '5', resultType: 'core'}));
 add('clinical_trials', ['medicine'], ['clinicaltrials.gov'], 'registered clinical trials and their results (worldwide, US registry)', q => get('clinical_trials', 'https://clinicaltrials.gov/api/v2/studies', {'query.term': q, pageSize: '5', format: 'json'}));
 add('courtlistener', ['law'], ['courtlistener.com'], 'US court opinions and case law', q => get('courtlistener', 'https://www.courtlistener.com/api/rest/v4/search/', {q, type: 'o', order_by: 'score desc'},
   {headers: {Authorization: `Token ${config.COURTLISTENER_API_KEY}`}}), !!config.COURTLISTENER_API_KEY);
 add('sec_edgar', ['finance'], ['sec.gov'], 'filings of US-listed companies (10-K, 10-Q, 8-K, prospectuses)', q => get('sec_edgar', 'https://efts.sec.gov/LATEST/search-index', {q, dateRange: 'all', from: '0', size: '5'},
   {headers: {'User-Agent': config.SEC_USER_AGENT}}), !!config.SEC_USER_AGENT);
 add('govinfo', ['government', 'law', 'finance'], ['govinfo.gov'], 'US federal government publications: Congressional Record, bills, US Code, CFR, federal reports', q => get('govinfo', 'https://api.govinfo.gov/search', {api_key: config.DATA_GOV_API_KEY},
   {method: 'POST', body: {query: q, pageSize: 5, offsetMark: '*', sorts: [{field: 'score', sortOrder: 'DESC'}]}}), !!config.DATA_GOV_API_KEY);
 add('federal_register', ['government', 'law', 'finance'], ['federalregister.gov'], 'US federal rules, proposed rules and notices from US agencies only', q => get('federal_register', 'https://www.federalregister.gov/api/v1/documents.json', {'conditions[term]': q, per_page: '5', order: 'relevance'}));
 add('huggingface', ['ai_models', 'datasets', 'software'], ['huggingface.co'], 'machine-learning models and datasets on the Hugging Face Hub', fewer(async q => interleave(await partial([
   ...['models', 'datasets'].map(kind => async () => parseDeepRows('huggingface', await request('huggingface', urlWith(`https://huggingface.co/api/${kind}`, {search: q, limit: '5'})), kind)),
 ]))));
 add('stack_exchange', ['software', 'engineering', 'diy_repair'], ['stackoverflow.com', 'stackexchange.com'], 'programming questions and answers on Stack Overflow', fewer(q => get('stack_exchange', 'https://api.stackexchange.com/2.3/search/advanced',
   {q, site: 'stackoverflow', pagesize: '5', order: 'desc', sort: 'relevance', filter: 'withbody'})));
 add('ckan', ['datasets', 'government', 'nature'], ['data.gov.uk', 'open.canada.ca', 'data.europa.eu'], 'government open-data datasets from the UK, Canada and the EU', async q => interleave(await partial([
   ...CKAN_PORTALS.map(p => async () => parseDeepRows('ckan', await request('ckan', urlWith(p.endpoint, {q, rows: '5'})), p.record)),
   // The EU portal migrated away from CKAN; its supported public catalogue interface is SPARQL.
   async () => parseDeepRows('eu_data', await request('ckan', urlWith('https://data.europa.eu/sparql', {
     query: `SELECT DISTINCT ?dataset ?title ?description WHERE { ?dataset a <http://www.w3.org/ns/dcat#Dataset>; <http://purl.org/dc/terms/title> ?title . FILTER(CONTAINS(LCASE(STR(?title)), LCASE(${JSON.stringify(q)}))) OPTIONAL { ?dataset <http://purl.org/dc/terms/description> ?description } } LIMIT 5`,
     format: 'application/sparql-results+json',
   }), {contentTypes: ['application/sparql-results+json', 'application/json']})).map(r => ({...r, engine: 'deep:ckan'})),
 ])));
 add('loc', ['history', 'regional_news', 'books', 'education'], ['loc.gov', 'chroniclingamerica.loc.gov'], 'US Library of Congress collections: books, manuscripts, maps, photos and historic US newspapers', async q => interleave(await partial([
   () => get('loc', 'https://www.loc.gov/search/', {q, fo: 'json', c: '5'}),
   () => get('loc', 'https://www.loc.gov/collections/chronicling-america/', {q, fo: 'json', c: '5'}),
 ])), config.DEEP_SOURCES_LOC);
 add('europeana', ['history', 'design', 'architecture', 'photography', 'books'], ['europeana.eu'], 'digitised items from European museums, libraries and archives: artworks, photos, drawings, books', q => get('europeana', 'https://api.europeana.eu/record/v2/search.json', {query: q, wskey: config.EUROPEANA_API_KEY, rows: '5'}), !!config.EUROPEANA_API_KEY);
 add('open_library', ['books', 'education', 'history'], ['openlibrary.org'], 'catalogue records for books by title or author (worldwide)', q => get('open_library', 'https://openlibrary.org/search.json', {q, limit: '5', fields: 'key,title,author_name,first_publish_year'}));
 add('gdelt', ['news', 'regional_news'], ['gdeltproject.org'], 'recent news articles from outlets worldwide (last few months)', q => get('gdelt', 'https://api.gdeltproject.org/api/v2/doc/doc', {query: q, mode: 'ArtList', format: 'json', maxrecords: '5', sort: 'HybridRel'}));
 add('openalex', ['science', 'medicine', 'education', 'engineering', 'ai_models', 'nature'], ['openalex.org'], 'scholarly works in every discipline: papers, preprints, theses, reports (worldwide)', q => get('openalex', 'https://api.openalex.org/works', {search: q, per_page: '5', api_key: config.OPENALEX_API_KEY}), !!config.OPENALEX_API_KEY);
 add('doaj', ['science', 'medicine', 'education', 'engineering', 'nature'], ['doaj.org'], 'open-access journal articles in every discipline (worldwide)', q => get('doaj', `https://doaj.org/api/search/articles/${encodeURIComponent(q)}`, {pageSize: '5'}));
 return entries;
}
async function partial(tasks: (() => Promise<SourceRow[]>)[]): Promise<SourceRow[][]> {
 const answers = await Promise.allSettled(tasks.map(t => t()));
 if (answers.every(a => a.status === 'rejected')) {
   const reasons = answers.map(a => a.reason);
   throw reasons.find(e => !(e instanceof UpstreamError && e.code === 'budget_exhausted')) ?? new UpstreamError('budget_exhausted');
 }
 return answers.map(a => a.status === 'fulfilled' ? a.value : []);
}
// The sources the router chose for this request (src/field-routing.ts); without a choice, the field's first sources.
export const selectConnectors = (registry: DeepConnector[], field: string|null, tab: DeepTab, chosen?: string[]) =>
 (chosen ? chosen.flatMap(name => registry.filter(c => c.name === name)) : registry.filter(c => field && c.fields.includes(field)))
   .filter(c => c.tabs.includes(tab)).slice(0, 3);
export type DeepDeps = {json?: typeof fetchJSON; budget?: typeof takeBudget; circuit?: SourceCircuit; log?: (line: Record<string, unknown>) => void};
export async function findDeepSources(db: DB, config: Config, query: string, route: FieldRoute, tab: DeepTab,
 deps: DeepDeps = {}, deadline = Date.now() + config.DEEP_SOURCES_TIMEOUT_MS): Promise<SourceRow[]> {
 if (!config.DEEP_SOURCES || !route.field && !route.sources?.length) return [];
 const log = deps.log ?? (line => process.stdout.write(`${JSON.stringify(line)}\n`));
 // Source APIs match keywords: a whole sentence with its conditions finds nothing in most of them.
 const terms = route.keywords || query;
 const circuit = deps.circuit ?? deepCircuit;
 // Set once the search has returned: a timer can fire a millisecond before the clock reaches the deadline, so late work
 // checks this rather than the clock before it sends anything.
 let closed = false;
 const request: Request = async (name, url, options) => within(deadline - 5, async () => {
   if (!await (deps.budget ?? takeBudget)(db, `deep:${name}`, config.DEEP_SOURCES_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
   if (closed) throw new UpstreamError('timeout');
   return (deps.json ?? fetchJSON)(url, {...options, trustedOrigin: new URL(url).origin, redirects: 0, maxBytes: 2 * 1024 * 1024, timeoutMs: remaining(deadline)});
 });
 const selected = selectConnectors(deepRegistry(config, request).filter(c => circuit.allows(c.name)), route.field, tab, route.sources);
 const lists = await Promise.all(selected.map(async c => {
   const started = Date.now();
   // One line per source for tuning: never the query or the results.
   const done = (rows: SourceRow[], e?: unknown) => {
     log({event: 'deep_source', tier: config.TIER, tab, field: route.field, connector: c.name, rows: rows.length, ms: Date.now() - started,
       ...(e ? {error: e instanceof UpstreamError ? e.code : 'error', ...(e instanceof UpstreamError && e.status ? {status: e.status} : {})} : {})});
     return rows;
   };
   try {
     // Requests expire just before the shared deadline so multi-endpoint sources can return partial successes.
     const rows = await within(deadline, () => c.search(terms));
     circuit.success(c.name); return done(rows);
   } catch (e) {
     if (!(e instanceof UpstreamError && e.code === 'budget_exhausted')) circuit.failure(c.name);
     return done([], e);
   }
 }));
 closed = true;
 return interleave(lists);
}
