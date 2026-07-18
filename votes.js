const { checkTeamPassword } = require("./teamAuth");

let votesCollection;

function initVotesCollection(db) {
  votesCollection = db.collection("votes");
  // Belt-and-suspenders against a race between two simultaneous votes from
  // the same team on the same rule -- the app-level check in submitVote
  // handles the common case, but only a unique index is race-proof.
  votesCollection.createIndex({ ruleId: 1, team: 1 }, { unique: true }).catch((err) => {
    console.error("Failed to create votes unique index:", err);
  });
}

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Rule/option definitions live in the frontend (easy for the commissioner to
// add new rules without touching the backend) -- this just records votes
// generically against whatever ruleId/optionId strings it's given.
async function getAllVotes() {
  const votes = await votesCollection.find({}).toArray();
  return votes.map((v) => ({ ruleId: v.ruleId, team: v.team, optionId: v.optionId }));
}

async function submitVote({ ruleId, team, password, optionId }) {
  if (!checkTeamPassword(team, password)) throw fail("Incorrect team or password", 403);
  if (!ruleId || typeof ruleId !== "string") throw fail("ruleId is required", 400);
  if (!optionId || typeof optionId !== "string") throw fail("optionId is required", 400);

  try {
    await votesCollection.insertOne({ ruleId, team, optionId, votedAt: new Date() });
  } catch (err) {
    if (err.code === 11000) {
      throw fail("You've already voted on this rule", 409);
    }
    throw err;
  }

  return { ok: true };
}

module.exports = { initVotesCollection, getAllVotes, submitVote };
