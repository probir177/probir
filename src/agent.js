// Claude-চালিত এজেন্ট: FTP টুল ব্যবহার করে নিজে নিজে কাজ সম্পন্ন করে।
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path/posix";
import { withConn, safePath, currentProtocol } from "./ftp.js";
import { fileKind, MAX_BYTES, toToolContent } from "./readers.js";
import * as fdroid from "./fdroid.js";
import fs from "node:fs/promises";

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_STEPS = 25; // এক অনুরোধে সর্বোচ্চ কতবার মডেল-টুল চক্র চলবে

const SYSTEM = `আপনি একজন দক্ষ এআই অ্যাসিস্ট্যান্ট, যিনি একটি মোবাইল/অ্যাড নেটওয়ার্ক স্টোরের FTP সার্ভার পরিচালনা করেন।
টুল ব্যবহার করে আপনি ফোল্ডার দেখতে, ফাইল পড়তে, খুঁজতে, লিখতে, নাম বদলাতে, মুছতে ও ফোল্ডার বানাতে পারেন।
- ব্যবহারকারীর অনুরোধ সম্পূর্ণ করতে যতগুলো ধাপ দরকার, নিজে থেকেই করুন — প্রতিটি ধাপে অনুমতি চাইবেন না।
- অনুমান না করে আগে list_directory / search_files দিয়ে আসল অবস্থা দেখে নিন।
- ফাইল পরিবর্তনের আগে বিদ্যমান কনটেন্ট পড়ে নিন, যাতে কিছু হারিয়ে না যায়। বড় পরিবর্তনের আগে প্রয়োজনে .bak ব্যাকআপ রাখুন।
- Word ফাইল (চুক্তিপত্র, চিঠি, রিপোর্ট) পড়ে সারাংশ, গুরুত্বপূর্ণ তথ্য (তারিখ, টাকার অঙ্ক, শর্ত) বের করে দিন।
- CSV/Excel/লগ/রিপোর্ট ফাইল বিশ্লেষণ করে সংক্ষিপ্ত সারাংশ, হিসাব ও সুপারিশ দিন। Excel-এর প্রতিটি শিট আলাদা করে দেখুন।
- PDF ও ছবি read_file দিয়ে সরাসরি দেখতে পারবেন — রসিদ, ইনভয়েস, বিজ্ঞাপনের ব্যানার, স্ক্রিনশট ইত্যাদির লেখা পড়ে ও বিষয়বস্তু বুঝে উত্তর দিন। ছবিতে যা স্পষ্ট নয়, তা অনুমান না করে জানিয়ে দিন।
F-Droid (ফ্রি ও ওপেন-সোর্স অ্যান্ড্রয়েড অ্যাপ রিপোজিটরি) সংযুক্ত আছে — fdroid_* টুলগুলো দিয়ে:
- গ্রাহকের চাহিদা অনুযায়ী অ্যাপ খুঁজে তুলনা করুন (লাইসেন্স, Android ভার্সন সাপোর্ট, পারমিশন, anti-features, শেষ হালনাগাদ)। anti-features (যেমন Ads, Tracking, NonFreeNet) থাকলে স্পষ্ট জানান।
- fdroid_download_apk দিয়ে APK যাচাই করে দোকানের FTP-তে রাখুন। ফোল্ডার না বললে /apps/<ক্যাটাগরি> ব্যবহার করুন।
- প্রোগ্রামিং/ডেভেলপমেন্টের কাজে fdroid_source_code ও fdroid_build_recipe দিয়ে বাস্তব ওপেন-সোর্স অ্যাপের কোড ও বিল্ড পদ্ধতি দেখে রেফারেন্স নিন। অন্যের কোড ব্যবহার করলে তার লাইসেন্স (GPL ইত্যাদি) মেনে চলার কথা মনে করিয়ে দিন।
- কোনো টুল ব্যর্থ হলে কারণ বুঝে বিকল্প চেষ্টা করুন; না পারলে স্পষ্ট করে জানান।
- ব্যবহারকারী যে ভাষায় লেখেন (সাধারণত বাংলা), সেই ভাষায় সংক্ষেপে উত্তর দিন এবং শেষে কী কী করেছেন তা তালিকা করে দিন।`;

const tool = (name, description, properties, required) => ({
  name,
  description,
  strict: true,
  input_schema: { type: "object", properties, required, additionalProperties: false },
});

