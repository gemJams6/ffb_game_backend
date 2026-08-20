// Server-side persistence for the New Era payout calculator. Previously
// this lived entirely in the browser's localStorage, which quietly broke
// the "viewable by all" requirement -- every visitor had their own separate
// empty copy, not the Commissioner's real data. One singleton document
// holds the whole calculator state; reads are public (matching every other
// read on this site), writes require the Commissioner password -- the same
// TEAM_PASSWORDS_JSON entry the page's own login already checks.

const { checkTeamPassword, fail } = require("./teamAuth");

const DOC_ID = "singleton";
let calculatorCollection;

function initNewEraCalculatorCollection(db) {
  calculatorCollection = db.collection("new_era_calculator");
}

// null means "nothing saved yet" -- the frontend falls back to its own
// built-in defaults rather than treating that as an error.
async function getCalculatorState() {
  const doc = await calculatorCollection.findOne({ _id: DOC_ID });
  return doc ? doc.state : null;
}

async function saveCalculatorState({ team, password, state }) {
  if (team !== "Commissioner" || !checkTeamPassword(team, password)) {
    throw fail("Incorrect Commissioner password", 403);
  }
  if (!state || typeof state !== "object") {
    throw fail("Missing calculator state", 400);
  }

  await calculatorCollection.updateOne(
    { _id: DOC_ID },
    { $set: { state, updatedAt: new Date() } },
    { upsert: true }
  );
  return state;
}

module.exports = { initNewEraCalculatorCollection, getCalculatorState, saveCalculatorState };
