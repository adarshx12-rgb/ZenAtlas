// Canonical sources (docs/superpowers/specs/2026-09-27-candidate-quality-design.md): the original or official publication
// of something ranks above copies of it. On 2026-09-27 a Scribd re-upload of the MapReduce paper (read, scored 10) ranked
// above Google's own PDF, which sat outside the documents read and was capped as unverified.

// Sites that mostly host copies other people uploaded.
const MIRRORS = ['scribd.com', 'researchgate.net', 'academia.edu', 'slideshare.net', 'studocu.com', 'coursehero.com', 'issuu.com',
 'yumpu.com', 'pdfcoffee.com', 'dokumen.pub', 'documents.pub', 'vdocuments.mx', 'vdocuments.net', 'doku.pub', 'idoc.pub',
 'fliphtml5.com', 'docplayer.net', 'pdfslide.net', 'kupdf.net'];
// Where research is first published.
const PUBLISHERS = ['acm.org', 'ieee.org', 'usenix.org', 'arxiv.org', 'springer.com', 'nature.com', 'science.org', 'sciencedirect.com',
 'wiley.com', 'jstor.org', 'plos.org', 'biorxiv.org', 'ssrn.com', 'openreview.net', 'aclanthology.org', 'neurips.cc', 'mlr.press'];
// Government and inter-governmental hosts.
const OFFICIAL = /(?:^|\.)(?:gov|gob|gouv|govt|nic|mil)(?:\.[a-z]{2})?$|(?:^|\.)(?:europa\.eu|int|un\.org)$/;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'which', 'how', 'who', 'why', 'when', 'where', 'full', 'text',
 'paper', 'video', 'official', 'free', 'best', 'guide', 'tutorial', 'about', 'into', 'introduced', 'covers', 'news', 'blog', 'docs', 'www']);

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const onSite = (host: string, sites: string[]) => sites.some(s => host === s || host.endsWith(`.${s}`));

export type SourceKind = 'canonical'|'mirror'|null;
export function sourceKind(url: string, query: string): SourceKind {
 const host = hostOf(url);
 if (!host) return null;
 if (onSite(host, MIRRORS)) return 'mirror';
 if (OFFICIAL.test(host) || onSite(host, PUBLISHERS)) return 'canonical';
 // A host whose name is an organisation the request names ("the Google paper" → research.google.com). Exact labels only:
 // pythontutorial.net is not python.org.
 const labels = host.split('.').slice(0, -1);
 const words = query.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu)?.filter(w => !STOP.has(w)) ?? [];
 return words.some(w => labels.includes(w)) ? 'canonical' : null;
}

// Added to relevance for ordering only (the shown relevance is unchanged): a canonical copy beats anything within one
// point of it, never a result two points better; a mirror loses ties. The judge scores relevance alone (a copy of the
// requested document is still the requested document); preferring the original is ranking's job.
export const rankBoost = (kind: SourceKind) => kind === 'canonical' ? 1.5 : kind === 'mirror' ? -0.5 : 0;
