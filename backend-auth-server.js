import express from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "70mb" }));

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/FISHKY";
const port = Number(process.env.PORT || 3552);
const reloadBackendUrl = (process.env.RELOAD_BACKEND_URL || "http://127.0.0.1:3551").replace(/\/+$/, "");
const mediaDirectory = path.resolve(process.env.NEWS_MEDIA_DIRECTORY || path.join(process.cwd(), "data", "news-media"));
const adminEmails = new Set((process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
const allowedMediaTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
]);
const maxMediaBytes = 50 * 1024 * 1024;

mongoose.connect(mongoUri).catch((err) => {
  console.error("MongoDB connection failed:", err.message);
});

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, required: true },
  password: { type: mongoose.Schema.Types.Mixed },
  passwordHash: { type: mongoose.Schema.Types.Mixed },
  discordId: { type: String, default: null },
  avatarHash: { type: String, default: null },
  discordLinked: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  role: { type: String, default: "user" },
  createdAt: { type: Date, default: Date.now },
  banned: { type: Boolean, default: false },
});

const User = mongoose.model("User", userSchema);
const newsCollection = () => mongoose.connection.db.collection("launcherNews");

function userIsAdmin(user) {
  return user?.isAdmin === true || user?.admin === true || user?.role === "admin" || adminEmails.has(String(user?.email || "").toLowerCase());
}

app.use("/news-media", express.static(mediaDirectory, { dotfiles: "deny", maxAge: "1h", setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff") }));

app.get("/health", (req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1, port });
});

app.get("/api/launcher/shop", async (_req, res) => {
  try {
    const response = await fetch(`${reloadBackendUrl}/fortnite/api/storefront/v2/catalog`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FishkyLauncher/1.0",
      },
    });
    if (!response.ok) {
      return res.status(502).json({ message: `Reload Backend returned HTTP ${response.status} for its storefront.` });
    }

    const payload = await response.json();
    const storefronts = payload?.storefronts;
    if (!Array.isArray(storefronts)) {
      return res.status(502).json({ message: "Reload Backend returned an invalid storefront catalog." });
    }

    const getOffers = (storefrontName) => {
      const storefront = storefronts.find((entry) => entry.name === storefrontName);
      if (!Array.isArray(storefront?.catalogEntries)) return [];
      return storefront.catalogEntries
        .filter((entry) => Array.isArray(entry.itemGrants) && entry.itemGrants.length > 0)
        .map((entry) => ({
          id: entry.offerId || entry.devName,
          itemGrants: entry.itemGrants.map((grant) => grant.templateId),
          price: entry.prices?.[0]?.finalPrice ?? null,
        }));
    };

    return res.json({
      featured: getOffers("BRWeeklyStorefront"),
      daily: getOffers("BRDailyStorefront"),
    });
  } catch (err) {
    console.error("Reload storefront proxy failed:", err.message);
    return res.status(502).json({ message: "Could not fetch the Reload Backend item shop." });
  }
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

    const storedHash = user.password ?? user.passwordHash;
    if (typeof storedHash !== "string") {
      console.error("Login rejected: user record has no string password hash.");
      return res.status(500).json({ success: false, message: "Account credentials need to be repaired by the server administrator." });
    }

    const valid = await bcrypt.compare(String(password), storedHash);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Wrong credentials or Discord account not linked." });
    }

    if (user.banned) {
      return res.status(403).json({ success: false, message: "This account is banned." });
    }

    if (!user.discordId || user.discordLinked === false) {
      return res.status(403).json({ success: false, message: "This account is not linked to Discord." });
    }

    return res.json({
      success: true,
      user: {
        email: user.email,
        username: user.username,
        discordId: user.discordId,
        avatarHash: user.avatarHash || null,
        isAdmin: userIsAdmin(user),
      },
    });
  } catch (err) {
    console.error("Login failed:", err);
    return res.status(500).json({ success: false, message: "Server error during login." });
  }
});

app.get("/api/news", async (_req, res) => {
  try {
    const items = await newsCollection().find({}, { projection: { _id: 0 } }).sort({ publishedAt: -1 }).limit(50).toArray();
    return res.json({ items });
  } catch (err) {
    console.error("News feed failed:", err);
    return res.status(500).json({ message: "Could not load announcements." });
  }
});

app.post("/api/news", async (req, res) => {
  let savedMediaPath;
  try {
    const { email, password, title, body, mediaData } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Sign in again to publish." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() }).lean();
    const storedHash = user?.password ?? user?.passwordHash;
    if (!user || typeof storedHash !== "string" || !(await bcrypt.compare(String(password), storedHash))) {
      return res.status(401).json({ success: false, message: "Your sign-in could not be verified." });
    }
    if (user.banned) {
      return res.status(403).json({ success: false, message: "This account is banned." });
    }
    if (!userIsAdmin(user)) {
      return res.status(403).json({ success: false, message: "Admin permission is required to publish news." });
    }

    const cleanTitle = String(title || "").trim();
    const cleanBody = String(body || "").trim();
    if (!cleanTitle || cleanTitle.length > 120 || !cleanBody || cleanBody.length > 5000) {
      return res.status(400).json({ success: false, message: "Add a title (up to 120 characters) and message (up to 5000 characters)." });
    }

    let mediaPath = null;
    let mediaType = null;
    if (mediaData) {
      const match = String(mediaData).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
      const extension = match && allowedMediaTypes.get(match[1].toLowerCase());
      if (!match || !extension) {
        return res.status(400).json({ success: false, message: "Choose a JPG, PNG, WebP, GIF, MP4, or WebM file." });
      }

      const mediaBuffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (!mediaBuffer.length || mediaBuffer.length > maxMediaBytes) {
        return res.status(413).json({ success: false, message: "Media must be smaller than 50 MB." });
      }

      const filename = `${randomUUID()}.${extension}`;
      await mkdir(mediaDirectory, { recursive: true });
      savedMediaPath = path.join(mediaDirectory, filename);
      await writeFile(savedMediaPath, mediaBuffer, { flag: "wx" });
      mediaPath = `/news-media/${filename}`;
      mediaType = match[1].toLowerCase();
    }

    const item = {
      id: randomUUID(),
      title: cleanTitle,
      body: cleanBody,
      mediaPath,
      mediaType,
      author: String(user.username || user.email),
      publishedAt: new Date(),
    };
    await newsCollection().insertOne(item);
    return res.status(201).json({ success: true, item });
  } catch (err) {
    if (savedMediaPath) await unlink(savedMediaPath).catch(() => {});
    console.error("News publish failed:", err);
    return res.status(500).json({ success: false, message: "Could not publish this announcement." });
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
