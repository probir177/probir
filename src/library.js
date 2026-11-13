// দোকানের অ্যাপ লাইব্রেরি (রোডম্যাপ ধাপ ২):
// FTP-তে রাখা APK-গুলো F-Droid ইনডেক্সের সাথে মিলিয়ে দেখা, নতুন ভার্সনে হালনাগাদ করা,
// পুরোনো ভার্সন _old-এ সরিয়ে রাখা, গ্রাহকদের জন্য catalog.html / catalog.json বানানো,
// এবং প্রতিদিন নির্দিষ্ট সময়ে এসব স্বয়ংক্রিয়ভাবে চালানো।
import fs from "node:fs/promises";
import path from "node:path";
import { withConn, safePath } from "./ftp.js";
import * as fdroid from "./fdroid.js";

const P = path.posix;
const ROOT = () => process.env.LIBRARY_DIR || "/apps";
const OLD = "_old";
const KEEP_OLD = () => Math.max(0, Number(process.env.LIBRARY_KEEP_OLD ?? 2));
const STATE_FILE = () => path.join(path.resolve(process.env.DATA_DIR || "data"), "library-state.json");
const MAX_DEPTH = 4;
// F-Droid-এর APK নামের ধরন: <package>_<versionCode>.apk
const APK_NAME = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)_(\d+)\.apk$/;

