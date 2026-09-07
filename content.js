(() => {
  const DEFAULTS = { currency: "EUR", annualSalary: 60000, hoursPerWeek: 40, weeksPerYear: 46, displayMode: "milestones", setupComplete: false };
  let settings, startedAt, timer, lastParticipants = 1, lastSavedAt = 0, meetingFinished = false, dismissed = false;
  const money = (value) => new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency, maximumFractionDigits: 2 }).format(value);
  const personalPerMinute = () => settings.annualSalary / (settings.hoursPerWeek * settings.weeksPerYear * 60);
  const duration = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const cost = () => duration() / 60 * personalPerMinute() * lastParticipants;
  const timeText = (s) => `${String(Math.floor(s / 3600)).padStart(2,"0")}:${String(Math.floor(s % 3600 / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;

  function participantCount() {
    // Meet's accessible labels are more stable than its generated class names. This intentionally
    // returns an estimate; unavailable names are handled by the local-rate fallback.
    const labelled = [...document.querySelectorAll('[aria-label]')].map(el => el.getAttribute('aria-label'));
    const match = labelled.map(label => label?.match(/(?:People|Participants|Participants in this call)[^0-9]*(\d+)/i)).find(Boolean);
    if (match) return Math.max(1, Number(match[1]));
    const tiles = document.querySelectorAll('[data-participant-id], [data-self-name]').length;
    return tiles || lastParticipants || 1;
  }
  function inMeeting() {
    // These are labels on Meet's own call-control buttons, and have proven less volatile than
    // generated class names. Text is kept as a fallback for locales / Meet UI experiments.
    if (document.querySelector('[aria-label*="Leave call" i], [data-tooltip*="Leave call" i], [aria-label*="End call" i], [data-tooltip*="End call" i]')) return true;
    const controls = [...document.querySelectorAll('button, [role="button"]')];
    if (controls.some(el => /leave call|end call|sair da chamada|abandonar chamada/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''}`))) return true;

    // The call controls can be visually hidden until the mouse moves. In that state, an active
    // Meet still has live video but no join prompt. This covers localized Meet interfaces too.
    const joinPrompt = controls.some(el => /join now|ask to join|join meeting|participar agora|pedir para participar|entrar na reunião/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.textContent || ''}`));
    return document.querySelectorAll('video').length > 0 && !joinPrompt;
  }
  function meetingHasEnded() {
    // Meet can end a call without a user pressing Leave (host ends it, removal, connection
    // failure). These messages live in alerts, dialogs, and action buttons after the call.
    const endPattern = /you left (?:the )?meeting|meeting (?:has )?ended|you (?:have )?been removed|return to home screen|rejoin(?: the meeting)?|connection (?:was )?lost/i;
    const signals = [...document.querySelectorAll('[role="alert"], [role="dialog"], [aria-live], button, [role="button"]')];
    return signals.some(el => endPattern.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.textContent || ''}`));
  }
  function render() {
    const root = document.getElementById("meeting-meter");
    if (!root) return;
    lastParticipants = participantCount();
    const seconds = duration();
    const mode = settings.displayMode;
    root.querySelector('.mm-time-value').textContent = timeText(seconds);
    root.querySelector('.mm-people').textContent = `${lastParticipants} ${lastParticipants === 1 ? "participant" : "participants"}`;
    if (mode === 'live') {
      root.querySelector('.mm-status').innerHTML = '<i class="mm-live"></i>Precious minutes';
      root.querySelector('.mm-cost').textContent = money(cost());
      root.querySelector('.mm-rate').textContent = `${money(personalPerMinute() * lastParticipants)} / min`;
    } else if (mode === 'milestones') {
      const milestone = Math.floor(seconds / 600) * 600;
      root.querySelector('.mm-cost').textContent = milestone ? money(milestone / 60 * personalPerMinute() * lastParticipants) : '—';
      root.querySelector('.mm-status').innerHTML = `<i class="mm-live"></i>${milestone ? `${milestone / 60}-minute check-in` : 'First check-in at 10 min'}`;
      root.querySelector('.mm-rate').textContent = milestone ? 'Updates every 10 min' : 'No running total';
    } else {
      root.querySelector('.mm-status').innerHTML = '<i class="mm-live"></i>Quietly tracking';
      root.querySelector('.mm-cost').textContent = '—';
      root.querySelector('.mm-rate').textContent = 'Total at the end';
    }
  }
  function mount() {
    if (dismissed || document.getElementById("meeting-meter")) return;
    const root = document.createElement('aside'); root.id = 'meeting-meter';
    root.innerHTML = `<div class="mm-head"><span class="mm-status"><i class="mm-live"></i>Precious Time is ready</span><button title="Hide for this meeting" aria-label="Hide for this meeting">×</button></div><div class="mm-time">Join a call to start the meter</div><div class="mm-cost">${money(0)}</div><div class="mm-bottom"><span class="mm-people">Private & local</span><span class="mm-rate">${money(personalPerMinute())} / min</span></div>`;
    root.querySelector('button').addEventListener('click', () => { dismissed = true; root.remove(); });
    document.body.append(root);
  }
  function startMeeting() {
    if (startedAt) return;
    startedAt = Date.now();
    const root = document.getElementById('meeting-meter');
    if (root) {
      root.querySelector('.mm-time').innerHTML = 'Time in meeting <span class="mm-time-value">00:00:00</span>';
    }
  }
  function showSummary(meeting) {
    const existing = document.getElementById('meeting-meter-summary');
    if (existing) existing.remove();
    const modal = document.createElement('section');
    modal.id = 'meeting-meter-summary';
    modal.innerHTML = `<div class="mms-card"><button class="mms-close" aria-label="Close summary">×</button><div class="mms-eyebrow">THE MEETING HAS ENDED</div><h2>Those were precious minutes.</h2><strong class="mms-total">${money(meeting.totalCost)}</strong><div class="mms-stats"><span><b>${timeText(meeting.durationSeconds)}</b>Duration</span><span><b>${meeting.participantEstimate}</b>Participants</span><span><b>${money(meeting.totalCost / (meeting.durationSeconds / 60 || 1))}</b>/ minute</span></div><p>Calculated locally. Your salary was never shared.</p></div>`;
    modal.querySelector('.mms-close').addEventListener('click', () => modal.remove());
    document.body.append(modal);
  }
  function unmount(save = true) {
    const root = document.getElementById('meeting-meter');
    if (save && duration() > 10 && Date.now() - lastSavedAt > 5000) {
      lastSavedAt = Date.now();
      const meeting = { id: crypto.randomUUID(), endedAt: new Date().toISOString(), durationSeconds: duration(), participantEstimate: lastParticipants, totalCost: cost(), currency: settings.currency };
      chrome.runtime.sendMessage({ type: 'saveMeeting', meeting });
      showSummary(meeting);
    }
    root?.remove(); clearInterval(timer); timer = null;
  }
  async function check() {
    if (!settings?.setupComplete) return;
    if (timer && meetingHasEnded()) {
      unmount();
      meetingFinished = true;
      return;
    }
    if (meetingFinished) return;
    mount(); // This confirms that the extension is loaded whenever meet.google.com is open.
    if (inMeeting()) {
      startMeeting();
      if (!timer) timer = setInterval(render, 1000);
      render();
    } else if (timer) {
      unmount();
      startedAt = undefined;
    }
  }
  chrome.storage.local.get(DEFAULTS).then(s => {
    settings = s;
    check();
    // Meet mutates its DOM constantly (video frames, captions, reactions). Watching every
    // mutation made this content script repeatedly scan the page and could freeze the call.
    // A small poll is sufficient for call start/end and keeps the UI responsive.
    setInterval(check, 1500);
  });
})();
