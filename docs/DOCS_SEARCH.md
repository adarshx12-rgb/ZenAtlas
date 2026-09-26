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
- Free-document sources are searched at the same time (`src/doc-sources.ts`): arXiv, Semantic Scholar, Zenodo, Google
  Books full view and Internet Archive texts give documents; DOAJ articles and institutional repositories (OpenStax,
  LibreTexts, UN, WHO, World Bank, government and university sites) give places for the hunt to look.
- Viewer pages count as documents (`src/doc-viewers.ts`): Scribd, SlideShare, Academia.edu, ResearchGate, DocPlayer,
  Issuu, Google Docs, Drive and Books, and the Internet Archive reader. A viewer page is verified when it loads and judged
  on its page text; it opens at its source rather than in the preview.
- Safety (`src/safety.ts`): both engines use strict safe search for documents, and every link is checked against public
  malware and phishing host lists (`DOC_BLOCKLISTS`, refreshed daily) and for explicit adult content. The dedicated piracy
  sites in `data/access-sources.json` stay excluded; every other third-party source is allowed.
- The response lists the verified documents at once and carries a `hunt` token.

## 2. Hunt and review (in the background, polled at `/api/docs/hunt?token=…`)

`src/doc-hunt.ts`, on the first result page:

1. **Websites.** An ordinary web search for the request gives up to `DOC_HUNT_SITES` websites to look inside (spam and
   unauthorized hosts excluded).
2. **Jev hunts inside them.** Each visited page's links (including script menus, drop-downs and embedded viewers) are
   sorted by Jev's decision API into *the document*, *a lead towards it* (an archive, publications, year or issue page on
   the same organisation's sites, or a repository such as DSpace) or *irrelevant*. Leads are followed for `DOC_HUNT_ROUNDS` rounds, at most `DOC_HUNT_VISITS` pages, within
   `DOC_HUNT_TIMEOUT_MS`. Candidate documents are confirmed by their signature, and each keeps the pages that led to it
   (*Found via*).
3. **Review.** The search's own documents are reviewed while Jev explores; documents found inside websites are reviewed
   after. Up to 60 documents are judged (more are not shown); the text of the first 20 is read within 30 seconds (PDFs two at a time, so the first-ranked finish first): PDFs up
   to `PDF_MAX_BYTES`, viewer pages, and office files through the preview converter (`DOC_PREVIEW_CONVERTER`). The rest are
   judged on their title and snippet. Third-party copies count like any other, unless clearly a full commercial book.
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
`JEV_DOC_HUNT_DAILY_BUDGET` (Jev decisions per day, separate from the video exploration budget); `DOC_SOURCES_ENABLED`,
`DOC_SOURCES_DAILY_BUDGET`, `SEMANTIC_SCHOLAR_API_KEY` and `DOC_BLOCKLISTS`. See `.env.example`.
