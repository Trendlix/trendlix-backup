import { timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { MongoClient, EJSON } from "mongodb";
import { Client as FtpClient } from "basic-ftp";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const authorized = (given, secret) => {
  const a = Buffer.from(given);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

const dumpDb = async (uri) => {
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db();
    const dump = {};
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
      dump[name] = await db.collection(name).find().toArray();
    }
    return { dbName: db.databaseName, data: Buffer.from(EJSON.stringify(dump, { relaxed: false })) };
  } finally {
    await client.close();
  }
};

const upload = async (files) => {
  const ftp = new FtpClient(30000);
  try {
    await ftp.access({
      host: process.env.FTP_HOST,
      port: Number(process.env.FTP_PORT) || 21,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASSWORD,
      secure: process.env.FTP_SECURE === "true",
    });
    await ftp.ensureDir(process.env.FTP_DIR || "/");
    for (const { fileName, buffer } of files) {
      await ftp.uploadFrom(Readable.from(buffer), fileName);
    }
  } finally {
    ftp.close();
  }
};

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, message: "CRON_SECRET is not set" }, { status: 503 });
  }
  if (!authorized(request.headers.get("authorization") ?? "", secret)) {
    return Response.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const uris = (process.env.DB_URIS ?? "").split(/[\s,]+/).filter(Boolean);
    if (!uris.length) {
      return Response.json({ ok: false, message: "DB_URIS is not set" }, { status: 503 });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const files = [];
    for (const [i, uri] of uris.entries()) {
      const { dbName, data } = await dumpDb(uri);
      files.push({ fileName: `backup-${i + 1}-${dbName}-${stamp}.json.gz`, buffer: gzipSync(data) });
    }
    await upload(files);
    return Response.json({ ok: true, files: files.map((f) => ({ fileName: f.fileName, bytes: f.buffer.length })) });
  } catch (error) {
    console.error("backup failed", error);
    return Response.json({ ok: false, message: error.message }, { status: 500 });
  }
}
