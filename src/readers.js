// FTP থেকে আনা ফাইলকে এআই-এর পড়ার উপযোগী রূপে রূপান্তর করে:
// Excel → টেবিল (CSV টেক্সট), PDF → document ব্লক, ছবি → image ব্লক, অন্যগুলো → টেক্সট।
import * as XLSX from "xlsx";
import sharp from "sharp";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import path from "node:path/posix";

const EXCEL = new Set([".xlsx", ".xlsm", ".xlsb", ".xls", ".ods"]);
const WORD = new Set([".docx", ".docm", ".doc"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif"]);
const MB = 1024 * 1024;

export function fileKind(p) {
  const ext = path.extname(p).toLowerCase();
  if (EXCEL.has(ext)) return "excel";
  if (WORD.has(ext)) return "word";
  if (ext === ".pdf") return "pdf";
  if (IMAGE.has(ext)) return "image";
  return "text";
}

/** প্রতিটি ধরনের জন্য সর্বোচ্চ কত বড় ফাইল পড়া হবে */
export const MAX_BYTES = { text: 512 * 1024, excel: 20 * MB, word: 20 * MB, pdf: 25 * MB, image: 20 * MB };

const MAX_EXCEL_CHARS = 200_000; // এর বেশি হলে কেটে ছোট করা হয় এবং এআই-কে জানানো হয়
const MAX_WORD_CHARS = 200_000;
const MAX_WORD_IMAGES = 8; // Word ফাইলের ভেতরের সর্বোচ্চ কয়টি ছবি এআই-কে দেখানো হবে

const truncNote = (limit) =>
  `\n\n[সতর্কতা: ফাইলটি অনেক বড়, তাই প্রথম ${limit} অক্ষর পর্যন্ত দেখানো হয়েছে। বাকি অংশ এখানে নেই — উত্তর দেওয়ার সময় এটি ব্যবহারকারীকে জানান।]`;

/** ছবিকে সোজা করে, লম্বা দিক সর্বোচ্চ 1568px করে JPEG বানায় (এর বেশি হলে শুধু খরচ বাড়ে) */
async function compressImage(buf) {
  const img = sharp(buf, { failOn: "none", animated: false }).rotate();
  const meta = await img.metadata();
  const data = await img
    .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { meta, block: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } } };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m,
  );

/** mammoth-এর পরিচ্ছন্ন HTML থেকে কাঠামো-সহ টেক্সট (শিরোনাম, তালিকা, টেবিল) */
function htmlToText(html) {
  return decode(
    html
      // টেবিলের ঘরের ভেতরের অনুচ্ছেদ একই লাইনে রাখা, যাতে সারি না ভাঙে
      .replace(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g, (_, tag, attrs, inner) =>
        `<${tag}${attrs}>${inner.replace(/<\/p>\s*<p[^>]*>/g, " / ").replace(/<\/?p[^>]*>/g, "")}</${tag}>`,
      )
      .replace(/<h([1-6])[^>]*>/g, (_, n) => "\n\n" + "#".repeat(Number(n)) + " ")
      .replace(/<\/h[1-6]>/g, "\n")
      .replace(/<table[^>]*>/g, "\n\n[টেবিল]\n")
      .replace(/<\/table>/g, "[টেবিল শেষ]\n")
      .replace(/<tr[^>]*>/g, "| ")
      .replace(/<\/t[dh]>/g, " | ")
      .replace(/<\/tr>/g, "\n")
      .replace(/<li[^>]*>/g, "\n- ")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<\/p>/g, "\n")
      .replace(/<(strong|b)>/g, "**")
      .replace(/<\/(strong|b)>/g, "**")
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, " $1 ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function docxBlocks(buf, name) {
  const images = [];
  let imageCount = 0;
  const { value: html } = await mammoth.convertToHtml(
    { buffer: buf },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        imageCount++;
        const label = `[ছবি ${imageCount}]`;
        if (images.length < MAX_WORD_IMAGES) {
          try {
            const raw = Buffer.from(await image.readAsBase64String(), "base64");
            images.push({ label, ...(await compressImage(raw)) });
          } catch {
            // EMF/WMF-এর মতো যেসব ফরম্যাট পড়া যায় না, সেগুলো বাদ
          }
        }
        return { src: "", alt: label };
      }),
    },
  );
  let text = htmlToText(html);
  if (text.length > MAX_WORD_CHARS) text = text.slice(0, MAX_WORD_CHARS) + truncNote(MAX_WORD_CHARS);
  let header = `Word ফাইল: ${name}`;
  if (imageCount) {
    header += ` — ভেতরে ${imageCount}টি ছবি`;
    if (images.length < imageCount) header += `, এর মধ্যে ${images.length}টি নিচে দেখানো হলো (বাকিগুলো সীমার বাইরে বা অসমর্থিত ফরম্যাট)`;
  }
  const blocks = [{ type: "text", text: `${header}\n\n${text || "(ফাইলে কোনো লেখা নেই)"}` }];
  for (const img of images) blocks.push({ type: "text", text: img.label }, img.block);
  return images.length ? blocks : blocks[0].text;
}

