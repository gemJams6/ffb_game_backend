// Builds the draft guide table via rank-distribution-overlap tiering:
//   - Spine: a 517-player 2026 consensus ranking list (the user's own
//     FantasyPros export).
//   - Each player's preseason position-rank is modeled as a *distribution*
//     (mean = consensus rank, spread = FFC's real draft-variance stdev,
//     estimated via a fitted fallback where FFC doesn't cover that deep).
//   - A "preseason position-rank -> actual PPG" curve, built from 2022-2025
//     real season results (PFR data, the user's own sheet) joined against
//     each of those years' own preseason FFC ADP -- never that season's
//     finish-rank, which would bias the curve toward the players who
//     broke out from a much lower preseason rank.
//   - Each player's rank distribution is Monte Carlo-sampled through the
//     curve to get a distribution of expected PPG, and a Gaussian Mixture
//     Model (per position) finds where players' distributions actually
//     stop overlapping -- that's what defines a tier.
//
// PFR's historical fantasy tables have no kicker or team-defense data at
// all, so K and DST can't go through this methodology -- both are excluded
// from this guide entirely (DST always was; K is new to exclude, forced by
// data availability, not a choice).

const { getRawExternalData, normalizePosition, normalizeName, buildNameToSleeperId } = require("./externalData");
const { getDraftGuideRawData, SLEEPER_FINISH_YEARS } = require("./draftGuideData");
const {
  PER_PLAYER_SAMPLE_COUNT,
  POOL_SAMPLE_COUNT_PER_PLAYER,
  compositeKey,
  buildPositionRankObservations,
  fitPositionCurve,
  evaluateCurve,
  fitStdevFallbackModel,
  estimateStdev,
  createRng,
  samplePlayerPpg,
  selectBestGMM,
  assignPlayerTiers
} = require("./draftGuideCurve");

const ALLOWED_POSITIONS = ["QB", "RB", "WR", "TE"];
const VOLATILITY_ORDER = { Safe: 1, Moderate: 2, Volatile: 3, Unknown: 4 };

// Fixed (not day-bucketed) -- reproducible across runs/cache-refreshes, not
// just stable within one, so results are diffable when debugging.
const RNG_SEED = 20260101;

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let cachedTable = null;
let cachedAt = 0;

function volatilityLabel(stdev) {
  if (stdev == null) return "Unknown";
  if (stdev <= 3) return "Safe";
  if (stdev <= 8) return "Moderate";
  return "Volatile";
}

function percentile(sortedValues, p) {
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.round(p * (sortedValues.length - 1))));
  return sortedValues[idx];
}

