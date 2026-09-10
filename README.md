# My Precious Time

A Manifest V3 Chrome extension for a privacy-first Google Meet cost meter.

## Run it

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this folder.
3. Open the extension, set your private rate, then join a Google Meet.

When you open `meet.google.com`, a **"My Precious Time is ready"** card appears in the top-right (drag it anywhere — it remembers where you put it); this confirms the extension is installed and configured. When Meet detects that you are in a call, it becomes the live cost meter. When the call ends, an in-page meeting summary appears and is saved locally. Chrome deliberately prevents extensions from opening their toolbar popup automatically, so the experience is delivered in the Meet tab instead. Dismissed the overlay by accident? The popup has a **Show meter on this call** button.

## Discretion

The overlay always shows a live, continuously-updating total — no delayed reveals. If someone might see your screen, click the eye icon next to the dismiss (×) button to mask the cost figure (`•••••`) without losing the running timer; click it again to reveal it. This resets when you leave the tab, same as dismissing the overlay.

## Privacy

Your salary and work schedule are stored only in `chrome.storage.local` and never leave your device. By default, the meter is single-player: it multiplies your own local rate by the headcount Google Meet shows on screen — an estimate, not a verified total.

Optionally connecting a Google account (in the popup) lets it show a **real** group total, but only once **3 or more** teammates in the same call have also connected — below that, nothing changes, and no individual rate is ever shown or recoverable, even by the people in the call. See [`CLAUDE.md`](./CLAUDE.md) for the full mechanism and why the 3-person floor exists.

## Known Google Meet limitations

Google Meet has no stable public participant-count extension API. The content script first reads accessible participant labels, then uses Meet tile attributes as a fallback. Google can change its UI at any time, so the count is presented as an estimate and requires regression testing against current Meet builds. Call-state detection currently only covers English and Portuguese Meet interfaces.