const TOOLS = [
  tool("list_directory", "একটি ফোল্ডারের ফাইল ও সাবফোল্ডারের তালিকা (নাম, ধরন, সাইজ, পরিবর্তনের সময়)।", {
    path: { type: "string", description: "ফোল্ডারের পাথ, রুট হলে \"/\"" },
  }, ["path"]),
  tool("read_file", "একটি ফাইল পড়ে। টেক্সট (CSV, TXT, JSON, HTML, লগ; সর্বোচ্চ 512KB) সরাসরি; Excel (.xlsx/.xls/.ods; সর্বোচ্চ 20MB) প্রতিটি শিট CSV টেবিল হিসেবে; Word (.docx/.doc; সর্বোচ্চ 20MB) শিরোনাম, তালিকা ও টেবিলসহ লেখা এবং .docx-এর ভেতরের ছবি; PDF (সর্বোচ্চ 25MB) পুরো ডকুমেন্ট হিসেবে — স্ক্যান করা পাতাও দেখা যায়; ছবি (.jpg/.png/.webp/.gif/.bmp/.tiff; সর্বোচ্চ 20MB) ছবি হিসেবে, যাতে ছবির লেখা ও বিষয়বস্তু দেখা যায়।", {
    path: { type: "string" },
  }, ["path"]),
  tool("search_files", "নামের অংশ দিয়ে ফোল্ডারের ভেতরে (সাবফোল্ডারসহ) ফাইল খোঁজে।", {
    path: { type: "string", description: "কোথা থেকে খোঁজা শুরু" },
    name_contains: { type: "string", description: "নামের যে অংশ খুঁজবেন (ছোট-বড় হাতের অক্ষর নির্বিশেষে); সব চাইলে খালি স্ট্রিং" },
    max_depth: { type: "integer", description: "কত স্তর গভীরে যাবে (১-৬)" },
  }, ["path", "name_contains", "max_depth"]),
  tool("write_file", "একটি টেক্সট ফাইল তৈরি করে বা লেখে। mode=overwrite পুরোটা বদলায়, append শেষে যোগ করে।", {
    path: { type: "string" },
    content: { type: "string" },
    mode: { type: "string", enum: ["overwrite", "append"] },
  }, ["path", "content", "mode"]),
  tool("create_directory", "নতুন ফোল্ডার তৈরি করে (প্রয়োজনে মাঝের ফোল্ডারসহ)।", {
    path: { type: "string" },
  }, ["path"]),
  tool("rename_path", "ফাইল বা ফোল্ডারের নাম বদলায় বা অন্য জায়গায় সরায়।", {
    from: { type: "string" },
    to: { type: "string" },
  }, ["from", "to"]),
  tool("delete_path", "ফাইল বা ফোল্ডার (ভেতরের সবকিছুসহ) মুছে ফেলে। সাবধানে ব্যবহার করুন।", {
    path: { type: "string" },
    is_directory: { type: "boolean" },
  }, ["path", "is_directory"]),

  // ---------- F-Droid ----------
  tool("fdroid_search", "F-Droid-এর প্রায় ৫,০০০ ফ্রি ও ওপেন-সোর্স অ্যান্ড্রয়েড অ্যাপের মধ্যে নাম, বিবরণ, প্যাকেজ নাম বা ক্যাটাগরি দিয়ে খোঁজে। ইংরেজি শব্দে খুঁজলে ভালো ফল পাবেন।", {
    query: { type: "string", description: "খোঁজার শব্দ (ইংরেজি ভালো), সব চাইলে খালি" },
    category: { type: "string", description: "নির্দিষ্ট ক্যাটাগরির নাম (fdroid_categories থেকে), না চাইলে খালি" },
    limit: { type: "integer", description: "কয়টি ফল (১-৫০)" },
  }, ["query", "category", "limit"]),
  tool("fdroid_latest_apps", "F-Droid-এ সম্প্রতি যোগ হওয়া (added) বা হালনাগাদ হওয়া (updated) অ্যাপের তালিকা।", {
    kind: { type: "string", enum: ["added", "updated"] },
    category: { type: "string", description: "ক্যাটাগরি, না চাইলে খালি" },
    limit: { type: "integer", description: "কয়টি (১-৫০)" },
  }, ["kind", "category", "limit"]),
  tool("fdroid_categories", "F-Droid-এর সব ক্যাটাগরি ও প্রতিটিতে অ্যাপের সংখ্যা।", {}, []),
  tool("fdroid_app_details", "একটি F-Droid অ্যাপের পূর্ণ বিবরণ: লাইসেন্স, ডেভেলপার, সোর্স কোড লিংক, সর্বশেষ ভার্সনগুলো (Android SDK, পারমিশন, ABI, anti-features, APK লিংক, SHA-256, কী নতুন)।", {
    package_name: { type: "string", description: "যেমন org.fossify.calendar" },
  }, ["package_name"]),
  tool("fdroid_build_recipe", "F-Droid কীভাবে অ্যাপটি সোর্স থেকে বিল্ড করে তার রেসিপি (fdroiddata মেটাডেটা YAML): রিপো, ব্রাঞ্চ/কমিট, gradle flavor, prebuild ধাপ ইত্যাদি। প্রোগ্রামিং/ডেভেলপমেন্টে রেফারেন্স হিসেবে কাজে লাগে।", {
    package_name: { type: "string" },
  }, ["package_name"]),
  tool("fdroid_source_code", "অ্যাপের ওপেন-সোর্স কোড ব্রাউজ করে (GitHub/GitLab/Codeberg, ডিফল্ট ব্রাঞ্চ)। path ফোল্ডার হলে ফাইলের তালিকা, ফাইল হলে কোড দেখায়। রুটের জন্য খালি স্ট্রিং।", {
    package_name: { type: "string" },
    path: { type: "string", description: "যেমন \"\" বা \"app/build.gradle\" বা \"app/src/main\"" },
  }, ["package_name", "path"]),
  tool("fdroid_download_apk", "F-Droid থেকে একটি অ্যাপের APK নামিয়ে SHA-256 যাচাই করে FTP সার্ভারের ফোল্ডারে রাখে (দোকানের গ্রাহকদের জন্য)।", {
    package_name: { type: "string" },
    version_code: { type: "integer", description: "নির্দিষ্ট versionCode, অথবা সর্বশেষ স্থিতিশীল ভার্সনের জন্য 0" },
    dest_dir: { type: "string", description: "FTP-র কোন ফোল্ডারে রাখবে, যেমন /apps" },
  }, ["package_name", "version_code", "dest_dir"]),
];

