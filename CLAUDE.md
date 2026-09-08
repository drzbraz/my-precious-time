# Precious Time

A Manifest V3 Chrome extension: a private, real-time meeting cost meter for Google Meet. No build step, no dependencies, no server — everything runs locally in the browser.

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

The private key itself (`extension_key.pem`) lives **outside this folder**, at `../my-precious-time-keys/extension_key.pem` — not just gitignored, but physically outside the directory `chrome://extensions` loads. Chrome scans the entire loaded folder and warns ("This extension includes the key file... you probably don't want to do that") if a `.pem` sits inside it, regardless of `.gitignore`. Nothing at runtime needs the private key present — only the public-key-derived `"key"` string already in `manifest.json` matters for Load Unpacked. Keep it out of this folder; when this extension is eventually published to the Chrome Web Store, the Store assigns its own permanent ID and the OAuth client will need to point at that ID instead (a separate step at publish time, not needed now).

## Architecture

Four independent entry points, no bundler, no shared module (see Known tradeoffs):

| File | Runs where | Responsibility |
|---|---|---|
| `manifest.json` | — | MV3 config: permissions, content script/service worker registration, icons |
| `public/icon*.png` | — | Extension icon at 16/32/48/128px (`public/icon.png` is the 1254×1254 source; regenerate the sized ones from it with e.g. `sips -z <size> <size> icon.png --out icon<size>.png` if it's replaced) |
| `service-worker.js` | background (ES module) | Seeds default settings on install; persists meeting history (`saveMeeting` message); owns the actual Google OAuth flow (`connectGoogle`/`disconnectGoogle` messages) |
| `content.js` | injected into `meet.google.com` | Detects call state via DOM heuristics, renders the floating meter overlay and end-of-meeting summary, computes cost locally |
| `popup.js` / `popup.html` / `popup.css` | extension popup | Settings form (salary, hours, display mode), a read-only "ready" view once configured, and a Google account connect/disconnect button that delegates to the service worker |
| `overlay.css` | injected into `meet.google.com` | Styles for the in-page overlay and summary modal |

All state (`chrome.storage.local`) lives in a single settings object plus a capped `meetings` history array (see `DEFAULTS` in each file — see below for why it's duplicated).

### `content.js` internals

Everything is a single IIFE polling on an interval — there's no MutationObserver, deliberately (see comment at the bottom of the file: Meet's DOM churns too fast/heavily to observe directly without risking call performance).

- **Detection is heuristic, not API-based.** Google Meet has no stable public API for call state or participant count. `inMeeting()`, `meetingHasEnded()`, and `participantCount()` all match against `aria-label`/`data-tooltip`/text content using regexes that include Portuguese strings alongside English (Meet locale coverage is intentionally partial — extend the regex constants at the top of the file if you need another locale, don't add a translation layer).
- **Cost math is always local.** `personalPerMinute()` derives from the user's own stored salary/hours; nothing about salary ever leaves `chrome.storage.local`.
- **Display modes** (`live`, `milestones`, `end`) are a UX choice to avoid anxiety-inducing constantly-ticking numbers — `milestones` (the default) only reveals a new total every `MILESTONE_SECONDS` (10 min).
- **Polling, not events**, drives both call-state checks (`POLL_INTERVAL_MS`) and the visible timer (`RENDER_INTERVAL_MS`).

### Known tradeoffs (intentional, not oversights)

- `DEFAULTS` is redefined separately in `content.js`, `popup.js`, and `service-worker.js` instead of a shared module. MV3 content scripts execute as plain (non-module) scripts, while the service worker is an ES module — sharing a single `const DEFAULTS` file across both would require either a build step or two copies of the constants file (one with `export`, one without). For a 3-file MVP with no bundler, the duplication was judged cheaper than that split. If a fourth consumer of `DEFAULTS` shows up, revisit this.
- Participant count and call-state detection are best-effort DOM scraping and **will break** when Google changes Meet's UI. Treat any Meet-facing change as needing manual regression testing against the current Meet build, not just unit-level reasoning.
- The floating overlay confirms the extension is active even before a call starts (see the comment above `mount()` in `content.js`) — this is intentional, not leftover debug UI: Chrome doesn't let extensions auto-open their popup, so the in-page card is the "it's installed and working" signal.

## Privacy boundary (v0.1)

Salary and work schedule are stored only in `chrome.storage.local`. No network calls exist anywhere in this codebase. The overlay multiplies the participant *estimate* by the user's own local rate — it is explicitly an estimated, single-user-perspective cost, not a verified team total.

A genuine team-wide cost (without any user having to trust another user's stored salary) would need authenticated group membership plus a secure aggregation protocol (masked/signed per-minute contributions that only reveal a sum). `teamCode` is a placeholder key in the storage schema (`DEFAULTS` in `popup.js`/`service-worker.js`) for this future direction — it currently has no UI (removed for onboarding simplicity, see "Design system" below) and does nothing. Don't wire it up to naive "share your rate" logic; that would break the privacy guarantee this extension exists for.

### Google account linking (in progress)

The popup can connect a Google account, but **the actual OAuth flow runs in `service-worker.js`, not `popup.js`** — this is load-bearing, not a style choice. `chrome.identity.getAuthToken({interactive: true})` opens a real browser window for the Google account picker; that window taking focus makes Chrome auto-close the popup bubble that triggered it, which would kill the flow mid-flight if it ran there. `popup.js` (`connectGoogleAccount`/`disconnectGoogleAccount`) only sends a `{type: "connectGoogle"}`/`{type: "disconnectGoogle"}` message and re-reads `chrome.storage` afterward (also live-updated via a `chrome.storage.onChanged` listener, in case the popup outlives the round-trip); `service-worker.js` does the real `getAuthToken` → `https://www.googleapis.com/oauth2/v3/userinfo` → `chrome.storage.local.set({googleAccount: {sub, email, name}})` work, since a service worker isn't a window and can't lose focus. **Don't move this logic back into the popup.**

This is the auth foundation for the future team-aggregation backend (see the design discussion in project history: a backend verifies this same token server-side per request, so it never has to trust a client-asserted identity, and only ever returns an aggregate sum for a meeting — never per-person rates).

As of now this connection is client-side only — no backend exists yet, so connecting an account doesn't change any cost math and doesn't send the token anywhere beyond Google's own endpoints. Don't send `ratePerMinute`/salary data alongside this token to any endpoint until the aggregate-only backend described above exists; sending raw rates anywhere before that backend can enforce "sum-only" responses would break the privacy guarantee.

## Design system (`popup.css`)

The popup is one small, deliberately minimal component set — resist re-introducing one-off styles per screen:

- **One card shape**: `.stat` is the only "label / value" row component (private rate, display mode, Google account). `.stat--accent` is the only visual emphasis available, reserved for the number the user cares about most (their own rate) — don't add a third variant without a real reason.
- **One spacing source**: `.stack { gap: var(--space-4) }` drives all vertical rhythm between fields/cards/buttons in both views. Don't add per-element `margin` to space things out — wrap them in (or add to) a `.stack` instead. This replaced several hand-tuned (including negative) margins that had drifted out of alignment.
- **Real branding, not placeholders**: the header uses `public/icon32.png`, the actual extension icon — not a text/letter mark. If the icon changes, the header updates automatically (same file, no separate asset to keep in sync).
- **`modes.css` was removed** — its two card styles (`.mode-card`, `.account-card`) were near-duplicates of `.stat`; consolidated as `.stat`/`.stat--accent` in `popup.css`. There is now exactly one stylesheet for the popup.

## Conventions for changes here

- No transpiler/bundler: any JS you write runs as-is in a content script, service worker, or popup context. Check which context before using an API (`chrome.storage` is fine everywhere; `chrome.tabs`-style APIs need a `permissions` entry in `manifest.json` — don't add permissions that aren't actually used, and remove ones that stop being used).
- Prefer extending the existing regex/constant tables (e.g. `MEETING_ENDED_PATTERN`, `DISPLAY_MODE_LABELS`) over branching logic when adding a new phrase, locale, or mode.
- Money/time formatting (`Intl.NumberFormat`, `timeText`) is duplicated between `content.js` and `popup.js` in slightly different local forms — same tradeoff as `DEFAULTS` above, same threshold for revisiting it.
- Keep the "why" comments (DOM-heuristics rationale, polling-vs-observer rationale, teamCode placeholder) — they explain non-obvious constraints from Meet's UI and the privacy model, not what the code does.
- Setup asks for as little as possible on purpose (salary, hours/week, display mode) — `weeksPerYear` and `teamCode` were both deliberately removed from the form (see git history) because they either can't be guessed by a user or do nothing yet. Don't add a field back without a UI reason the user will immediately understand.

## Manual test checklist (no automated tests exist)

- Fresh install → popup shows setup form → save → popup shows "ready" view with correct hourly rate.
- Open `meet.google.com` (no call) → "Precious Time is ready" card appears, top-right.
- Join a real Meet call → timer starts, participant count updates, cost/milestone display matches the selected display mode.
- Leave the call (both via the Leave button and via being removed/host-ended) → summary modal appears once, meeting is saved to `chrome.storage.local` (`meetings` array), overlay is cleaned up.
- Dismiss the overlay (×) → it does not reappear for the rest of that Meet tab's session.
- Click **Connect Google account** (once the OAuth client ID is filled in) → Chrome's account picker appears → after granting, the popup shows the connected email and the button flips to **Disconnect**. Click **Disconnect** → button flips back and the stored `googleAccount` is gone (check via the extension's storage in DevTools).
