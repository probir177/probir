// F-Droid সংযোগ: অফিসিয়াল রিপোজিটরির ইনডেক্স (index-v2.json) ডাউনলোড করে
// যাচাই (SHA-256) করে, ছোট আকারে ডিস্কে ক্যাশ রাখে এবং খোঁজা/বিস্তারিত/APK ডাউনলোডের সুবিধা দেয়।
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = (process.env.FDROID_REPO || "https://f-droid.org/repo").replace(/\/+$/, "");
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const CACHE_FILE = path.join(DATA_DIR, "fdroid-cache.json");
const CHECK_EVERY_MS = Number(process.env.FDROID_REFRESH_HOURS || 6) * 3600_000;
const MAX_APK_BYTES = Number(process.env.FDROID_MAX_APK_MB || 300) * 1024 * 1024;
const MAX_VERSIONS = 5; // প্রতি অ্যাপের সর্বশেষ কয়টি ভার্সন রাখা হবে
const UA = { "User-Agent": "ftp-ai-assistant (F-Droid index client)" };
const LOCALES = ["bn", "bn-BD", "bn-IN", "en-US", "en", "en-GB"];

let cache = null; // { timestamp, builtAt, repoName, categories: {name: count}, apps: [...] }
let byId = new Map();
let lastCheck = 0;
let building = null;

export const enabled = () => process.env.FDROID_ENABLED !== "false";

/** একাধিক ভাষার অবজেক্ট থেকে বাংলা → ইংরেজি → প্রথমটি বেছে নেয় */
function loc(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  for (const l of LOCALES) if (obj[l]) return obj[l];
  return Object.values(obj)[0] || "";
}

const stripHtml = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`F-Droid সার্ভার ${res.status} ফেরত দিয়েছে (${url})`);
  return res.json();
}

/** URL থেকে ফাইলে ডাউনলোড, সাথে SHA-256 ও সাইজ হিসাব ও সীমা যাচাই */
async function downloadTo(url, file, maxBytes, timeoutMs) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`ডাউনলোড ব্যর্থ: ${res.status} (${url})`);
  const hash = crypto.createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new Error(`ফাইল ${Math.round(maxBytes / 1048576)}MB সীমার চেয়ে বড়`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(file));
  return { size, sha256: hash.digest("hex") };
}

function compactApp(id, pkg) {
  const m = pkg.metadata || {};
  const versions = Object.values(pkg.versions || {})
    .map((v) => ({
      code: v.manifest?.versionCode,
      name: v.manifest?.versionName,
      added: iso(v.added),
      file: v.file?.name,
      sha256: v.file?.sha256,
      size: v.file?.size,
      src: v.src?.name || null,
      minSdk: v.manifest?.usesSdk?.minSdkVersion ?? null,
      targetSdk: v.manifest?.usesSdk?.targetSdkVersion ?? null,
      abis: v.manifest?.nativecode || [],
      permissions: (v.manifest?.usesPermission || []).map((p) => p.name),
      antiFeatures: Object.keys(v.antiFeatures || {}),
      channels: v.releaseChannels || [],
      whatsNew: stripHtml(loc(v.whatsNew)).slice(0, 1500),
    }))
    .filter((v) => v.code != null && v.file)
    .sort((a, b) => b.code - a.code)
    .slice(0, MAX_VERSIONS);
  const icon = loc(m.icon);
  return {
    id,
    name: loc(m.name) || id,
    summary: stripHtml(loc(m.summary)),
    description: stripHtml(loc(m.description)).slice(0, 6000),
    categories: m.categories || [],
    license: m.license || null,
    sourceCode: m.sourceCode || null,
    webSite: m.webSite || null,
    issueTracker: m.issueTracker || null,
    changelog: m.changelog || null,
    authorName: m.authorName || null,
    added: m.added || null,
    lastUpdated: m.lastUpdated || null,
    icon: icon?.name ? REPO + icon.name : null,
    versions,
  };
}