// minSdk → Android ভার্সনের নাম (গ্রাহকদের বোঝার সুবিধার জন্য)
const ANDROID = { 14: "4.0", 15: "4.0.3", 16: "4.1", 17: "4.2", 18: "4.3", 19: "4.4", 21: "5.0", 22: "5.1", 23: "6", 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16", 37: "17" };
export const androidName = (sdk) => (sdk == null ? null : ANDROID[sdk] ? `Android ${ANDROID[sdk]}+` : `API ${sdk}+`);

let running = null; // একসাথে একটির বেশি আপডেট চলবে না

async function walkApks(c, dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let items;
  try {
    items = await c.list(dir);
  } catch {
    return;
  }
  for (const it of items) {
    if (it.name === "." || it.name === "..") continue;
    const full = P.join(dir, it.name);
    if (it.type === "dir") {
      if (it.name !== OLD) await walkApks(c, full, depth + 1, out);
    } else if (it.name.toLowerCase().endsWith(".apk")) {
      out.push({ path: full, name: it.name, size: it.size });
    }
  }
}

/** FTP লাইব্রেরি স্ক্যান করে প্রতিটি APK-কে F-Droid ইনডেক্সের সাথে মেলায় */
export async function scan(dir = ROOT()) {
  const root = safePath(dir);
  const files = [];
  await withConn((c) => walkApks(c, root, 1, files));
  await fdroid.ensureIndex();

  // একই প্যাকেজের একাধিক APK একই ফোল্ডারে থাকলে সবচেয়ে নতুনটি "চলতি" ধরা হয়
  const groups = new Map();
  const unrecognized = [];
  for (const f of files) {
    const m = f.name.match(APK_NAME);
    if (!m) {
      unrecognized.push({ path: f.path, reason: "নাম F-Droid ধরনের নয় (package_versionCode.apk)" });
      continue;
    }
    const key = `${P.dirname(f.path)}|${m[1]}`;
    const entry = { ...f, package: m[1], code: Number(m[2]) };
    const prev = groups.get(key);
    if (!prev) groups.set(key, { current: entry, duplicates: [] });
    else if (entry.code > prev.current.code) {
      prev.duplicates.push(prev.current);
      prev.current = entry;
    } else prev.duplicates.push(entry);
  }

  const apps = [];
  for (const { current, duplicates } of groups.values()) {
    const info = await fdroid.appInfo(current.package);
    if (!info) {
      unrecognized.push({ path: current.path, reason: "F-Droid-এ এই প্যাকেজ নেই (সরিয়ে ফেলা হয়েছে বা অন্য উৎসের)" });
      continue;
    }
    const latest = info.latest;
    apps.push({
      package: current.package,
      name: info.name,
      summary: info.summary,
      categories: info.categories,
      license: info.license,
      icon: info.icon,
      path: current.path,
      dir: P.dirname(current.path),
      size: current.size,
      installed_code: current.code,
      latest_code: latest?.code ?? null,
      latest_version: latest?.name ?? null,
      latest_size: latest?.size ?? null,
      min_android: androidName(latest?.minSdk),
      anti_features: latest?.antiFeatures || [],
      update_available: !!latest && latest.code > current.code,
      duplicates: duplicates.map((d) => d.path),
    });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return {
    library_dir: root,
    total_apks: files.length,
    apps,
    updates_available: apps.filter((a) => a.update_available).length,
    unrecognized,
  };
}

/** _old ফোল্ডারে প্রতি প্যাকেজের সর্বশেষ KEEP_OLD টি রেখে বাকিগুলো মুছে ফেলে */
async function pruneOld(c, root, log) {
  const oldDir = P.join(root, OLD);
  let items;
  try {
    items = await c.list(oldDir);
  } catch {
    return;
  }
  const byPkg = new Map();
  for (const it of items) {
    const m = it.name.match(APK_NAME);
    if (!m) continue;
    if (!byPkg.has(m[1])) byPkg.set(m[1], []);
    byPkg.get(m[1]).push({ name: it.name, code: Number(m[2]) });
  }
  for (const list of byPkg.values()) {
    list.sort((a, b) => b.code - a.code);
    for (const extra of list.slice(KEEP_OLD())) {
      await c.remove(P.join(oldDir, extra.name), false);
      log.push(`পুরোনো কপি মুছে ফেলা হলো: ${OLD}/${extra.name}`);
    }
  }
}

/**
 * নতুন ভার্সন থাকা অ্যাপগুলো হালনাগাদ করে।
 * packages খালি হলে সবগুলো; dryRun হলে শুধু কী হবে তা জানায়।
 * নিরাপদ ক্রম: নতুন APK নামানো ও যাচাই → FTP-তে তোলা → তারপরই পুরোনোটি _old-এ সরানো।
 */
export async function update({ packages = [], dryRun = false, dir = ROOT(), trigger = "manual" } = {}) {
  if (running) throw new Error("আরেকটি লাইব্রেরি আপডেট এখন চলছে — শেষ হলে আবার চেষ্টা করুন");
  running = (async () => {
    const started = new Date().toISOString();
    const status = await scan(dir);
    const wanted = new Set(packages.filter(Boolean));
    const targets = status.apps.filter((a) => a.update_available && (!wanted.size || wanted.has(a.package)));
    const notFound = [...wanted].filter((p) => !status.apps.some((a) => a.package === p));
    const result = { started, trigger, dry_run: dryRun, checked: status.apps.length, updated: [], failed: [], skipped_not_in_library: notFound, log: [] };

    if (dryRun) {
      result.would_update = targets.map((a) => ({ package: a.package, name: a.name, from: a.installed_code, to: `${a.latest_version} (${a.latest_code})`, dir: a.dir }));
      return result;
    }
    const root = status.library_dir;
    for (const a of targets) {
      let apk;
      try {
        apk = await fdroid.downloadApk(a.package, 0);
        const newPath = P.join(a.dir, apk.fileName);
        await withConn(async (c) => {
          await c.putFile(newPath, apk.tmpFile);
          await c.mkdir(P.join(root, OLD));
          const oldTarget = P.join(root, OLD, P.basename(a.path));
          if (a.path !== newPath) await c.rename(a.path, oldTarget);
          for (const dup of a.duplicates) await c.rename(dup, P.join(root, OLD, P.basename(dup)));
        });
        result.updated.push({ package: a.package, name: a.name, from: a.installed_code, to: apk.version, path: newPath });
      } catch (e) {
        result.failed.push({ package: a.package, name: a.name, error: e.message });
      } finally {
        if (apk) await fs.rm(apk.tmpFile, { force: true });
      }
    }
    try {
      await withConn((c) => pruneOld(c, root, result.log));
    } catch (e) {
      result.log.push(`_old পরিষ্কার করা যায়নি: ${e.message}`);
    }
    if (result.updated.length || trigger === "schedule") {
      try {
        const cat = await buildCatalog({ dir });
        result.log.push(`ক্যাটালগ হালনাগাদ: ${cat.apps} অ্যাপ`);
      } catch (e) {
        result.log.push(`ক্যাটালগ বানানো যায়নি: ${e.message}`);
      }
    }
    result.finished = new Date().toISOString();
    await saveRun(result);
    return result;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const mb = (n) => (n ? `${(n / 1048576).toFixed(1)} MB` : "");
const relUrl = (from, to) => P.relative(from, to).split("/").map(encodeURIComponent).join("/");

function catalogHtml(apps, generated, title) {
  const cats = [...new Set(apps.flatMap((a) => a.categories))].sort();
  const cards = apps
    .map(
      (a) => `<article class="app" data-cat="${esc(a.categories.join("|"))}" data-q="${esc(`${a.name} ${a.summary} ${a.package}`.toLowerCase())}">
  ${a.icon ? `<img src="${esc(a.icon)}" alt="" loading="lazy" width="56" height="56">` : `<div class="noicon"></div>`}
  <div class="body">
    <h2>${esc(a.name)}</h2>
    <p>${esc(a.summary)}</p>
    <div class="meta">ভার্সন ${esc(a.version)} · ${esc(mb(a.size))}${a.min_android ? ` · ${esc(a.min_android)}` : ""} · ${esc(a.license || "")}</div>
    ${a.anti_features.length ? `<div class="warn">সতর্কতা: ${esc(a.anti_features.join(", "))}</div>` : ""}
  </div>
  <a class="dl" href="${esc(a.href)}" download>ডাউনলোড</a>
</article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--text:#1d2230;--muted:#6b7280;--accent:#2563eb;--border:#e3e6eb;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--card:#1b1f29;--text:#e6e8ee;--muted:#9aa3b2;--accent:#60a5fa;--border:#2b3140;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;font-family:"Noto Sans Bengali",system-ui,sans-serif;background:var(--bg);color:var(--text)}
header{padding:20px 16px;max-width:900px;margin:auto}h1{margin:0 0 4px;font-size:1.4rem}.sub{color:var(--muted);font-size:.9rem}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}input,select{font:inherit;color:inherit;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 10px}input{flex:1;min-width:180px}
main{max-width:900px;margin:auto;padding:0 16px 32px;display:grid;gap:10px}
.app{display:flex;gap:12px;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px}
.app img,.noicon{width:56px;height:56px;border-radius:12px;flex:none;background:var(--bg)}.body{flex:1;min-width:0}
h2{font-size:1rem;margin:0}p{margin:2px 0;color:var(--muted);font-size:.9rem}.meta{font-size:.8rem;color:var(--muted)}.warn{font-size:.8rem;color:var(--warn)}
.dl{background:var(--accent);color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;white-space:nowrap}
@media (max-width:520px){.app{flex-wrap:wrap}.dl{width:100%;text-align:center}}
</style></head><body>
<header><h1>${esc(title)}</h1><div class="sub">${apps.length}টি ফ্রি ও ওপেন-সোর্স অ্যাপ · F-Droid থেকে যাচাই করা · হালনাগাদ: ${esc(generated.slice(0, 10))}</div>
<div class="tools"><input id="q" type="search" placeholder="অ্যাপ খুঁজুন…"><select id="cat"><option value="">সব ক্যাটাগরি</option>${cats.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div></header>
<main id="list">
${cards || "<p>এখনো কোনো অ্যাপ নেই।</p>"}
</main>
<script>
const q=document.getElementById("q"),cat=document.getElementById("cat");
function f(){const t=q.value.toLowerCase().trim(),c=cat.value;for(const el of document.querySelectorAll(".app")){const ok=(!t||el.dataset.q.includes(t))&&(!c||el.dataset.cat.split("|").includes(c));el.style.display=ok?"":"none";}}
q.oninput=f;cat.onchange=f;
</script>
</body></html>`;
}

/** লাইব্রেরি থেকে গ্রাহকদের জন্য catalog.json ও catalog.html বানিয়ে লাইব্রেরি ফোল্ডারে রাখে */
export async function buildCatalog({ dir = ROOT(), title = process.env.STORE_NAME ? `${process.env.STORE_NAME} — অ্যাপ ক্যাটালগ` : "অ্যাপ ক্যাটালগ" } = {}) {
  const status = await scan(dir);
  const root = status.library_dir;
  const generated = new Date().toISOString();
  // একই অ্যাপ একাধিক ফোল্ডারে থাকলে গ্রাহকদের তালিকায় একবারই (সবচেয়ে নতুনটি) দেখানো হয়
  const best = new Map();
  for (const a of status.apps) if (!best.has(a.package) || a.installed_code > best.get(a.package).installed_code) best.set(a.package, a);
  const apps = [...best.values()].sort((x, y) => x.name.localeCompare(y.name)).map((a) => ({
    package: a.package,
    name: a.name,
    summary: a.summary,
    categories: a.categories,
    license: a.license,
    icon: a.icon,
    version: a.installed_code === a.latest_code ? a.latest_version : String(a.installed_code),
    version_code: a.installed_code,
    size: a.size,
    min_android: a.min_android,
    anti_features: a.anti_features,
    file: P.relative(root, a.path),
    href: relUrl(root, a.path),
  }));
  const json = JSON.stringify({ generated, source: "F-Droid", apps: apps.map(({ href, ...rest }) => rest) }, null, 2);
  await withConn(async (c) => {
    await c.put(P.join(root, "catalog.json"), Buffer.from(json, "utf8"));
    await c.put(P.join(root, "catalog.html"), Buffer.from(catalogHtml(apps, generated, title), "utf8"));
  });
  return { apps: apps.length, files: [P.join(root, "catalog.html"), P.join(root, "catalog.json")] };
}

// ---------- রান-লগ ----------
async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE(), "utf8"));
  } catch {
    return { runs: [] };
  }
}
async function saveRun(result) {
  const state = await readState();
  state.runs = [
    {
      started: result.started,
      finished: result.finished,
      trigger: result.trigger,
      checked: result.checked,
      updated: result.updated.map((u) => `${u.name} → ${u.to}`),
      failed: result.failed.map((f) => `${f.name}: ${f.error}`),
    },
    ...(state.runs || []),
  ].slice(0, 30);
  await fs.mkdir(path.dirname(STATE_FILE()), { recursive: true });
  await fs.writeFile(STATE_FILE(), JSON.stringify(state, null, 2));
}
export async function history(limit = 10) {
  const s = await readState();
  return (s.runs || []).slice(0, limit);
}

// ---------- স্বয়ংক্রিয় রাতের আপডেট ----------
export const scheduleConfig = () => ({
  enabled: process.env.AUTO_UPDATE === "true",
  time: /^\d{2}:\d{2}$/.test(process.env.AUTO_UPDATE_TIME || "") ? process.env.AUTO_UPDATE_TIME : "03:00",
});

/** প্রতি মিনিটে সময় দেখে, দিনে একবার নির্ধারিত সময়ে আপডেট চালায় (সার্ভারের TZ অনুযায়ী) */
export function startScheduler() {
  const { enabled, time } = scheduleConfig();
  if (!enabled) return null;
  console.log(`[library] স্বয়ংক্রিয় আপডেট চালু: প্রতিদিন ${time}`);
  const tick = async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (hhmm < time || running) return;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const state = await readState();
    if (state.lastScheduledDate === today) return;
    // দুবার না চলার জন্য আগেই তারিখ লিখে রাখা
    state.lastScheduledDate = today;
    await fs.mkdir(path.dirname(STATE_FILE()), { recursive: true });
    await fs.writeFile(STATE_FILE(), JSON.stringify(state, null, 2));
    try {
      const r = await update({ trigger: "schedule" });
      console.log(`[library] রাতের আপডেট: ${r.updated.length} হালনাগাদ, ${r.failed.length} ব্যর্থ`);
    } catch (e) {
      console.error("[library] রাতের আপডেট ব্যর্থ:", e.message);
    }
  };
  const timer = setInterval(() => tick().catch((e) => console.error("[library]", e.message)), 60_000);
  timer.unref();
  return timer;
}
