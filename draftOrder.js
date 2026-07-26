// Pre-draft slot selection: teams take turns, in a fixed order, choosing
// which of the 10 draft positions (1-10) they want for the live draft. Each
// team gets a 24-hour window on the clock; there's no auto-pick on timeout
// (unlike the live draft) -- the frontend just calls out whoever is overdue.

const { checkTeamPassword, fail } = require("./teamAuth");

const ORDER = ["Torelli", "Old Guys", "Brian", "Rican", "Tyton", "Ed", "Jason", "Dan", "Drew", "Grove"];
const TURN_MS = 24 * 60 * 60 * 1000;

let draftOrderCollection;

function initDraftOrderCollection(db) {
  draftOrderCollection = db.collection("draft_order_selections");
}

function toPublicState(doc) {
  const currentIndex = doc.selections.length;
  const complete = currentIndex >= ORDER.length;
  const currentTeam = complete ? null : ORDER[currentIndex];
  const turnStartedAt = complete
    ? null
    : currentIndex === 0
      ? doc.startedAt
      : doc.selections[currentIndex - 1].selectedAt;
  const turnDeadline = turnStartedAt ? new Date(turnStartedAt.getTime() + TURN_MS) : null;

  return {
    order: ORDER,
    selections: doc.selections.map((s) => ({
      team: s.team,
      slot: s.slot,
      selectedAt: s.selectedAt.toISOString()
    })),
    currentTeam,
    complete,
    turnStartedAt: turnStartedAt ? turnStartedAt.toISOString() : null,
    turnDeadline: turnDeadline ? turnDeadline.toISOString() : null
  };
}

// The very first team's clock starts the moment this feature first gets
// used, not on some separately-scheduled kickoff -- so a fresh doc is
// created (and its clock starts) lazily on first read.
async function getOrCreateDoc() {
  let doc = await draftOrderCollection.find({}).sort({ startedAt: -1 }).limit(1).next();
  if (!doc) {
    const fresh = { startedAt: new Date(), selections: [], selectionsCount: 0 };
    const result = await draftOrderCollection.insertOne(fresh);
    doc = { ...fresh, _id: result.insertedId };
  }
  return doc;
}

async function getDraftOrderState() {
  const doc = await getOrCreateDoc();
  return toPublicState(doc);
}

async function selectSlot({ team, password, slot }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect team or password", 403);
  if (!ORDER.includes(team)) throw fail(`${team} is not part of this draft order`, 403);
  if (!Number.isInteger(slot) || slot < 1 || slot > ORDER.length) {
    throw fail(`Slot must be between 1 and ${ORDER.length}`, 400);
  }

  const doc = await getOrCreateDoc();
  const currentIndex = doc.selections.length;
  if (currentIndex >= ORDER.length) throw fail("All slots have already been picked", 400);

  const currentTeam = ORDER[currentIndex];
  if (currentTeam !== team) throw fail(`It is not ${team}'s turn`, 409);

  if (doc.selections.some((s) => s.slot === slot)) {
    throw fail("That slot has already been taken", 409);
  }

  const newSelection = { team, slot, selectedAt: new Date() };

  // selectionsCount in the filter is an optimistic-concurrency guard, same
  // pattern as draftSession's currentPickIndex -- a losing race just re-reads.
  const updateResult = await draftOrderCollection.updateOne(
    { _id: doc._id, selectionsCount: currentIndex },
    { $push: { selections: newSelection }, $set: { selectionsCount: currentIndex + 1 } }
  );

  if (updateResult.matchedCount === 0) {
    throw fail("That selection was already submitted -- refresh and try again", 409);
  }

  const updatedDoc = await draftOrderCollection.findOne({ _id: doc._id });
  return toPublicState(updatedDoc);
}

async function resetDraftOrder({ commissionerSecret }) {
  if (!process.env.COMMISSIONER_SECRET || commissionerSecret !== process.env.COMMISSIONER_SECRET) {
    throw fail("Invalid commissioner secret", 403);
  }

  await draftOrderCollection.deleteMany({});
}

module.exports = {
  initDraftOrderCollection,
  getDraftOrderState,
  selectSlot,
  resetDraftOrder
};
