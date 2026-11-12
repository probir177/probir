// FTP থেকে আনা ফাইলকে এআই-এর পড়ার উপযোগী রূপে রূপান্তর করে:
// Excel → টেবিল (CSV টেক্সট), PDF → document ব্লক, ছবি → image ব্লক, অন্যগুলো → টেক্সট।
import * as XLSX from "xlsx";
import sharp from "sharp";
import path from "node:path/posix";

const EXCEL = new Set([".xlsx", ".xlsm", ".xlsb", ".xls", ".ods"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif"]);
const MB = 1024 * 1024;

export function fileKind(p) {
  const ext = path.extname(p).toLowerCase();
  if (EXCEL.has(ext)) return "excel";
  if (ext === ".pdf") return "pdf";
  if (IMAGE.has(ext)) return "image";
  return "text";
}

/** প্রতিটি ধরনের জন্য সর্বোচ্চ কত বড় ফাইল পড়া হবে */
export const MAX_BYTES = { text: 512 * 1024, excel: 20 * MB, pdf: 25 * MB, image: 20 * MB };

const MAX_EXCEL_CHARS = 200_000; // এর বেশি হলে কেটে ছোট করা হয় এবং এআই-কে জানানো হয়

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
  if (truncated) {
    out += `\n\n[সতর্কতা: ফাইলটি অনেক বড়, তাই প্রথম ${MAX_EXCEL_CHARS} অক্ষর পর্যন্ত দেখানো হয়েছে। বাকি অংশ এখানে নেই — হিসাব করার সময় এটি ব্যবহারকারীকে জানান।]`;
  }
  return out;
}

async function imageBlocks(buf, name) {
  const img = sharp(buf, { failOn: "none", animated: false }).rotate(); // EXIF অনুযায়ী সোজা করা
  const meta = await img.metadata();
  // লম্বা দিক সর্বোচ্চ 1568px — এর বেশি হলে এআই এমনিতেই ছোট করে নেয়, শুধু খরচ বাড়ে
  const data = await img
    .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return [
    { type: "text", text: `ছবি: ${name} (মূল আকার ${meta.width}×${meta.height}px)` },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } },
  ];
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
    case "pdf":
      return pdfBlocks(buf, name);
    case "image":
      return imageBlocks(buf, name);
    default:
      if (looksBinary(buf)) return `এটি বাইনারি ফাইল (${buf.length} বাইট), এই ধরনের ফাইল পড়া সমর্থিত নয়।`;
      return buf.toString("utf8");
  }
}
