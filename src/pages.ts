import type { Config } from './config.js';
import { fetchText, UpstreamError, type TextResponse } from './http.js';
import { BrowserRenderer, type Renderer } from './render.js';
import { Trafilatura, type TextExtractor } from './extract.js';

const AGENT = 'zenatlas';
const TEXT_CHARS = 800;
export interface PageEvidence {
 status: 'checked'|'robots_disallowed'|'unavailable';
 title: string|null; description: string|null; text: string|null; libraries: string[]; badges: string[];
 rendered?: boolean; screenshot?: Buffer|null;
}
export interface PageCheck { check(url: string): Promise<PageEvidence> }
// renders: at most this many pages per checker are opened in the browser (default PAGE_RENDERS).
export interface PageTools { renderer?: Renderer; extractor?: TextExtractor; renders?: number }
type Transport = (url: string, options: Parameters<typeof fetchText>[1]) => Promise<TextResponse>;

let shared: {key: string; tools: PageTools}|undefined;
// One browser and one text helper serve every search in this worker process.
export function pageTools(config: Config): PageTools {
 const key = `${config.PAGE_RENDERS}|${config.PAGE_RENDER_TIMEOUT_MS}|${config.PAGE_TEXT_PYTHON}`;
 if (shared?.key !== key) {
   void shared?.tools.renderer?.close();
   shared?.tools.extractor?.close();
   shared = {key, tools: {renderer: config.PAGE_RENDERS > 0 ? new BrowserRenderer(config.PAGE_RENDER_TIMEOUT_MS) : undefined,
     extractor: config.PAGE_TEXT_PYTHON ? new Trafilatura(config.PAGE_TEXT_PYTHON) : undefined}};
 }
 return shared.tools;
}

