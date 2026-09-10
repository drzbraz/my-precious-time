# My Precious Time

A Manifest V3 Chrome extension: a private, real-time meeting cost meter for Google Meet. The extension itself has no build step and no dependencies. It optionally calls a small backend (`/backend`, see below) to turn "your rate × headcount" into a real group total when enough other participants also use it — see "Cost calculation" for exactly how, and why that's more delicate than it sounds.

## Run it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the extension popup, set a private hourly rate, then join a `meet.google.com` call.

There is no test suite and no build/lint tooling in this repo. Verify changes by reloading the unpacked extension and testing against a real Meet call (see "Manual test checklist" below).

### One-time setup: Google OAuth (needed for the "Connect Google account" button)

The extension now requests Google sign-in via `chrome.identity` (see "Google account linking" below) so a future backend can attribute a real total to a real person instead of a guess. `chrome.identity.getAuthToken` only works if a Google Cloud OAuth client is registered against this extension's exact ID — and an unpacked extension's ID normally depends on the folder path it was loaded from, which isn't stable. To fix that, `manifest.json` pins a `"key"` (the public half of `extension_key.pem`, generated once with `openssl genrsa`/`openssl rsa ... -pubout`), which forces this extension to always load with the same ID: **`mapdgmebijfbljbjnpdlfgkahglojdjb`**.

To finish wiring OAuth (only needs doing once, by whoever owns the Google Cloud project):

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project → **APIs & Services → OAuth consent screen** → configure it (External is fine; add yourself as a test user while the app is unpublished).
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type **Chrome Extension** → Application ID: `mapdgmebijfbljbjnpdlfgkahglojdjb`.
3. Copy the generated client ID into `manifest.json`'s `oauth2.client_id`.
4. Reload the unpacked extension, open the popup, click **Connect Google account**.

This is done — `oauth2.client_id` is a real Chrome Extension–type client. If it ever needs regenerating (e.g. a new Google Cloud project), application type must be **Chrome Extension** specifically (a Desktop/Web/"installed" client will fail with a redirect/URI mismatch, not the client ID itself), and don't activate GCP billing/free-trial — creating an OAuth consent screen and client ID is free and doesn't require it. Also make sure every Google account you'll test with is added as a **test user** on the OAuth consent screen — an unpublished app otherwise blocks sign-in for anyone not listed.

The private key itself (`extension_key.pem`) lives **outside this folder**, at `../my-precious-time-keys/extension_key.pem` — not just gitignored, but physically outside the directory `chrome://extensions` loads. Chrome scans the entire loaded folder and warns ("This extension includes the key file... you probably don't want to do that") if a `.pem` sits inside it, regardless of `.gitignore`. Nothing at runtime needs the private key present — only the public-key-derived `"key"` string already in `manifest.json` matters for Load Unpacked.

### Publishing to the Chrome Web Store — the `"key"` field must NOT be in the uploaded package

The Store rejects any manifest containing `"key"` ("O campo key não é permitido no manifesto") — that field is a *local-dev-only* trick; the Store always assigns its own permanent ID regardless. This means **two different manifests exist for two different purposes**:

- **This repo's `manifest.json`** (with `"key"`) — for `Load Unpacked` / local dev, so the ID stays pinned to `mapdgmebijfbljbjnpdlfgkahglojdjb` and OAuth testing keeps working.
- **The Store package** (`dist/precious-time-v0.2.0.zip`, built by stripping `"key"` from a copy of the manifest before zipping — see the packaging command in project history) — this gets a **different, permanent ID assigned by the Store**, visible in the dashboard as soon as the item is created, before review/publishing.

**That ID mismatch breaks Google sign-in on the published version** until the OAuth client in Google Cloud Console is updated: either edit the existing Chrome Extension–type client's Application ID to the Store's ID, or add a second Chrome Extension client scoped to it. Whichever `client_id` ends up in the *published* manifest's `oauth2.client_id` must belong to a client whose Application ID is the Store's real ID, not the dev one. Do this update as soon as the Store assigns the ID — don't wait for review to finish.

If `dist/` needs regenerating: copy `manifest.json`, delete its `"key"` field, then zip that copy plus `content.js`, `service-worker.js`, `popup.html`/`.js`/`.css`, `overlay.css`, and only the four sized `public/icon*.png` files (not the 1.5MB `public/icon.png` source, which nothing references).