async function buildDraftGuideTable() {
  const [{ adpData: adp2026, sleeperPlayers }, { consensus, historicalSeasons, sleeperFinishesByYear }] = await Promise.all([
    getRawExternalData(),
    getDraftGuideRawData()
  ]);

  // Sleeper player_id, purely to look up recent real finishes for the
  // breakdown panel's reference display -- not used anywhere in the
  // curve/tiering math itself.
  const nameToSleeperId = buildNameToSleeperId(sleeperPlayers, ALLOWED_POSITIONS);

  const rng = createRng(RNG_SEED);

  const ffc2026ByKey = new Map();
  adp2026.players.forEach((p) => {
    const key = compositeKey(p.name, p.position);
    if (!ffc2026ByKey.has(key)) ffc2026ByKey.set(key, p);
  });

  const consensusByPosition = {};
  consensus.forEach((p) => {
    const pos = normalizePosition(p.position);
    if (!ALLOWED_POSITIONS.includes(pos)) return;
    (consensusByPosition[pos] = consensusByPosition[pos] || []).push(p);
  });

  const rowsByRank = new Map();

  ALLOWED_POSITIONS.forEach((position) => {
    const players = consensusByPosition[position] || [];
    if (!players.length) return;

    // Curve: preseason position-rank -> actual PPG, from 2022-2025.
    const { observations } = buildPositionRankObservations(historicalSeasons, position);
    const historicalObservationCount = observations.length;
    const deepestHistorical = observations.reduce((m, o) => Math.max(m, o.positionRank), 0);
    const deepestConsensus = players.reduce((m, p) => Math.max(m, p.positionRank || 0), 0);
    const maxRank = Math.max(deepestHistorical, deepestConsensus, 1);
    const curve = fitPositionCurve(observations, maxRank);

    // Spread: real 2026 FFC stdev where matched; log-linear fallback fit
    // (on this position's own matched players) for the deep tail FFC
    // doesn't cover.
    const matchedForModel = [];
    const spreadByRank = new Map();
    players.forEach((p) => {
      const ffc = ffc2026ByKey.get(compositeKey(p.name, p.position));
      if (ffc && typeof ffc.stdev === "number") {
        spreadByRank.set(p.rank, { stdev: ffc.stdev, source: "ffc" });
        matchedForModel.push({ positionRank: p.positionRank, stdev: ffc.stdev });
      }
    });

    const stdevModel = matchedForModel.length >= 5 ? fitStdevFallbackModel(matchedForModel) : null;
    const fallbackMeanStdev = matchedForModel.length
      ? matchedForModel.reduce((s, m) => s + m.stdev, 0) / matchedForModel.length
      : 3; // no FFC coverage at all for this position -- arbitrary last resort, documented here

    players.forEach((p) => {
      if (!spreadByRank.has(p.rank)) {
        const stdev = stdevModel ? estimateStdev(stdevModel, p.positionRank) : fallbackMeanStdev;
        spreadByRank.set(p.rank, { stdev, source: "estimated" });
      }
    });

    // Sample every player: a full set for their own tier-confidence
    // average, plus a smaller subsample pooled across the position to keep
    // the GMM fit tractable.
    const playerSamples = [];
    const pooledForGmm = [];
    players.forEach((p) => {
      const spread = spreadByRank.get(p.rank);
      const fullSamples = samplePlayerPpg(curve, p.positionRank, spread.stdev, rng, PER_PLAYER_SAMPLE_COUNT);
      pooledForGmm.push(...fullSamples.slice(0, POOL_SAMPLE_COUNT_PER_PLAYER));
      playerSamples.push({ p, spread, fullSamples });
    });

    const { best } = selectBestGMM(pooledForGmm);
    const tierMap = assignPlayerTiers(
      best.fit,
      playerSamples.map(({ p, fullSamples }) => ({ id: p.rank, samples: fullSamples }))
    );
    // Tier N (1-indexed) is the Nth-highest-mean component -- same ordering
    // assignPlayerTiers itself uses internally -- so this lets us report
    // "your tier's average" without re-exporting that internal mapping.
    const tierAverages = best.fit.means.slice().sort((a, b) => b - a);

    playerSamples.forEach(({ p, spread, fullSamples }) => {
      const sorted = fullSamples.slice().sort((a, b) => a - b);
      const mean = fullSamples.reduce((s, v) => s + v, 0) / fullSamples.length;
      const tierInfo = tierMap.get(p.rank);
      const volatility = volatilityLabel(spread.stdev);

      rowsByRank.set(p.rank, {
        rank: p.rank,
        name: p.name,
        position,
        team: p.team,
        bye: p.bye,
        adp: null,
        adpFormatted: null,
        consensusPositionRank: p.positionRank,
        consensusPositionRankLabel: p.positionRank ? `${position}${p.positionRank}` : null,
        spreadStdev: Math.round(spread.stdev * 100) / 100,
        spreadSource: spread.source,
        volatility,
        volatilityRank: VOLATILITY_ORDER[volatility],
        curvePpg: Math.round(evaluateCurve(curve, p.positionRank) * 10) / 10,
        historicalObservationCount,
        projectedPpgMean: Math.round(mean * 10) / 10,
        projectedPpgLow: Math.round(percentile(sorted, 0.1) * 10) / 10,
        projectedPpgHigh: Math.round(percentile(sorted, 0.9) * 10) / 10,
        tier: tierInfo ? tierInfo.tier : null,
        tierConfidence: tierInfo ? Math.round(tierInfo.confidence * 100) : null,
        tierAveragePpg: tierInfo ? Math.round(tierAverages[tierInfo.tier - 1] * 10) / 10 : null,
        tierCount: best.fit.means.length
      });
    });
  });

  // Real ADP is a reference field only (not the ranking spine anymore) --
  // fill it in wherever a 2026 FFC match exists, null otherwise (~268/517
  // of the full consensus list won't have one; the frontend renders "—").
  rowsByRank.forEach((row) => {
    const ffc = ffc2026ByKey.get(compositeKey(row.name, row.position));
    if (ffc) {
      row.adp = ffc.adp;
      row.adpFormatted = ffc.adp_formatted;
    }

    // Recent real finishes (most recent year first) -- reference only, see
    // note above. Rookies/unmatched names just get an empty array; the
    // frontend shows a "no history" message rather than treating it as an error.
    const sleeperId = nameToSleeperId.get(normalizeName(row.name));
    row.recentFinishes = sleeperId
      ? SLEEPER_FINISH_YEARS.slice().reverse()
          .map((year) => {
            const finish = sleeperFinishesByYear[year] && sleeperFinishesByYear[year].get(sleeperId);
            return finish ? { year, position: finish.position, positionRank: finish.positionRank, points: finish.points } : null;
          })
          .filter(Boolean)
      : [];
  });

  // Renumber 1..N over just the QB/RB/WR/TE rows (K/DST excluded), same
  // convention the old ADP-based table used (contiguous rank within the
  // relevant pool, not the original consensus list's numbering with gaps).
  return Array.from(rowsByRank.values())
    .sort((a, b) => a.rank - b.rank)
    .map((row, i) => ({ ...row, rank: i + 1 }));
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

module.exports = { getDraftGuideTable, buildDraftGuideTable };
