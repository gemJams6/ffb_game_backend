// Standalone verification for the draft guide's rank-distribution-overlap
// pipeline. No server, no Mongo -- just network access to the same sources
// draftGuide.js itself hits. Run with: node scripts/checkDraftGuidePipeline.js
//
// Prints diagnostics at every stage so a bad curve fit, a broken join, or a
// degenerate GMM shows up here -- before ever touching the live server.

const { getRawExternalData, normalizePosition, normalizeName, buildNameToSleeperId } = require("../externalData");
const { getDraftGuideRawData, SLEEPER_FINISH_YEARS } = require("../draftGuideData");
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
} = require("../draftGuideCurve");

const ALLOWED_POSITIONS = ["QB", "RB", "WR", "TE"];
const RNG_SEED = 20260101;
const CURVE_SAMPLE_RANKS = [1, 2, 3, 5, 10, 15, 20, 30, 40, 60];

function section(title) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

async function main() {
  section("1. FETCH LAYER");
  const t0 = Date.now();
  const [{ adpData: adp2026, sleeperPlayers }, { consensus, historicalSeasons, sleeperFinishesByYear }] = await Promise.all([
    getRawExternalData(),
    getDraftGuideRawData()
  ]);
  console.log(`Fetched in ${Date.now() - t0}ms`);
  console.log(`Consensus list: ${consensus.length} rows (expect 517)`);
  console.log(`2026 FFC ADP: ${adp2026.players.length} players`);
  Object.entries(historicalSeasons).forEach(([year, s]) => {
    console.log(`  ${year}: PFR ${s.pfr.length} rows, FFC ADP ${s.ffcAdp.length} players`);
  });
  SLEEPER_FINISH_YEARS.forEach((year) => {
    console.log(`  Sleeper ${year} finishes: ${sleeperFinishesByYear[year].size} players with a computed PPR position rank`);
  });

  const consensusPositionCounts = {};
  consensus.forEach((p) => {
    const pos = normalizePosition(p.position);
    consensusPositionCounts[pos] = (consensusPositionCounts[pos] || 0) + 1;
  });
  console.log("Consensus list position breakdown:", consensusPositionCounts);
  const excludedCount = consensus.length - ALLOWED_POSITIONS.reduce((s, p) => s + (consensusPositionCounts[p] || 0), 0);
  console.log(`Excluded from this guide (K + DST, no PFR historical data for either): ${excludedCount}`);

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

  const rng = createRng(RNG_SEED);
  const perPositionResults = {};

  for (const position of ALLOWED_POSITIONS) {
    section(`2-4. POSITION: ${position}`);
    const players = consensusByPosition[position] || [];
    console.log(`Consensus players at this position: ${players.length}`);

    const { observations, matchStats } = buildPositionRankObservations(historicalSeasons, position);
    console.log("Curve observation match rate by year (FFC preseason -> PFR actual):");
    Object.entries(matchStats).forEach(([year, s]) => {
      console.log(`  ${year}: ${s.matched}/${s.total} FFC-ranked players matched to a PFR actual (${((s.matched / s.total) * 100).toFixed(0)}%)`);
    });
    console.log(`Total observations feeding the curve: ${observations.length}`);

    const deepestHistorical = observations.reduce((m, o) => Math.max(m, o.positionRank), 0);
    const deepestConsensus = players.reduce((m, p) => Math.max(m, p.positionRank || 0), 0);
    const maxRank = Math.max(deepestHistorical, deepestConsensus, 1);
    const curve = fitPositionCurve(observations, maxRank);
    console.log(`maxRank=${maxRank}, bandwidth=${Math.max(2, Math.round(maxRank / 20))}`);

    console.log("Curve sampled at ranks:");
    let prevVal = Infinity;
    let nonMonotonicBumps = 0;
    CURVE_SAMPLE_RANKS.filter((r) => r <= maxRank).forEach((r) => {
      const v = evaluateCurve(curve, r);
      const bump = v > prevVal + 0.5 ? "  <-- non-monotonic bump" : "";
      if (bump) nonMonotonicBumps++;
      console.log(`  rank ${String(r).padStart(3)}: ${v.toFixed(2)} PPG${bump}`);
      prevVal = v;
    });
    if (nonMonotonicBumps > 0) console.log(`  FLAG: ${nonMonotonicBumps} non-monotonic bump(s) found -- review observations for this position.`);

    // How separated is the curve at the very top? (rank 1 vs rank 5, in PPG)
    const top1 = evaluateCurve(curve, 1);
    const top5 = evaluateCurve(curve, 5);
    console.log(`Top-of-position spread check: curve(1)=${top1.toFixed(2)} vs curve(5)=${top5.toFixed(2)}  (delta=${(top1 - top5).toFixed(2)} PPG)`);

    // Spread
    const matchedForModel = [];
    const spreadByRank = new Map();
    players.forEach((p) => {
      const ffc = ffc2026ByKey.get(compositeKey(p.name, p.position));
      if (ffc && typeof ffc.stdev === "number") {
        spreadByRank.set(p.rank, { stdev: ffc.stdev, source: "ffc" });
        matchedForModel.push({ positionRank: p.positionRank, stdev: ffc.stdev });
      }
    });
    console.log(`\n2026 FFC spread coverage: ${matchedForModel.length}/${players.length} players have real stdev`);

    const stdevModel = matchedForModel.length >= 5 ? fitStdevFallbackModel(matchedForModel) : null;
    if (stdevModel) {
      console.log(`Fallback stdev model: intercept=${stdevModel.intercept.toFixed(3)}, slope=${stdevModel.slope.toFixed(3)}, observed range=[${stdevModel.minObservedStdev.toFixed(2)}, ${stdevModel.maxObservedStdev.toFixed(2)}]`);
      // Calibration spot-check: compare fallback estimate against real stdev for a few matched players
      const spotChecks = matchedForModel.filter((_, i) => i % Math.max(1, Math.floor(matchedForModel.length / 5)) === 0).slice(0, 5);
      console.log("Fallback-vs-real calibration spot-check (fit is never actually USED where real data exists -- this just sanity-checks the shape):");
      spotChecks.forEach((m) => {
        const est = estimateStdev(stdevModel, m.positionRank);
        console.log(`  rank ${m.positionRank}: real stdev=${m.stdev.toFixed(2)}, fallback-would-estimate=${est.toFixed(2)}`);
      });
    } else {
      console.log("Not enough FFC-matched players to fit a fallback model for this position -- using flat mean fallback.");
    }
    const fallbackMeanStdev = matchedForModel.length ? matchedForModel.reduce((s, m) => s + m.stdev, 0) / matchedForModel.length : 3;

    players.forEach((p) => {
      if (!spreadByRank.has(p.rank)) {
        const stdev = stdevModel ? estimateStdev(stdevModel, p.positionRank) : fallbackMeanStdev;
        spreadByRank.set(p.rank, { stdev, source: "estimated" });
      }
    });

    // GMM
    const playerSamples = [];
    const pooledForGmm = [];
    players.forEach((p) => {
      const spread = spreadByRank.get(p.rank);
      const fullSamples = samplePlayerPpg(curve, p.positionRank, spread.stdev, rng, PER_PLAYER_SAMPLE_COUNT);
      pooledForGmm.push(...fullSamples.slice(0, POOL_SAMPLE_COUNT_PER_PLAYER));
      playerSamples.push({ p, spread, fullSamples });
    });

    const gmmStart = Date.now();
    const { best, all } = selectBestGMM(pooledForGmm);
    const gmmMs = Date.now() - gmmStart;
    console.log(`\nGMM fit: pooled ${pooledForGmm.length} samples, took ${gmmMs}ms`);
    console.log("BIC table (lower is better):");
    all.forEach((r) => console.log(`  k=${r.k}: BIC=${r.bic.toFixed(1)}${r.k === best.k ? "  <-- chosen" : ""}`));
    console.log(`Chosen K=${best.k}, components (sorted by mean PPG desc):`);
    best.fit.means
      .map((mean, idx) => ({ mean, stdev: Math.sqrt(best.fit.variances[idx]), weight: best.fit.weights[idx] }))
      .sort((a, b) => b.mean - a.mean)
      .forEach((c, i) => console.log(`  Tier ${i + 1}: mean=${c.mean.toFixed(2)} PPG, stdev=${c.stdev.toFixed(2)}, weight=${(c.weight * 100).toFixed(1)}%`));

    const tierMap = assignPlayerTiers(best.fit, playerSamples.map(({ p, fullSamples }) => ({ id: p.rank, samples: fullSamples })));

    const roster = playerSamples.map(({ p, spread, fullSamples }) => {
      const mean = fullSamples.reduce((s, v) => s + v, 0) / fullSamples.length;
      const info = tierMap.get(p.rank);
      return { name: p.name, consensusPositionRank: p.positionRank, spreadStdev: spread.stdev, spreadSource: spread.source, ppgMean: mean, tier: info.tier, confidence: info.confidence };
    }).sort((a, b) => a.consensusPositionRank - b.consensusPositionRank);

    console.log(`\nTier roster (first 20 by consensus position rank):`);
    roster.slice(0, 20).forEach((r) => {
      console.log(`  ${position}${r.consensusPositionRank} ${r.name.padEnd(24)} ppg=${r.ppgMean.toFixed(1)} stdev=${r.spreadStdev.toFixed(2)}(${r.spreadSource}) tier=${r.tier} conf=${(r.confidence * 100).toFixed(0)}%`);
    });

    perPositionResults[position] = { curve, playerSamples, tierMap, gmmFit: best.fit };
  }

  section("5. NAMED SPOT-CHECKS");
  // A clear elite, a known boom/bust, and a rookie/deep player -- adjust
  // names below if the 2026 consensus list composition shifts.
  const spotCheckNames = ["Ja'Marr Chase", "Malik Nabers", "Ashton Jeanty"];
  for (const position of ALLOWED_POSITIONS) {
    const { playerSamples, tierMap } = perPositionResults[position];
    playerSamples.forEach(({ p, spread, fullSamples }) => {
      if (!spotCheckNames.some((n) => p.name.includes(n) || n.includes(p.name))) return;
      const sorted = fullSamples.slice().sort((a, b) => a - b);
      const mean = fullSamples.reduce((s, v) => s + v, 0) / fullSamples.length;
      const info = tierMap.get(p.rank);
      console.log(`\n${p.name} (${position}${p.positionRank}, overall rank ${p.rank}):`);
      console.log(`  spread: stdev=${spread.stdev.toFixed(2)} (${spread.source})`);
      console.log(`  projected PPG: mean=${mean.toFixed(1)}, 10th pct=${sorted[Math.round(0.1 * (sorted.length - 1))].toFixed(1)}, 90th pct=${sorted[Math.round(0.9 * (sorted.length - 1))].toFixed(1)}`);
      console.log(`  tier=${info.tier}, confidence=${(info.confidence * 100).toFixed(0)}%`);
    });
  }

  section("6. SLEEPER RECENT-FINISH REFERENCE DATA (display-only, not model input)");
  const nameToSleeperId = buildNameToSleeperId(sleeperPlayers, ALLOWED_POSITIONS);
  let matchedAny = 0;
  let totalConsensus = 0;
  ALLOWED_POSITIONS.forEach((position) => {
    (consensusByPosition[position] || []).forEach((p) => {
      totalConsensus++;
      const sleeperId = nameToSleeperId.get(normalizeName(p.name));
      const hasAnyFinish = sleeperId && SLEEPER_FINISH_YEARS.some((y) => sleeperFinishesByYear[y].has(sleeperId));
      if (hasAnyFinish) matchedAny++;
    });
  });
  console.log(`Consensus players (QB/RB/WR/TE) with at least one matched Sleeper finish year: ${matchedAny}/${totalConsensus}`);

  const finishSpotCheckNames = ["Bijan Robinson", "Ja'Marr Chase"];
  finishSpotCheckNames.forEach((name) => {
    const sleeperId = nameToSleeperId.get(normalizeName(name));
    if (!sleeperId) {
      console.log(`\n${name}: no Sleeper ID match`);
      return;
    }
    console.log(`\n${name} (sleeperId=${sleeperId}):`);
    SLEEPER_FINISH_YEARS.slice().reverse().forEach((year) => {
      const finish = sleeperFinishesByYear[year].get(sleeperId);
      if (!finish) { console.log(`  ${year}: no finish data`); return; }
      const ppg = finish.gamesPlayed > 0 ? (finish.points / finish.gamesPlayed).toFixed(1) : "n/a";
      console.log(`  ${year}: ${finish.position}${finish.positionRank}, ${finish.points} pts over ${finish.gamesPlayed} games (${ppg} PPG)`);
    });
  });

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Verification script failed:", err);
  process.exit(1);
});
