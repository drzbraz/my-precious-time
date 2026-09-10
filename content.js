(() => {
  const DEFAULTS = {
    currency: "EUR",
    annualSalary: 60000,
    hoursPerWeek: 40,
    weeksPerYear: 46,
    setupComplete: false,
    overlayPosition: null, // {top, left} in px once the user has dragged it; null = default corner.
  };

  const OVERLAY_MARGIN = 8; // Keep the draggable overlay fully on-screen, however it's dragged.

  // Meet mutates its DOM constantly (video frames, captions, reactions). Watching every
  // mutation made this content script repeatedly scan the page and could freeze the call.
  // A small poll is sufficient for call start/end and keeps the UI responsive.
  const POLL_INTERVAL_MS = 1500;
  const RENDER_INTERVAL_MS = 1000;
  const MIN_SAVE_DURATION_SECONDS = 10; // Ignore accidental/instant joins when saving history.
  const SAVE_DEDUPE_WINDOW_MS = 5000; // Guards against duplicate end-of-meeting saves.

  // Matches the backend's ACTIVE_WINDOW_MS (45s) with margin for one missed beat.
  const HEARTBEAT_INTERVAL_MS = 20_000;

  const LEAVE_OR_END_CALL_PATTERN = /leave call|end call|sair da chamada|abandonar chamada/i;
  const JOIN_PROMPT_PATTERN = /join now|ask to join|join meeting|participar agora|pedir para participar|entrar na reunião/i;
  const PARTICIPANT_COUNT_PATTERN = /(?:People|Participants|Participants in this call)[^0-9]*(\d+)/i;
  // Meet can end a call without a user pressing Leave (host ends it, removal, connection
  // failure). These messages live in alerts, dialogs, and action buttons after the call.
  const MEETING_ENDED_PATTERN = /you left (?:the )?meeting|meeting (?:has )?ended|you (?:have )?been removed|return to home screen|rejoin(?: the meeting)?|connection (?:was )?lost/i;

  let settings;
  let startedAt;
  let timer;
  let groupSyncTimer;
  let lastParticipants = 1;
  let lastSavedAt = 0;
  let meetingFinished = false;
  let dismissed = false;
  // Resets per tab session, same as `dismissed` — a deliberate, momentary "someone's looking at
  // my screen" toggle, not a persisted preference.
  let costHidden = false;
  const COST_MASK = "•••••";
  // { participantCount, ratePerMinuteSum } from the backend, or null. Only ever set when the
  // backend has judged the sum safe to reveal (see MIN_GROUP_SIZE_FOR_SUM server-side) — below
  // that, this stays null and the UI behaves exactly as it does with no backend at all.
  let groupAggregate = null;

  const money = (value) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: settings.currency,
      maximumFractionDigits: 2,
    }).format(value);

  const personalPerMinute = () =>
    settings.annualSalary / (settings.hoursPerWeek * settings.weeksPerYear * 60);

  const duration = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

  function isGroupEstimateAvailable() {
    return groupAggregate != null && groupAggregate.participantCount > 0;
  }

  // The one place "other people's real rates" turns into a number. Never expose this rate
  // itself in the UI — only feed it into an accumulating total (see render()) — averaging 1-2
  // known rates is trivially reversible by anyone who knows their own rate.
  function effectiveRatePerMinute() {
    if (isGroupEstimateAvailable()) {
      const knownAverage = groupAggregate.ratePerMinuteSum / groupAggregate.participantCount;
      return knownAverage * Math.max(lastParticipants, groupAggregate.participantCount);
    }
    return personalPerMinute() * lastParticipants;
  }

  const cost = () => (duration() / 60) * effectiveRatePerMinute();

  const timeText = (totalSeconds) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  };

  function elementLabel(el) {
    return `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-tooltip") || ""} ${el.textContent || ""}`;
  }

  function participantCount() {
    // Meet's accessible labels are more stable than its generated class names. This intentionally
    // returns an estimate; unavailable names are handled by the local-rate fallback.
    const labels = [...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"));
    const match = labels.map((label) => label?.match(PARTICIPANT_COUNT_PATTERN)).find(Boolean);
    if (match) return Math.max(1, Number(match[1]));

    const tileCount = document.querySelectorAll("[data-participant-id], [data-self-name]").length;
    return tileCount || lastParticipants || 1;
  }

  function inMeeting() {
    // These are labels on Meet's own call-control buttons, and have proven less volatile than
    // generated class names. Text is kept as a fallback for locales / Meet UI experiments.
    if (document.querySelector('[aria-label*="Leave call" i], [data-tooltip*="Leave call" i], [aria-label*="End call" i], [data-tooltip*="End call" i]')) {
      return true;
    }
    const controls = [...document.querySelectorAll("button, [role=\"button\"]")];
    if (controls.some((el) => LEAVE_OR_END_CALL_PATTERN.test(elementLabel(el)))) return true;

    // The call controls can be visually hidden until the mouse moves. In that state, an active
    // Meet still has live video but no join prompt. This covers localized Meet interfaces too.
    const showingJoinPrompt = controls.some((el) => JOIN_PROMPT_PATTERN.test(elementLabel(el)));
    return document.querySelectorAll("video").length > 0 && !showingJoinPrompt;
  }

  function meetingHasEnded() {
    const signals = [...document.querySelectorAll('[role="alert"], [role="dialog"], [aria-live], button, [role="button"]')];
    return signals.some((el) => MEETING_ENDED_PATTERN.test(elementLabel(el)));
  }

  // The path segment of a Meet URL (meet.google.com/abc-defg-hij) is the call's own id — every
  // participant's browser resolves to the same value independently, no handshake needed.
  function currentMeetingId() {
    return location.pathname.split("/").filter(Boolean)[0] || null;
  }

  // All auth and network work for this happens in service-worker.js, not here — a content
  // script's fetches are subject to the host page's CSP, and there's no reliable way to confirm
  // from this codebase alone that Meet's CSP wouldn't interfere. The service worker has no such
  // ambiguity. See the comment on syncMeetingCost() in service-worker.js.
  function requestGroupSync(meetingId, ratePerMinute) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "syncMeetingCost", meetingId, ratePerMinute }, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    });
  }

  async function syncWithBackend() {
    const meetingId = currentMeetingId();
    if (!meetingId) return;

    const response = await requestGroupSync(meetingId, personalPerMinute());
    if (!response?.ok) {
      // Not connected (or the extension messaging itself failed) → behave exactly as if the
      // backend didn't exist. A one-off backend/network failure → keep the last known aggregate
      // rather than flicker the display back to the local estimate for a single missed beat.
      if (!response || response.error === "not_connected") groupAggregate = null;
      return;
    }

    const data = response.aggregate;
    groupAggregate = typeof data?.ratePerMinuteSum === "number"
      ? { participantCount: data.participantCount, ratePerMinuteSum: data.ratePerMinuteSum }
      : null;
  }

  function coverageText() {
    const total = Math.max(lastParticipants, groupAggregate.participantCount);
    return groupAggregate.participantCount >= total
      ? `${total} connected`
      : `${groupAggregate.participantCount} of ${total} connected`;
  }

  // "≈" only when we're extrapolating beyond who we actually know about. If every visible
  // participant is connected, the total is exact, not an estimate.
  function costPrefix() {
    return isGroupEstimateAvailable() && groupAggregate.participantCount < lastParticipants ? "≈ " : "";
  }

  function render() {
    const root = document.getElementById("meeting-meter");
    if (!root) return;

    lastParticipants = participantCount();
    const groupActive = isGroupEstimateAvailable();

    root.querySelector(".mm-time-value").textContent = timeText(duration());
    root.querySelector(".mm-people").textContent = groupActive
      ? coverageText()
      : `${lastParticipants} ${lastParticipants === 1 ? "participant" : "participants"}`;
    root.querySelector(".mm-status").innerHTML = '<i class="mm-live"></i>Precious minutes';
    root.querySelector(".mm-cost").textContent = costHidden ? COST_MASK : `${costPrefix()}${money(cost())}`;
    // Deliberately never a €/min figure here when group data is involved — that number IS
    // the average rate of real people, and would visibly jump whenever someone joins.
    root.querySelector(".mm-rate").textContent = groupActive ? "Verified total" : `${money(personalPerMinute() * lastParticipants)} / min`;
  }

  // Open eye = visible, click to hide. Slashed eye = hidden, click to reveal — the same
  // convention as a password field's show/hide toggle.
  function eyeIconSVG(hidden) {
    const slash = hidden ? '<line x1="3" y1="3" x2="21" y2="21"></line>' : "";
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle>${slash}</svg>`;
  }

  function updateEyeButton(button) {
    button.innerHTML = eyeIconSVG(costHidden);
    const label = costHidden ? "Show cost" : "Hide cost";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // Applied after the element is in the DOM, since clamping needs its real rendered size.
  function applySavedPosition(root) {
    const saved = settings.overlayPosition;
    if (!saved) return;
    root.style.left = `${clamp(saved.left, OVERLAY_MARGIN, window.innerWidth - root.offsetWidth - OVERLAY_MARGIN)}px`;
    root.style.top = `${clamp(saved.top, OVERLAY_MARGIN, window.innerHeight - root.offsetHeight - OVERLAY_MARGIN)}px`;
    root.style.right = "auto";
  }

  // The header is the drag handle. Pointer events (not mouse events) so this also works with
  // touch, and setPointerCapture keeps receiving move events even if the cursor leaves the header.
  function makeDraggable(root, handle) {
    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return; // Let the × dismiss button work normally.
      const rect = root.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);
      root.classList.add("mm-dragging");
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      root.style.left = `${clamp(event.clientX - drag.offsetX, OVERLAY_MARGIN, window.innerWidth - root.offsetWidth - OVERLAY_MARGIN)}px`;
      root.style.top = `${clamp(event.clientY - drag.offsetY, OVERLAY_MARGIN, window.innerHeight - root.offsetHeight - OVERLAY_MARGIN)}px`;
      root.style.right = "auto";
    });

    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      handle.releasePointerCapture(event.pointerId);
      root.classList.remove("mm-dragging");
      drag = null;
      const position = { top: parseFloat(root.style.top), left: parseFloat(root.style.left) };
      settings.overlayPosition = position;
      chrome.storage.local.set({ overlayPosition: position });
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  function mount() {
    if (dismissed || document.getElementById("meeting-meter")) return;

    const root = document.createElement("aside");
    root.id = "meeting-meter";
    root.innerHTML = `
      <div class="mm-head">
        <span class="mm-status"><i class="mm-live"></i>My Precious Time is ready</span>
        <span class="mm-actions">
          <button class="mm-eye"></button>
          <button class="mm-dismiss" title="Hide for this meeting" aria-label="Hide for this meeting">×</button>
        </span>
      </div>
      <div class="mm-time">Join a call to start the meter</div>
      <div class="mm-cost">${money(0)}</div>
      <div class="mm-bottom">
        <span class="mm-people">Private &amp; local</span>
        <span class="mm-rate">${money(personalPerMinute())} / min</span>
      </div>
    `;
    const eyeButton = root.querySelector(".mm-eye");
    updateEyeButton(eyeButton);
    eyeButton.addEventListener("click", () => {
      costHidden = !costHidden;
      updateEyeButton(eyeButton);
      render();
    });
    root.querySelector(".mm-dismiss").addEventListener("click", () => {
      dismissed = true;
      root.remove();
    });
    document.body.append(root);
    applySavedPosition(root);
    makeDraggable(root, root.querySelector(".mm-head"));
  }

  function startMeeting() {
    if (startedAt) return;
    startedAt = Date.now();
    const root = document.getElementById("meeting-meter");
    if (root) {
      root.querySelector(".mm-time").innerHTML = 'Time in meeting <span class="mm-time-value">00:00:00</span>';
    }
    syncWithBackend();
    groupSyncTimer = setInterval(syncWithBackend, HEARTBEAT_INTERVAL_MS);
  }

  function showSummary(meeting) {
    document.getElementById("meeting-meter-summary")?.remove();

    // Same rule as the live view: never surface a €/minute figure derived from other people's
    // real rates. Show how many were verified instead of the number that would reveal them.
    const thirdStat = meeting.knownParticipants
      ? `<span><b>${meeting.knownParticipants}</b>Verified</span>`
      : `<span><b>${money(meeting.totalCost / (meeting.durationSeconds / 60 || 1))}</b>/ minute</span>`;
    const footerText = meeting.knownParticipants
      ? "Your rate contributes to the total — never shared individually."
      : "Calculated locally. Your salary was never shared.";

    const modal = document.createElement("section");
    modal.id = "meeting-meter-summary";
    modal.innerHTML = `
      <div class="mms-card">
        <button class="mms-close" aria-label="Close summary">×</button>
        <div class="mms-eyebrow">THE MEETING HAS ENDED</div>
        <h2>Those were precious minutes.</h2>
        <strong class="mms-total">${meeting.isEstimate ? "≈ " : ""}${money(meeting.totalCost)}</strong>
        <div class="mms-stats">
          <span><b>${timeText(meeting.durationSeconds)}</b>Duration</span>
          <span><b>${meeting.participantEstimate}</b>Participants</span>
          ${thirdStat}
        </div>
        <p>${footerText}</p>
      </div>
    `;
    modal.querySelector(".mms-close").addEventListener("click", () => modal.remove());
    document.body.append(modal);
  }

  function saveMeetingIfNeeded() {
    const isLongEnough = duration() > MIN_SAVE_DURATION_SECONDS;
    const isNotDuplicate = Date.now() - lastSavedAt > SAVE_DEDUPE_WINDOW_MS;
    if (!isLongEnough || !isNotDuplicate) return;

    lastSavedAt = Date.now();
    const groupActive = isGroupEstimateAvailable();
    const meeting = {
      id: crypto.randomUUID(),
      endedAt: new Date().toISOString(),
      durationSeconds: duration(),
      participantEstimate: lastParticipants,
      totalCost: cost(),
      currency: settings.currency,
      isEstimate: !groupActive || groupAggregate.participantCount < lastParticipants,
      knownParticipants: groupActive ? groupAggregate.participantCount : null,
    };
    chrome.runtime.sendMessage({ type: "saveMeeting", meeting });
    showSummary(meeting);
  }

  function unmount(save = true) {
    if (save) saveMeetingIfNeeded();
    document.getElementById("meeting-meter")?.remove();
    clearInterval(timer);
    timer = null;
    clearInterval(groupSyncTimer);
    groupSyncTimer = null;
    groupAggregate = null;
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
      if (!timer) timer = setInterval(render, RENDER_INTERVAL_MS);
      render();
    } else if (timer) {
      unmount();
      startedAt = undefined;
    }
  }

  // Dismissing (the × button) only hides the overlay for this tab's session — it doesn't stop
  // the background timers, so the moment it's shown again it's already showing live data.
  // The popup's "Show meter on this call" button reaches in via this message.
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "showOverlay") {
      dismissed = false;
      mount();
      respond({ ok: true });
    }
  });

  chrome.storage.local.get(DEFAULTS).then((storedSettings) => {
    settings = storedSettings;
    check();
    setInterval(check, POLL_INTERVAL_MS);
  });
})();
