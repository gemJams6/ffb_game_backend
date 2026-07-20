// Builds a draft-prep table by joining three free, public data sources:
//   - Fantasy Football Calculator's ADP API (crowdsourced average draft
//     position from real mock drafts) -- see help.fantasyfootballcalculator.com,
//     free for personal/commercial use with attribution.
//   - Sleeper's player pool, last year's draft picks, and last year's raw
//     season stats -- all public, no auth required.
// Tiers and a volatility ("upside/bust" proxy) label are computed from FFC's
// own numbers rather than copying anyone's proprietary ratings.

const { getRawExternalData, normalizeName, buildNameToSleeperId } = require("./externalData");

const LAST_YEAR_LEAGUE_ID = "1257201187006971904";
const LAST_YEAR_DRAFT_ID = "1257201187015372800";
const LAST_YEAR_SEASON = "2025";
const ALLOWED_POSITIONS = ["QB", "RB", "WR", "TE", "K"];

// Last year's picks/stats are finalized and never change; the ADP list is
// the only part that updates (FFC says at most once/day) -- one cache
// covering the whole joined table (on top of externalData's own cache for
// the raw FFC/Sleeper fetch) avoids redoing the join/tier computation on
// every request.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let cachedTable = null;
let cachedAt = 0;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`);
  return res.json();
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

// Same k-means idea as assignTiers, but per position on 2025 point totals
// instead of on ADP -- finds where a position's real scoring naturally
// breaks into tiers (e.g. "the RB1-RB3 tier, then a real drop-off to
// RB4-RB9"), independent of ADP entirely. Higher points is better, so
// cluster on ascending totals (kmeans1D's contiguous-cluster guarantee
// needs ascending 1D input) and then flip the tier numbering so the
// highest-scoring cluster becomes Tier 1.
function assignFinishTiersForPosition(entries) {
  const ascending = entries.slice().sort((a, b) => a.total - b.total);
  const values = ascending.map((e) => e.total);
  const tierCount = Math.max(3, Math.min(Math.round(ascending.length / 6), ascending.length));
  const assignments = kmeans1D(values, tierCount);

  // Cluster ids appear in ascending-value order here (worst first); the
  // last-appearing (best) cluster should become Tier 1, so reverse it.
  const appearanceOrder = [];
  assignments.forEach((c) => {
    if (!appearanceOrder.includes(c)) appearanceOrder.push(c);
  });
  const clusterToTier = new Map();
  appearanceOrder.forEach((c, idx) => clusterToTier.set(c, appearanceOrder.length - idx));

  const tierByPlayerId = new Map();
  ascending.forEach((entry, i) => tierByPlayerId.set(entry.playerId, clusterToTier.get(assignments[i])));
  return tierByPlayerId;
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
  const { adpData, sleeperPlayers } = await getRawExternalData();
  const [draftPicks, league] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/draft/${LAST_YEAR_DRAFT_ID}/picks`),
    fetchJson(`https://api.sleeper.app/v1/league/${LAST_YEAR_LEAGUE_ID}`)
  ]);
  const stats = await fetchJson(`https://api.sleeper.app/v1/stats/nfl/regular/${LAST_YEAR_SEASON}`);

  const nameToSleeperId = buildNameToSleeperId(sleeperPlayers, ALLOWED_POSITIONS);

  const pickByPlayerId = new Map();
  draftPicks.forEach((pick) => {
    pickByPlayerId.set(pick.player_id, { round: pick.round, pickNo: pick.pick_no });
  });

  // Custom point totals under THIS league's own scoring_settings, not
  // generic PPR -- Sleeper's stat blob already pre-counts bonus thresholds
  // (e.g. "hit 100+ receiving yards in N games"), so this is a
  // straightforward weighted sum, no special-casing needed. Points
  // themselves aren't shown -- they're only used to rank/tier players.
  const scoringSettings = league.scoring_settings || {};
  const totalsByPlayerId = new Map();
  Object.entries(stats).forEach(([playerId, statLine]) => {
    let total = 0;
    Object.entries(scoringSettings).forEach(([key, value]) => {
      if (statLine[key]) total += statLine[key] * value;
    });
    if (total !== 0) totalsByPlayerId.set(playerId, Math.round(total * 100) / 100);
  });

  // Team defenses aren't individually ranked/tracked for this guide.
  const skillPlayers = adpData.players.filter((p) => p.position !== "DEF");
  const sortedAdp = skillPlayers.slice().sort((a, b) => a.adp - b.adp);
  const withTiers = assignTiers(sortedAdp);

  // "2025 finish" and "2026 ADP" are only directly comparable if both are
  // ranked among the same player pool -- so finish rank is scoped to just
  // the players in THIS year's ADP list (not our own 160-pick league draft,
  // and not the full ~225-deep NFL WR pool full of waiver-wire scrubs).
  const adpMatchedSleeperIds = new Set();
  sortedAdp.forEach((p) => {
    const id = nameToSleeperId.get(normalizeName(p.name));
    if (id) adpMatchedSleeperIds.add(id);
  });

  const positionGroups = {};
  Object.values(sleeperPlayers).forEach((p) => {
    if (!totalsByPlayerId.has(p.player_id) || !p.position) return;
    if (!adpMatchedSleeperIds.has(p.player_id)) return;
    (positionGroups[p.position] = positionGroups[p.position] || []).push({
      playerId: p.player_id,
      total: totalsByPlayerId.get(p.player_id)
    });
  });
  const posRankByPlayerId = new Map();
  const finishTierByPlayerId = new Map();
  Object.values(positionGroups).forEach((group) => {
    group.sort((a, b) => b.total - a.total);
    group.forEach((entry, i) => posRankByPlayerId.set(entry.playerId, i + 1));
    assignFinishTiersForPosition(group).forEach((tier, playerId) => finishTierByPlayerId.set(playerId, tier));
  });

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
    const finishPosRank = sleeperId ? posRankByPlayerId.get(sleeperId) : undefined;
    const finishTier = sleeperId ? finishTierByPlayerId.get(sleeperId) : undefined;
    const adpPosRank = adpPositionRankByName.get(normalizeName(p.name));

    // The "one useable number": 2026 ADP position rank vs. 2025 finish
    // position rank. Positive = they finished better last year than their
    // current ADP reflects (possible value/undervalued this year).
    // Negative = current ADP has them rated higher than their actual 2025
    // finish supports (possible overvalue/bust risk). Null if either half
    // is missing (e.g. no 2025 finish data, like a rookie).
    const finishVsAdpGap =
      adpPosRank != null && finishPosRank != null ? adpPosRank - finishPosRank : null;

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
      positionRankLastYear: finishPosRank ? `${p.position}${finishPosRank}` : null,
      finishTierLastYear: finishTier ? `Tier ${finishTier}` : null,
      finishVsAdpGap
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
