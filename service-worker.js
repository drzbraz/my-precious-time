const DEFAULTS = {
  currency: "EUR",
  annualSalary: 60000,
  hoursPerWeek: 40,
  weeksPerYear: 46,
  teamCode: "",
  setupComplete: false,
  meetings: []
};

const BACKEND_BASE_URL = "https://precious-time-backend.drz-braz.workers.dev";

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set(stored);
});

// The interactive Google sign-in flow opens a browser window that steals focus. If it were
// triggered from the popup, Chrome would auto-close that popup (and abort the flow) the moment
// focus moves away. Running it here, in the background service worker, survives that.
function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError ?? new Error("No auth token returned"));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

async function fetchGoogleProfile(token) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Google userinfo request failed: ${response.status}`);
  return response.json(); // { sub, email, name, picture, ... }
}

async function connectGoogleAccount() {
  const token = await getAuthToken(true);
  const profile = await fetchGoogleProfile(token);
  const googleAccount = { sub: profile.sub, email: profile.email, name: profile.name };
  await chrome.storage.local.set({ googleAccount });
  return googleAccount;
}

async function disconnectGoogleAccount() {
  try {
    const token = await getAuthToken(false);
    await removeCachedAuthToken(token);
    // Best-effort: also revoke Google's server-side grant, not just Chrome's local token cache.
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
  } catch {
    // No cached token to revoke — nothing to clean up on Google's side.
  }
  await chrome.storage.local.remove("googleAccount");
}

// content.js can't safely make this fetch itself: it runs inside meet.google.com's page, subject
// to that page's CSP, and there's no reliable way to test from here whether Meet's CSP would
// block a cross-origin content-script fetch even with host_permissions granted. A service worker
// has no such ambiguity — it's never subject to any page's CSP — so all backend calls live here.
// interactive: false, always — this runs on a timer during a live meeting and must never pop
// the account picker; "not connected" is a normal outcome, not an error.
async function syncMeetingCost(meetingId, ratePerMinute) {
  let token;
  try {
    token = await getAuthToken(false);
  } catch {
    // Distinguishable from a network/backend failure below — content.js treats "genuinely not
    // connected" (drop to the local estimate immediately) differently from "one failed request"
    // (keep showing the last known good total rather than flicker).
    throw new Error("not_connected");
  }

  await fetch(`${BACKEND_BASE_URL}/v1/meetings/${meetingId}/presence`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ratePerMinute }),
  });

  const response = await fetch(`${BACKEND_BASE_URL}/v1/meetings/${meetingId}/aggregate`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`aggregate request failed: ${response.status}`);
  return response.json(); // { participantCount, ratePerMinuteSum: number | null, asOf }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "saveMeeting") {
    chrome.storage.local.get({ meetings: [] }).then(({ meetings }) => {
      const next = [message.meeting, ...meetings].slice(0, 100);
      return chrome.storage.local.set({ meetings: next });
    }).then(() => respond({ ok: true }));
    return true;
  }
  if (message.type === "connectGoogle") {
    connectGoogleAccount()
      .then((googleAccount) => respond({ ok: true, googleAccount }))
      .catch((error) => respond({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "disconnectGoogle") {
    disconnectGoogleAccount()
      .then(() => respond({ ok: true }))
      .catch((error) => respond({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "syncMeetingCost") {
    syncMeetingCost(message.meetingId, message.ratePerMinute)
      .then((aggregate) => respond({ ok: true, aggregate }))
      .catch((error) => respond({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});
