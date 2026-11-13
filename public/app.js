const $ = (id) => document.getElementById(id);
let cwd = "/";

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "X-Requested-With": "fetch", ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...opts.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/login") showLogin();
  if (!res.ok) throw new Error(data.error || `ত্রুটি ${res.status}`);
  return data;
}
const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body || {}) });

function showLogin() { $("app").classList.add("hidden"); $("login").classList.remove("hidden"); }
async function showApp(me) {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("auto").checked = me.autoApprove;
  $("proto").textContent = me.protocol;
  if (me.pending) renderApproval(me.pending);
  loadFiles();
  loadLibrary();
}

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post("/api/login", { password: $("password").value });
    $("password").value = "";
    showApp(await api("/api/me"));
  } catch (err) { $("loginErr").textContent = err.message; }
};
$("logout").onclick = async () => { await post("/api/logout"); location.reload(); };
$("reset").onclick = async () => { await post("/api/reset"); $("messages").innerHTML = ""; $("approval").classList.add("hidden"); };
$("auto").onchange = async (e) => { await post("/api/settings", { autoApprove: e.target.checked }); };

// ---------- চ্যাট ----------
function addMsg(text, cls, actions) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  if (actions?.length) {
    const a = document.createElement("div");
    a.className = "actions";
    for (const act of actions) {
      const line = document.createElement("div");
      line.className = act.ok ? "" : "bad";
      const i = act.input;
      const target = i.package_name ? `${i.package_name}${i.path ? "/" + i.path : ""}` : i.path || i.from || i.query || i.kind || "";
      line.textContent = `${act.ok ? "✓" : "✗"} ${act.tool} ${target}${act.error ? " — " + act.error : ""}`;
      a.appendChild(line);
    }
    div.appendChild(a);
  }
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}
function busy(on) { $("send").disabled = on; $("send").textContent = on ? "কাজ চলছে…" : "পাঠান"; }

function handleResult(r) {
  if (r.reply || r.actions?.length) addMsg(r.reply || "(কাজ চলছে)", "bot", r.actions);
  if (r.pending) renderApproval(r.pending); else $("approval").classList.add("hidden");
  if (r.actions?.some((a) => a.ok && ["write_file", "rename_path", "delete_path", "create_directory", "fdroid_download_apk", "library_update", "library_build_catalog"].includes(a.tool))) { loadFiles(); loadLibrary(); }
}

