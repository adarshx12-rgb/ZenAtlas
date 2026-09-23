# Jev screening evaluation — 23 September 2026

**Assessment:** Jev is fast and inexpensive, but the current metadata-only screening setup is too conservative on the WhatsApp request and overconfident about format/content on the other two. Keep the final evidence checks and judge. This run does not establish calibrated accuracy or an overall ranking improvement.

## Method

Ran these exact queries through the application's live quick-discovery pipeline, with its configured search providers, planner, evidence checks and final judge:

1. `official whatsapp chat ui interface from over past 3 years`
2. `rosswell ufo incident real article`
3. `robert greene art of seduction pdf`

Jev ran through OpenRouter, which reported `typesafe/jev-1.13-20260917`. The existing promotion rule requires both confidence and promising probability of at least 0.80. Each query sampled 120 leads and checked an admission pool of 60. Confidence describes certainty in the selected label; it is not measured relevance accuracy. A high-confidence mismatch is not a good match.

The original Roswell run had three of six batches time out. The application correctly discarded partial promotions and retained its original ordering. A separate screening-only retry used the identical 218-candidate baseline and the same 4-second timeout; no new provider searches or final-judge calls were made for that retry. Its results are diagnostic and did not change the original search results.

## Measurements

| Query | Retrieved candidates | Jev labels: promising / uncertain / mismatch | Promoted | Mean confidence of promotions | Screening elapsed | Final results |
|---|---:|---:|---:|---:|---|---:|
| WhatsApp UI | 221 | 8 / 50 / 62 | 0 | — | 0.686 s | 21 |
| Roswell article, original run | 218 | Incomplete; 60 answers arrived | 0 applied | — | 4.034 s, fallback | 25 |
| Roswell, same-pool retry | Same 218 | 71 / 19 / 30 | 35 proposed | 90.94% | 2.315 s | Original results unchanged |
| Art of Seduction PDF | 177 | 28 / 15 / 77 | 19 | 93.16% | 0.999 s | 15 |

Full discovery took 34.5, 39.8 and 40.2 seconds respectively. Reported Jev cost across successful original and retry requests totaled **$0.005112702**. This excludes other search/model costs and any unreported charges for timed-out calls. Of the original 18 Jev batches, 15 returned and three timed out; all six retry batches returned. These observations are not a long-run reliability estimate.

## Findings

### WhatsApp: no screening benefit at this threshold

The eight promising labels had confidence of only 23–42%, so no candidate was promoted and the admission order was unchanged. The Meta design article “Keeping WhatsApp fresh, simple and approachable” received **26% confidence / 51% promising probability**, while the final judge scored it 9/10. Its retrieved description explicitly mentioned 9 May 2024 and a WhatsApp UI update. Its baseline rank was already 5, so it survived without Jev assistance.

The official WhatsApp chat-themes post received mismatch with only 28% confidence (6% promising probability), and its baseline rank of 65 left it outside the 60-candidate pool. The [official post](https://blog.whatsapp.com/chat-themes-to-reflect-your-style), dated 13 February 2025, discusses bubble colors, wallpapers and chat-theme settings. This is a useful dated UI lead, although one post does not supply the whole three-year history.

The search found useful sources, but its final list also included a current WhatsApp Web page and loosely related social/video results. It did not establish complete chronological coverage of the requested period. Jev was not responsible for improving this result list, since it changed no ordering.

### Roswell: operational fallback worked; format matching is weak

On the successful diagnostic retry, **14 of 35 promotions (40%) were YouTube watch pages**, although the user requested an article. Confidence for those videos ranged from **82% to 96%**. Examples include “The Roswell Incident and UFO Sightings Documentary - PART 1” at 85% and “Roswell: The First Reports” at 96%. This is a directly observable format error; it does not require assuming the final judge is correct.

The planner separately classified the request as `mixed`, with criteria that did not enforce article format. The final results contained useful article leads, including the Smithsonian and TIME, along with several videos. The original misspelling was effectively expanded into Roswell searches.

Of the retry's 35 proposed promotions, 23 overlapped candidates already judged in the original run; ten scored above 5 and thirteen did not. **This is agreement on an overlapping subset, not Jev accuracy.** Many non-accepted article candidates were merely unverified because the evidence was unavailable. Several are plausible article leads, so they should not be counted as demonstrated false positives. A real historical article also does not establish that an extraterrestrial explanation is true; [National Archives material](https://www.archives.gov/research/military/air-force/ufos) distinguishes the event and records from those claims.

### PDF: identifies download-like metadata but can mistake summaries for the book

The 19 promotions averaged **93.16% confidence / 95.58% promising probability**. Their confidence range was 81–99%. Nine passed the final judge and ten did not. Most non-accepted pages were inaccessible or unverified, which is a limitation of evidence collection rather than proof that their metadata was irrelevant.

One clear error was the Scribd document ending in `757161093`: **98% confidence / 99% promising probability**. Its title and search snippet looked like the requested book. Inspecting the [document page](https://www.scribd.com/document/757161093/The-Art-of-Seduction-Robert-Greene) shows a 38-page StoryShots summary and review. The final judge correctly rejected that mismatch with 4/10. Jev only saw the misleading metadata, illustrating why its confidence cannot substitute for inspecting the document.

Compared with the initial top 60, screening admitted two additional candidates: a Scribd page the judge rejected and an Archive PDF URL the judge gave 6/10 on metadata. That is one additional judged-acceptable lead, not a verified full-book download or proof of an overall ranking gain. Some displayed hits remained document listings or metadata-only PDF leads.

## Changes to test next

1. Give Jev the URL/domain, known result format, publication date and current date. Its present input contains only title, description and creator, making official-source, time-window and article/PDF distinctions unnecessarily difficult.
2. Separate format, subject and essential constraints into independent decisions. Respect explicit article/PDF requests when planning and selecting sources. For PDFs, distinguish full work, summary, excerpt and download listing after obtaining evidence.
3. Keep uncertain leads eligible and retain evidence-based final judging. Tune thresholds against a larger reviewed dataset; lowering 0.80 blindly would also admit more wrong-format results.
4. Evaluate bounded recovery for timed-out batches. The current all-or-nothing fallback preserves existing behavior, but one failed batch eliminates the benefit of all successful batches.

No promotion threshold, search routing rule, timeout or production prompt was changed for this evaluation. Added diagnostic decision capture and repeatable evaluation scripts only. Build and screener tests passed. Review here is assistant analysis with targeted source inspection, not independent human ground truth or a statistical calibration study.

## Recorded data

- [Original searches, raw decision responses, metadata, costs and final judgments](jev-evaluation-2026-09-23.json)
- [Separate Roswell same-pool retry](jev-roswell-retry-2026-09-23.json)
