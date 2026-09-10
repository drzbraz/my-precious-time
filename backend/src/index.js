// A row counts as "active" only if it heartbeated within this window. Heartbeats from
// content.js arrive roughly every 20s (see content.js POLL_INTERVAL_MS), so 45s tolerates
// one missed beat before someone drops out of a meeting's aggregate.
const ACTIVE_WINDOW_MS = 45_000;

// With only 1-2 people known, a viewer who knows their own rate can solve for the other
// person's exact rate from the sum (sum - your rate = theirs). Below this floor we withhold
// the sum entirely — enforced here, not just hidden in the UI, since a client can always
// read its own network requests.
const MIN_GROUP_SIZE_FOR_SUM = 3;

// A sanity ceiling, not a real-world limit — guards the shared sum against a fat-fingered or
// corrupted client value (e.g. a stray extra zero) skewing everyone else's total. €600/min is
// already an absurd rate (~€31M/year); this exists purely as a data-integrity backstop.
const MAX_RATE_PER_MINUTE = 600;

// Rows older than this are deleted by the cron trigger (see scheduled() below) — generous
// margin past ACTIVE_WINDOW_MS, this is table hygiene, not part of the active-participant logic.
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;

const ROUTE_PATTERN = /^\/v1\/meetings\/([^/]+)\/(presence|aggregate)$/;
// Meet call codes look like "abc-defgh-ijk" — loose check, just enough to reject junk before it
// reaches the database.
const MEETING_ID_PATTERN = /^[a-z0-9-]{5,50}$/i;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function extractBearerToken(request) {
  const match = (request.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

// Never trust a client-supplied user id — resolve it from Google on every request instead.
async function verifyGoogleToken(token, expectedClientId) {
  const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error("token_invalid");

  const info = await response.json();
  if (info.aud !== expectedClientId) throw new Error("token_wrong_audience");
  if (Number(info.exp) * 1000 < Date.now()) throw new Error("token_expired");

  return info.sub;
}

async function handlePresence(request, env, meetingId, userId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400);
  }

  const ratePerMinute = Number(body.ratePerMinute);
  if (!Number.isFinite(ratePerMinute) || ratePerMinute < 0 || ratePerMinute > MAX_RATE_PER_MINUTE) {
    return jsonResponse({ error: "invalid_rate" }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO presence (meeting_id, user_id, rate_per_minute, last_seen_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(meeting_id, user_id) DO UPDATE SET rate_per_minute = ?3, last_seen_at = ?4`
  ).bind(meetingId, userId, ratePerMinute, Date.now()).run();

  return jsonResponse({ ok: true });
}

async function handleAggregate(env, meetingId, userId) {
  const activeSince = Date.now() - ACTIVE_WINDOW_MS;

  // Only someone currently heartbeating in this meeting may read its aggregate — otherwise
  // anyone who can guess a Meet URL could snoop on who's in a call and what it's costing.
  const self = await env.DB.prepare(
    `SELECT 1 FROM presence WHERE meeting_id = ?1 AND user_id = ?2 AND last_seen_at >= ?3`
  ).bind(meetingId, userId, activeSince).first();
  if (!self) return jsonResponse({ error: "not_a_participant" }, 403);

  // Sum-only, on purpose: no endpoint here ever returns another participant's individual rate.
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS participant_count, COALESCE(SUM(rate_per_minute), 0) AS rate_per_minute_sum
     FROM presence WHERE meeting_id = ?1 AND last_seen_at >= ?2`
  ).bind(meetingId, activeSince).first();

  const sumAvailable = totals.participant_count >= MIN_GROUP_SIZE_FOR_SUM;

  return jsonResponse({
    participantCount: totals.participant_count,
    ratePerMinuteSum: sumAvailable ? totals.rate_per_minute_sum : null,
    asOf: new Date().toISOString(),
  });
}

export default {
  async scheduled(event, env) {
    await env.DB.prepare(`DELETE FROM presence WHERE last_seen_at < ?1`)
      .bind(Date.now() - CLEANUP_AGE_MS)
      .run();
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(ROUTE_PATTERN);
    if (!match) return jsonResponse({ error: "not_found" }, 404);
    const [, meetingId, resource] = match;
    if (!MEETING_ID_PATTERN.test(meetingId)) return jsonResponse({ error: "invalid_meeting_id" }, 400);

    const token = extractBearerToken(request);
    if (!token) return jsonResponse({ error: "missing_token" }, 401);

    let userId;
    try {
      userId = await verifyGoogleToken(token, env.OAUTH_CLIENT_ID);
    } catch (error) {
      return jsonResponse({ error: error.message }, 401);
    }

    if (resource === "presence" && request.method === "POST") return handlePresence(request, env, meetingId, userId);
    if (resource === "aggregate" && request.method === "GET") return handleAggregate(env, meetingId, userId);
    return jsonResponse({ error: "method_not_allowed" }, 405);
  },
};
