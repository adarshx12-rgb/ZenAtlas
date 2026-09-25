# Docs search

The Docs tab looks for the document a request asks for, in any format (PDF, Word, slides, spreadsheets, e-books),
and says for each website it looked at whether that document is there. It runs in two stages.

## 1. Search and verify (inside the `/api/web?kind=docs` request)

- Brave, then SearXNG, search with file-type operators for direct document links (`src/web.ts`).
- Every link is verified (`src/doc-review.ts`), reading only its first 4 KB (`peekDocument` in `src/http.ts`):
  - spam links are dropped: script paths posing as files (`default.aspx/Title.pdf`), `fulldisplay` listings, and titles
    that start with their own host;
  - dead or unreachable links are dropped;
  - pages posing as documents are dropped: the file's own signature decides (`%PDF-`, ZIP, OLE, RTF), not its name;
  - sites that refuse automated requests (401, 403, 429) stay, marked *Unverified*.
- The response lists the verified documents at once and carries a `hunt` token.

## 2. Hunt and review (in the background, polled at `/api/docs/hunt?token=…`)

`src/doc-hunt.ts`, on the first result page:

1. **Websites.** An ordinary web search for the request gives up to `DOC_HUNT_SITES` websites to look inside (spam and
   unauthorized hosts excluded).
2. **Jev hunts inside them.** Each visited page's links (including script menus, drop-downs and embedded viewers) are
   sorted by Jev's decision API into *the document*, *a lead towards it* (an archive, publications, year or issue page on
   the same site) or *irrelevant*. Leads are followed for `DOC_HUNT_ROUNDS` rounds, at most `DOC_HUNT_VISITS` pages, within
   `DOC_HUNT_TIMEOUT_MS`. Candidate documents are confirmed by their signature, and each keeps the pages that led to it
   (*Found via*).
3. **Review.** The search's own documents are reviewed while Jev explores; documents found inside websites are reviewed
   after. PDFs up to `PDF_MAX_BYTES` are read, office files through the preview converter (`DOC_PREVIEW_CONVERTER`).
   The Jev pre-judge (rejections on, for documents only) and the LLM judge remove documents at relevance 4 or below, or
   with an intent mismatch; ambiguous requests count any reasonable reading. The rest are ordered by relevance.
4. **Website verdicts.** *Document found* when a kept document came from the site; *Buy / Borrow / Subscription* for a
   known store, library or subscription (`data/access-sources.json`) or when Jev reads the site's first page as one;
   *On the page, no file* when the information is there as text; otherwise *Not found*. The judge decides the pages Jev
   is unsure about.

Later result pages only review their own documents. Hunts run in the API process, at most four exploring at once, and
their state is kept for ten minutes.

Paid or copyrighted works are never hunted as "free" copies: shadow libraries are unauthorized, and Jev is told that a
free download of a work sold elsewhere is not a legitimate offer.

## Settings

`DOC_HUNT_ENABLED`, `DOC_HUNT_SITES`, `DOC_HUNT_VISITS`, `DOC_HUNT_ROUNDS`, `DOC_HUNT_TIMEOUT_MS`, `DOC_HUNT_MAX_DOCS` and
`JEV_DOC_HUNT_DAILY_BUDGET` (Jev decisions per day, separate from the video exploration budget). See `.env.example`.
