# Candidate quality: durations, canonical sources, a refill round, images through the judge

Date: 2026-09-27. Status: approved by the user; built in the order below, one commit each, then the SSJ3 probe set rerun.

The 2026-09-27 SSJ3 probe run (`output/ssj3-suite-2026-09-27T09-42-40-845Z.json`) failed for four reasons, none of them the
judge architecture: V3 hid correct videos (a known duration could not confirm "under 10 minutes"); D2 ranked re-uploads
above Google's own PDF (only the first 20 documents are read, the rest are capped as unverified); W2 and W3 never fetched
authority or first-hand sources (Brave's top 40 held none); images have no judge at all.

## 1. Durations from the video's own details

A request's duration limit ("under 10 minutes", "over an hour", "between 5 and 15 minutes", "shorter than 90 seconds")
becomes a `duration` requirement built by rules from the query's words, like dates and formats. It is checked against the
duration from the video platform or the result's metadata: supported inside the range, contradicted outside, unknown when
no duration is known. The planner's own duration requirements are dropped when the rules made one. Language stays with the
judge (Hinglish titles make script detection unreliable).

## 2. Canonical preference

- Reading order (Docs, Web): candidates on the request's official domains (the contract's authority domains and the
  planner's `official_domains`), government and inter-governmental hosts, and the publisher's own host are read first.
- Ranking: among results within one relevance point, an official or canonical copy ranks above mirrors and re-uploads
  (Scribd, course archives, ResearchGate/Academia copies) and summaries; videos from the official channel above re-uploads.
- Judge criterion: prefer the original or official publication over copies of it.

## 3. Refill round after judging (all tabs, both tiers; tested on SSJ3)

After the first judging pass, the planner reviews what was kept (titles, hosts, scores, reasons; never page text) against
the request. When something the request needs is missing (an authority for a health question, first-hand accounts, the
official source), it writes 1-3 targeted searches. New candidates, minus every URL already seen, are screened by Jev and
judged; the kept ones merge into the list. At most one round, only when the planner asks for it, within the search's time
budget. Jev chooses among fetched candidates only; new searches are what bring new candidates.

## 4. Images through the planner and judge

The planner writes the image searches and requirements; the judge sees the thumbnails of the top results (the judge models
accept images); licence and attribution come from sources that publish them (Wikimedia Commons, Openverse), and results
without them are labelled licence unknown. "Not AI-generated" is filtered on source signals (Freepik ai-image URLs, stock
sites' Generative AI labels) and stated as such; pixels alone are not treated as proof.
