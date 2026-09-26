# Web search

The Web tab shows what Brave (then SearXNG) finds at once, and then checks every result for relevance and accuracy in
the background, removing pages that do not match and ranking the rest, each with a reason.

## 1. Search (inside the `/api/web` request)

`src/web.ts`: Brave first; SearXNG fills in when Brave is missing, fails or finds fewer than `BRAVE_MIN_RESULTS`. Shadow
libraries (`data/access-sources.json`) are dropped. The response lists the results at once and carries a `review` token.

## 2. Review (in the background, polled at `/api/web/review?token=…`)

`src/web-review.ts`, using the review shared with the Docs tab (`src/review.ts`):

1. **Read.** Every result is read (`PageChecker`, no browser), six at a time, within `WEB_REVIEW_READ_MS`. A page that
   cannot be read (bot block, robots.txt, error, too slow) is judged on its title and snippet; it is not removed, since
   many good sites refuse automated reads. With more than 40 results the Jev screener decides which are read first.
2. **Jev analyses each page** (`src/jev-judge.ts`, gate mode). From exact snippets of the page text, one Jev call answers:
   does the page satisfy the request (relevance score, and which snippet shows it), and does its information look accurate
   (specific, credible, consistent; no spam, generated filler, clickbait or outdated claims). A page Jev confidently says
   misses the request, or whose accuracy is below `WEB_JEV_ACCURACY_MIN`, is removed. Jev cannot check facts against the
   world: accuracy here is the page's own signals of reliability.
3. **LLM judge.** Every page that passed Jev goes to the LLM judge, with Jev's reading attached as advisory `jev_check`.
   Pages at relevance 4 or below, or with an intent mismatch, are removed.
4. **Rank.** The rest are ordered by relevance; ties keep search order. Each shows "Why this matches (n/10): …".

The page refines the list in place when the review completes; rows from later result pages are untouched, and each later
page is reviewed on its own. Reviews run in the API process, at most four at once, and are kept for ten minutes.

| Failure | Result |
|---|---|
| No judge configured, or `WEB_REVIEW_ENABLED=false` | No review; results as found |
| Screener unavailable | Read in search order |
| Jev unavailable or out of budget | Every page goes to the LLM judge |
| LLM judge unavailable | Jev's removals stand; the rest stay in search order, without reasons |
| Server busy (four reviews running) | Results as found, with a notice |
| Review expired or poll failed | Results as found |

## Login-free preview

Results from login-walled sites (`data/login-walled.json`: X, Reddit, Quora, Instagram, Facebook, LinkedIn, Medium,
Threads, Pinterest, TikTok…) carry a **Preview** badge. Clicking the title opens a window attached to the result (beside
it on wide screens, below it on phones) with the content the engine found, labelled *Login-free preview*, and a
**Continue to {site}** button. Links in the window and the button go to the site itself, where its login rules apply.

The site's login wall is never touched (`src/walled.ts`): X and Pinterest (and TikTok when it answers) give the content
through their public oEmbed endpoints; Reddit through its official API with this instance's app keys
(`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`), or only its title through oEmbed without them; every other site shows its
page text when robots.txt allows reading it and it is more than a login prompt, else the search snippet. The preview is
rendered as plain text by our page; the site's HTML and scripts never run. Previews load ahead on hover or focus, on
touch, and for the first three walled results in view (not on Data Saver or 2G/3G); ↓/↑ or a swipe move to the next
walled result, Esc, × or a swipe down close it.

## Should Jev decide confident matches alone?

Not yet: in the Web tab Jev only removes. Pages Jev *would* have accepted on its own are recorded as `would_settle`, and
each review writes one line to the API log (counts only, never the query):

```json
{"event":"web_review","judged":20,"jev_rejected":3,"jev_would_settle":2,"settle_agreement":1}
```

`settle_agreement` is the share of would-settle pages the LLM judge scored 7 or more. When it stays high over many
searches, `WEB_JEV_SETTLE=true` lets Jev accept those pages without the LLM judge, saving judge calls.

## Settings

`WEB_REVIEW_ENABLED`, `WEB_REVIEW_READ_MS`, `WEB_JEV_ACCURACY_MIN`, `WEB_JEV_SETTLE`. Jev and judge spending comes from the
existing daily budgets (`JEV_SCREEN_DAILY_BUDGET`, `JEV_JUDGE_DAILY_BUDGET` and the judge's own). See `.env.example`.
