require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { getAvailability, saveAvailability } = require("./googleSheets");
const { checkTeamPassword, verifyTeamLogin } = require("./teamAuth");
const {
  initDraftCollection,
  getCurrentSession,
  createSession,
  submitPick,
  resetSession
} = require("./draftSession");
const { initVotesCollection, getAllVotes, submitVote, resetVotesForRule } = require("./votes");
const {
  initMovieNightCollection,
  getMovieNightState,
  spinMovieNight,
  submitRating,
  resetCurrentSpin,
  resetAllMovieNights
} = require("./movieNight");
const { initMessagesCollection, getMessages, postMessage } = require("./messages");
const { getDraftGuideTable } = require("./draftGuide");
const { getRankedPlayerPool } = require("./playerPool");

const app = express();
const PORT = process.env.PORT || 3000;
const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("Missing MONGODB_URI in .env");
}

app.use(cors());
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true
  }
});

let leaderboardCollection;

app.get("/health", (req, res) => {
  console.log(`Health check ping at ${new Date().toISOString()}`);
  res.json({ ok: true });
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const scores = await leaderboardCollection
      .find({})
      .sort({ score: -1, createdAt: 1 })
      .limit(5)
      .toArray();

    res.json(scores);
  } catch (error) {
    console.error("Error loading leaderboard:", error);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

app.get("/api/leaderboard/daily", async (req, res) => {
  try {
    const now = new Date();

    const chicagoNow = new Date(
      now.toLocaleString("en-US", { timeZone: "America/Chicago" })
    );

    const startOfDay = new Date(chicagoNow);
    startOfDay.setHours(0,0,0,0);

    const endOfDay = new Date(chicagoNow);
    endOfDay.setHours(24,0,0,0);

    const scores = await leaderboardCollection
      .find({
        createdAt: {
          $gte: startOfDay,
          $lt: endOfDay
        }
      })
      .sort({ score: -1, createdAt: 1 })
      .limit(5)
      .toArray();

    res.json(scores);
  } catch (error) {
    console.error("Error loading daily leaderboard:", error);
    res.status(500).json({ error: "Failed to load daily leaderboard" });
  }
});

app.post("/api/leaderboard", async (req, res) => {
  try {
    const { name, score, submitted_at, roster } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Name is required" });
    }

    if (typeof score !== "number" || !Number.isFinite(score)) {
      return res.status(400).json({ error: "Score must be a valid number" });
    }

    const cleanName = name.trim().slice(0, 30);

    if (!cleanName) {
      return res.status(400).json({ error: "Name cannot be empty" });
    }

    const createdAt = new Date();

    const newEntry = {
      name: cleanName,
      score: Number(score.toFixed(2)),
      submitted_at: submitted_at || createdAt.toISOString(),
      roster: Array.isArray(roster) ? roster : [],
      createdAt
    };

    const result = await leaderboardCollection.insertOne(newEntry);

    const overallHigherScores = await leaderboardCollection.countDocuments({
      score: { $gt: newEntry.score }
    });

    const overallRank = overallHigherScores + 1;

    const startOfDay = new Date(createdAt);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(createdAt);
    endOfDay.setHours(24, 0, 0, 0);

    const dailyHigherScores = await leaderboardCollection.countDocuments({
      score: { $gt: newEntry.score },
      createdAt: {
        $gte: startOfDay,
        $lt: endOfDay
      }
    });

    const dailyRank = dailyHigherScores + 1;

    res.status(201).json({
      message: "Score submitted successfully",
      id: result.insertedId,
      overallRank,
      dailyRank
    });
  } catch (error) {
    console.error("Error saving score:", error);
    res.status(500).json({ error: "Failed to save score" });
  }
});

app.delete("/api/leaderboard", async (req, res) => {
  try {
    const result = await leaderboardCollection.deleteMany({});

    res.json({
      message: "Leaderboard cleared",
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error("Error clearing leaderboard:", error);
    res.status(500).json({ error: "Failed to clear leaderboard" });
  }
});

app.get("/api/draft-availability", async (req, res) => {
  try {
    const data = await getAvailability();
    res.json(data);
  } catch (error) {
    console.error("Error loading draft availability:", error);
    res.status(500).json({ error: "Failed to load draft availability" });
  }
});

app.post("/api/draft-availability", async (req, res) => {
  try {
    const { player, password, values, note } = req.body;

    if (!player || typeof player !== "string") {
      return res.status(400).json({ error: "Player is required" });
    }

    if (!checkTeamPassword(player, password)) {
      return res.status(403).json({ error: "Incorrect team or password" });
    }

    if (!Array.isArray(values)) {
      return res.status(400).json({ error: "Values must be an array" });
    }

    await saveAvailability(player, values, typeof note === "string" ? note.slice(0, 500) : "");

    res.json({ message: "Availability saved" });
  } catch (error) {
    console.error("Error saving draft availability:", error);
    res.status(400).json({ error: error.message || "Failed to save draft availability" });
  }
});

app.get("/api/draft-session", async (req, res) => {
  try {
    const session = await getCurrentSession();
    res.json(session || { draftId: null });
  } catch (error) {
    console.error("Error loading draft session:", error);
    res.status(500).json({ error: "Failed to load draft session" });
  }
});

app.post("/api/draft-session", async (req, res) => {
  try {
    const { teamOrder, totalRounds, commissionerSecret } = req.body;
    const result = await createSession({ teamOrder, totalRounds, commissionerSecret });
    res.status(201).json(result);
  } catch (error) {
    console.error("Error creating draft session:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to create draft session" });
  }
});

app.post("/api/team-login", (req, res) => {
  try {
    const { team, password } = req.body;
    const result = verifyTeamLogin({ team, password });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to log in" });
  }
});

app.post("/api/draft-session/pick", async (req, res) => {
  try {
    const { team, password, player } = req.body;
    const session = await submitPick({ team, password, player });
    res.json(session);
  } catch (error) {
    console.error("Error submitting pick:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to submit pick" });
  }
});

app.post("/api/draft-session/reset", async (req, res) => {
  try {
    const { commissionerSecret } = req.body;
    await resetSession({ commissionerSecret });
    res.json({ message: "Draft session reset" });
  } catch (error) {
    console.error("Error resetting draft session:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to reset draft session" });
  }
});