async function buildFromNetwork(entry) {
  const tmp = path.join(os.tmpdir(), `fdroid-index-${process.pid}-${Date.now()}.json`);
  try {
    console.log(`[fdroid] ইনডেক্স ডাউনলোড হচ্ছে (${Math.round(entry.index.size / 1048576)}MB)…`);
    const { size, sha256 } = await downloadTo(REPO + entry.index.name, tmp, entry.index.size + 1024, 10 * 60_000);
    if (sha256 !== entry.index.sha256 || size !== entry.index.size) throw new Error("F-Droid ইনডেক্সের SHA-256 মেলেনি — ফাইলটি বাতিল করা হলো");
    const raw = JSON.parse(await fsp.readFile(tmp, "utf8"));
    const categories = {};
    const apps = Object.entries(raw.packages).map(([id, pkg]) => {
      const app = compactApp(id, pkg);
      for (const c of app.categories) categories[c] = (categories[c] || 0) + 1;
      return app;
    });
    const built = { timestamp: entry.timestamp, builtAt: Date.now(), repoName: loc(raw.repo?.name), categories, apps };
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(CACHE_FILE + ".tmp", JSON.stringify(built));
    await fsp.rename(CACHE_FILE + ".tmp", CACHE_FILE);
    console.log(`[fdroid] ইনডেক্স তৈরি: ${apps.length}টি অ্যাপ`);
    return built;
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

function use(c) {
  cache = c;
  byId = new Map(c.apps.map((a) => [a.id, a]));
}

/** প্রয়োজন হলে ইনডেক্স লোড/হালনাগাদ করে; ব্যর্থ হলে পুরোনো ক্যাশ দিয়েই কাজ চালায় */
export async function ensureIndex() {
  if (!enabled()) throw new Error("F-Droid সংযোগ বন্ধ আছে (FDROID_ENABLED=false)");
  if (cache && Date.now() - lastCheck < CHECK_EVERY_MS) return cache;
  if (building) return building;
  building = (async () => {
    try {
      if (!cache) {
        try {
          use(JSON.parse(await fsp.readFile(CACHE_FILE, "utf8")));
        } catch {}
      }
      let entry;
      try {
        entry = await getJson(`${REPO}/entry.json`);
      } catch (e) {
        if (cache) return cache; // অফলাইন: পুরোনো ক্যাশ চলবে
        throw e;
      }
      lastCheck = Date.now();
      if (!cache || cache.timestamp !== entry.timestamp) {
        try {
          use(await buildFromNetwork(entry));
        } catch (e) {
          if (!cache) throw e;
          console.error("[fdroid] হালনাগাদ ব্যর্থ, পুরোনো ক্যাশ ব্যবহার হচ্ছে:", e.message);
        }
      }
      return cache;
    } finally {
      building = null;
    }
  })();
  return building;
}

/** স্থিতিশীল (beta নয়) সর্বশেষ ভার্সন */
const latestStable = (app) => app.versions.find((v) => v.channels.length === 0) || app.versions[0] || null;

const brief = (a) => {
  const v = latestStable(a);
  return {
    package_name: a.id,
    name: a.name,
    summary: a.summary,
    categories: a.categories,
    license: a.license,
    last_updated: iso(a.lastUpdated),
    latest_version: v ? `${v.name} (${v.code})` : null,
    min_android_sdk: v?.minSdk ?? null,
  };
};

export async function search({ query, category, limit }) {
  const c = await ensureIndex();
  const q = String(query || "").toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  const cat = String(category || "").toLowerCase();
  const scored = [];
  for (const a of c.apps) {
    if (cat && !a.categories.some((x) => x.toLowerCase() === cat)) continue;
    let score = 0;
    if (!words.length) score = 1;
    const name = a.name.toLowerCase(), id = a.id.toLowerCase(), sum = a.summary.toLowerCase(), desc = a.description.toLowerCase();
    if (q && (id === q || name === q)) score += 100;
    for (const w of words) {
      let s = 0;
      if (name.includes(w)) s += name.split(/\W+/).some((t) => t.startsWith(w)) ? 30 : 15;
      if (id.includes(w)) s += 12;
      if (sum.includes(w)) s += 8;
      if (a.categories.some((x) => x.toLowerCase().includes(w))) s += 6;
      if (desc.includes(w)) s += 2;
      if (!s) { score = 0; break; } // সব শব্দ মিলতে হবে
      score += s;
    }
    if (score > 0) scored.push([score + (a.lastUpdated || 0) / 1e14, a]); // সমান হলে হালনাগাদটি আগে
  }
  scored.sort((x, y) => y[0] - x[0]);
  const n = Math.max(1, Math.min(50, limit || 10));
  return { total_matches: scored.length, results: scored.slice(0, n).map(([, a]) => brief(a)) };
}

export async function latest({ kind, category, limit }) {
  const c = await ensureIndex();
  const key = kind === "added" ? "added" : "lastUpdated";
  const cat = String(category || "").toLowerCase();
  const list = c.apps
    .filter((a) => !cat || a.categories.some((x) => x.toLowerCase() === cat))
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))
    .slice(0, Math.max(1, Math.min(50, limit || 15)));
  return list.map((a) => ({ ...brief(a), added: iso(a.added) }));
}