/** যেসব টুল সার্ভারে কিছু বদলায় — অটো-মোড বন্ধ থাকলে এগুলোর জন্য অনুমোদন লাগে। */
export const DESTRUCTIVE = new Set(["write_file", "rename_path", "delete_path", "fdroid_download_apk"]);

async function runTool(name, input) {
  switch (name) {
    case "list_directory": {
      const items = await withConn((c) => c.list(safePath(input.path)));
      return JSON.stringify(items.slice(0, 500));
    }
    case "read_file": {
      const target = safePath(input.path);
      const buf = await withConn((c) => c.get(target, MAX_BYTES[fileKind(target)]));
      return toToolContent(buf, target);
    }
    case "search_files": {
      const needle = input.name_contains.toLowerCase();
      const depth = Math.max(1, Math.min(6, input.max_depth || 3));
      const found = [];
      await withConn(async (c) => {
        const walk = async (dir, d) => {
          if (d > depth || found.length >= 300) return;
          let items;
          try {
            items = await c.list(dir);
          } catch {
            return;
          }
          for (const it of items) {
            if (it.name === "." || it.name === "..") continue;
            const full = path.join(dir, it.name);
            if (it.name.toLowerCase().includes(needle)) found.push({ path: full, type: it.type, size: it.size });
            if (it.type === "dir") await walk(full, d + 1);
          }
        };
        await walk(safePath(input.path), 1);
      });
      return JSON.stringify(found);
    }
    case "write_file": {
      const target = safePath(input.path);
      await withConn(async (c) => {
        let data = Buffer.from(input.content, "utf8");
        if (input.mode === "append") {
          let old = Buffer.alloc(0);
          try {
            old = await c.get(target, 20 * 1024 * 1024);
          } catch {}
          data = Buffer.concat([old, data]);
        }
        await c.mkdir(path.dirname(target)); // মাঝের ফোল্ডার না থাকলে তৈরি
        await c.put(target, data);
      });
      return `লেখা হয়েছে: ${input.path}`;
    }
    case "create_directory":
      await withConn((c) => c.mkdir(safePath(input.path)));
      return `ফোল্ডার তৈরি: ${input.path}`;
    case "rename_path":
      await withConn((c) => c.rename(safePath(input.from), safePath(input.to)));
      return `${input.from} → ${input.to}`;
    case "delete_path": {
      const target = safePath(input.path);
      if (target === safePath("/")) throw new Error("রুট ফোল্ডার মোছা যাবে না");
      await withConn((c) => c.remove(target, input.is_directory));
      return `মুছে ফেলা হয়েছে: ${input.path}`;
    }
    case "fdroid_search":
      return JSON.stringify(await fdroid.search(input));
    case "fdroid_latest_apps":
      return JSON.stringify(await fdroid.latest(input));
    case "fdroid_categories":
      return JSON.stringify(await fdroid.categories());
    case "fdroid_app_details":
      return JSON.stringify(await fdroid.details(input.package_name));
    case "fdroid_build_recipe":
      return fdroid.buildRecipe(input.package_name);
    case "fdroid_source_code": {
      const r = await fdroid.sourceCode(input.package_name, input.path);
      return typeof r === "string" ? r : JSON.stringify(r);
    }
    case "fdroid_download_apk": {
      const apk = await fdroid.downloadApk(input.package_name, input.version_code);
      try {
        const target = safePath(path.join(input.dest_dir || "/", apk.fileName));
        await withConn(async (c) => {
          await c.mkdir(path.dirname(target));
          await c.putFile(target, apk.tmpFile);
        });
        return `${apk.name} ${apk.version} → ${target} (${(apk.size / 1048576).toFixed(2)} MB, SHA-256 যাচাই সফল: ${apk.sha256})`;
      } finally {
        await fs.rm(apk.tmpFile, { force: true });
      }
    }
    default:
      throw new Error(`অজানা টুল: ${name}`);
  }
}