app.get("/api/votes", async (req, res) => {
  try {
    const votes = await getAllVotes();
    res.json(votes);
  } catch (error) {
    console.error("Error loading votes:", error);
    res.status(500).json({ error: "Failed to load votes" });
  }
});

app.post("/api/votes", async (req, res) => {
  try {
    const { ruleId, team, password, optionId } = req.body;
    const result = await submitVote({ ruleId, team, password, optionId });
    res.status(201).json(result);
  } catch (error) {
    console.error("Error submitting vote:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to submit vote" });
  }
});

app.post("/api/votes/reset", async (req, res) => {
  try {
    const { ruleId, commissionerSecret } = req.body;
    const result = await resetVotesForRule({ ruleId, commissionerSecret });
    res.json(result);
  } catch (error) {
    console.error("Error resetting votes:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to reset votes" });
  }
});

app.get("/api/messages", async (req, res) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (error) {
    console.error("Error loading messages:", error);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

app.post("/api/messages", async (req, res) => {
  try {
    const { username, password, content } = req.body;
    const result = await postMessage({ username, password, content });
    res.status(201).json(result);
  } catch (error) {
    console.error("Error posting message:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to post message" });
  }
});

app.get("/api/draft-guide", async (req, res) => {
  try {
    const table = await getDraftGuideTable();
    res.json(table);
  } catch (error) {
    console.error("Error loading draft guide:", error);
    res.status(500).json({ error: "Failed to load draft guide" });
  }
});

app.get("/api/movie-night", async (req, res) => {
  try {
    const state = await getMovieNightState();
    res.json(state);
  } catch (error) {
    console.error("Error loading movie night state:", error);
    res.status(500).json({ error: "Failed to load movie night state" });
  }
});

app.post("/api/movie-night/spin", async (req, res) => {
  try {
    const { team, password } = req.body;
    const result = await spinMovieNight({ team, password });
    res.status(201).json(result);
  } catch (error) {
    console.error("Error spinning movie night:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to spin" });
  }
});

app.post("/api/movie-night/rate", async (req, res) => {
  try {
    const { team, password, number, rating } = req.body;
    const result = await submitRating({ team, password, number, rating });
    res.json(result);
  } catch (error) {
    console.error("Error submitting movie rating:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to submit rating" });
  }
});

app.post("/api/movie-night/reset", async (req, res) => {
  try {
    const { team, password } = req.body;
    const result = await resetCurrentSpin({ team, password });
    res.json(result);
  } catch (error) {
    console.error("Error resetting movie night spin:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to reset spin" });
  }
});

app.post("/api/movie-night/reset-all", async (req, res) => {
  try {
    const { team, password } = req.body;
    const result = await resetAllMovieNights({ team, password });
    res.json(result);
  } catch (error) {
    console.error("Error resetting all movie nights:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to reset everything" });
  }
});

app.get("/api/player-pool", async (req, res) => {
  try {
    const pool = await getRankedPlayerPool();
    res.json(pool);
  } catch (error) {
    console.error("Error loading player pool:", error);
    res.status(500).json({ error: "Failed to load player pool" });
  }
});

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");

    const db = client.db("ffb_game");
    leaderboardCollection = db.collection("leaderboard");
    initDraftCollection(db);
    initVotesCollection(db);
    initMessagesCollection(db);
    initMovieNightCollection(db);

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup error:", error);
    process.exit(1);
  }
}

startServer();