// Library names found in page source. A match is evidence; no match proves nothing, since many sites bundle their code.
const LIBRARIES: {name: string; group: '3D'|'Motion'|'Video'|null; pattern: RegExp}[] = [
 {name: 'three.js', group: '3D', pattern: /\bthree(?:\.module|\.core)?(?:\.min)?\.js\b|from\s*["']three["']|["']three\/(?:examples|addons)\/|\bTHREE\.(?:WebGLRenderer|Scene|PerspectiveCamera)\b/},
 {name: 'React Three Fiber', group: '3D', pattern: /@react-three\/(?:fiber|drei)|react-three-fiber/i},
 {name: 'Babylon.js', group: '3D', pattern: /\bbabylon(?:\.max)?(?:\.min)?\.js\b|@babylonjs\//i},
 {name: 'Spline', group: '3D', pattern: /prod\.spline\.design|@splinetool\/|<spline-viewer\b/i},
 {name: 'PlayCanvas', group: '3D', pattern: /\bplaycanvas(?:-stable)?(?:\.min)?\.js\b|playcanv\.as/i},
 {name: 'model-viewer', group: '3D', pattern: /<model-viewer\b|@google\/model-viewer/i},
 {name: 'WebGL', group: '3D', pattern: /getContext\(\s*["']webgl2?["']|\bWebGL(?:2)?RenderingContext\b/},
 {name: 'GSAP', group: 'Motion', pattern: /\bgsap(?:\.min)?\.js\b|\bgsap\.(?:to|from|fromTo|timeline|registerPlugin)\(|greensock|\bScrollTrigger\b/},
 {name: 'Lottie', group: 'Motion', pattern: /\blottie(?:-web|-player)?(?:\.min)?\.js\b|<(?:lottie|dotlottie)-player\b|\bbodymovin\b|@lottiefiles\//i},
 {name: 'Rive', group: 'Motion', pattern: /@rive-app\/|\bcdn\.rive\.app\b|\.riv["']/i},
 {name: 'Framer', group: 'Motion', pattern: /framer-motion|framerusercontent\.com/i},
 {name: 'Anime.js', group: 'Motion', pattern: /\banime(?:\.min)?\.js\b|\banimejs\b/i},
 {name: 'PixiJS', group: 'Motion', pattern: /\bpixi(?:\.min)?\.js\b|@pixi\//i},
 {name: 'Theatre.js', group: 'Motion', pattern: /@theatre\/(?:core|studio)/i},
 {name: 'Locomotive Scroll', group: 'Motion', pattern: /locomotive-scroll/i},
 {name: 'Lenis', group: 'Motion', pattern: /@studio-freight\/lenis|\blenis(?:\.min)?\.js\b|\bdata-lenis|class="[^"]*\blenis\b/i},
 {name: 'Barba.js', group: 'Motion', pattern: /@barba\/core|\bbarba(?:\.umd)?(?:\.min)?\.js\b/i},
 {name: 'Background video', group: 'Video', pattern: /<video\b[^>]*\bautoplay\b/i},
 {name: 'Canvas', group: null, pattern: /<canvas\b/i},
];

const ENTITIES: Record<string,string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
function decode(text: string) {
 return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
   if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
   const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
   return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
 });
}
const clean = (text: string|undefined|null, max: number) => {
 const value = decode((text ?? '').replace(/\s+/g, ' ')).trim();
 return value ? value.slice(0, max) : null;
};

const badgesFor = (names: string[]) => (['3D', 'Motion', 'Video'] as const).flatMap(group => {
 const found = LIBRARIES.filter(l => l.group === group && names.includes(l.name)).map(l => l.name);
 return found.length ? [group === 'Video' ? 'Background video' : `${group}: ${found.slice(0, 3).join(', ')}`] : [];
});

// scripts: script URLs a browser loaded; detected: library names a browser saw running (see render.ts).
export function extractPage(html: string, seen: {scripts?: string[]; detected?: string[]} = {}): Omit<PageEvidence,'status'> {
 const meta = new Map<string,string>();
 for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
   const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3]]));
   const key = (attrs.name ?? attrs.property)?.toLowerCase();
   if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
 }
 const visible = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
   .replace(/<[^>]+>/g, ' ');
 const libraries = LIBRARIES.filter(l => l.pattern.test(html) || seen.scripts?.some(url => l.pattern.test(url)) || seen.detected?.includes(l.name))
   .map(l => l.name);
 return {title: clean(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? meta.get('og:title'), 200),
   description: clean(meta.get('description') ?? meta.get('og:description'), 400), text: clean(visible, TEXT_CHARS),
   libraries, badges: badgesFor(libraries)};
}

// Longest matching rule wins and Allow wins a tie, as in RFC 9309. A group naming this crawler replaces the "*" group.
export function robotsAllows(robots: string, path: string, agent = AGENT): boolean {
 const groups: {agents: string[]; rules: {allow: boolean; pattern: string}[]}[] = [];
 let current: typeof groups[number]|null = null, lastWasAgent = false;
 for (const raw of robots.split(/\r?\n/)) {
   const line = raw.replace(/#.*/, '').trim();
   const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
   if (!match) continue;
   const field = match[1].toLowerCase(), value = match[2].trim();
   if (field === 'user-agent') {
     if (!current || !lastWasAgent) groups.push(current = {agents: [], rules: []});
     current.agents.push(value.toLowerCase()); lastWasAgent = true;
   } else if ((field === 'allow' || field === 'disallow') && current) {
     lastWasAgent = false;
     if (value) current.rules.push({allow: field === 'allow', pattern: value});
   }
 }
 const named = groups.filter(g => g.agents.some(a => a && a !== '*' && agent.includes(a)));
 const rules = (named.length ? named : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
 let best: {allow: boolean; length: number}|null = null;
 for (const rule of rules) {
   const regex = new RegExp('^' + rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
   if (!regex.test(path)) continue;
   if (!best || rule.pattern.length > best.length || rule.pattern.length === best.length && rule.allow) best = {allow: rule.allow, length: rule.pattern.length};
 }
 return best?.allow ?? true;
}

export class PageChecker implements PageCheck {
 private robots = new Map<string, Promise<string|null|false>>();
 private renders = 0;
 constructor(private config: Config, private transport: Transport = fetchText, private tools: PageTools = pageTools(config)) {}
 // null: no usable robots.txt, so crawling is allowed; false: robots.txt could not be read, so the page is skipped.
 private rules(origin: string) {
   let pending = this.robots.get(origin);
   if (!pending) {
     pending = this.transport(`${origin}/robots.txt`, {accept: 'text/plain', contentTypes: ['text/plain'], maxBytes: 512*1024,
       timeoutMs: this.config.PAGE_TIMEOUT_MS, redirects: 3})
       .then(r => r.text, (error: unknown) => error instanceof UpstreamError &&
         (error.code === 'unsupported_content' || (error.status ?? 0) >= 400 && (error.status ?? 0) < 500) ? null : false);
     this.robots.set(origin, pending);
   }
   return pending;
 }
 async check(url: string): Promise<PageEvidence> {
   const empty = {title: null, description: null, text: null, libraries: [], badges: []};
   const target = new URL(url);
   const robots = await this.rules(target.origin);
   if (robots === false) return {status: 'unavailable', ...empty};
   if (robots !== null && !robotsAllows(robots, target.pathname + target.search)) return {status: 'robots_disallowed', ...empty};
   try {
     const page = await this.transport(url, {maxBytes: 1536*1024, timeoutMs: this.config.PAGE_TIMEOUT_MS, redirects: 3});
     const rendered = await this.render(page.url);
     const source = extractPage(page.text), live = rendered && extractPage(rendered.html, rendered);
     const libraries = LIBRARIES.map(l => l.name).filter(name => source.libraries.includes(name) || !!live?.libraries.includes(name));
     // Main-content text (trafilatura) skips menus and banners; the regex text is the fallback.
     const main = await this.tools.extractor?.text(rendered?.html ?? page.text) ?? null;
     return {status: 'checked', title: live?.title ?? source.title, description: live?.description ?? source.description,
       text: clean(main, TEXT_CHARS) ?? live?.text ?? source.text, libraries, badges: badgesFor(libraries),
       rendered: !!rendered, screenshot: rendered?.screenshot ?? null};
   } catch { return {status: 'unavailable', ...empty}; }
 }
 // Only pages that robots.txt allows and that answered a plain request are opened in the browser.
 private async render(url: string) {
   const {renderer} = this.tools;
   if (!renderer || this.renders >= (this.tools.renders ?? this.config.PAGE_RENDERS)) return null;
   this.renders++;
   try { return await renderer.render(url); } catch { return null; }
 }
}
