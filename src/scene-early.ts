import type { Result } from './types.js';
import type { LinkScore, ScreenSignal } from './link-potential.js';
import { youtubeId } from './youtube.js';

// Early scene analysis (docs/superpowers/specs/2026-10-01-early-scenes-design.md): for requests only watching can settle,
// the videos Jev's screen is confidently promising about start scene analysis before judging, so their verdicts can land
// around the time results appear instead of a minute later. Only YouTube videos: Gemini watches them by URL, nothing is
// downloaded. Without screening there is nothing to go on, so nothing is picked and the post-judge pick works as before.
export function earlyScenePicks(results: Result[], screens: Map<string, ScreenSignal>|undefined, link: (r: Result) => LinkScore,
 limit: number, minConfidence: number): Result[] {
 if (!screens || limit <= 0) return [];
 return results.filter(r => {
   const s = screens.get(r.canonical_url);
   return !!youtubeId(r.canonical_url) && s?.choice === 'promising' && s.confidence >= minConfidence;
 }).sort((a, b) => link(b).value - link(a).value).slice(0, limit);
}
