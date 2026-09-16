import type { Browser } from 'playwright';
import { publicDestination, startEgress, type Egress, type EgressPolicy } from './egress.js';

export interface RenderEvidence { url: string; html: string; scripts: string[]; detected: string[]; screenshot: Buffer|null }
export interface Renderer { render(url: string): Promise<RenderEvidence>; close(): Promise<void> }

const PAGES_AT_ONCE = 3, IDLE_CLOSE_MS = 60_000, RETRY_LAUNCH_MS = 5 * 60_000;
const MAX_HTML_CHARS = 3_000_000, MAX_SCRIPTS = 300, MAX_SCREENSHOT_BYTES = 300_000;
const VIEWPORT = {width: 1280, height: 800};
// WebRTC may not open UDP around the proxy.
const BROWSER_ARGS = ['--disable-quic', '--dns-prefetch-disable',
 '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];

const WEBGL_PROBE = `for (const type of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
 const original = type && type.prototype.getContext;
 if (original) type.prototype.getContext = function (kind, ...rest) {
   const context = original.call(this, kind, ...rest);
   if (context && /^(webgl2?|experimental-webgl)$/.test(String(kind))) globalThis.__zenatlasWebgl = true;
   return context;
 };
}`;
// Library names match LIBRARIES in pages.ts. Bundled code often hides file names but still sets these globals.
const RUNTIME_PROBE = `(() => {
 const w = window, found = [], has = selector => !!document.querySelector(selector);
 if (w.__THREE__ || w.THREE) found.push('three.js');
 if (w.BABYLON) found.push('Babylon.js');
 if (w.gsap || w.TweenMax || w.ScrollTrigger) found.push('GSAP');
 if (w.lottie || w.bodymovin || has('lottie-player, dotlottie-player')) found.push('Lottie');
 if (w.rive) found.push('Rive');
 if (w.PIXI) found.push('PixiJS');
 if (w.LocomotiveScroll) found.push('Locomotive Scroll');
 if (w.Lenis || w.lenis) found.push('Lenis');
 if (w.barba) found.push('Barba.js');
 if (has('spline-viewer')) found.push('Spline');
 if (has('model-viewer')) found.push('model-viewer');
 if (w.__zenatlasWebgl) found.push('WebGL');
 if (has('canvas')) found.push('Canvas');
 if ([...document.querySelectorAll('video')].some(v => v.autoplay)) found.push('Background video');
 return found;
})()`;

// Opens pages in a sandboxed headless Chromium whose traffic all passes through the egress proxy.
// The browser starts on first use and closes after a minute without work.
export class BrowserRenderer implements Renderer {
 private started?: Promise<{browser: Browser; egress: Egress}>;
 private failedAt = 0;
 private active = 0;
 private queue: (() => void)[] = [];
 private idle?: NodeJS.Timeout;
 constructor(private timeoutMs: number, private policy: EgressPolicy = publicDestination) {}

 private launch() {
   if (!this.started) {
     if (Date.now() - this.failedAt < RETRY_LAUNCH_MS) return Promise.reject(new Error('browser_unavailable'));
     const starting = (async () => {
       const egress = await startEgress(this.policy);
       try {
         const {chromium} = await import('playwright');
         const browser = await chromium.launch({chromiumSandbox: true, args: BROWSER_ARGS, proxy: {server: egress.server, bypass: '<-loopback>'}});
         browser.on('disconnected', () => { if (this.started === starting) this.started = undefined; void egress.close(); });
         return {browser, egress};
       } catch (error) { await egress.close(); throw error; }
     })();
     starting.catch(() => {
       if (this.started !== starting) return;
       this.started = undefined; this.failedAt = Date.now();
       console.error(JSON.stringify({event: 'browser_launch_failed', time: new Date().toISOString()}));
     });
     this.started = starting;
   }
   return this.started;
 }
 private async slot() {
   clearTimeout(this.idle);
   if (this.active >= PAGES_AT_ONCE) await new Promise<void>(resolve => this.queue.push(resolve));
   else this.active++;
 }
 private release() {
   const next = this.queue.shift();
   if (next) { next(); return; }
   this.active--;
   if (!this.active) { this.idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS); this.idle.unref(); }
 }

 async render(url: string): Promise<RenderEvidence> {
   await this.slot();
   try {
     const {browser} = await this.launch();
     const context = await browser.newContext({viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false, locale: 'en-US'});
     const deadline = setTimeout(() => void context.close().catch(() => {}), this.timeoutMs);
     try {
       const started = Date.now();
       // Keep the last 1.5 s of the budget for reading the page and taking the screenshot.
       const left = () => Math.max(1, this.timeoutMs - (Date.now() - started) - 1500);
       await context.addInitScript(WEBGL_PROBE);
       await context.route('**/*', route => route.request().resourceType() === 'media' ? route.abort() : route.continue());
       const page = await context.newPage();
       context.on('page', popup => { if (popup !== page) void popup.close(); });
       const scripts = new Set<string>();
       page.on('request', request => { if (request.resourceType() === 'script' && scripts.size < MAX_SCRIPTS) scripts.add(request.url().slice(0, 500)); });
       const response = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: left()});
       if (!response || response.status() >= 400) throw new Error('render_failed');
       await page.waitForLoadState('load', {timeout: Math.min(left(), 5000)}).catch(() => {});
       // A short scroll wakes lazily loaded scripts and scroll-driven animation code.
       await page.mouse.wheel(0, VIEWPORT.height * 2).catch(() => {});
       await page.waitForTimeout(Math.min(800, left()));
       await page.evaluate('window.scrollTo(0, 0)').catch(() => {});
       await page.waitForTimeout(Math.min(700, left()));
       const detected: unknown = await page.evaluate(RUNTIME_PROBE);
       const html = (await page.content()).slice(0, MAX_HTML_CHARS);
       const cdp = await context.newCDPSession(page);
       const shot = await cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 70,
         clip: {x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 0.5}});
       const screenshot = Buffer.from(shot.data, 'base64');
       return {url: page.url(), html, scripts: [...scripts],
         detected: Array.isArray(detected) ? detected.filter((d): d is string => typeof d === 'string') : [],
         screenshot: screenshot.length <= MAX_SCREENSHOT_BYTES ? screenshot : null};
     } finally {
       clearTimeout(deadline);
       await context.close().catch(() => {});
     }
   } finally { this.release(); }
 }

 async close() {
   clearTimeout(this.idle);
   const started = this.started;
   this.started = undefined;
   const running = await started?.catch(() => undefined);
   await running?.browser.close().catch(() => {});
   await running?.egress.close();
 }
}
