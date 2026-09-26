const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, required: true },
  passwordHash: { type: String, required: true },
  discordId: { type: String, default: null },
  avatarHash: { type: String, default: null },
  discordLinked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() }).lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Wrong credentials or Discord account not linked.",
      });
    }

    const valid = await bcrypt.compare(String(password), user.passwordHash);

    if (!valid) {
      return res.status(401).json({
        success: false,
        message: "Wrong credentials or Discord account not linked.",
      });
    }

    if (!user.discordLinked || !user.discordId) {
      return res.status(403).json({
        success: false,
        message: "This account is not linked to Discord.",
      });
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
    console.error("Login error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error during login.",
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, username, password, discordId } = req.body || {};

    if (!email || !username || !password) {
      return res.status(400).json({
        success: false,
        message: "Email, username and password are required.",
      });
    }

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with that email already exists.",
      });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = await User.create({
      email: String(email).toLowerCase(),
      username: String(username),
      passwordHash,
      discordId: discordId ? String(discordId) : null,
      discordLinked: Boolean(discordId),
      avatarHash: null,
    });

    return res.status(201).json({
      success: true,
      user: {
        email: user.email,
        username: user.username,
        discordId: user.discordId,
        discordLinked: user.discordLinked,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error during registration.",
    });
  }
});

app.post("/api/auth/link-discord", async (req, res) => {
  try {
    const { email, discordId, avatarHash } = req.body || {};

    if (!email || !discordId) {
      return res.status(400).json({
        success: false,
        message: "Email and Discord ID are required.",
      });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    user.discordId = String(discordId);
    user.avatarHash = avatarHash ? String(avatarHash) : user.avatarHash;
    user.discordLinked = true;
    await user.save();

    return res.json({
      success: true,
      message: "Discord account linked successfully.",
    });
  } catch (err) {
    console.error("Link Discord error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while linking Discord.",
    });
  }
});

const PORT = process.env.PORT || 3551;
app.listen(PORT, () => {
  console.log(`Auth API running on http://localhost:${PORT}`);
});
