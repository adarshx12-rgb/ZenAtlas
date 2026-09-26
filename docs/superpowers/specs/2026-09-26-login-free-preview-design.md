# Login-free preview — design

## Goal

Results from login-walled sites (X, Reddit, Quora, Instagram, Facebook, LinkedIn, Medium, Threads, Pinterest, TikTok…)
ask the user to sign in when clicked. The engine shows the content it found in a preview window attached to the result,
without signing in. Anything beyond that content (links inside it, "Continue to site") goes to the real site, whose login
rules apply again.

No login wall is bypassed on the site itself: content comes only from official public endpoints (oEmbed, the Reddit API)
or from what the engine already holds (search snippet, page text readable under robots.txt). No crawler spoofing, cookie
reuse, mirrors or fake accounts.

## Content sources

| Site | Source | Result |
|---|---|---|
| X / Twitter | `publish.x.com/oembed` (public, no key) | Full: tweet text, author, date, links |
| Reddit | Official API with app-only OAuth when `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are set: post title, body, top comments. Without keys: `reddit.com/oembed` (title, subreddit, author) | Full with keys, partial without |
| Pinterest | `pinterest.com/oembed.json` | Full: title, author |
| TikTok | `tiktok.com/oembed` (often redirected away from servers) | Full when it answers, else partial |
| Everyone else in `data/login-walled.json` | Page text via `PageChecker` (robots.txt respected), unless it is a login prompt; else the search snippet | Partial |

Rendered as plain text and links by our page; the site's HTML and scripts never run. Images are not shown (CSP
`img-src 'self'`); media appear as links.

## Server

- `data/login-walled.json`: host → display name.
- `src/walled.ts`: `walledSite(url)`; `walledToken(secret, url)` (HMAC, like the Docs preview token);
  `walledPreview(db, config, url, deps)` → `WalledPreview {host, site, complete: boolean, source, title, author, author_url,
  published, text, links: {url, text}[], comments: {author, text}[]}`. In-memory cache 30 min; budget
  `WALLED_PREVIEW_DAILY_BUDGET` (default 3000); timeout `PAGE_TIMEOUT_MS`.
- `src/web.ts`: a walled result gets `walled: {site, token}`.
- `GET /api/walled?url=&t=`: 403 `invalid_token` unless the token matches the URL (only engine results can be previewed —
  no open proxy); returns `WalledPreview`; failures return `{complete: false, text: null, ...}` so the page falls back to
  the snippet.
- `src/http.ts`: a string `body` is sent as-is (form bodies for the Reddit token call).

## Page

- A walled result shows a **Preview** badge; clicking its title opens the preview (modified clicks still open the site).
- **Desktop (room on the right):** a window about 520 px wide in the empty right column, top aligned with the row, a notch
  pointing left at the row; the row takes the window's colour so the two read as one. Clamped to the viewport; follows its
  row on scroll; closes when the row leaves the screen.
- **Phone / narrow:** the window opens directly below the row, notch pointing up, pushing later rows down.
- **Copy:** top line `🔓 Login-free preview · {host} normally asks you to sign in to see this. ZenAtlas brought it here
  for you.` (partial: `🔓 Login-free preview · {host} requires sign-in to read this. Here's what ZenAtlas could show
  without it.`). Footer: button `Continue to {host} ↗` with `{host} may ask you to sign in.` beneath.
- **Prefetch:** desktop on hover/focus; phone on touchstart, plus the first 3 walled results in view unless Data Saver is
  on or the connection is 2G/3G.
- **Navigation:** ↓/↑ next/previous walled result, Esc closes, focus moves into the window. Phone: swipe left/right for
  next/previous, swipe down, × or tapping outside closes.

## Implementation outline (TDD per step)

1. `src/walled.ts` + `data/login-walled.json` + config + `http.ts` string body; tests with a fake transport for each source,
   the token check, the cache, the login-prompt detection and the budget.
2. `web.ts` marks walled results; `/api/walled` route; tests.
3. `public/results.js` + `style.css`: badge, popover (desktop/phone placement), copy, prefetch, keyboard and swipe;
   verified in a real browser (desktop + phone) with Playwright.
4. Docs (`docs/WEB_SEARCH.md`, `docs/API.md`, `.env.example`).
