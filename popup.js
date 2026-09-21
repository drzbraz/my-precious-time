const $ = (id) => document.getElementById(id);

// Not user-editable: nobody knows their exact working weeks off the top of their head.
// 46 assumes ~6 weeks of vacation/holidays — a reasonable default, not asked for during setup.
const ASSUMED_WEEKS_PER_YEAR = 46;

const DEFAULTS = {
  currency: "EUR",
  annualSalary: 60000,
  hoursPerWeek: 40,
  weeksPerYear: ASSUMED_WEEKS_PER_YEAR,
  teamCode: "",
  showLiveMeter: true,
  setupComplete: false,
};

const SETTINGS_FIELDS = ["currency", "annualSalary", "hoursPerWeek"];
const RATE_INPUT_FIELDS = ["annualSalary", "hoursPerWeek", "currency"];

function hourlyRate({ annualSalary, hoursPerWeek, weeksPerYear }) {
  return Number(annualSalary || 0) / (Number(hoursPerWeek || 1) * Number(weeksPerYear || 1));
}

function formatMoney(value, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function readFormValues() {
  return {
    currency: $("currency").value,
    annualSalary: +$("annualSalary").value,
    hoursPerWeek: +$("hoursPerWeek").value,
    weeksPerYear: ASSUMED_WEEKS_PER_YEAR,
    showLiveMeter: $("showLiveMeter").checked,
  };
}

function renderRate() {
  const values = readFormValues();
  $("hourly-rate").textContent = formatMoney(hourlyRate(values), values.currency);
}

function showView(setupComplete) {
  $("setup-view").hidden = setupComplete;
  $("ready-view").hidden = !setupComplete;
  if (!setupComplete) return;

  const values = readFormValues();
  $("ready-rate").textContent = `${formatMoney(hourlyRate(values), values.currency)} / hr`;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  });
}

function errorMessage(error) {
  return error?.message || (typeof error === "string" ? error : JSON.stringify(error));
}

function showAccountError(message) {
  const el = $("account-error");
  el.textContent = message;
  el.hidden = !message;
}

async function connectGoogleAccount() {
  $("account-action").disabled = true;
  $("account-action").textContent = "Connecting…";
  showAccountError("");
  try {
    // This may open a Google account-picker window, which steals focus and can close this
    // popup before the flow finishes — that's fine, the service worker completes it regardless
    // and chrome.storage reflects the result next time the popup opens (or via onChanged below).
    const response = await sendMessage({ type: "connectGoogle" });
    if (!response?.ok) throw new Error(response?.error || "Unknown error");
  } catch (error) {
    console.error("Google sign-in failed:", errorMessage(error));
    showAccountError(`Couldn't connect: ${errorMessage(error)}`);
  } finally {
    $("account-action").disabled = false;
    renderAccountStatus();
  }
}

async function disconnectGoogleAccount() {
  $("account-action").disabled = true;
  showAccountError("");
  try {
    const response = await sendMessage({ type: "disconnectGoogle" });
    if (!response?.ok) throw new Error(response?.error || "Unknown error");
  } catch (error) {
    console.error("Google disconnect failed:", errorMessage(error));
    showAccountError(`Couldn't disconnect: ${errorMessage(error)}`);
  } finally {
    $("account-action").disabled = false;
    renderAccountStatus();
  }
}

async function renderAccountStatus() {
  const { googleAccount } = await chrome.storage.local.get("googleAccount");
  const connected = Boolean(googleAccount);
  $("account-status").textContent = connected ? googleAccount.email : "Not connected";
  $("account-action").textContent = connected ? "Disconnect Google account" : "Connect Google account";
  $("account-action").onclick = connected ? disconnectGoogleAccount : connectGoogleAccount;
  $("account-dot").classList.toggle("dot--on", connected);
}

// Only shown when the active tab is actually a Meet call — a button that silently does nothing
// on any other tab is worse than no button.
async function initShowOverlayButton() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://meet.google.com/")) return;

  const button = $("show-overlay");
  button.hidden = false;
  button.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, { type: "showOverlay" });
    window.close(); // Get out of the way so they can see it reappear.
  });
}

async function loadSavedFormValues() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  for (const field of SETTINGS_FIELDS) $(field).value = settings[field];
  $("showLiveMeter").checked = settings.showLiveMeter;
  renderRate();
  return settings;
}

async function init() {
  const settings = await loadSavedFormValues();
  showView(settings.setupComplete);
  renderAccountStatus();
  initShowOverlayButton();
}

RATE_INPUT_FIELDS.forEach((field) => $(field).addEventListener("input", renderRate));

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({ ...readFormValues(), setupComplete: true });
  showView(true);
});

// Only meaningful once there's a saved state to return to — first-time setup has no ready view
// yet, so the button stays hidden until "Edit settings" reveals it.
$("edit-settings").addEventListener("click", () => {
  $("cancel-edit").hidden = false;
  showView(false);
});

$("cancel-edit").addEventListener("click", async () => {
  // Discard any unsaved edits in the form before returning, so the ready view reflects what's
  // actually stored, not whatever the user was mid-typing.
  await loadSavedFormValues();
  showView(true);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "googleAccount" in changes) renderAccountStatus();
});

init();
