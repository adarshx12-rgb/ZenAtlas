# Early scene analysis (step B, narrowed)

Date: 2026-10-01. Builds on main 08ad03a (query remake live). Step B of the pipeline redesign, narrowed by the user after
measurement: transcripts are already fetched right after screening for the 10 most promising videos (LINK_CAPTIONS,
Supadata first), so only the scene-analysis half changes.

## Why

Scene analysis (Gemini watching a YouTube video by URL) starts only after every candidate is judged, about 98 s into a
search, for the top 2 judged videos. Jobs take a median 31 s (p90 53 s, last 10 days), so verdicts arrive about a minute
after results are shown and revise them. Starting right after screening (~37 s) lets most verdicts land around the time
results appear; the existing post-search scene review then updates the results within seconds.

## Faults found while designing

- No requirement contract for a video search ever marks a requirement `evidence_kind: visual` (0 of 54 recent
  contracts); `visual` is set only for image searches. A gate on it would never fire.
- Marking video requirements `visual` would be harmful: the judge accepts a visual requirement only from a screenshot or
  scene evidence (src/judge.ts requirement checks), so unwatched videos would turn "not confirmed" and be hidden.
- So the gate is a separate planner flag that only this feature reads.

## Design

1. **Watch flag.** The planner's JSON reply gains `watch: boolean`: true when the request asks for something only
   watching the video can confirm (an action, a moment, a scene, what is shown or heard), false when titles,
   descriptions or transcripts can settle it. `SearchPlan.watch?: boolean`, stored in the trace plan. It never reaches
   the judge. A missing or malformed flag counts as false.
2. **When.** Inside `applySignals`, right after the early caption fetch finishes (so long videos get transcript-guided
   windows), in the background: judging never waits for it.
3. **Which searches.** Live searches (`deps.sceneLive`), `SCENE_EARLY` on, `SCENE_AUTO_QUEUE` on, plan `watch` true.
4. **Which videos.** YouTube videos whose Jev screen choice is `promising` with confidence at least
   `JEV_SCREEN_CONFIDENCE`, highest link potential first, at most `SCENE_SEARCH_LIMIT`. `requestSceneAnalysis` gains an
   `early` option that skips its judge-relevance minimum (there is no judgement yet).
5. **Slots.** Early requests count toward `SCENE_SEARCH_LIMIT`; the post-judge pick only fills the remaining slots with
   judged candidates not already requested.
6. **Verdicts.** Early requests join `sceneRequests`, and their judged candidates join `sceneCandidates`, so the existing
   scene-review plan re-judges them once their scene job completes. No new waiting.
7. **Observability.** Log line `{event: 'scene_early', picked, ms}`; the trace plan carries `watch`.
8. **Switch.** `SCENE_EARLY` (default true).

## Testing

Unit: the planner keeps `watch` (and treats a missing/malformed one as false); early picks happen only for live, watch,
confident-promising YouTube videos; slots are shared with the post-judge pick; early picks reach the scene-review plan;
`SCENE_EARLY=false` restores today's behaviour. Bench: the real planner's `watch` flag on the 11 benchmark requests
(expected true for the moment/action ones: cat glass, falcon heavy landing, interstellar docking, snow leopard; false for
tie tutorial, UPI explainer, slime anime). Live: 2 moment searches, time from search start to scene verdict, main vs branch.
