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
- When YouTube blocks the address (`IpBlocked`, `RequestBlocked`), the whole lane pauses for an hour
  (`CAPTION_PAUSE_MINUTES`) without spending attempts. The worker logs `youtube_captions_paused`. YouTube blocks many
  cloud addresses, so a VPS usually needs `YOUTUBE_CAPTIONS_PROXY`.
- Any other helper failure is retried like any job: three attempts with backoff.

The library reads YouTube's web-player caption endpoint, not the official Data API, which can only download captions
for videos the signed-in account owns. A change on YouTube's side can break it until the library is updated.
