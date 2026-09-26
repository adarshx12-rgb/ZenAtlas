// Document viewer pages: sites that show an uploaded or scanned document in their own reader instead of serving the file
// (Scribd, SlideShare, Academia.edu, Google Docs, the Internet Archive reader...). For the Docs tab such a page is the
// document: it is kept when it loads, and judged on its page text. group: the document type filter it belongs to.
export interface Viewer { name: string; group: 'pdf'|'word'|'slides'|'sheets'|'ebook' }
const VIEWERS: {host: string; path: RegExp; viewer: Viewer}[] = [
 {host: 'scribd.com', path: /^\/(?:document|doc|presentation)\/\d+/i, viewer: {name: 'Scribd', group: 'pdf'}},
 {host: 'slideshare.net', path: /^\/(?:slideshow\/)?[^/]+\/[^/]+/i, viewer: {name: 'SlideShare', group: 'slides'}},
 {host: 'academia.edu', path: /^\/\d+\//, viewer: {name: 'Academia.edu', group: 'pdf'}},
 {host: 'researchgate.net', path: /^\/publication\/\d+/i, viewer: {name: 'ResearchGate', group: 'pdf'}},
 {host: 'docplayer.net', path: /^\/\d+-/, viewer: {name: 'DocPlayer', group: 'pdf'}},
 {host: 'issuu.com', path: /^\/[^/]+\/docs\/[^/]+/i, viewer: {name: 'Issuu', group: 'pdf'}},
 {host: 'yumpu.com', path: /^\/[a-z]{2}\/document\/(?:read|view)\/\d+/i, viewer: {name: 'Yumpu', group: 'pdf'}},
 {host: 'calameo.com', path: /^\/read\/[\w-]+/i, viewer: {name: 'Calaméo', group: 'pdf'}},
 {host: 'docs.google.com', path: /^\/document\/d\//, viewer: {name: 'Google Docs', group: 'word'}},
 {host: 'docs.google.com', path: /^\/presentation\/d\//, viewer: {name: 'Google Slides', group: 'slides'}},
 {host: 'docs.google.com', path: /^\/spreadsheets\/d\//, viewer: {name: 'Google Sheets', group: 'sheets'}},
 {host: 'drive.google.com', path: /^\/file\/d\//, viewer: {name: 'Google Drive', group: 'pdf'}},
 {host: 'books.google.com', path: /^\/books/, viewer: {name: 'Google Books', group: 'ebook'}},
 {host: 'archive.org', path: /^\/details\/[\w.-]+/i, viewer: {name: 'Internet Archive', group: 'ebook'}},
];
export function viewerOf(url: string): Viewer|null {
 try {
   const u = new URL(url), host = u.hostname.toLowerCase().replace(/^www\./, '');
   // Google Books pages are documents only with a volume id; the Internet Archive reader only for items, not search pages.
   return VIEWERS.find(v => (host === v.host || host.endsWith(`.${v.host}`)) && v.path.test(u.pathname) &&
     (v.host !== 'books.google.com' || u.searchParams.has('id')))?.viewer ?? null;
 } catch { return null; }
}
// For searching user-upload viewers by name: site: operators for the engines.
export const VIEWER_SITES = ['scribd.com/document', 'slideshare.net', 'academia.edu', 'researchgate.net/publication', 'docplayer.net', 'issuu.com'];
