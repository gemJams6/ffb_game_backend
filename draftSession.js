let draftCollection;

function initDraftCollection(db) {
  draftCollection = db.collection("draft_sessions");
}

// Set once via the TEAM_PASSWORDS_JSON env var, e.g.
// {"Dan":"eagles92","Grove":"...", ...} -- persistent across seasons/drafts,
// unlike the old per-draft tokens. Parsed lazily so a malformed/missing env
// var fails loudly at the point of use rather than crashing server startup.
function getTeamPasswords() {
  const raw = process.env.TEAM_PASSWORDS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("TEAM_PASSWORDS_JSON is not valid JSON:", err.message);
    return {};
  }
}

function checkTeamPassword(team, password) {
  const passwords = getTeamPasswords();
  return Boolean(team) && Boolean(password) && passwords[team] === password;
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

function verifyTeamLogin({ team, password }) {
  if (!checkTeamPassword(team, password)) {
    throw fail("Incorrect team or password", 403);
  }
  return { ok: true };
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

  const doc = {
    teamOrder,
    totalRounds: rounds,
    pickOrder,
    picks: new Array(pickOrder.length).fill(null),
    currentPickIndex: 0,
    createdAt: new Date()
  };

  // Only one active draft at a time.
  await draftCollection.deleteMany({});
  const result = await draftCollection.insertOne(doc);

  return { draftId: result.insertedId.toString() };
}

async function submitPick({ team, password, player }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect team or password", 403);

  const doc = await draftCollection.find({}).sort({ createdAt: -1 }).limit(1).next();

  if (!doc) throw fail("No active draft", 404);
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

module.exports = {
  initDraftCollection,
  getCurrentSession,
  verifyTeamLogin,
  createSession,
  submitPick,
  resetSession
};