$("chatForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("input").value.trim();
  if (!text) return;
  $("input").value = "";
  addMsg(text, "user");
  busy(true);
  try { handleResult(await post("/api/chat", { message: text })); }
  catch (err) { addMsg(err.message, "bot error"); }
  finally { busy(false); }
};
$("input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit(); } };

const LABEL = { write_file: "ফাইল লেখা", rename_path: "নাম বদল/সরানো", delete_path: "মুছে ফেলা", fdroid_download_apk: "F-Droid থেকে APK এনে FTP-তে রাখা", library_update: "লাইব্রেরির অ্যাপ হালনাগাদ", library_build_catalog: "গ্রাহকদের ক্যাটালগ বানানো" };
const describe = (i) =>
  Array.isArray(i.packages) ? (i.packages.length ? i.packages.join(", ") : "নতুন ভার্সন থাকা সব অ্যাপ") :
  !Object.keys(i).length ? "লাইব্রেরি ফোল্ডারে catalog.html ও catalog.json" :
  i.package_name ? `${i.package_name} (${i.version_code ? "ভার্সন " + i.version_code : "সর্বশেষ"}) → ${i.dest_dir}` : i.path || `${i.from} → ${i.to}`;
function renderApproval(pending) {
  const box = $("approval");
  box.innerHTML = "<strong>এই কাজগুলোর জন্য আপনার অনুমতি দরকার:</strong>";
  for (const p of pending.filter((x) => x.destructive)) {
    const row = document.createElement("label");
    row.className = "item";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = true; cb.dataset.id = p.id;
    const info = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = `${LABEL[p.name] || p.name}: ${describe(p.input)}`;
    info.appendChild(title);
    if (p.input.content) {
      const pre = document.createElement("pre");
      pre.textContent = p.input.content.slice(0, 2000);
      info.appendChild(pre);
    }
    row.append(cb, info);
    box.appendChild(row);
  }
  const btns = document.createElement("div");
  btns.className = "btns";
  const ok = Object.assign(document.createElement("button"), { textContent: "নির্বাচিতগুলো অনুমোদন" });
  const no = Object.assign(document.createElement("button"), { textContent: "সব বাতিল", className: "ghost" });
  const send = async (all) => {
    const decisions = {};
    box.querySelectorAll("input[data-id]").forEach((cb) => { decisions[cb.dataset.id] = all === null ? cb.checked : all; });
    box.classList.add("hidden");
    busy(true);
    try { handleResult(await post("/api/approve", { decisions })); }
    catch (err) { addMsg(err.message, "bot error"); }
    finally { busy(false); }
  };
  ok.onclick = () => send(null);
  no.onclick = () => send(false);
  btns.append(ok, no);
  box.appendChild(btns);
  box.classList.remove("hidden");
}

// ---------- ফাইল ব্রাউজার ----------
const fmt = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const join = (a, b) => (a.endsWith("/") ? a + b : `${a}/${b}`);
async function loadFiles() {
  $("cwd").textContent = cwd;
  const list = $("fileList");
  list.innerHTML = "<li>লোড হচ্ছে…</li>";
  try {
    const items = (await api(`/api/files?path=${encodeURIComponent(cwd)}`))
      .filter((i) => i.name !== "." && i.name !== "..")
      .sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
    list.innerHTML = "";
    if (!items.length) list.innerHTML = "<li>(খালি ফোল্ডার)</li>";
    for (const it of items) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${it.type === "dir" ? "📁" : "📄"} ${it.name}`;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = it.type === "dir" ? "" : fmt(it.size);
      li.append(name, size);
      li.onclick = () => {
        if (it.type === "dir") { cwd = join(cwd, it.name); loadFiles(); }
        else location.href = `/api/download?path=${encodeURIComponent(join(cwd, it.name))}`;
      };
      list.appendChild(li);
    }
  } catch (err) { list.innerHTML = ""; const li = document.createElement("li"); li.className = "err"; li.textContent = err.message; list.appendChild(li); }
}
$("refresh").onclick = loadFiles;
$("up").onclick = () => { cwd = cwd.replace(/\/[^/]+\/?$/, "") || "/"; loadFiles(); };
$("uploadInput").onchange = async (e) => {
  const fd = new FormData();
  fd.append("path", cwd);
  for (const f of e.target.files) fd.append("files", f);
  try { await api("/api/upload", { method: "POST", body: fd }); loadFiles(); }
  catch (err) { alert(err.message); }
  e.target.value = "";
};

// ---------- অ্যাপ লাইব্রেরি ----------
async function loadLibrary() {
  const info = $("libInfo");
  info.textContent = "দেখা হচ্ছে…";
  try {
    const s = await api("/api/library/status");
    const auto = s.auto_update.enabled ? `স্বয়ংক্রিয় আপডেট: প্রতিদিন ${s.auto_update.time} (${s.auto_update.zone})` : "স্বয়ংক্রিয় আপডেট: বন্ধ";
    const last = s.last_run ? `শেষ আপডেট: ${s.last_run.started.slice(0, 16).replace("T", " ")} (${s.last_run.updated.length}টি হালনাগাদ)` : "এখনো কোনো আপডেট চালানো হয়নি";
    info.textContent = `${s.library_dir} · ${s.apps}টি অ্যাপ · ${s.updates_available}টির নতুন ভার্সন আছে${s.unrecognized ? ` · ${s.unrecognized}টি চেনা যায়নি` : ""}\n${auto}\n${last}`;
    info.style.whiteSpace = "pre-line";
  } catch (err) { info.textContent = err.message; }
}
const ask = (text) => { $("input").value = text; $("chatForm").requestSubmit(); };
$("libRefresh").onclick = loadLibrary;
$("libCheck").onclick = () => ask("অ্যাপ লাইব্রেরিতে কোন কোন অ্যাপের নতুন ভার্সন এসেছে দেখাও, এবং আপডেট করলে কী হবে তা dry run দিয়ে দেখাও।");
$("libCatalog").onclick = () => ask("লাইব্রেরির সব অ্যাপ নিয়ে গ্রাহকদের জন্য ক্যাটালগ বানাও।");

api("/api/me").then((me) => (me.loggedIn ? showApp(me) : showLogin())).catch(showLogin);
