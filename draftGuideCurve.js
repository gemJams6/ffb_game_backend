// Pure math, no I/O: builds a "preseason position-rank -> actual PPG" curve
// from several historical seasons, models each 2026 player's rank as a
// distribution (not a point estimate), Monte Carlo-samples that through the
// curve to get a distribution of expected PPG, and fits a Gaussian Mixture
// Model per position to find where those distributions actually stop
// overlapping -- that's what defines a tier, rather than an arbitrary
// cluster on raw ADP.

const { normalizeName, normalizePosition } = require("./externalData");

const PER_PLAYER_SAMPLE_COUNT = 300; // each player's own tier-confidence averaging
const POOL_SAMPLE_COUNT_PER_PLAYER = 50; // smaller subsample feeding the pooled GMM fit (keeps EM tractable)

function compositeKey(name, position) {
  return `${normalizeName(name)}|${normalizePosition(position)}`;
}

// ---- Curve construction ----

// Joins each historical year's FFC preseason ADP to that year's PFR actuals
// by name+position, producing (positionRank, ppg) observations. Deliberately
// uses FFC's preseason rank, never the PFR tab's own Rk/PosRank (which is
// that season's END-of-season finish -- using finish rank as a stand-in for
// preseason expectation is the order-statistic bias this whole model exists
// to avoid: the player who ends up, say, WR10 is disproportionately someone
// who broke out from a much lower preseason rank).
function buildPositionRankObservations(historicalSeasons, position) {
  const observations = [];
  const matchStats = {};

  Object.entries(historicalSeasons).forEach(([year, season]) => {
    const ffcYear = season.ffcAdp
      .filter((p) => normalizePosition(p.position) === position)
      .slice()
      .sort((a, b) => a.adp - b.adp);

    const rankByKey = new Map();
    ffcYear.forEach((p, i) => {
      const key = compositeKey(p.name, p.position);
      if (!rankByKey.has(key)) rankByKey.set(key, i + 1);
    });

    const pfrYear = season.pfr.filter((p) => normalizePosition(p.position) === position && p.games > 0);

    let matched = 0;
    pfrYear.forEach((row) => {
      const positionRank = rankByKey.get(compositeKey(row.name, row.position));
      if (positionRank == null) return; // FFC didn't preseason-rank this player that year
      observations.push({ year: Number(year), positionRank, ppg: row.ppr / row.games, games: row.games });
      matched++;
    });

    matchStats[year] = { matched, total: ffcYear.length };
  });

  return { observations, matchStats };
}

// Gaussian-kernel (Nadaraya-Watson) regression, evaluated once per integer
// rank and memoized -- continuous queries during Monte Carlo just interpolate
// between the two nearest integers instead of re-summing every observation
// per sample. Games-played weight downweights injury-shortened, noisier
// seasons without excluding them outright.
function fitPositionCurve(observations, maxRank) {
  const bandwidth = Math.max(2, Math.round(maxRank / 20));
  const values = new Array(maxRank);

  for (let r = 1; r <= maxRank; r++) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const obs of observations) {
      const distWeight = Math.exp(-((obs.positionRank - r) ** 2) / (2 * bandwidth * bandwidth));
      const gamesWeight = Math.min(obs.games, 12) / 12;
      const w = distWeight * gamesWeight;
      weightedSum += w * obs.ppg;
      weightTotal += w;
    }
    values[r - 1] = weightTotal > 0 ? weightedSum / weightTotal : (values[r - 2] ?? 0);
  }

  return { maxRank, values };
}

// Clamps to [1, maxRank] -- beyond the deepest historically-observed rank,
// the curve simply floors out at its deepest value rather than extrapolating
// into unrealistic territory.
function evaluateCurve(curve, rank) {
  const r = Math.max(1, Math.min(curve.maxRank, rank));
  const lo = Math.floor(r);
  const hi = Math.ceil(r);
  const frac = r - lo;
  return curve.values[lo - 1] + (curve.values[hi - 1] - curve.values[lo - 1]) * frac;
}

// ---- Spread modeling ----

