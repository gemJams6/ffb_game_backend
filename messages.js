const { checkTeamPassword } = require("./teamAuth");

const MAX_CONTENT_LENGTH = 2000;
const MESSAGE_HISTORY_LIMIT = 200;

let messagesCollection;

function initMessagesCollection(db) {
  messagesCollection = db.collection("messages");
}

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Returns the most recent messages in chronological (oldest-first) order --
// sorted descending + limited at the DB level to bound the query, then
// reversed in memory so the client always renders oldest-to-newest.
async function getMessages() {
  const docs = await messagesCollection
    .find({})
    .sort({ createdAt: -1 })
    .limit(MESSAGE_HISTORY_LIMIT)
    .toArray();

  return docs.reverse().map((d) => ({
    username: d.username,
    content: d.content,
    createdAt: d.createdAt
  }));
}

async function postMessage({ username, password, content }) {
  if (!checkTeamPassword(username, password)) throw fail("Incorrect team or password", 403);

  if (typeof content !== "string") throw fail("Message content is required", 400);
  const cleanContent = content.trim().slice(0, MAX_CONTENT_LENGTH);
  if (!cleanContent) throw fail("Message cannot be empty", 400);

  await messagesCollection.insertOne({
    username,
    content: cleanContent,
    createdAt: new Date()
  });

  return { ok: true };
}

module.exports = { initMessagesCollection, getMessages, postMessage };
