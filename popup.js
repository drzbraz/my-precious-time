const $ = (id) => document.getElementById(id);
const DEFAULTS = { currency: "EUR", annualSalary: 60000, hoursPerWeek: 40, weeksPerYear: 46, teamCode: "", setupComplete: false };
const symbol = (currency) => ({ EUR: "€", USD: "$", GBP: "£" }[currency] || "€");
const hourly = ({ annualSalary, hoursPerWeek, weeksPerYear }) => Number(annualSalary || 0) / (Number(hoursPerWeek || 1) * Number(weeksPerYear || 1));
const format = (value, currency) => new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value);

async function init() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  for (const key of ["currency", "annualSalary", "hoursPerWeek", "weeksPerYear", "teamCode"]) $(key).value = settings[key];
  renderRate();
  show(settings.setupComplete);
}
function values() { return { currency: $("currency").value, annualSalary: +$("annualSalary").value, hoursPerWeek: +$("hoursPerWeek").value, weeksPerYear: +$("weeksPerYear").value, teamCode: $("teamCode").value.trim().toUpperCase() }; }
function renderRate() { const v = values(); $("hourly-rate").textContent = format(hourly(v), v.currency); }
function show(ready) { $("setup-view").hidden = ready; $("ready-view").hidden = !ready; if (ready) { const v = values(); $("ready-rate").textContent = `${format(hourly(v), v.currency)} / hr`; } }
["annualSalary", "hoursPerWeek", "weeksPerYear", "currency"].forEach(id => $(id).addEventListener("input", renderRate));
$("settings-form").addEventListener("submit", async (event) => { event.preventDefault(); await chrome.storage.local.set({ ...values(), setupComplete: true }); show(true); });
$("edit-settings").addEventListener("click", () => show(false));
init();
