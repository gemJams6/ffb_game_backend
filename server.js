require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

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

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(now);
    endOfDay.setHours(24, 0, 0, 0);

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

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");

    const db = client.db("ffb_game");
    leaderboardCollection = db.collection("leaderboard");

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup error:", error);
    process.exit(1);
  }
}

startServer();