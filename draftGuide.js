// Builds a draft-prep table by joining three free, public data sources:
//   - Fantasy Football Calculator's ADP API (crowdsourced average draft
//     position from real mock drafts) -- see help.fantasyfootballcalculator.com,
//     free for personal/commercial use with attribution.
//   - Sleeper's player pool, last year's draft picks, and last year's raw
//     season stats -- all public, no auth required.
// Tiers and a volatility ("upside/bust" proxy) label are computed from FFC's
// own numbers rather than copying anyone's proprietary ratings.

const ADP_API_URL = "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=10&year=2026&position=all";
const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
const LAST_YEAR_LEAGUE_ID = "1257201187006971904";
const LAST_YEAR_DRAFT_ID = "1257201187015372800";
const LAST_YEAR_SEASON = "2025";
const ALLOWED_POSITIONS = ["QB", "RB", "WR", "TE", "K"];

// Last year's picks/stats are finalized and never change; the ADP list is
// the only part that updates (FFC says at most once/day) -- one shared
// cache covering the whole joined table is simplest and matches their
// "don't call too frequently" guidance.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let cachedTable = null;
let cachedAt = 0;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`);
  return res.json();
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Our own tiers (not FantasyPros' proprietary ones), found via 1D k-means
// clustering on ADP -- a standard way to find natural groupings in a
// numeric distribution, rather than a hand-tuned gap threshold (which we
// tried twice and both times mis-calibrated badly across the ADP range).
// For sorted 1D data, k-means clusters are always contiguous intervals, so
// this safely produces ordered, non-overlapping tiers.
function kmeans1D(values, k, iterations = 100) {
  const min = values[0];
  const max = values[values.length - 1];
  let centroids = Array.from({ length: k }, (_, i) => min + ((max - min) * i) / (k - 1));
  let assignments = new Array(values.length).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < values.length; i++) {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dist = Math.abs(values[i] - centroids[c]);
        if (dist < bestDist) {
          bestDist = dist;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) changed = true;
      assignments[i] = bestCluster;
    }

    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < values.length; i++) {
      sums[assignments[i]] += values[i];
      counts[assignments[i]]++;
    }
    centroids = sums.map((s, c) => (counts[c] ? s / counts[c] : centroids[c]));

    if (!changed) break;
  }

  return assignments;
}

function assignTiers(sortedByAdp) {
  const adpValues = sortedByAdp.map((p) => p.adp);
  // Roughly one tier per ~8 players, floor of 8 tiers total, so tier count
  // scales sensibly whether the list is 60 players or 250.
  const tierCount = Math.max(8, Math.round(sortedByAdp.length / 8));
  const clusterAssignments = kmeans1D(adpValues, tierCount);

  // Cluster indices from k-means aren't necessarily in ADP order -- remap
  // them to sequential tier numbers in the order they first appear (which,
  // since clusters are contiguous for sorted 1D input, is the ADP order).
  const clusterToTier = new Map();
  let nextTier = 1;
  return sortedByAdp.map((p, i) => {
    const cluster = clusterAssignments[i];
    if (!clusterToTier.has(cluster)) {
      clusterToTier.set(cluster, nextTier);
      nextTier++;
    }
    return { ...p, tier: clusterToTier.get(cluster) };
  });
}

// Our own "upside/bust" proxy computed from FFC's real draft-variance
// numbers (stdev of where this player has actually been picked) -- not a
// copy of anyone's proprietary star rating.
function volatilityLabel(stdev) {
  if (stdev == null) return "Unknown";
  if (stdev <= 3) return "Safe";
  if (stdev <= 8) return "Moderate";
  return "Volatile";
}

async function buildDraftGuideTable() {
  const [adpData, sleeperPlayers, draftPicks, league] = await Promise.all([
    fetchJson(ADP_API_URL),
    fetchJson(SLEEPER_PLAYERS_URL),
    fetchJson(`https://api.sleeper.app/v1/draft/${LAST_YEAR_DRAFT_ID}/picks`),
    fetchJson(`https://api.sleeper.app/v1/league/${LAST_YEAR_LEAGUE_ID}`)
  ]);
  const stats = await fetchJson(`https://api.sleeper.app/v1/stats/nfl/regular/${LAST_YEAR_SEASON}`);

  // Sleeper's player pool includes retired/practice-squad/irrelevant-position
  // players who can share a name with an active fantasy-relevant one (e.g.
  // there's both an inactive Guard and the actual Bills QB named "Josh
  // Allen"). Restricting the name lookup to active players in a fantasy
  // position -- with a real team -- avoids silently matching the wrong one.
  const nameToSleeperId = new Map();
  Object.values(sleeperPlayers).forEach((p) => {
    if (!p.active || !p.team || !ALLOWED_POSITIONS.includes(p.position)) return;
    const fullName = p.full_name || (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : "");
    const key = normalizeName(fullName);
    if (key && !nameToSleeperId.has(key)) nameToSleeperId.set(key, p.player_id);
  });

  const pickByPlayerId = new Map();
  draftPicks.forEach((pick) => {
    pickByPlayerId.set(pick.player_id, { round: pick.round, pickNo: pick.pick_no });
  });

  // 2025 "ADP by position" proxy: FFC has no broader-market 2025 ADP (we
  // checked -- it's a genuine gap in their archive, sandwiched between
  // working 2023/2024/2026 snapshots), so this uses our own league's real
  // 2025 draft order instead. Smaller sample (160 picks vs. thousands of
  // mock drafts), but it's real data: 1st RB taken in that draft = RB1, etc.
  const draftPositionRankByPlayerId = new Map();
  const picksByPosition = {};
  draftPicks.forEach((pick) => {
    const pos = pick.metadata && pick.metadata.position;
    if (!pos || !ALLOWED_POSITIONS.includes(pos)) return;
    (picksByPosition[pos] = picksByPosition[pos] || []).push(pick);
  });
  Object.values(picksByPosition).forEach((picks) => {
    picks.sort((a, b) => a.pick_no - b.pick_no);
    picks.forEach((pick, i) => draftPositionRankByPlayerId.set(pick.player_id, i + 1));
  });

  // Custom point totals under THIS league's own scoring_settings, not
  // generic PPR -- Sleeper's stat blob already pre-counts bonus thresholds
  // (e.g. "hit 100+ receiving yards in N games"), so this is a
  // straightforward weighted sum, no special-casing needed.
  const scoringSettings = league.scoring_settings || {};
  const totalsByPlayerId = new Map();
  Object.entries(stats).forEach(([playerId, statLine]) => {
    let total = 0;
    Object.entries(scoringSettings).forEach(([key, value]) => {
      if (statLine[key]) total += statLine[key] * value;
    });
    if (total !== 0) totalsByPlayerId.set(playerId, Math.round(total * 100) / 100);
  });

  // Finish rank is scoped to only players actually drafted in our 2025
  // league (not the full ~225-deep NFL WR pool etc., which includes tons of
  // waiver-wire/garbage-time scrubs) -- that keeps "finish position" and
  // "draft position" comparable, both drawn from the same ~160-player pool,
  // so a "drafted RB5, finished RB2" delta means the same kind of thing as
  // a "drafted WR5, finished WR2" one.
  const positionGroups = {};
  Object.values(sleeperPlayers).forEach((p) => {
    if (!totalsByPlayerId.has(p.player_id) || !p.position) return;
    if (!pickByPlayerId.has(p.player_id)) return;
    (positionGroups[p.position] = positionGroups[p.position] || []).push({
      playerId: p.player_id,
      total: totalsByPlayerId.get(p.player_id)
    });
  });
  const posRankByPlayerId = new Map();
  Object.values(positionGroups).forEach((group) => {
    group.sort((a, b) => b.total - a.total);
    group.forEach((entry, i) => posRankByPlayerId.set(entry.playerId, i + 1));
  });

  // Team defenses aren't individually ranked/tracked for this guide.
  const skillPlayers = adpData.players.filter((p) => p.position !== "DEF");
  const sortedAdp = skillPlayers.slice().sort((a, b) => a.adp - b.adp);
  const withTiers = assignTiers(sortedAdp);

  // 2026 ADP by position -- same idea as the finish-rank grouping above, but
  // ranking this year's ADP within each position instead of last year's points.
  const adpPositionGroups = {};
  sortedAdp.forEach((p) => {
    (adpPositionGroups[p.position] = adpPositionGroups[p.position] || []).push(p);
  });
  const adpPositionRankByName = new Map();
  Object.values(adpPositionGroups).forEach((group) => {
    group.forEach((p, i) => adpPositionRankByName.set(normalizeName(p.name), i + 1));
  });

  return withTiers.map((p, i) => {
    const sleeperId = nameToSleeperId.get(normalizeName(p.name));
    const draftedInfo = sleeperId ? pickByPlayerId.get(sleeperId) : null;
    const points = sleeperId ? totalsByPlayerId.get(sleeperId) : undefined;
    const finishPosRank = sleeperId ? posRankByPlayerId.get(sleeperId) : undefined;
    const draftPosRank = sleeperId ? draftPositionRankByPlayerId.get(sleeperId) : undefined;
    const adpPosRank = adpPositionRankByName.get(normalizeName(p.name));

    // The "one useable number": how much better/worse a player finished
    // than where our own league actually drafted them, by position, last
    // year. Positive = outperformed their draft slot (value/breakout).
    // Negative = underperformed (bust). Null if we're missing either half
    // (e.g. wasn't drafted in that league, or didn't finish with any points).
    const valueDeltaLastYear =
      draftPosRank != null && finishPosRank != null ? draftPosRank - finishPosRank : null;

    return {
      rank: i + 1,
      name: p.name,
      position: p.position,
      team: p.team,
      bye: p.bye,
      adp: p.adp,
      adpFormatted: p.adp_formatted,
      adpPositionRank: adpPosRank ? `${p.position}${adpPosRank}` : null,
      tier: p.tier,
      volatility: volatilityLabel(p.stdev),
      draftedLastYear: draftedInfo ? `Rd ${draftedInfo.round}, Pick ${draftedInfo.pickNo}` : "Undrafted",
      draftPositionRankLastYear: draftPosRank ? `${p.position}${draftPosRank}` : null,
      pointsLastYear: points != null ? points : null,
      positionRankLastYear: finishPosRank ? `${p.position}${finishPosRank}` : null,
      valueDeltaLastYear
    };
  });
}

async function getDraftGuideTable() {
  const isStale = !cachedTable || Date.now() - cachedAt >= CACHE_MAX_AGE_MS;
  if (!isStale) return cachedTable;

  try {
    const table = await buildDraftGuideTable();
    cachedTable = table;
    cachedAt = Date.now();
    return table;
  } catch (err) {
    console.error("Failed to refresh draft guide table:", err);
    if (cachedTable) return cachedTable; // serve stale rather than a hard failure
    throw err;
  }
}

module.exports = { getDraftGuideTable };