export async function categories() {
  const c = await ensureIndex();
  return {
    repository: c.repoName,
    total_apps: c.apps.length,
    index_date: iso(c.timestamp),
    categories: Object.entries(c.categories).sort((a, b) => b[1] - a[1]).map(([name, apps]) => ({ name, apps })),
  };
}

function getApp(id) {
  const a = byId.get(String(id || "").trim());
  if (!a) throw new Error(`F-Droid-এ "${id}" প্যাকেজ পাওয়া যায়নি — আগে fdroid_search দিয়ে সঠিক package_name খুঁজুন`);
  return a;
}

export async function details(id) {
  await ensureIndex();
  const a = getApp(id);
  return {
    ...brief(a),
    description: a.description,
    author: a.authorName,
    source_code: a.sourceCode,
    website: a.webSite,
    issue_tracker: a.issueTracker,
    changelog: a.changelog,
    added: iso(a.added),
    icon: a.icon,
    page: `https://f-droid.org/packages/${a.id}/`,
    versions: a.versions.map((v) => ({
      version: v.name,
      version_code: v.code,
      released: v.added,
      apk_size_mb: v.size ? +(v.size / 1048576).toFixed(2) : null,
      min_sdk: v.minSdk,
      target_sdk: v.targetSdk,
      abis: v.abis,
      release_channels: v.channels,
      anti_features: v.antiFeatures,
      permissions: v.permissions,
      apk_url: REPO + v.file,
      source_tarball_url: v.src ? REPO + v.src : null,
      sha256: v.sha256,
      whats_new: v.whatsNew,
    })),
  };
}

/** F-Droid কীভাবে অ্যাপটি সোর্স থেকে বিল্ড করে — fdroiddata-র মেটাডেটা রেসিপি */
export async function buildRecipe(id) {
  if (!/^[A-Za-z0-9_.]+$/.test(String(id))) throw new Error("অবৈধ package_name");
  const url = `https://gitlab.com/fdroid/fdroiddata/-/raw/master/metadata/${id}.yml`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) throw new Error(`fdroiddata-তে ${id}-এর বিল্ড রেসিপি নেই`);
  if (!res.ok) throw new Error(`fdroiddata থেকে আনা যায়নি: ${res.status}`);
  const text = await res.text();
  const cut = 40_000;
  return `উৎস: ${url}\n\n${text.slice(0, cut)}${text.length > cut ? `\n\n[দ্রষ্টব্য: ফাইলটি বড়, প্রথম ${cut} অক্ষর দেখানো হলো]` : ""}`;
}