async function execute(tu, log) {
  try {
    const content = await runTool(tu.name, tu.input);
    log.push({ tool: tu.name, input: tu.input, ok: true });
    return { type: "tool_result", tool_use_id: tu.id, content };
  } catch (e) {
    log.push({ tool: tu.name, input: tu.input, ok: false, error: e.message });
    return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: e.message };
  }
}

/**
 * এজেন্ট চক্র চালায়। state = { messages, pending, autoApprove } (সেশনে রাখা হয়)।
 * ফেরত: { reply, actions, pending? } — pending থাকলে ব্যবহারকারীর অনুমোদন লাগবে।
 */
async function loop(state, actions) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: `${SYSTEM}\nসংযোগের প্রোটোকল: ${currentProtocol()}`,
      tools: TOOLS,
      messages: state.messages,
    });

    // মডেলের পুরো content (thinking ব্লকসহ) অপরিবর্তিত রেখে ইতিহাসে যোগ করা হয়
    state.messages.push({ role: "assistant", content: response.content });
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason === "refusal") {
      return { reply: text || "দুঃখিত, এই অনুরোধটি সম্পন্ন করা যাচ্ছে না।", actions };
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) return { reply: text, actions };
    if (response.stop_reason === "max_tokens") {
      // কাটা পড়া টুল ইনপুট চালানো হবে না
      state.messages.push({
        role: "user",
        content: toolUses.map((t) => ({ type: "tool_result", tool_use_id: t.id, is_error: true, content: "আউটপুট সীমা পেরিয়ে ইনপুট কাটা পড়েছে; ছোট ছোট ধাপে আবার চেষ্টা করুন।" })),
      });
      continue;
    }

    const needsApproval = !state.autoApprove && toolUses.some((t) => DESTRUCTIVE.has(t.name));
    if (needsApproval) {
      state.pending = toolUses.map((t) => ({ id: t.id, name: t.name, input: t.input, destructive: DESTRUCTIVE.has(t.name) }));
      return { reply: text, actions, pending: state.pending };
    }

    const results = await Promise.all(toolUses.map((t) => execute(t, actions)));
    state.messages.push({ role: "user", content: results });
  }
  return { reply: "অনেকগুলো ধাপ হয়ে গেছে — কাজ চালিয়ে যেতে \"চালিয়ে যাও\" লিখুন।", actions };
}

export async function chat(state, userText) {
  if (state.pending) throw new Error("আগের কাজের অনুমোদন বাকি আছে");
  state.messages.push({ role: "user", content: userText });
  return loop(state, []);
}

/** decisions: { [toolUseId]: true | false } */
export async function resolvePending(state, decisions) {
  if (!state.pending) throw new Error("অনুমোদনের অপেক্ষায় কোনো কাজ নেই");
  const pending = state.pending;
  state.pending = null;
  const actions = [];
  const results = await Promise.all(
    pending.map((p) =>
      !p.destructive || decisions[p.id] === true
        ? execute(p, actions)
        : { type: "tool_result", tool_use_id: p.id, is_error: true, content: "ব্যবহারকারী এই কাজটি অনুমোদন করেননি। অন্য উপায় ভাবুন বা জিজ্ঞেস করুন।" },
    ),
  );
  state.messages.push({ role: "user", content: results });
  return loop(state, actions);
}

export { runTool };
