// Raw-data layer for the draft guide's historical rank->points curve, plus
// the 2026 consensus ranking list that's the guide's spine. Three source
// families:
//   - The user's own Google Sheet (public "anyone with the link" CSV
//     export, no auth needed): a 2026 consensus list, and one tab per
//     season 2022-2025 of real PFR-sourced season stats.
//   - Fantasy Football Calculator's ADP API, by year, for the preseason
//     side of each historical season (2022-2025 here; 2026 itself is
//     already fetched/cached by externalData.js and shared with
//     playerPool.js, so it's deliberately NOT re-fetched here).
//   - Sleeper's per-season stats API, last 3 completed seasons, for each
//     player's actual PPR finish (points + position rank) -- purely a
//     reference display ("where did this guy actually finish the last few
//     years") alongside the model's tier, NOT an input to the curve/tiering
//     math itself. Feeding finish-rank into the ranking model was
//     deliberately avoided elsewhere in this pipeline (order-statistic
//     bias -- see draftGuideCurve.js) and that stays true; this is just
//     context for the human reading the breakdown panel.
// These sources are all functionally frozen (historical) or rarely
// re-exported (the 2026 list), so this uses a much longer cache than the
// live ADP/player-pool data.

const SHEET_ID = "128kAe1m0WbiOJfirSIl-RGmPguS3FEN1WAjxjwJlxCQ";
const CONSENSUS_GID = "2047075400";
const HISTORICAL_GIDS = {
  2025: "1312535253",
  2024: "922482049",
  2023: "2052520787",
  2022: "1675543032"
};
const HISTORICAL_YEARS = [2022, 2023, 2024, 2025];

// Last 3 completed seasons -- matches what Sleeper's own player-page
// "Career" table shows, and is a separate, shorter window than the curve's
// 4-year HISTORICAL_YEARS above (that one's driven by how many years of PFR
// data the user's sheet has; this one's just "recent finishes for context").
const SLEEPER_FINISH_YEARS = [2023, 2024, 2025];

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let cached = null;
let cachedAt = 0;

function sheetCsvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

function ffcAdpUrl(year) {
  return `https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=10&year=${year}&position=all`;
}

function sleeperStatsUrl(year) {
  return `https://api.sleeper.app/stats/nfl/${year}?season_type=regular`;
}

