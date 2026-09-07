# Precious Time — MVP

A Manifest V3 Chrome extension for a privacy-first Google Meet cost meter.

## Run it

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this folder.
3. Open the extension, set your private rate, then join a Google Meet.

When you open `meet.google.com`, a **“Precious Time is ready”** card appears in the top-right; this confirms the extension is installed and configured. When Meet detects that you are in a call, it becomes the live cost meter. When the call ends, an in-page meeting summary appears and is saved locally. Chrome deliberately prevents extensions from opening their toolbar popup automatically, so the experience is delivered in the Meet tab instead.

## Display modes

**Gentle check-ins** is the default: the estimated total is revealed at 10-minute milestones rather than constantly rising. Users can switch to **Live total** or **End-only** in the extension settings.

## Privacy boundary (v0.1)

Salary and work schedule are stored only in `chrome.storage.local`. No server calls are made. The overlay multiplies the participant estimate by the user's own local rate, so it is explicitly an **estimated meeting cost**.

To produce a genuine team-wide cost without retaining salary data, a future service needs authenticated group membership plus a per-meeting secure aggregation protocol (e.g. masked, signed per-minute contributions that only reveal a sum). A shared group code alone is not sufficient authentication or secure aggregation.

## Known Google Meet limitations

Google Meet has no stable public participant-count extension API. The content script first reads accessible participant labels, then uses Meet tile attributes as a fallback. Google can change its UI at any time, so the count is presented as an estimate and requires regression testing against current Meet builds.
