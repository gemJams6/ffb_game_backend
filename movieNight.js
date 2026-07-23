// Movie Date Night: a random-draw mechanism over IMDb Top 250 ranks (1-250),
// shared between just Dan and Danielle (not the 10 fantasy teams). One
// number is "in play" at a time -- once both people have rated it, it's
// archived to history and permanently retired from the draw pool.

const { checkTeamPassword } = require("./teamAuth");

const RATERS = ["Dan", "Danielle"];
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

function isComplete(doc) {
  return RATERS.every((name) => doc.ratings && typeof doc.ratings[name] === "number");
}

async function getMovieNightState() {
  const docs = await movieNightCollection.find({}).sort({ spunAt: 1 }).toArray();
  const usedNumbers = docs.map((d) => d.number);
  const current = docs.find((d) => !isComplete(d)) || null;
  const history = docs.filter((d) => isComplete(d));

  return {
    usedNumbers,
    current: current ? { number: current.number, ratings: current.ratings || {} } : null,
    history: history.map((d) => ({ number: d.number, ratings: d.ratings, completedAt: d.completedAt }))
  };
}

async function spinMovieNight({ team, password }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect login", 403);
  if (!RATERS.includes(team)) throw fail("Only Dan and Danielle can spin", 403);

  const docs = await movieNightCollection.find({}).toArray();
  if (docs.some((d) => !isComplete(d))) {
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
  if (!RATERS.includes(team)) throw fail("Only Dan and Danielle can rate", 403);
  if (typeof number !== "number") throw fail("number is required", 400);
  if (typeof rating !== "number" || rating < 1 || rating > 10) {
    throw fail("Rating must be between 1 and 10", 400);
  }

  const doc = await movieNightCollection.findOne({ number });
  if (!doc) throw fail("No movie night found for that number", 404);

  await movieNightCollection.updateOne({ number }, { $set: { [`ratings.${team}`]: rating } });

  const updated = await movieNightCollection.findOne({ number });
  if (isComplete(updated) && !updated.completedAt) {
    await movieNightCollection.updateOne({ number }, { $set: { completedAt: new Date() } });
  }

  return { ok: true };
}

module.exports = { initMovieNightCollection, getMovieNightState, spinMovieNight, submitRating };
