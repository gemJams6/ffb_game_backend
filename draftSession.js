const { checkTeamPassword, verifyTeamLogin, fail } = require("./teamAuth");
const { getRankedPlayerPool } = require("./playerPool");

let draftCollection;

function initDraftCollection(db) {
  draftCollection = db.collection("draft_sessions");
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

// Rounds 1-6 get 5 minutes to pick; every round after that gets 3.
function pickTimerMs(round) {
  return round <= 6 ? 5 * 60 * 1000 : 3 * 60 * 1000;
}

function deadlineForNextPick(pickOrder, pickIndex) {
  const nextSlot = pickOrder[pickIndex];
  return nextSlot ? new Date(Date.now() + pickTimerMs(nextSlot.round)) : null;
}

// Auto-picking (below) uses the same ranked pool (playerPool.js) as
// draft-replica's displayed list, so an auto-pick always lands on whoever a
// human would actually see at the top of their available-players table.

function toPublicSession(doc) {
  if (!doc) return null;
  return {
    draftId: doc._id.toString(),
    teamOrder: doc.teamOrder,
    totalRounds: doc.totalRounds,
    pickOrder: doc.pickOrder,
    picks: doc.picks,
    currentPickIndex: doc.currentPickIndex,
    pickDeadline: doc.pickDeadline ? doc.pickDeadline.toISOString() : null,
    createdAt: doc.createdAt
  };
}

// If the clock has run out on the current pick, auto-drafts the highest-
// ranked available player for that team and advances the draft, then checks
// again -- recursing so that if the server was idle/asleep through more than
// one pick window, a single poll fast-forwards through all of them at once
// instead of trickling out one auto-pick per 3-second poll interval.
async function autoPickIfExpired(doc) {
  if (!doc) return doc;
  if (doc.currentPickIndex >= doc.pickOrder.length) return doc;
  if (!doc.pickDeadline || doc.pickDeadline.getTime() > Date.now()) return doc;

  const draftedIds = new Set(doc.picks.filter(Boolean).map((p) => p.player.id));
  const pool = await getRankedPlayerPool();
  const bestAvailable = pool.find((p) => !draftedIds.has(p.id));
  if (!bestAvailable) return doc; // pool exhausted -- nothing left to auto-pick

  const pickIndex = doc.currentPickIndex;
  const currentSlot = doc.pickOrder[pickIndex];
  const updatedPicks = [...doc.picks];
  updatedPicks[pickIndex] = {
    round: currentSlot.round,
    pickInRound: currentSlot.pickInRound,
    team: currentSlot.team,
    player: {
      id: bestAvailable.id,
      name: bestAvailable.name,
      position: bestAvailable.position,
      team: bestAvailable.team
    },
    autoPicked: true
  };

  const nextDeadline = deadlineForNextPick(doc.pickOrder, pickIndex + 1);

  // Same optimistic-concurrency guard as a manual pick: if a real user's
  // pick (or another auto-pick check) already advanced this exact pick
  // index, this update loses the race harmlessly -- just re-read.
  const updateResult = await draftCollection.updateOne(
    { _id: doc._id, currentPickIndex: pickIndex },
    { $set: { picks: updatedPicks, currentPickIndex: pickIndex + 1, pickDeadline: nextDeadline } }
  );

  // Either way -- whether this update won the race or lost it to a manual
  // pick/concurrent auto-pick -- re-read to get the authoritative state.
  const latestDoc = await draftCollection.findOne({ _id: doc._id });
  return autoPickIfExpired(latestDoc);
}

async function getCurrentSession() {
  const doc = await draftCollection.find({}).sort({ createdAt: -1 }).limit(1).next();
  const finalDoc = await autoPickIfExpired(doc);
  return toPublicSession(finalDoc);
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
    pickDeadline: deadlineForNextPick(pickOrder, 0),
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

  const nextDeadline = deadlineForNextPick(doc.pickOrder, pickIndex + 1);

  // currentPickIndex in the filter is an optimistic-concurrency guard: if two
  // requests race for the same pick, only the first's update actually matches.
  const updateResult = await draftCollection.updateOne(
    { _id: doc._id, currentPickIndex: pickIndex },
    { $set: { picks: updatedPicks, currentPickIndex: pickIndex + 1, pickDeadline: nextDeadline } }
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