/** অ্যাপের sourceCode লিংক থেকে কোড-হোস্ট চেনে (শুধু GitHub / GitLab.com / Codeberg) */
function parseRepo(url) {
  const m = String(url || "").match(/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/([^?#]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const parts = m[2].split("/").filter(Boolean);
  const host = m[1].toLowerCase();
  // GitLab-এ সাবগ্রুপ থাকতে পারে; /-/ এর পরের অংশ বাদ
  const dash = parts.indexOf("-");
  const repoParts = host === "gitlab.com" ? (dash >= 0 ? parts.slice(0, dash) : parts) : parts.slice(0, 2);
  if (repoParts.length < 2) return null;
  return { host, repo: repoParts.join("/") };
}

const MAX_SOURCE_CHARS = 100_000;

/**
 * অ্যাপের ওপেন-সোর্স কোড ব্রাউজ করে: path ফোল্ডার হলে তালিকা, ফাইল হলে কনটেন্ট (ডিফল্ট ব্রাঞ্চ)।
 * শুধু F-Droid মেটাডেটায় থাকা রিপোজিটরিতেই যায় — যেকোনো ওয়েবসাইটে নয়।
 */
export async function sourceCode(id, rawPath) {
  await ensureIndex();
  const a = getApp(id);
  const r = parseRepo(a.sourceCode);
  if (!r) throw new Error(`এই অ্যাপের সোর্স (${a.sourceCode || "নেই"}) GitHub/GitLab/Codeberg-এ নয়, তাই সরাসরি ব্রাউজ করা যাচ্ছে না`);
  const p = String(rawPath || "").replace(/^\/+|\/+$/g, "");
  if (p.split("/").includes("..")) throw new Error("অবৈধ পাথ");
  const enc = p.split("/").map(encodeURIComponent).join("/");
  const headers = { ...UA, Accept: "application/json" };
  if (r.host === "github.com" && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const get = async (url, asText) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) throw new Error(`${r.host} অনুরোধের সীমা পেরিয়েছে — কিছুক্ষণ পর চেষ্টা করুন${r.host === "github.com" ? " (বা .env-এ GITHUB_TOKEN দিন)" : ""}`);
    if (!res.ok) throw new Error(`${r.host} ${res.status} ফেরত দিয়েছে`);
    return asText ? Buffer.from(await res.arrayBuffer()) : res.json();
  };
  const asDir = (items) => ({
    repository: a.sourceCode,
    path: p || "/",
    entries: items.map((i) => ({ name: i.name, type: i.type === "dir" || i.type === "tree" ? "dir" : "file", size: i.size ?? null })),
  });
  const asFile = (buf) => {
    if (buf.subarray(0, 8000).includes(0)) return `${p}: বাইনারি ফাইল (${buf.length} বাইট), দেখানো যাচ্ছে না।`;
    const text = buf.toString("utf8");
    return `রিপোজিটরি: ${a.sourceCode}\nফাইল: ${p}\n\n${text.slice(0, MAX_SOURCE_CHARS)}${text.length > MAX_SOURCE_CHARS ? `\n\n[দ্রষ্টব্য: ফাইলটি বড়, প্রথম ${MAX_SOURCE_CHARS} অক্ষর দেখানো হলো]` : ""}`;
  };

  if (r.host === "gitlab.com") {
    const proj = encodeURIComponent(r.repo);
    const tree = await get(`https://gitlab.com/api/v4/projects/${proj}/repository/tree?per_page=100&path=${encodeURIComponent(p)}`);
    if (tree && tree.length) return asDir(tree);
    if (!p) throw new Error("রিপোজিটরি খালি বা ব্যক্তিগত");
    const buf = await get(`https://gitlab.com/api/v4/projects/${proj}/repository/files/${encodeURIComponent(p)}/raw?ref=HEAD`, true);
    if (!buf) throw new Error(`"${p}" পাওয়া যায়নি`);
    return asFile(buf);
  }
  // GitHub ও Codeberg (Forgejo)-এর contents API প্রায় একই রকম
  const api = r.host === "github.com" ? `https://api.github.com/repos/${r.repo}/contents/${enc}` : `https://codeberg.org/api/v1/repos/${r.repo}/contents/${enc}`;
  const data = await get(api);
  if (!data) throw new Error(`"${p || "/"}" পাওয়া যায়নি`);
  if (Array.isArray(data)) return asDir(data);
  if (data.content && data.encoding === "base64") return asFile(Buffer.from(data.content, "base64"));
  if (data.download_url) {
    const buf = await get(data.download_url, true);
    if (buf) return asFile(buf);
  }
  throw new Error(`"${p}" পড়া যায়নি`);
}

/**
 * APK অস্থায়ী ফাইলে নামিয়ে ইনডেক্সের SHA-256-এর সাথে মিলিয়ে দেখে।
 * version_code 0 হলে সর্বশেষ স্থিতিশীল ভার্সন। ফেরত: { tmpFile, fileName, size, sha256, version }
 */
export async function downloadApk(id, versionCode) {
  await ensureIndex();
  const a = getApp(id);
  const v = versionCode ? a.versions.find((x) => x.code === versionCode) : latestStable(a);
  if (!v) throw new Error(`${id}-এর ভার্সন ${versionCode} ইনডেক্সে নেই (শুধু সর্বশেষ ${MAX_VERSIONS}টি রাখা হয়)`);
  if (v.size > MAX_APK_BYTES) throw new Error(`APK ${Math.round(v.size / 1048576)}MB — সীমা ${MAX_APK_BYTES / 1048576}MB`);
  const fileName = path.basename(v.file);
  const tmpFile = path.join(os.tmpdir(), `fdroid-${crypto.randomUUID()}-${fileName}`);
  try {
    const { size, sha256 } = await downloadTo(REPO + v.file, tmpFile, MAX_APK_BYTES, 15 * 60_000);
    if (sha256 !== v.sha256) throw new Error("APK-এর SHA-256 F-Droid ইনডেক্সের সাথে মেলেনি — ফাইলটি বাতিল করা হলো");
    return { tmpFile, fileName, size, sha256, version: `${v.name} (${v.code})`, name: a.name };
  } catch (e) {
    await fsp.rm(tmpFile, { force: true });
    throw e;
  }
}
