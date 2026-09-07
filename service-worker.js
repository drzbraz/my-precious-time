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

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "saveMeeting") {
    chrome.storage.local.get({ meetings: [] }).then(({ meetings }) => {
      const next = [message.meeting, ...meetings].slice(0, 100);
      return chrome.storage.local.set({ meetings: next });
    }).then(() => respond({ ok: true }));
    return true;
  }
});
