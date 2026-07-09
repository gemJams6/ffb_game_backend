const crypto = require("crypto");

let draftCollection;

function initDraftCollection(db) {
  draftCollection = db.collection("draft_sessions");
}

function generateToken() {
  return crypto.randomBytes(12).toString("hex");
}

function buildPickOrder(teamOrder, totalRounds) {
  const order = [];
  for (let round = 1; round <= totalRounds; round++) {
    const roundTeams = round % 2 === 1 ? teamOrder : [...teamOrder].slice().reverse();
    roundTeams.forEach((team, i) => {
      order.push({ round, pickInRound: i + 1, team });
    });
  }
  return order;
}

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Team tokens never leave the server except once, at creation time, in the
// response the commissioner uses to build each team's private link.
function toPublicSession(doc) {
  if (!doc) return null;
  return {
    draftId: doc._id.toString(),
    teamOrder: doc.teamOrder,
    totalRounds: doc.totalRounds,
    pickOrder: doc.pickOrder,
    picks: doc.picks,
    currentPickIndex: doc.currentPickIndex,
    createdAt: doc.createdAt
  };
}

async function getCurrentSession() {
  const doc = await draftCollection.find({}).sort({ createdAt: -1 }).limit(1).next();
  return toPublicSession(doc);
}

async function createSession({ teamOrder, totalRounds, commissionerSecret }) {
  if (!process.env.COMMISSIONER_SECRET || commissionerSecret !== process.env.COMMISSIONER_SECRET) {
    throw fail("Invalid commissioner secret", 403);
  }

  if (!Array.isArray(teamOrder) || teamOrder.length < 2 || new Set(teamOrder).size !== teamOrder.length) {
    throw fail("teamOrder must be a list of unique teams", 400);
  }

  const rounds = Math.max(1, Math.min(25, Number(totalRounds) || 16));
  const pickOrder = buildPickOrder(teamOrder, rounds);

  const teamTokens = {};
  teamOrder.forEach((team) => {
    teamTokens[team] = generateToken();
  });

  const doc = {
    teamOrder,
    totalRounds: rounds,
    pickOrder,
    picks: new Array(pickOrder.length).fill(null),
    currentPickIndex: 0,
    teamTokens,
    createdAt: new Date()
  };

  // Only one active draft at a time.
  await draftCollection.deleteMany({});
  const result = await draftCollection.insertOne(doc);

  return { draftId: result.insertedId.toString(), teamTokens };
}

async function submitPick({ team, token, player }) {
  const doc = await draftCollection.find({}).sort({ createdAt: -1 }).limit(1).next();

  if (!doc) throw fail("No active draft", 404);
  if (!team || !doc.teamTokens || doc.teamTokens[team] !== token) throw fail("Invalid team or token", 403);
  if (!player || !player.id || !player.name) throw fail("Invalid player payload", 400);
  if (doc.currentPickIndex >= doc.pickOrder.length) throw fail("Draft is already complete", 400);

  const currentSlot = doc.pickOrder[doc.currentPickIndex];
  if (currentSlot.team !== team) throw fail(`It is not ${team}'s turn`, 409);

  const alreadyDrafted = doc.picks.some((p) => p && p.player && p.player.id === player.id);
  if (alreadyDrafted) throw fail("That player has already been drafted", 409);

  const pickIndex = doc.currentPickIndex;
  const updatedPicks = [...doc.picks];
  updatedPicks[pickIndex] = {
    round: currentSlot.round,
    pickInRound: currentSlot.pickInRound,
    team: currentSlot.team,
    player
  };

  // currentPickIndex in the filter is an optimistic-concurrency guard: if two
  // requests race for the same pick, only the first's update actually matches.
  const updateResult = await draftCollection.updateOne(
    { _id: doc._id, currentPickIndex: pickIndex },
    { $set: { picks: updatedPicks, currentPickIndex: pickIndex + 1 } }
  );

  if (updateResult.matchedCount === 0) {
    throw fail("That pick was already submitted -- refresh and try again", 409);
  }

  const updatedDoc = await draftCollection.findOne({ _id: doc._id });
  return toPublicSession(updatedDoc);
}

async function resetSession({ commissionerSecret }) {
  if (!process.env.COMMISSIONER_SECRET || commissionerSecret !== process.env.COMMISSIONER_SECRET) {
    throw fail("Invalid commissioner secret", 403);
  }

  await draftCollection.deleteMany({});
}

module.exports = { initDraftCollection, getCurrentSession, createSession, submitPick, resetSession };
