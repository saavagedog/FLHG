import express from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

const app = express();
app.use(express.json());

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/FISHKY";
const port = Number(process.env.PORT || 3552);

mongoose.connect(mongoUri).catch((err) => {
  console.error("MongoDB connection failed:", err.message);
});

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, required: true },
  passwordHash: { type: String, required: true },
  discordId: { type: String, default: null },
  avatarHash: { type: String, default: null },
  discordLinked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  banned: { type: Boolean, default: false },
});

const User = mongoose.model("User", userSchema);

app.get("/health", (req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1, port });
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() }).lean();

    if (!user) {
      return res.status(401).json({ success: false, message: "Wrong credentials or Discord account not linked." });
    }

    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Wrong credentials or Discord account not linked." });
    }

    if (user.banned) {
      return res.status(403).json({ success: false, message: "This account is banned." });
    }

    if (!user.discordLinked || !user.discordId) {
      return res.status(403).json({ success: false, message: "This account is not linked to Discord." });
    }

    return res.json({
      success: true,
      user: {
        email: user.email,
        username: user.username,
        discordId: user.discordId,
        avatarHash: user.avatarHash || null,
      },
    });
  } catch (err) {
    console.error("Login failed:", err);
    return res.status(500).json({ success: false, message: "Server error during login." });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, username, password, discordId } = req.body || {};

    if (!email || !username || !password) {
      return res.status(400).json({ success: false, message: "Email, username, and password are required." });
    }

    const exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) {
      return res.status(409).json({ success: false, message: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const newUser = await User.create({
      email: String(email).toLowerCase(),
      username: String(username),
      passwordHash,
      discordId: discordId ? String(discordId) : null,
      discordLinked: Boolean(discordId),
      avatarHash: null,
      banned: false,
    });

    return res.status(201).json({
      success: true,
      user: {
        email: newUser.email,
        username: newUser.username,
        discordId: newUser.discordId,
        avatarHash: newUser.avatarHash || null,
      },
    });
  } catch (err) {
    console.error("Register failed:", err);
    return res.status(500).json({ success: false, message: "Server error during registration." });
  }
});

app.post("/api/auth/link-discord", async (req, res) => {
  try {
    const { email, password, discordId, avatarHash } = req.body || {};

    if (!email || !password || !discordId) {
      return res.status(400).json({ success: false, message: "Email, password, and Discord ID are required." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Wrong credentials." });
    }

    user.discordId = String(discordId);
    user.avatarHash = avatarHash ? String(avatarHash) : user.avatarHash;
    user.discordLinked = true;
    await user.save();

    return res.json({ success: true, message: "Discord linked successfully." });
  } catch (err) {
    console.error("Discord link failed:", err);
    return res.status(500).json({ success: false, message: "Server error while linking Discord." });
  }
});

app.listen(port, () => {
  console.log(`Auth server running on http://127.0.0.1:${port}`);
  console.log(`MongoDB URI: ${mongoUri}`);
});