// Log-linear fit of stdev vs. ln(positionRank) on the subset of this
// position's 2026 consensus players who DO have real FFC spread -- used to
// estimate spread for the deep tail FFC doesn't cover. Clamped to the
// observed range (extended 1.5x on the high end) so the fit can't predict a
// negative/absurd stdev for shallow ranks or runaway values far past
// coverage.
function fitStdevFallbackModel(matchedPlayers) {
  const n = matchedPlayers.length;
  const xs = matchedPlayers.map((p) => Math.log(p.positionRank));
  const ys = matchedPlayers.map((p) => p.stdev);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - meanX) * (ys[i] - meanY);
    varX += (xs[i] - meanX) ** 2;
  }
  const slope = varX > 0 ? cov / varX : 0;
  const intercept = meanY - slope * meanX;

  return { intercept, slope, minObservedStdev: Math.min(...ys), maxObservedStdev: Math.max(...ys) };
}

function estimateStdev(model, positionRank) {
  const raw = model.intercept + model.slope * Math.log(positionRank);
  return Math.max(model.minObservedStdev, Math.min(model.maxObservedStdev * 1.5, raw));
}

// ---- Monte Carlo bridge ----

// Hand-rolled deterministic PRNG (mulberry32) -- fixed seed so results are
// reproducible run-to-run, not just stable within one cache period.
function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleNormal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function samplePlayerPpg(curve, meanRank, stdev, rng, count) {
  const samples = new Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = evaluateCurve(curve, meanRank + stdev * sampleNormal(rng));
  }
  return samples;
}

// ---- 1D k-means (GMM initializer) ----

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

// ---- 1D Gaussian Mixture Model (EM from scratch) ----

// A floor this low (1e-3) let components collapse onto near-single-point
// "spikes" -- an artifact of pooling many nearly-identical samples from
// low-individual-stdev players. A spike's density blows up near its center,
// so it ends up hijacking tier assignment for wide-distribution players
// whose tail merely brushes past it (observed directly: TE, at 1e-3, placed
// Travis Kelce at 10.3 PPG in Tier 1 while Kyle Pitts at 10.7 PPG -- higher
// -- landed in Tier 3). PPG values here run roughly 5-20, so a 0.25
// variance floor (0.5 PPG stdev) keeps that from happening while still
// allowing a genuinely tight elite tier.
const VARIANCE_FLOOR = 0.25;

function logGaussianPdf(x, mean, variance) {
  return -0.5 * Math.log(2 * Math.PI * variance) - ((x - mean) ** 2) / (2 * variance);
}

function logSumExp(logValues) {
  const max = Math.max(...logValues);
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const v of logValues) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

function fitGMM1D(values, k, maxIterations = 200, tol = 1e-6) {
  const n = values.length;
  const sorted = values.slice().sort((a, b) => a - b);
  const initAssignments = kmeans1D(sorted, k);

  let means = new Array(k).fill(0);
  let variances = new Array(k).fill(0);
  let weights = new Array(k).fill(1 / k);

  const initSums = new Array(k).fill(0);
  const initCounts = new Array(k).fill(0);
  sorted.forEach((v, i) => {
    initSums[initAssignments[i]] += v;
    initCounts[initAssignments[i]]++;
  });
  for (let c = 0; c < k; c++) {
    means[c] = initCounts[c] ? initSums[c] / initCounts[c] : sorted[Math.floor(((c + 0.5) * n) / k)];
    weights[c] = Math.max(initCounts[c] / n, 1e-3);
  }
  const initSqDiff = new Array(k).fill(0);
  sorted.forEach((v, i) => {
    const c = initAssignments[i];
    initSqDiff[c] += (v - means[c]) ** 2;
  });
  for (let c = 0; c < k; c++) {
    variances[c] = Math.max(initCounts[c] ? initSqDiff[c] / initCounts[c] : 1, VARIANCE_FLOOR);
  }

  let prevLogLik = -Infinity;
  const resp = Array.from({ length: n }, () => new Array(k).fill(0));

  for (let iter = 0; iter < maxIterations; iter++) {
    // E-step (log-space, log-sum-exp normalized -- avoids underflow)
    let logLik = 0;
    for (let i = 0; i < n; i++) {
      const logUnnorm = new Array(k);
      for (let c = 0; c < k; c++) {
        logUnnorm[c] = Math.log(weights[c]) + logGaussianPdf(values[i], means[c], variances[c]);
      }
      const logNorm = logSumExp(logUnnorm);
      logLik += logNorm;
      for (let c = 0; c < k; c++) resp[i][c] = Math.exp(logUnnorm[c] - logNorm);
    }

    // M-step
    const Nk = new Array(k).fill(0);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) Nk[c] += resp[i][c];

    const newMeans = new Array(k).fill(0);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) newMeans[c] += resp[i][c] * values[i];
    for (let c = 0; c < k; c++) newMeans[c] = Nk[c] > 0 ? newMeans[c] / Nk[c] : means[c];

    const newVariances = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) newVariances[c] += resp[i][c] * (values[i] - newMeans[c]) ** 2;
    }
    for (let c = 0; c < k; c++) {
      newVariances[c] = Math.max(Nk[c] > 0 ? newVariances[c] / Nk[c] : variances[c], VARIANCE_FLOOR);
    }

    means = newMeans;
    variances = newVariances;
    weights = Nk.map((v) => v / n);

    if (Math.abs(logLik - prevLogLik) < tol) {
      prevLogLik = logLik;
      break;
    }
    prevLogLik = logLik;
  }

  return { means, variances, weights, logLikelihood: prevLogLik, k };
}

