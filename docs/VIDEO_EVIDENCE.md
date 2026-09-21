# Video evidence and evaluation

All launched discovery specialists settle before the final candidate pool is reviewed. Comments, available captions, retained transcript passages, scene observations and page checks then feed one relevance review. An unavailable channel means unknown; comments are viewer claims, not verified facts. Evidence coverage is returned separately as `evidence_coverage`.

The scoring rubric is enforced: metadata alone caps relevance at 6/10, viewer claims at 8, transcripts at 9, and analysed scenes or checked website pages permit 10. These are maximum evidence-supported relevance scores, not factual-accuracy percentages. Website screenshots or text do not establish unseen video content. Popularity and response speed do not increase relevance.

Relevance checks require separate subject, intent and format assessments. Each supported assessment must quote text present in that candidate's evidence (exactly, or at least 80% of a quote of three or more words, which tolerates truncated titles and site suffixes). A verified match keeps the evidence ceiling above. A plausible match whose quotes are missing or cannot be verified is capped at 5; such unverified matches only fill the list up to ten results, after every verified match, with a `Possible match` badge. An explicit mismatch caps the score at 4, and scores of 4 or below are excluded. A video is never excluded as the wrong format for a website or mixed request, because a video presenting the requested tools, sites or repositories delivers them; the planner's `websites` guess reaches the judge as `mixed` for the same reason. When every judged candidate is excluded, up to five that scored 3 or 4 are shown with a `Closest match` badge and a partial `relevance_filter` status; candidates scoring 0–2 never are. Validated quotes are exposed in `judgement.intent_checks`. This verifies provenance, not the truth of a viewer's claim or the model's interpretation. Tone and genre follow the request generally (comedy does not satisfy a request for scary material unless asked); no rule is specific to one query. A model outage still exposes explicitly unjudged keyword fallback results.

## Implemented channels

- YouTube: relevant and recent comment-thread samples, returned replies, deduplication, and bounded pagination. The judge's sample reserves space for query matches, timestamps, corrections, recent comments and replies. This is a sample, not all comments. Default 25 videos and 100 comments per video; configure `SIGNAL_VIDEOS` and `SIGNAL_COMMENTS` within quota.
- PeerTube: validate the video through its native API, read recent/discussed comment threads, and load a publisher-provided caption track. Caption timing and provenance are preserved.
- Internet Archive: read item reviews as viewer claims. Captions are accepted only when their filename matches the single original film stem. Multi-film items and ambiguous caption associations are skipped.
- Other sites: existing page analysis and retained/imported transcripts still work. Unsupported comment APIs are explicitly marked unsupported; this is not universal scraping.

PeerTube and Archive adapters require existing `viewer_signals` and `transcripts` source permissions respectively. They never approve newly discovered sites or override an administrator's review. Enable those permissions for reviewed sources in the existing admin workflow. HTTP requests retain public-address validation, bounded responses and deadlines.

SRT/WebVTT cues must be ordered with valid times and fit known video duration. Unchanged transcripts retain their IDs and cached vectors. Updating captions preserves viewer-timestamp moments. Official YouTube caption download requires uploader authorization; this implementation does not bypass that requirement.

## Scene and semantic processing

`SCENE_AUTO_QUEUE=true` registers a canonical YouTube timeline only when verified duration is known (up to 45 minutes), or reuses an explicitly registered local media version. Up to `SCENE_SHORTLIST=3` promising results are queued, capped at 20 automatically queued jobs/day. The Python worker separately enforces `SCENE_ANALYSIS_DAILY_BUDGET`.

Run `node scripts/scene-worker.cjs`, or start the `zenatlas-scenes` entry in `ecosystem.config.cjs`. Install the existing Python package into `scene-worker/.venv`. The worker checks access before analysing. Captions identify focus spans, while the whole video remains sampled at 1 FPS for context; **these are not clipped-only requests or frame-perfect inspection**. Stored inspected ranges describe the full submitted timeline. Fast action can be missed.

Registered local sidecar captions and optional authorized local speech recognition are now retained as timestamped transcript windows after successful analysis, with timing quality and provenance. Speech recognition needs the existing transcription extra, `SCENE_TRANSCRIBE_FALLBACK=true`, and an authorized local media file. It does not download arbitrary site videos. Provider/permission failures preserve existing usable evidence.

Scene work is asynchronous. Current searches report pending scene jobs without using them as evidence. Completed scenes and transcripts enter later searches and enqueue semantic enrichment. This can improve later rankings; it does not silently rewrite an already completed search snapshot.

Apply `npm run migrate -- --vectors`. Optional migrations create metadata and evidence vector tables and grant the existing `search_app` role access; `scripts/app-user.ts` also covers a newly created runtime role. Set `SEMANTIC_ENABLED=true`, `EMBEDDING_URL`, `EMBEDDING_MODEL`, and matching `EMBEDDING_DIMENSIONS`. Both `{embedding:[...]}` and compatible `{data:[{embedding:[...]}]}` responses are accepted. The official OpenRouter endpoint can use the existing OpenRouter key when `EMBEDDING_TOKEN` is empty. No credentials are sent to arbitrary caption URLs.

Transcripts and scene descriptions/tags have separate vectors linked to the original evidence. Retrieval rechecks active evidence, source permissions and media state; deletions cascade to vectors. Explicit query operators retain keyword restrictions. The daily embedding budget applies across queries, metadata and evidence. `npm run admin -- enrich CONTENT_ID` can backfill existing permitted content; scene completions automatically enqueue enrichment.

## Real-query evaluation

`evaluation/real-queries.json` contains the four user-provided searches and review criteria. Run:

```powershell
node --env-file=.env --import tsx scripts/evaluate-real.ts capture evaluation/current-real-results.json
node --import tsx scripts/evaluate-real.ts compare evaluation/initial-real-results.json evaluation/current-real-results.json evaluation/current-real-results.json.review.json
```

Capture uses live deep discovery and its configured provider budgets. The adjacent review file sorts URLs independently of rank and omits AI scores. Enter a reviewer name and human grades (0 unrelated, 1 partial, 2 relevant, 3 strong exact match). Leave unseen results null. To compare, review the union of both runs' candidates. Unreviewed top results produce null metrics, not false zero grades. Inspect scene timestamps and factual claims separately; relevance grades alone do not certify them. Initial/current live captures vary in provider responses and are diagnostic, not a controlled causal experiment.

Validation: `npm run build`, `npm test`, and `python -m pytest scene-worker/tests -q`. The real vector regression is opt-in with `VECTOR_INTEGRATION=true` and a migrated `DATABASE_URL`; it uses synthetic vectors and rolls back all fixture writes.

API references: [PeerTube](https://docs.joinpeertube.org/api-rest-reference.html), [Internet Archive metadata](https://archive.org/developers/md-read.html), [YouTube comment threads](https://developers.google.com/youtube/v3/docs/commentThreads/list), [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding).
