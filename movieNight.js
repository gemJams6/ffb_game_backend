// IMDb 250: a random-draw mechanism over IMDb Top 250 ranks (1-250), shared
// between Dan, Danielle, Jake, and Madison (not the 10 fantasy teams). One
// number is "in play" at a time -- once everyone has rated it, it's archived
// to history and permanently retired from the draw pool.

const { checkTeamPassword } = require("./teamAuth");

const RATERS = ["Dan", "Danielle", "Jake", "Madison"];
const MAX_NUMBER = 250;

let movieNightCollection;

function initMovieNightCollection(db) {
  movieNightCollection = db.collection("movieNights");
  movieNightCollection.createIndex({ number: 1 }, { unique: true }).catch((err) => {
    console.error("Failed to create movieNights unique index:", err);
  });
}

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Whether a doc currently has a rating from everyone in RATERS -- only used
// to decide whether to *newly* stamp completedAt in submitRating. Whether a
// doc is actually archived to history is decided by completedAt itself (see
// below), not by re-running this check -- otherwise growing RATERS later
// would retroactively un-complete old history entries that were finished
// under a smaller roster.
function meetsAllCurrentRaters(doc) {
  return RATERS.every((name) => doc.ratings && typeof doc.ratings[name] === "number");
}

async function getMovieNightState() {
  const docs = await movieNightCollection.find({}).sort({ spunAt: 1 }).toArray();
  const usedNumbers = docs.map((d) => d.number);
  const current = docs.find((d) => !d.completedAt) || null;
  const history = docs.filter((d) => d.completedAt);

  return {
    usedNumbers,
    current: current ? { number: current.number, ratings: current.ratings || {} } : null,
    history: history.map((d) => ({ number: d.number, ratings: d.ratings, completedAt: d.completedAt }))
  };
}

async function spinMovieNight({ team, password }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect login", 403);
  if (!RATERS.includes(team)) throw fail(`Only ${RATERS.join(", ")} can spin`, 403);

  const docs = await movieNightCollection.find({}).toArray();
  if (docs.some((d) => !d.completedAt)) {
    throw fail("Finish rating the current movie before spinning again", 409);
  }

  const usedNumbers = new Set(docs.map((d) => d.number));
  const available = [];
  for (let i = 1; i <= MAX_NUMBER; i++) {
    if (!usedNumbers.has(i)) available.push(i);
  }
  if (available.length === 0) throw fail("All 250 movies have been used", 409);

  const number = available[Math.floor(Math.random() * available.length)];

  try {
    await movieNightCollection.insertOne({ number, spunAt: new Date(), ratings: {} });
  } catch (err) {
    if (err.code === 11000) throw fail("That number was just taken -- try spinning again", 409);
    throw err;
  }

  return { number };
}

async function submitRating({ team, password, number, rating }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect login", 403);
  if (!RATERS.includes(team)) throw fail(`Only ${RATERS.join(", ")} can rate`, 403);
  if (typeof number !== "number") throw fail("number is required", 400);
  if (typeof rating !== "number" || rating < 1 || rating > 10) {
    throw fail("Rating must be between 1 and 10", 400);
  }

  // Ratings support one decimal place (e.g. 7.5) -- round off any float
  // noise from the client so stored/displayed values stay clean.
  const cleanRating = Math.round(rating * 10) / 10;

  const doc = await movieNightCollection.findOne({ number });
  if (!doc) throw fail("No movie night found for that number", 404);

  await movieNightCollection.updateOne({ number }, { $set: { [`ratings.${team}`]: cleanRating } });

  const updated = await movieNightCollection.findOne({ number });
  if (meetsAllCurrentRaters(updated) && !updated.completedAt) {
    await movieNightCollection.updateOne({ number }, { $set: { completedAt: new Date() } });
  }

  return { ok: true };
}

// Cancels whatever movie is currently "in play" (not yet fully rated) and
// frees its number back into the draw pool -- for a mis-spin or a pick
// nobody wants to commit to. Only ever touches the current incomplete doc;
// completed (history) entries are untouchable through this.
async function resetCurrentSpin({ team, password }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect login", 403);
  if (!RATERS.includes(team)) throw fail(`Only ${RATERS.join(", ")} can reset the spin`, 403);

  const docs = await movieNightCollection.find({}).toArray();
  const current = docs.find((d) => !d.completedAt);
  if (!current) throw fail("No spin in progress to reset", 404);

  await movieNightCollection.deleteOne({ number: current.number });
  return { ok: true, number: current.number };
}

// Wipes every movie night -- used pool, current pick, and history -- back to
// a blank slate. Dan-only: his own real team password is the gate, same as
// any other write here, just restricted to one of the four names.
async function resetAllMovieNights({ team, password }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect login", 403);
  if (team !== "Dan") throw fail("Only Dan can reset everything", 403);

  const result = await movieNightCollection.deleteMany({});
  return { ok: true, deletedCount: result.deletedCount };
}

module.exports = {
  initMovieNightCollection,
  getMovieNightState,
  spinMovieNight,
  submitRating,
  resetCurrentSpin,
  resetAllMovieNights
};