async function fetchCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`);
  return res.json();
}

// Minimal RFC4180-ish line parser -- handles quoted fields (embedded commas,
// escaped "" quotes), which a naive split(",") would mangle.
function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

function parseCsv(text) {
  return text.split(/\r?\n/).filter((line) => line.length > 0).map(parseCsvLine);
}

const CONSENSUS_HEADER = ["RK", "PLAYER NAME", "TEAM", "POS", "BYE WEEK"];

// { rank, name, team, position, positionRank, bye } per row. POS is a
// combined string like "WR176" -- split into letters (position) + digits
// (positionRank).
function parseConsensusCsv(text) {
  const rows = parseCsv(text);
  const header = rows[0];
  if (JSON.stringify(header) !== JSON.stringify(CONSENSUS_HEADER)) {
    throw new Error(`Consensus sheet header changed -- expected [${CONSENSUS_HEADER}], got [${header}]`);
  }

  return rows.slice(1).filter((r) => r[1]).map((r) => {
    const [rk, name, team, posCombined, bye] = r;
    const m = (posCombined || "").match(/^([A-Z]+)(\d+)$/);
    return {
      rank: Number(rk),
      name,
      team,
      position: m ? m[1] : posCombined,
      positionRank: m ? Number(m[2]) : null,
      bye: bye === "-" || !bye ? null : Number(bye)
    };
  });
}

// Real header is row 2 (row 1 is a category-group header like
// "Games,Games,Passing,Passing,..."). Only the columns we actually read are
// validated -- the tail (VBD/PosRank/OvRank/player-id-slug) isn't, since one
// year's VBD header carries a trailing sort-arrow character we don't care
// about matching exactly.
const HISTORICAL_HEADER_PREFIX = [
  "Rk", "Player", "Tm", "FantPos", "Age", "G", "GS", "Cmp", "Att", "Yds", "TD", "Int",
  "Att", "Yds", "Y/A", "TD", "Tgt", "Rec", "Yds", "Y/R", "TD", "Fmb", "FL", "TD",
  "2:00 PM", "2PP", "FantPt", "PPR", "DKPt", "FDPt"
];

// { name, team, position, games, ppr } per row -- ppr is the season TOTAL
// (points-per-game is derived later, once joined with a specific curve use,
// so this layer stays a faithful raw transcription of the sheet).
function parseHistoricalCsv(text, year) {
  const rows = parseCsv(text);
  const header = rows[1];
  const prefix = header.slice(0, HISTORICAL_HEADER_PREFIX.length);
  if (JSON.stringify(prefix) !== JSON.stringify(HISTORICAL_HEADER_PREFIX)) {
    throw new Error(
      `Historical sheet header changed for ${year} -- expected [${HISTORICAL_HEADER_PREFIX}], got [${prefix}]`
    );
  }

  return rows.slice(2)
    .filter((r) => r.length > 27 && r[1])
    .map((r) => ({
      name: r[1],
      team: r[2],
      position: r[3],
      games: Number(r[5]) || 0,
      ppr: Number(r[27]) || 0
    }));
}

// Sleeper's season-stats response is a flat array, one entry per
// player-season, with the fields we want nested under `.stats` and
// `.player_id` at the top level. Keep only players who actually have a PPR
// finish computed (bench/practice-squad entries carry no pos_rank_ppr) --
// { playerId -> { position, positionRank, points } }.
function parseSleeperFinishes(records) {
  const byPlayerId = new Map();
  records.forEach((rec) => {
    const posRank = rec.stats && rec.stats.pos_rank_ppr;
    const pts = rec.stats && rec.stats.pts_ppr;
    if (posRank == null || pts == null || !rec.player_id) return;
    byPlayerId.set(rec.player_id, {
      position: rec.player && rec.player.position,
      positionRank: posRank,
      points: pts
    });
  });
  return byPlayerId;
}

async function getDraftGuideRawData() {
  const isStale = !cached || Date.now() - cachedAt >= CACHE_MAX_AGE_MS;
  if (!isStale) return cached;

  try {
    const [consensusCsvText, historicalCsvTexts, historicalAdpJsons, sleeperFinishJsons] = await Promise.all([
      fetchCsv(sheetCsvUrl(CONSENSUS_GID)),
      Promise.all(HISTORICAL_YEARS.map((y) => fetchCsv(sheetCsvUrl(HISTORICAL_GIDS[y])))),
      Promise.all(HISTORICAL_YEARS.map((y) => fetchJson(ffcAdpUrl(y)))),
      Promise.all(SLEEPER_FINISH_YEARS.map((y) => fetchJson(sleeperStatsUrl(y))))
    ]);

    const consensus = parseConsensusCsv(consensusCsvText);

    const historicalSeasons = {};
    HISTORICAL_YEARS.forEach((year, i) => {
      historicalSeasons[year] = {
        pfr: parseHistoricalCsv(historicalCsvTexts[i], year),
        ffcAdp: historicalAdpJsons[i].players || []
      };
    });

    const sleeperFinishesByYear = {};
    SLEEPER_FINISH_YEARS.forEach((year, i) => {
      sleeperFinishesByYear[year] = parseSleeperFinishes(sleeperFinishJsons[i]);
    });

    cached = { consensus, historicalSeasons, sleeperFinishesByYear };
    cachedAt = Date.now();
    return cached;
  } catch (err) {
    console.error("Failed to refresh draft guide historical data:", err);
    if (cached) return cached; // serve stale rather than a hard failure
    throw err;
  }
}

module.exports = { getDraftGuideRawData, HISTORICAL_YEARS, SLEEPER_FINISH_YEARS };
