const DEFAULTS = {
  currency: "EUR",
  annualSalary: 60000,
  hoursPerWeek: 40,
  weeksPerYear: 46,
  teamCode: "",
  setupComplete: false,
  meetings: []
};

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
});