async function docToText(buf, name) {
  const doc = await new WordExtractor().extract(buf);
  const parts = [
    ["", doc.getBody()],
    ["হেডার", doc.getHeaders({ includeFooters: false })],
    ["ফুটার", doc.getFooters()],
    ["ফুটনোট", doc.getFootnotes()],
    ["এন্ডনোট", doc.getEndnotes()],
    ["টেক্সট বক্স", doc.getTextboxes({ includeHeadersAndFooters: false })],
  ].filter(([, t]) => t && t.trim());
  let text = parts.map(([label, t]) => (label ? `\n\n=== ${label} ===\n` : "") + t.trim()).join("");
  if (text.length > MAX_WORD_CHARS) text = text.slice(0, MAX_WORD_CHARS) + truncNote(MAX_WORD_CHARS);
  return `Word ফাইল (পুরোনো .doc ফরম্যাট): ${name}\n[দ্রষ্টব্য: এই ফরম্যাট থেকে শুধু লেখা পাওয়া যায়; টেবিলের কাঠামো ও ছবি দেখা যাবে না।]\n\n${text || "(ফাইলে কোনো লেখা নেই)"}`;
}

async function wordContent(buf, name) {
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // .docx আসলে ZIP ফাইল
  const isOle = buf.subarray(0, 4).toString("hex") === "d0cf11e0"; // পুরোনো .doc
  if (isZip) return docxBlocks(buf, name);
  if (isOle) return docToText(buf, name);
  throw new Error("এটি সঠিক Word ফাইল নয় (বা পাসওয়ার্ড-সুরক্ষিত)");
}

function excelToText(buf, name) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, dense: true });
  let out = `Excel ফাইল: ${name} — শিট সংখ্যা ${wb.SheetNames.length}\n`;
  let truncated = false;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
    const rows = range ? range.e.r - range.s.r + 1 : 0;
    const cols = range ? range.e.c - range.s.c + 1 : 0;
    // তারিখগুলো দ্ব্যর্থহীন ISO রূপে (যেমন 2026-11-01) দেখানো হয়, 11/1/26 নয়
    for (const row of ws["!data"] || []) {
      for (const cell of row || []) {
        if (cell?.t === "d" && cell.v instanceof Date && !isNaN(cell.v)) {
          const iso = cell.v.toISOString();
          cell.w = iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
        }
      }
    }
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    out += `\n=== শিট: "${sheetName}" (${rows} সারি × ${cols} কলাম) ===\n`;
    const room = MAX_EXCEL_CHARS - out.length;
    if (csv.length > room) {
      out += csv.slice(0, Math.max(0, room));
      truncated = true;
      break;
    }
    out += csv + "\n";
  }
  if (truncated) out += truncNote(MAX_EXCEL_CHARS);
  return out;
}

async function imageBlocks(buf, name) {
  const { meta, block } = await compressImage(buf);
  return [{ type: "text", text: `ছবি: ${name} (মূল আকার ${meta.width}×${meta.height}px)` }, block];
}

function pdfBlocks(buf, name) {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("এটি সঠিক PDF ফাইল নয়");
  return [
    { type: "text", text: `PDF: ${name} (${buf.length < MB ? `${(buf.length / 1024).toFixed(1)} KB` : `${(buf.length / MB).toFixed(1)} MB`})` },
    { type: "document", title: name, source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
  ];
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** tool_result-এর content হিসেবে ব্যবহারযোগ্য স্ট্রিং বা ব্লকের তালিকা ফেরত দেয় */
export async function toToolContent(buf, filePath) {
  const name = path.basename(filePath);
  switch (fileKind(filePath)) {
    case "excel":
      return excelToText(buf, name);
    case "word":
      return wordContent(buf, name);
    case "pdf":
      return pdfBlocks(buf, name);
    case "image":
      return imageBlocks(buf, name);
    default:
      if (looksBinary(buf)) return `এটি বাইনারি ফাইল (${buf.length} বাইট), এই ধরনের ফাইল পড়া সমর্থিত নয়।`;
      return buf.toString("utf8");
  }
}
