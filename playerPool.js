// The player pool used by the live draft (draft-replica's available-players
// list, and the auto-pick-on-timeout logic in draftSession.js) -- both need
// to agree on the same ordering, so an auto-pick always lands on whoever a
// human would actually see at the top of their list.
//
// FFC's ADP list (~195-220 skill players, no defenses) is too shallow on its
// own for a full 10-team/16-round draft (160 picks) plus bench depth, so
// this uses FFC's order for the players it covers, then appends everyone
// else Sleeper considers active and fantasy-relevant (deep bench, rookies
// FFC hasn't ranked yet, defenses, kickers) ordered by Sleeper's own
// search_rank -- full draft depth is preserved, FFC's consensus just wins
// for the players both sources agree exist.

const { getRawExternalData, normalizeName, buildNameToSleeperId } = require("./externalData");

const ALLOWED_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

function normalizePosition(pos) {
  return pos === "FB" ? "RB" : pos;
}

async function buildRankedPlayerPool() {
  const { adpData, sleeperPlayers } = await getRawExternalData();
  const nameToSleeperId = buildNameToSleeperId(sleeperPlayers, ALLOWED_POSITIONS);

  const sortedAdp = adpData.players.slice().sort((a, b) => a.adp - b.adp);

  const ffcOrdered = [];
  const usedIds = new Set();
  sortedAdp.forEach((p) => {
    const sleeperId = nameToSleeperId.get(normalizeName(p.name));
    if (!sleeperId || usedIds.has(sleeperId)) return; // no confident match -- falls into the tail below instead
    const sp = sleeperPlayers[sleeperId];
    ffcOrdered.push({
      id: sleeperId,
      name: sp.full_name || p.name,
      position: normalizePosition(sp.position),
      team: sp.team || p.team || ""
    });
    usedIds.add(sleeperId);
  });

  const fallbackTail = Object.values(sleeperPlayers)
    .filter((p) => p.active && p.team && ALLOWED_POSITIONS.includes(p.position) && !usedIds.has(p.player_id))
    .map((p) => ({
      id: p.player_id,
      name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
      position: normalizePosition(p.position),
      team: p.team || "",
      searchRank: typeof p.search_rank === "number" ? p.search_rank : 999999
    }))
    .sort((a, b) => a.searchRank - b.searchRank)
    .map(({ searchRank, ...rest }) => rest);

  return [...ffcOrdered, ...fallbackTail];
}

// Separate cache from externalData's raw-fetch cache -- this covers the
// join/ordering work on top of it, so repeat calls (every draft-session
// poll, every draft-replica page load) don't redo the merge every time.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let cachedPool = null;
let cachedAt = 0;

async function getRankedPlayerPool() {
  const isStale = !cachedPool || Date.now() - cachedAt >= CACHE_MAX_AGE_MS;
  if (!isStale) return cachedPool;

  try {
    const pool = await buildRankedPlayerPool();
    cachedPool = pool;
    cachedAt = Date.now();
    return pool;
  } catch (err) {
    console.error("Failed to refresh ranked player pool:", err);
    if (cachedPool) return cachedPool; // serve stale rather than a hard failure
    throw err;
  }
}

module.exports = { getRankedPlayerPool };
