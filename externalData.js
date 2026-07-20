// Shared raw-data layer for the two features that both need FFC's ADP list
// + Sleeper's player pool (draftGuide.js's analytics table, and
// playerPool.js's draft-replica ordering) -- one cache means both features
// share a single daily fetch instead of hitting FFC/Sleeper independently.

const ADP_API_URL = "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=10&year=2026&position=all";
const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";

// FFC says their ADP updates at most once/day; Sleeper asks apps not to hit
// the full player list more than once/day either -- one shared cache
// respects both.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let cached = null;
let cachedAt = 0;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`);
  return res.json();
}

async function getRawExternalData() {
  const isStale = !cached || Date.now() - cachedAt >= CACHE_MAX_AGE_MS;
  if (!isStale) return cached;

  try {
    const [adpData, sleeperPlayers] = await Promise.all([
      fetchJson(ADP_API_URL),
      fetchJson(SLEEPER_PLAYERS_URL)
    ]);
    cached = { adpData, sleeperPlayers };
    cachedAt = Date.now();
    return cached;
  } catch (err) {
    console.error("Failed to refresh FFC/Sleeper external data:", err);
    if (cached) return cached; // serve stale rather than a hard failure
    throw err;
  }
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Sleeper's pool includes retired/practice-squad/irrelevant-position players
// who can share a name with an active fantasy-relevant one (e.g. there's
// both an inactive Guard and the actual Bills QB named "Josh Allen").
// Restricting to active players in an allowed position with a real team
// avoids silently matching the wrong one. `allowedPositions` is passed in
// since draftGuide excludes DEF (not individually analyzed) while
// playerPool needs it (real drafts need a defense).
function buildNameToSleeperId(sleeperPlayers, allowedPositions) {
  const map = new Map();
  Object.values(sleeperPlayers).forEach((p) => {
    if (!p.active || !p.team || !allowedPositions.includes(p.position)) return;
    const fullName = p.full_name || (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : "");
    const key = normalizeName(fullName);
    if (key && !map.has(key)) map.set(key, p.player_id);
  });
  return map;
}

module.exports = { getRawExternalData, normalizeName, buildNameToSleeperId };
