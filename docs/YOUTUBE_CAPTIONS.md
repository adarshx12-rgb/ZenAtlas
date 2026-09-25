# YouTube captions

Search results from YouTube have no transcript unless the engine fetches the captions YouTube already has. With
`YOUTUBE_CAPTIONS=true`, each search queues a `youtube_captions` job for up to `YOUTUBE_CAPTIONS_SHORTLIST` of its top
YouTube results that have no transcript yet. The Node worker runs the job in its main lane and calls
`python -m zenatlas_scenes.captions <video id> [language]`, which uses
[youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api). Only caption text is fetched, never audio or
video.

## Which captions

- Creator-uploaded captions whenever any exist: the video's language first, then English, then the first listed.
- Otherwise auto-generated captions in the video's language, else the first auto track.
- Sound tags such as `[Music]` are dropped. Each cue ends where the next begins, because auto captions overlap on screen.

The transcript is stored like any other (`transcript_segments`, then `moments` windows), with `source_kind` set to
`youtube_manual` or `youtube_auto`. Matches in auto captions count 0.9× in ranking (`AUTO_CAPTION_WEIGHT` in
`src/moments.ts`), so creator captions win at equal match quality. Quotes are always the stored caption text.

The source must permit transcripts (`policy.transcripts`), exactly as for other transcript retention.

## Limits and failures

- Each video is fetched once. A video without captions (`TranscriptsDisabled`, `NoTranscriptFound`) completes as
  `no_captions` and is not asked again.
- At most 6 fetches per minute (`CAPTION_FETCHES_PER_MINUTE`); extra jobs wait a minute without spending an attempt.
- `YOUTUBE_CAPTIONS_DAILY_BUDGET` caps jobs queued per day.
- When YouTube blocks the address (`IpBlocked`, `RequestBlocked`), direct requests pause for an hour
  (`CAPTION_PAUSE_MINUTES`, recorded in `lane_pauses`). Each further block within a day doubles the pause, up to a day,
  and a successful fetch clears it. Waiting never spends job attempts. The worker logs `youtube_captions_paused`.
  YouTube blocks many cloud addresses, so a VPS usually needs `YOUTUBE_CAPTIONS_PROXY` or Supadata.
- Any other helper failure is retried like any job: three attempts with backoff.

## Supadata fallback

While direct requests are paused, and only then, jobs use [Supadata](https://supadata.ai) (`SUPADATA_API_KEY`), which
fetches the same YouTube captions on its own servers with `mode=native` (never AI-generated). Each video costs one
credit, including videos without captions, so `SUPADATA_DAILY_BUDGET` caps calls per day (default 3: the free plan has
100 credits a month). Past the budget, jobs wait for YouTube again.

Supadata does not say whether captions are creator-made or auto-generated. When YouTube blocked only the caption
download, its track list already showed the kind and language, and those are kept. When it blocked the track list too,
the transcript is stored as `youtube_unknown`, weighted like auto captions. Running out of credits or a rejected key
pauses Supadata for a day (`supadata_paused` in the log).

The library reads YouTube's web-player caption endpoint, not the official Data API, which can only download captions
for videos the signed-in account owns. A change on YouTube's side can break it until the library is updated.

## Sound-tolerant matching

Hindi auto-captions write English words in Devanagari ("anticipation gap" is "एंटीसिपेशन गैप"), and auto-captions
mishear words, so exact keywords miss them. `src/phonetic.ts` handles both:

- Devanagari caption lines are romanized as a Hindi speaker would type them (`transcript_segments.search_text`).
- Every word becomes a sound key, its consonant skeleton: aspirates merge, `-tion` becomes `sn`, `w` becomes `v`, and
  vowels drop ("anticipation" and "एंटीसिपेशन" are both `ANTSPSN`). A line stores the keys of itself and the next line
  (`sound_keys`), so a phrase split across two lines matches; a moment stores the keys of its lines.
- A query matches by sound when one caption line pair holds the key of every word that is not a stopword. Queries with
  search operators (quotes, `-`, `OR`) and queries whose keys total under 5 characters (a lone "gap") never match by sound.
- Sound matches are a separate ranking list at half weight (`PHONETIC_WEIGHT` in `src/retrieval.ts`), so exact matches
  rank first. The moment points at the line where the matched phrase starts. Quotes are always the stored caption text.

Keys are computed when a transcript is imported; transcripts imported before migration 013 get them on their next
import. `scripts/evaluate-transcripts.ts` measures moment search with and without transcripts on a copy of the catalogue.