## Architecture

Four independent entry points, no bundler, no shared module (see Known tradeoffs):

| File | Runs where | Responsibility |
|---|---|---|
| `manifest.json` | — | MV3 config: permissions, content script/service worker registration, icons |
| `public/icon*.png` | — | Extension icon at 16/32/48/128px (`public/icon.png` is the 1254×1254 source; regenerate the sized ones from it with e.g. `sips -z <size> <size> icon.png --out icon<size>.png` if it's replaced) |
| `service-worker.js` | background (ES module) | Seeds default settings on install; persists meeting history (`saveMeeting` message); owns the actual Google OAuth flow (`connectGoogle`/`disconnectGoogle` messages) |
| `content.js` | injected into `meet.google.com` | Detects call state via DOM heuristics, renders the floating meter overlay and end-of-meeting summary, computes cost locally |
| `popup.js` / `popup.html` / `popup.css` | extension popup | Settings form (salary, hours), a read-only "ready" view once configured, and a Google account connect/disconnect button that delegates to the service worker |
| `overlay.css` | injected into `meet.google.com` | Styles for the in-page overlay and summary modal |

All state (`chrome.storage.local`) lives in a single settings object plus a capped `meetings` history array (see `DEFAULTS` in each file — see below for why it's duplicated).

### `content.js` internals

Everything is a single IIFE polling on an interval — there's no MutationObserver, deliberately (see comment at the bottom of the file: Meet's DOM churns too fast/heavily to observe directly without risking call performance).

- **Detection is heuristic, not API-based.** Google Meet has no stable public API for call state or participant count. `inMeeting()`, `meetingHasEnded()`, and `participantCount()` all match against `aria-label`/`data-tooltip`/text content using regexes that include Portuguese strings alongside English (Meet locale coverage is intentionally partial — extend the regex constants at the top of the file if you need another locale, don't add a translation layer).
- **Salary never leaves `chrome.storage.local`.** Only the *derived* `ratePerMinute` number is ever sent anywhere (to our own backend, if connected) — see "Cost calculation" below for exactly what that backend does and doesn't reveal.
- **Always live, no display modes.** The overlay used to have three modes (`live`/`milestones`/`end`) trading off "gentleness" against always-on accuracy; that setting was removed entirely (see git history) in favor of always-live rendering plus a manual eye-toggle for discretion (below) — the user controls when to look, rather than the extension deciding when to reveal on a timer. Don't reintroduce a display-mode picker; if a "quieter" mode is wanted again, it should extend the eye-toggle idea, not resurrect delayed reveals.
- **The eye toggle (`costHidden` in `content.js`) masks the cost figure only, not the timer or participant count.** Click state, not a stored preference — resets on tab reload, same lifecycle as `dismissed`. Icon convention follows a password field: open eye = visible (click to hide), slashed eye = hidden (click to reveal) — see `eyeIconSVG()`/`updateEyeButton()`. This does **not** apply to the end-of-meeting summary modal, which always shows the real total — the risk this protects against (someone glancing at your screen mid-call) mostly doesn't apply once the call's over.
- **Polling, not events**, drives both call-state checks (`POLL_INTERVAL_MS`) and the visible timer (`RENDER_INTERVAL_MS`); a third, slower timer (`HEARTBEAT_INTERVAL_MS`, 20s) drives the backend sync — see below.
- **The overlay is draggable** (`makeDraggable()`, using Pointer Events on `.mm-head`) and remembers where you put it (`chrome.storage.local.overlayPosition`, `{top, left}` in px). Position is re-clamped to the current viewport on every mount (`applySavedPosition()`), not just while dragging — otherwise a position saved on a wider screen (e.g. an external monitor) would strand the overlay off-screen on a laptop display.
- **Dismissing the overlay (×) is session-only and reachable from the popup.** `dismissed = true` only stops `mount()` from recreating the DOM node — it doesn't touch `timer`/`groupSyncTimer`, so the meter keeps tracking in the background even while hidden. The popup's "Show meter on this call" button (`popup.js`: `initShowOverlayButton()`) queries the active tab and sends `{type: "showOverlay"}`, which `content.js` handles by resetting `dismissed` and calling `mount()` — the very next `render()` tick (≤1s later) shows it fully caught up, no re-sync needed. That button reads `tab.url` via `chrome.tabs.query` without the `"tabs"` permission — it works because `host_permissions` already covers `meet.google.com`, which is enough for Chrome to populate `url` for matching tabs; don't add `"tabs"` back for this, it was deliberately removed earlier as unused.
- **Content-script CSS is injected once per tab, not hot-reloaded.** Reloading the extension in `chrome://extensions` re-reads `popup.html`/`.js`/`.css` (the popup always fetches fresh), but an already-open Meet tab keeps running whatever `overlay.css`/`content.js` it originally injected — it won't pick up changes until that specific tab is refreshed, not just the extension. A recurring "the overlay still looks old" report almost always means this, not a missed code change — check the popup's own appearance first (it reloads instantly) to tell the two apart.

### Cost calculation

`effectiveRatePerMinute()` in `content.js` is the one function that decides what number gets shown, and it's the result of a real design discussion (see project history), not an obvious formula:

- **No one else connected, or fewer than 3 people connected**: exactly today's original behavior — `personalPerMinute() * lastParticipants` (your own rate × Meet's on-screen headcount). This is a guess and has always been presented as one.
- **3 or more people connected** (i.e. `groupAggregate` is non-null — see below): `(groupAggregate.ratePerMinuteSum / groupAggregate.participantCount) * max(lastParticipants, groupAggregate.participantCount)` — the *average* real rate of everyone known, applied to the full headcount. Exact once every visible participant is connected; an extrapolation below that (shown with a "≈" prefix — see `costPrefix()`).
- **Why 3, not 1**: with only 1-2 people's real rates known, *any* combined number (sum, average, or a total built from it) can be reversed — you know your own rate, so `(known combined figure) − your rate` gives the other person's exact rate. This is enforced **server-side** (`MIN_GROUP_SIZE_FOR_SUM` in `backend/src/index.js` — the backend withholds `ratePerMinuteSum` entirely below 3, not just the UI), because a client can always inspect its own network requests. `content.js` treats a withheld sum (`ratePerMinuteSum: null` in the response) identically to "not connected."
- **The average rate itself is never displayed, anywhere**, even once 3+ are connected. A "€X/min" figure *is* the average — showing it (especially one that visibly jumps when someone joins) is exactly the same leak in slower motion, just framed as a rate instead of a sum. Live view and the end-of-meeting summary both replace that figure with a "connected"/"verified" count instead (`coverageText()` in `content.js`, `knownParticipants` in the summary). **Don't reintroduce a numeric rate/average anywhere in the UI once group data is involved** — this was an explicit, deliberate call, not an oversight.
- **Still a snapshot, not an integral**: like the pre-backend version, cost is `elapsed time × current rate`, not accumulated second-by-second as the rate changes. If the group's rate-sum shifts mid-call (someone joins/leaves), the new rate gets applied retroactively to the whole elapsed duration rather than only from the moment it changed. Known, accepted simplification — a per-second accumulator would be more correct but wasn't built (see git history discussion).

### Known tradeoffs (intentional, not oversights)

- `DEFAULTS` is redefined separately in `content.js`, `popup.js`, and `service-worker.js` instead of a shared module. MV3 content scripts execute as plain (non-module) scripts, while the service worker is an ES module — sharing a single `const DEFAULTS` file across both would require either a build step or two copies of the constants file (one with `export`, one without). For a 3-file MVP with no bundler, the duplication was judged cheaper than that split. If a fourth consumer of `DEFAULTS` shows up, revisit this.
- Participant count and call-state detection are best-effort DOM scraping and **will break** when Google changes Meet's UI. Treat any Meet-facing change as needing manual regression testing against the current Meet build, not just unit-level reasoning.
- The floating overlay confirms the extension is active even before a call starts (see the comment above `mount()` in `content.js`) — this is intentional, not leftover debug UI: Chrome doesn't let extensions auto-open their popup, so the in-page card is the "it's installed and working" signal.

## Privacy boundary (v0.2)

Salary and work schedule are stored only in `chrome.storage.local` and never transmitted. Only a derived `ratePerMinute` number is sent anywhere, and only to our own backend (`/backend`), and only once you've connected a Google account. With fewer than 3 people connected in a given meeting, nothing has changed from v0.1: the overlay multiplies your own local rate by Meet's on-screen headcount, same guess as always.

With 3+ people connected, the backend computes a real average of known real rates and hands back only `{participantCount, ratePerMinuteSum}` — never an individual rate, and never anything at all below the 3-person floor (enforced server-side; see "Cost calculation" above for why). `teamCode` remains a placeholder key in the storage schema with no UI and no effect — the actual team-aggregation mechanism that shipped is the Google-account + backend flow described here, not `teamCode`.

### Google account linking

The popup connects a Google account, but **the actual OAuth flow runs in `service-worker.js`, not `popup.js`** — this is load-bearing, not a style choice. `chrome.identity.getAuthToken({interactive: true})` opens a real browser window for the Google account picker; that window taking focus makes Chrome auto-close the popup bubble that triggered it, which would kill the flow mid-flight if it ran there. `popup.js` (`connectGoogleAccount`/`disconnectGoogleAccount`) only sends a `{type: "connectGoogle"}`/`{type: "disconnectGoogle"}` message and re-reads `chrome.storage` afterward (also live-updated via a `chrome.storage.onChanged` listener, in case the popup outlives the round-trip); `service-worker.js` does the real `getAuthToken` → `https://www.googleapis.com/oauth2/v3/userinfo` → `chrome.storage.local.set({googleAccount: {sub, email, name}})` work, since a service worker isn't a window and can't lose focus. **Don't move this logic back into the popup.**

`content.js` never talks to Google or the backend directly — it sends a `{type: "syncMeetingCost", meetingId, ratePerMinute}` message every `HEARTBEAT_INTERVAL_MS` (20s) and `service-worker.js` does the real work (`syncMeetingCost()`: silent token → `POST .../presence` → `GET .../aggregate`). Two reasons, both load-bearing: (1) it must never trigger the interactive picker mid-meeting, and a silent `getAuthToken({interactive: false})` resolving to "not connected" needs a specific place to live; (2) a content script's `fetch()` runs subject to the *host page's* CSP — there's no reliable way to verify from this codebase that Meet's CSP wouldn't interfere, whereas a service worker is never subject to any page's CSP. **Don't move backend calls into `content.js`** for the same reason the OAuth flow doesn't live in the popup.

`service-worker.js` distinguishes two failure shapes when `syncMeetingCost` rejects: `Error("not_connected")` (no cached token — `content.js` drops `groupAggregate` to `null` immediately, same as if the backend didn't exist) vs. anything else (a failed fetch — `content.js` keeps the last known `groupAggregate` rather than flicker the display back to the local estimate for one missed beat).

## Backend (`/backend`)

A separate Cloudflare Workers + D1 project, deployed and live at **https://precious-time-backend.drz-braz.workers.dev**, deliberately outside the extension's own "no build step" boundary described above. See `/backend` for the actual code; this is the summary.

- **Why Cloudflare, not the originally-planned MongoDB Atlas**: Atlas's Data API (the HTTPS-based access this design needed, since Workers can't hold a persistent DB driver connection) was deprecated and fully shut down 2025-09-30. Cloudflare D1 replaced it — a SQL database that's a native Workers binding (`env.DB`), no network hop, no separate account/API keys, and it's genuinely free at this scale (no credit card, unlike Railway's trial-then-paid model).
- **Two endpoints**, both under `/v1/meetings/:meetingId/`, both requiring `Authorization: Bearer <Google OAuth token>` verified server-side via `https://www.googleapis.com/oauth2/v3/tokeninfo` on every request (see `verifyGoogleToken` in `backend/src/index.js`) — the same kind of token the extension obtains via `chrome.identity` (see above):
  - `POST .../presence` — upserts `{meetingId, userId, ratePerMinute, lastSeenAt: now}`. Called every `HEARTBEAT_INTERVAL_MS` (20s, see `content.js`) as a heartbeat while in a call.
  - `GET .../aggregate` — returns `{participantCount, ratePerMinuteSum, asOf}`, where `ratePerMinuteSum` is `null` below `MIN_GROUP_SIZE_FOR_SUM` (3) — see "Cost calculation" above for why that floor exists and why it's enforced here, not just client-side. Computed only from rows that heartbeated within `ACTIVE_WINDOW_MS` (45s). **Requires the caller to already have an active presence row for that same meeting** — this is what stops someone from guessing a Meet URL and reading its cost without being in the call.
- **Sum-only, by construction**: no code path in `backend/src/index.js` returns another participant's individual `ratePerMinute` — only `SUM()`/`COUNT()`, and only once `MIN_GROUP_SIZE_FOR_SUM` is met. Don't add a "list participants" endpoint or an aggregate field that leaks a per-row value or that lowers/removes the 3-person floor; that's the whole reason this backend exists instead of a naive shared roster.
- **Input hardening**: `ratePerMinute` is capped at `MAX_RATE_PER_MINUTE` (€600/min — a sanity ceiling against a corrupted client value skewing the shared sum, not a real-world limit) and `meetingId` must match `MEETING_ID_PATTERN` before it ever reaches a query.
- **Config vs. secrets**: `OAUTH_CLIENT_ID` lives in `wrangler.toml`'s `[vars]`, committed — it's non-secret by design (a Chrome Extension OAuth client ID is embedded in every copy of the extension anyway). There are no real secrets in this project yet (D1 is a native binding, no connection string; no paid third-party API is called). If one shows up: **local dev** → copy `backend/.dev.vars.example` to `backend/.dev.vars` (gitignored) and fill it in, which `wrangler dev` reads automatically; **production** → `wrangler secret put NAME` (interactive, encrypted, never touches a file). Never put a real secret in `wrangler.toml` — that file is committed.
- **Cleanup**: a Cron Trigger (`[triggers] crons` in `wrangler.toml`, hourly) calls the `scheduled()` export, which deletes `presence` rows older than `CLEANUP_AGE_MS` (24h — generous margin past the 45s active window; this is table hygiene, not part of the active-participant logic).
- **Redeploying**: `cd backend && npx wrangler deploy`. Schema changes go in `backend/schema.sql` and need `npx wrangler d1 execute precious-time --local --file=./schema.sql` (dev) and `--remote` (production) — local and remote D1 are separate databases that don't sync automatically.
- **Access is already gated for a POC, via Google, not app code**: the OAuth consent screen is in "Testing" mode, so *only* Google accounts added as test users in Cloud Console can complete sign-in at all — anyone else's `chrome.identity.getAuthToken` fails before a token is ever issued. This is a real access control for a small-group POC, not a placeholder; going beyond ~100 testers means either adding more test users or publishing the consent screen (the `userinfo.email`/`.profile` scopes used here are non-sensitive, so that likely doesn't require Google's full verification review, but wasn't checked end-to-end).
- **Not verified end-to-end**: everything above has been checked individually (Worker deploys, rejects bad/missing tokens, D1 schema applied both locally and remotely, cron registered) from a sandboxed environment that cannot reach `*.workers.dev` or open a real Google sign-in flow. **A real multi-account test in an actual Meet call — 3+ people, each clicking Connect — has not happened yet.** Do that before calling this done.

## Design system (`popup.css`)

The popup is one small, deliberately minimal component set — resist re-introducing one-off styles per screen:

- **One card shape**: `.stat` is the only "label / value" row component (private rate, Google account). `.stat--accent` is the only visual emphasis available, reserved for the number the user cares about most (their own rate) — don't add a third variant without a real reason.
- **One spacing source**: `.stack { gap: var(--space-4) }` drives all vertical rhythm between fields/cards/buttons in both views. Don't add per-element `margin` to space things out — wrap them in (or add to) a `.stack` instead. This replaced several hand-tuned (including negative) margins that had drifted out of alignment.
- **Real branding, not placeholders**: the header uses `public/icon32.png`, the actual extension icon — not a text/letter mark. If the icon changes, the header updates automatically (same file, no separate asset to keep in sync).
- **`modes.css` was removed** — its two card styles (`.mode-card`, `.account-card`) were near-duplicates of `.stat`; consolidated as `.stat`/`.stat--accent` in `popup.css`. There is now exactly one stylesheet for the popup.
- **Palette is derived from the actual icon** (`public/icon.png`, a gold ring on black — the "My Precious" reference is literal), not a generic "money app" green. All three surfaces — `popup.css`, `overlay.css`, and the `#meeting-meter-summary` modal in `overlay.css` — share one dark, warm theme: near-black grounds (`#0c0803`/`#0a0704`), warm parchment text (`#f3e7d2`/`#f4e8d4`), amber gold as the one accent (`#d99a3d` for fills/eyebrows/focus, `#ffd699` for hero numbers/headings). The token *names* in `popup.css` (`--ink`, `--muted`, `--green`, `--dark`, `--mint`) are unchanged from the original light theme — only their *values* changed — specifically so every existing `var(--x)` call site kept working across the re-theme without a rewrite; don't rename these tokens without also checking every call site.
- **Primary buttons flip the usual contrast direction on purpose**: `button` is a solid gold fill (`var(--green)`) with near-black text (`#17110a`), not a dark fill with light text — on an already-dark page, the button needs to be the *brightest* thing to read as clickable, matching the ring's own "bright gold on black" logic. `.secondary` stays outlined (transparent fill, gold-cream text, dark border) for lower-emphasis actions.
- **Semantic status color (green) is intentionally separate from the brand accent (gold)**: the connected/ready dot and pill (`#3ddb96`) and the live-call coral dot (`#fa8c8c`) are state indicators, not brand color — don't reassign them to gold just for palette purity. Three colors doing three different jobs (gold = brand/action, green = "good/connected," coral = "live") reads more clearly than collapsing them into one.

## Conventions for changes here

- No transpiler/bundler: any JS you write runs as-is in a content script, service worker, or popup context. Check which context before using an API (`chrome.storage` is fine everywhere; `chrome.tabs`-style APIs need a `permissions` entry in `manifest.json` — don't add permissions that aren't actually used, and remove ones that stop being used).
- Prefer extending the existing regex/constant tables (e.g. `MEETING_ENDED_PATTERN`, `DISPLAY_MODE_LABELS`) over branching logic when adding a new phrase, locale, or mode.
- Money/time formatting (`Intl.NumberFormat`, `timeText`) is duplicated between `content.js` and `popup.js` in slightly different local forms — same tradeoff as `DEFAULTS` above, same threshold for revisiting it.
- Keep the "why" comments (DOM-heuristics rationale, polling-vs-observer rationale, teamCode placeholder) — they explain non-obvious constraints from Meet's UI and the privacy model, not what the code does.
- Setup asks for as little as possible on purpose (salary, hours/week) — `weeksPerYear`, `teamCode`, and the display-mode picker were all deliberately removed from the form (see git history) because they either can't be guessed by a user, do nothing yet, or were replaced by a better mechanism (the eye toggle). Don't add a field back without a UI reason the user will immediately understand.

## Manual test checklist (no automated tests exist)

- Fresh install → popup shows setup form → save → popup shows "ready" view with correct hourly rate.
- Open `meet.google.com` (no call) → "My Precious Time is ready" card appears, top-right.
- Join a real Meet call → timer starts, participant count updates, cost updates live every second.
- Click the eye icon → cost masks to `•••••`, timer/participant count keep updating, icon switches to the slashed variant. Click again → cost reappears, icon switches back.
- Leave the call (both via the Leave button and via being removed/host-ended) → summary modal appears once, meeting is saved to `chrome.storage.local` (`meetings` array), overlay is cleaned up.
- Dismiss the overlay (×) → it does not reappear on its own for the rest of that Meet tab's session. Open the popup while still on that Meet tab → **Show meter on this call** button is visible → click it → overlay reappears with live data, popup closes. Open the popup on any non-Meet tab → button is not shown at all.
- Drag the overlay by its header to a new spot → it stays there through a re-render; reload the Meet tab → it reopens in the same spot (not the default top-right corner).
- Click **Connect Google account** (once the OAuth client ID is filled in) → Chrome's account picker appears → after granting, the popup shows the connected email and the button flips to **Disconnect**. Click **Disconnect** → button flips back and the stored `googleAccount` is gone (check via the extension's storage in DevTools).
- With 1-2 connected accounts in the same real Meet call, the overlay must behave exactly as if nobody were connected (own-rate × headcount, no "≈", no "connected" count) — this is the privacy floor, not just a nice-to-have; if it shows a group figure below 3 connected, that's a regression, not a feature.
- With 3+ connected accounts in the same real call: overlay bottom-left switches to "N of M connected" (or "M connected" once full coverage), cost gets a "≈" prefix until full coverage, and no €/min figure appears anywhere in the live view or the end-of-meeting summary.
