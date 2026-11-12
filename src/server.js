import "dotenv/config";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { chat, resolvePending } from "./agent.js";
import { withConn, safePath, currentProtocol } from "./ftp.js";
import * as fdroid from "./fdroid.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { ADMIN_PASSWORD, SESSION_SECRET, PORT = 3000 } = process.env;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) throw new Error("ADMIN_PASSWORD (কমপক্ষে ৮ অক্ষর) .env-এ সেট করুন");
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET (কমপক্ষে ৩২ অক্ষর) .env-এ সেট করুন");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: { "script-src": ["'self'"], "style-src": ["'self'"] } } }));
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    name: "sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
);
app.use(express.static(path.join(__dirname, "..", "public")));

// প্রতিটি সেশনের কথোপকথন সার্ভারের মেমরিতে থাকে
const states = new Map();
const stateFor = (req) => {
  if (!states.has(req.session.id)) states.set(req.session.id, { messages: [], pending: null, autoApprove: false, busy: false });
  return states.get(req.session.id);
};

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const auth = (req, res, next) => (req.session.loggedIn ? next() : res.status(401).json({ error: "লগইন করুন" }));
// সাধারণ CSRF সুরক্ষা: শুধু আমাদের নিজস্ব ফ্রন্টএন্ড এই হেডার পাঠায়
const csrf = (req, res, next) => (req.get("X-Requested-With") === "fetch" ? next() : res.status(403).json({ error: "অনুরোধ প্রত্যাখ্যাত" }));
const fail = (res, e) => {
  console.error(e);
  const msg = e instanceof Anthropic.APIError ? `এআই সার্ভিসে সমস্যা (${e.status ?? "network"})` : e.message;
  res.status(500).json({ error: msg });
};

app.post("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), csrf, (req, res) => {
  const ok = crypto.timingSafeEqual(sha(String(req.body?.password ?? "")), sha(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: "ভুল পাসওয়ার্ড" });
  req.session.regenerate((err) => {
    if (err) return fail(res, err);
    req.session.loggedIn = true;
    res.json({ ok: true });
  });
});

app.post("/api/logout", csrf, (req, res) => {
  states.delete(req.session.id);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.loggedIn) return res.json({ loggedIn: false });
  const s = stateFor(req);
  res.json({ loggedIn: true, autoApprove: s.autoApprove, pending: s.pending, protocol: currentProtocol() });
});

// এআই চ্যাট
async function guarded(req, res, fn) {
  const s = stateFor(req);
  if (s.busy) return res.status(409).json({ error: "আগের কাজ এখনো চলছে" });
  s.busy = true;
  try {
    res.json(await fn(s));
  } catch (e) {
    fail(res, e);
  } finally {
    s.busy = false;
  }
}
app.post("/api/chat", auth, csrf, (req, res) => {
  const msg = String(req.body?.message ?? "").trim();
  if (!msg) return res.status(400).json({ error: "বার্তা খালি" });
  guarded(req, res, (s) => chat(s, msg.slice(0, 20000)));
});
app.post("/api/approve", auth, csrf, (req, res) => guarded(req, res, (s) => resolvePending(s, req.body?.decisions || {})));
app.post("/api/reset", auth, csrf, (req, res) => {
  const s = stateFor(req);
  if (s.busy) return res.status(409).json({ error: "কাজ চলছে" });
  Object.assign(s, { messages: [], pending: null });
  res.json({ ok: true });
});
app.post("/api/settings", auth, csrf, (req, res) => {
  stateFor(req).autoApprove = req.body?.autoApprove === true;
  res.json({ autoApprove: stateFor(req).autoApprove });
});

// সরাসরি ফাইল ব্রাউজার
app.get("/api/files", auth, async (req, res) => {
  try {
    res.json(await withConn((c) => c.list(safePath(req.query.path || "/"))));
  } catch (e) {
    fail(res, e);
  }
});
app.get("/api/download", auth, async (req, res) => {
  try {
    const p = safePath(String(req.query.path || ""));
    await withConn(async (c) => {
      const size = await c.size(p); // ফাইল না থাকলে এখানেই ত্রুটি — হেডার পাঠানোর আগে
      res.attachment(path.posix.basename(p));
      if (Number.isFinite(size)) res.setHeader("Content-Length", size);
      await c.getStream(p, res);
    });
    res.end();
  } catch (e) {
    if (!res.headersSent) fail(res, e);
    else res.destroy();
  }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 10 } });
app.post("/api/upload", auth, csrf, upload.array("files"), async (req, res) => {
  try {
    const dir = String(req.body?.path || "/");
    await withConn(async (c) => {
      for (const f of req.files || []) {
        const name = path.posix.basename(Buffer.from(f.originalname, "latin1").toString("utf8"));
        await c.put(safePath(path.posix.join(dir, name)), f.buffer);
      }
    });
    res.json({ ok: true, count: req.files?.length || 0 });
  } catch (e) {
    fail(res, e);
  }
});

app.get("/api/fdroid/status", auth, async (_req, res) => {
  try {
    const c = await fdroid.categories();
    res.json({ ok: true, apps: c.total_apps, index_date: c.index_date });
  } catch (e) {
    fail(res, e);
  }
});

app.listen(PORT, () => {
  console.log(`এআই অ্যাসিস্ট্যান্ট চালু: http://localhost:${PORT}`);
  // F-Droid ইনডেক্স আগেভাগে পেছনে তৈরি করে রাখা, যাতে প্রথম প্রশ্নে দেরি না হয়
  if (fdroid.enabled()) fdroid.ensureIndex().catch((e) => console.error("[fdroid]", e.message));
});
