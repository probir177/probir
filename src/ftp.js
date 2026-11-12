// FTP / FTPS / SFTP-এর জন্য একটি সাধারণ ইন্টারফেস।
// প্রতিটি অপারেশন নতুন সংযোগ খুলে কাজ শেষে বন্ধ করে — সহজ ও নির্ভরযোগ্য।
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
import { PassThrough, Writable, Readable } from "node:stream";
import path from "node:path/posix";

const cfg = () => ({
  protocol: (process.env.FTP_PROTOCOL || "auto").toLowerCase(), // auto | ftp | ftps | sftp
  host: process.env.FTP_HOST,
  port: process.env.FTP_PORT ? Number(process.env.FTP_PORT) : undefined,
  user: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD,
  root: process.env.FTP_ROOT || "/",
  allowInsecure: process.env.FTP_ALLOW_INSECURE === "true",
});

let detectedProtocol = null; // "auto" মোডে প্রথম সফল প্রোটোকল মনে রাখা হয়

/** মডেল বা ব্যবহারকারীর দেওয়া পাথকে FTP_ROOT-এর ভেতরে আটকে রাখে। */
export function safePath(p = ".") {
  const root = path.normalize(cfg().root.replace(/\\/g, "/"));
  const target = path.normalize(path.join(root, String(p).replace(/\\/g, "/")));
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith("../")) throw new Error("পাথ অনুমোদিত ফোল্ডারের বাইরে যাচ্ছে");
  return target;
}

async function openFtp(secure) {
  const c = cfg();
  const client = new FtpClient(30_000);
  await client.access({
    host: c.host,
    port: c.port || 21,
    user: c.user,
    password: c.password,
    secure,
    secureOptions: { rejectUnauthorized: !c.allowInsecure },
  });
  return {
    async list(dir) {
      const items = await client.list(dir);
      return items.map((i) => ({
        name: i.name,
        type: i.isDirectory ? "dir" : i.isSymbolicLink ? "link" : "file",
        size: i.size,
        modified: i.modifiedAt ? i.modifiedAt.toISOString() : i.rawModifiedAt || null,
      }));
    },
    async get(file, maxBytes) {
      const chunks = [];
      let total = 0;
      const sink = new Writable({
        write(chunk, _e, cb) {
          total += chunk.length;
          if (maxBytes && total > maxBytes) return cb(new Error(`ফাইল ${maxBytes} বাইটের চেয়ে বড়`));
          chunks.push(chunk);
          cb();
        },
      });
      await client.downloadTo(sink, file);
      return Buffer.concat(chunks);
    },
    async getStream(file, out) {
      await client.downloadTo(out, file);
    },
    async put(file, buf) {
      await client.uploadFrom(Readable.from(buf), file);
    },
    async mkdir(dir) {
      await client.ensureDir(dir);
    },
    async rename(from, to) {
      await client.rename(from, to);
    },
    async remove(target, isDir) {
      if (isDir) await client.removeDir(target);
      else await client.remove(target);
    },
    async size(file) {
      return client.size(file);
    },
    close: () => client.close(),
  };
}

async function openSftp() {
  const c = cfg();
  const sftp = new SftpClient();
  await sftp.connect({
    host: c.host,
    port: c.port || 22,
    username: c.user,
    password: c.password,
    readyTimeout: 30_000,
  });
  return {
    async list(dir) {
      const items = await sftp.list(dir);
      return items.map((i) => ({
        name: i.name,
        type: i.type === "d" ? "dir" : i.type === "l" ? "link" : "file",
        size: i.size,
        modified: new Date(i.modifyTime).toISOString(),
      }));
    },
    async get(file, maxBytes) {
      if (maxBytes) {
        const st = await sftp.stat(file);
        if (st.size > maxBytes) throw new Error(`ফাইল ${maxBytes} বাইটের চেয়ে বড়`);
      }
      return sftp.get(file);
    },
    async getStream(file, out) {
      await sftp.get(file, out);
    },
    async put(file, buf) {
      await sftp.put(buf, file);
    },
    async mkdir(dir) {
      await sftp.mkdir(dir, true);
    },
    async rename(from, to) {
      await sftp.rename(from, to);
    },
    async remove(target, isDir) {
      if (isDir) await sftp.rmdir(target, true);
      else await sftp.delete(target);
    },
    async size(file) {
      return (await sftp.stat(file)).size;
    },
    close: () => sftp.end(),
  };
}

async function open() {
  const c = cfg();
  if (!c.host) throw new Error("FTP_HOST সেট করা নেই (.env ফাইল দেখুন)");
  const proto = c.protocol === "auto" ? detectedProtocol : c.protocol;
  if (proto === "sftp") return openSftp();
  if (proto === "ftps") return openFtp(true);
  if (proto === "ftp") return openFtp(false);

  // auto: পোর্ট 22 হলে SFTP, নাহলে FTPS → সাধারণ FTP → SFTP ক্রমে চেষ্টা
  const order = c.port === 22 ? ["sftp", "ftps", "ftp"] : ["ftps", "ftp", "sftp"];
  const errors = [];
  for (const p of order) {
    try {
      const conn = p === "sftp" ? await openSftp() : await openFtp(p === "ftps");
      detectedProtocol = p;
      console.log(`[ftp] স্বয়ংক্রিয়ভাবে প্রোটোকল নির্ধারিত: ${p}`);
      return conn;
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error("সার্ভারে সংযোগ হয়নি — " + errors.join(" | "));
}

/** একটি সংযোগ খুলে কাজ করে বন্ধ করে। */
export async function withConn(fn) {
  const conn = await open();
  try {
    return await fn(conn);
  } finally {
    try {
      await conn.close();
    } catch {}
  }
}

export const currentProtocol = () => (cfg().protocol === "auto" ? detectedProtocol || "auto" : cfg().protocol);
export { PassThrough };