// K in [2, min(6, max(2, round(n/25)))], 2 restarts per K (kmeans1D's own
// even centroid spacing is deterministic, but EM can still land in different
// local optima depending on the exact values passed in). Lowest BIC wins.
function selectBestGMM(values, restarts = 2) {
  const n = values.length;
  const minK = 2;
  const maxK = Math.min(6, Math.max(2, Math.round(n / 25)));

  const results = [];
  for (let k = minK; k <= maxK; k++) {
    let best = null;
    for (let r = 0; r < restarts; r++) {
      const fit = fitGMM1D(values, k);
      if (!best || fit.logLikelihood > best.logLikelihood) best = fit;
    }
    const bic = -2 * best.logLikelihood + (3 * k - 1) * Math.log(n);
    results.push({ k, bic, fit: best });
  }

  results.sort((a, b) => a.bic - b.bic);
  return { best: results[0], all: results };
}

// Assigns each PLAYER (not each sample) to the component that best explains
// the bulk of their own sampled distribution -- averaging posterior
// responsibility across all of a player's samples, rather than just using
// their mean, so a player whose distribution straddles a tier boundary
// lands wherever most of their probability mass actually is. Tier 1 = the
// component with the highest mean PPG.
function assignPlayerTiers(gmmFit, playersWithSamples) {
  const k = gmmFit.means.length;
  const componentOrder = gmmFit.means
    .map((mean, idx) => ({ mean, idx }))
    .sort((a, b) => b.mean - a.mean)
    .map((c) => c.idx);
  const tierByComponent = new Map();
  componentOrder.forEach((idx, i) => tierByComponent.set(idx, i + 1));

  const result = new Map();
  playersWithSamples.forEach(({ id, samples }) => {
    const avgResp = new Array(k).fill(0);
    samples.forEach((x) => {
      const logUnnorm = new Array(k);
      for (let c = 0; c < k; c++) {
        logUnnorm[c] = Math.log(gmmFit.weights[c]) + logGaussianPdf(x, gmmFit.means[c], gmmFit.variances[c]);
      }
      const logNorm = logSumExp(logUnnorm);
      for (let c = 0; c < k; c++) avgResp[c] += Math.exp(logUnnorm[c] - logNorm);
    });
    for (let c = 0; c < k; c++) avgResp[c] /= samples.length;

    let bestC = 0;
    for (let c = 1; c < k; c++) if (avgResp[c] > avgResp[bestC]) bestC = c;

    result.set(id, { tier: tierByComponent.get(bestC), confidence: avgResp[bestC] });
  });

  return result;
}

module.exports = {
  PER_PLAYER_SAMPLE_COUNT,
  POOL_SAMPLE_COUNT_PER_PLAYER,
  compositeKey,
  buildPositionRankObservations,
  fitPositionCurve,
  evaluateCurve,
  fitStdevFallbackModel,
  estimateStdev,
  createRng,
  sampleNormal,
  samplePlayerPpg,
  kmeans1D,
  selectBestGMM,
  assignPlayerTiers
};
