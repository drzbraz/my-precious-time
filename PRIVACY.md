# Privacy Policy — My Precious Time

**Last updated:** September 17, 2026

My Precious Time is a Chrome extension that shows a real-time estimated cost for Google Meet calls. This policy explains what data the extension handles and how.

## What we collect and store

**Your hourly rate.** The rate you enter in the extension's popup is stored only in your browser (`chrome.storage.local`) and is never transmitted anywhere on its own. Only a derived number — cost per minute — is ever sent off your device, and only under the conditions below.

**Meeting history.** A local log of your recent meetings (date, duration, and calculated cost) is kept in `chrome.storage.local` on your device, for your own reference. It is not transmitted anywhere.

**Google account information (optional).** If you choose to connect your Google account, the extension requests your email address and name via Google Sign-In (`chrome.identity`) and stores them locally so the popup can show which account is connected. We do not access your Gmail, contacts, files, or any other Google data — only basic profile info (email, name).

**Meeting cost data sent to our backend (optional, only if connected).** If you've connected your Google account, while you're in an active Meet call the extension periodically sends your derived rate-per-minute, together with a meeting identifier and your Google account identifier, to our backend (hosted on Cloudflare Workers). This is used solely to calculate a combined group cost when 3 or more participants in the same call are also connected — see "Group cost calculation" below. This data is automatically deleted from our backend after 24 hours.

## Group cost calculation and your privacy

To protect individual privacy, our backend will only return a combined group total once **at least 3 participants** in the same call are connected. Below that threshold, no combined figure is calculated or returned — this prevents anyone from working backward from a 1-or-2-person total to learn another person's individual rate. Your individual rate is never shared with, or visible to, other participants, at any group size.

## What we don't do

- We don't sell or share your data with third parties.
- We don't use your data for advertising or tracking.
- We don't run analytics or telemetry beyond what's described above.
- We don't access any Google data beyond your basic profile (email, name) needed to identify your connected account.

## Disconnecting your account

You can disconnect your Google account at any time from the extension popup. This removes the locally stored account info and revokes the extension's access on Google's side as well.

## Data retention

- Local data (rate, meeting history, overlay position) stays on your device until you remove the extension or clear its storage.
- Backend presence data (used only for live group aggregation) is automatically deleted after 24 hours.

## Contact

Questions about this policy can be sent to: **drz.braz@gmail.com**
