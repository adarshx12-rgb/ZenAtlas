// The buddha-hand scroll reveal on the home page. Must be an external module: the app
// serves a `script-src 'self'` CSP, so an inline <script> is blocked outright.
//
// Progressive enhancement, in two states:
//   (none)     — no JS, no clip, a viewport too narrow, or reduced motion: hero and search
//                bar sit in normal flow, exactly the page as it was before.
//   .is-live   — the scene is pinned and scrubbed against the scroll.
// Reduced motion deliberately gets the plain page rather than a frozen final frame: the
// composed picture fades the headline out to clear room for the hand, and a reader who
// asked for no motion should not lose the h1 to it.
// Nothing below ever removes or re-parents #search-form, so app.js keeps its submit wiring.
import { CONFIG } from './hand-config.js';

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

const scene = document.querySelector('#hand-scene');
if (scene) boot();

function boot() {
 const pin = scene.querySelector('.hand-pin');
 const clip = scene.querySelector('.hand-clip');
 const hero = scene.querySelector('.hand-hero');
 const bar = scene.querySelector('.hand-bar');
 const barLabel = bar.querySelector('label');

 const aspect = CONFIG.frame.w / CONFIG.frame.h;
 const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
 const narrow = window.matchMedia(`(max-width:${CONFIG.staticBelow}px)`);

 let live = false, dy = 0, fullW = 0, landedW = 0, riseFrom = 0;

 const wanted = () => !narrow.matches && !reduced.matches;

 // The src is attached here rather than in the markup so a viewport that never shows the
 // hand does not download the clip just to throw it away.
 clip.addEventListener('loadeddata', () => { live = true; layout(); }, { once: true });
 clip.addEventListener('error', () => { live = false; reset(); }, { once: true });
 if (wanted()) { clip.src = CONFIG.clip; clip.load(); }

 // Scroll position -> 0..1 across the scene. While the scene's top is still below the
 // viewport top the pin has not caught yet, and this reads 0, which is what we want.
 function progress() {
  const total = scene.offsetHeight - window.innerHeight;
  if (total <= 0) return 1;
  return clamp01(-scene.getBoundingClientRect().top / total);
 }

 function reset() {
  scene.classList.remove('is-live');
  hero.style.cssText = '';
  bar.style.cssText = '';
  barLabel.style.cssText = '';
  clip.style.cssText = '';
 }

 function layout() {
  if (!live || !wanted()) { reset(); return; }
  scene.classList.add('is-live');
  scene.style.setProperty('--hand-vh', `${CONFIG.scrollVh}vh`);

  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = vw * CONFIG.coverScale, ch = cw / aspect;
  const landY = vh * CONFIG.landing.y;

  // Place the clip so the palm lands under the middle of the bar. The bar itself is always
  // horizontally centred, so moving the clip is what solves the horizontal fit — the hand
  // sits at 0.726 across its own frame, not at the middle of it.
  const clipTop = landY - (CONFIG.palm.y + CONFIG.sink) * ch;
  clip.style.width = `${cw}px`;
  clip.style.height = `${ch}px`;
  clip.style.left = `${vw / 2 - CONFIG.palm.x * cw}px`;
  clip.style.top = `${clipTop}px`;
  // Far enough down that the clip's top edge starts level with the bottom of the viewport,
  // so at rest there is no hand on the page at all — it arrives entirely on scroll.
  riseFrom = Math.max(0, vh - clipTop);

  // Measure the bar at its natural width, offset from the PIN rather than the viewport:
  // the pin is only flush with the viewport top once it has caught, and layout() can run
  // before that.
  bar.style.removeProperty('--bar-w');
  bar.style.transform = '';
  const barBox = bar.getBoundingClientRect();
  fullW = barBox.width;
  landedW = Math.min(fullW, Math.max(CONFIG.landedBarMin, CONFIG.barToCradle * CONFIG.cradleWidth * cw));
  dy = landY - (barBox.bottom - pin.getBoundingClientRect().top);

  apply(progress());
 }

 // Only ever seek; never play. A seek issued while one is still outstanding is ignored by
 // the element, so the target is parked in `wanted` and drained on `seeked` instead of
 // being dropped. Without that, one large jump — End, a scrollbar drag, a restored scroll
 // position on reload — leaves the hand frozen on whatever frame it had, because no
 // further scroll events arrive to correct it.
 let wantedTime = null;
 clip.addEventListener('seeked', () => {
  if (wantedTime !== null && Math.abs(clip.currentTime - wantedTime) > 0.02) clip.currentTime = wantedTime;
 });

 function scrub(p) {
  const d = clip.duration;
  if (!d || !isFinite(d)) return;
  const [a, b] = CONFIG.stages.clip;
  wantedTime = smoothstep(0, 1, clamp01((p - a) / (b - a))) * d;
  if (clip.seeking) return;
  if (Math.abs(clip.currentTime - wantedTime) > 0.02) clip.currentTime = wantedTime;
 }

 function apply(p) {
  if (!live) return;
  scrub(p);
  const out = smoothstep(CONFIG.stages.heroOut[0], CONFIG.stages.heroOut[1], p);
  hero.style.opacity = `${1 - out}`;
  hero.style.transform = `translateY(${-CONFIG.heroLift * out}px)`;
  const up = smoothstep(CONFIG.stages.rise[0], CONFIG.stages.rise[1], p);
  clip.style.transform = `translateY(${riseFrom * (1 - up)}px)`;
  const t = smoothstep(CONFIG.stages.barTravel[0], CONFIG.stages.barTravel[1], p);
  bar.style.setProperty('--bar-w', `${lerp(fullW, landedW, t)}px`);
  bar.style.transform = `translateY(${dy * t}px)`;
  barLabel.style.opacity = `${1 - smoothstep(CONFIG.stages.labelOut[0], CONFIG.stages.labelOut[1], p)}`;
 }

 let queued = false;
 const onScroll = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; apply(progress()); });
 };
 window.addEventListener('scroll', onScroll, { passive: true });
 window.addEventListener('resize', layout);
 for (const q of [reduced, narrow]) q.addEventListener('change', () => {
  if (wanted() && !clip.src) { clip.src = CONFIG.clip; clip.load(); }
  layout();
 });
}
