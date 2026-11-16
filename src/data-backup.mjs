// Data backup before an update deploys, and the data-shape check at rollback (docs/live-app-restart-rollback-spec.md, Brief B).
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writesCover } from "./wbs.mjs";

const CONFIRMATION = "data-backup-confirmed.json";
// The controller's reading of "touches data": a feature writes an existing file that names the data folder, or the store module.
// ponytail: a source scan, not an import graph; a module that reaches data/ through another file is caught only by the planner's flag.
const DATA_SOURCE = /\bDATA_DIR\b|\bdata\/|["'`]data["'`]/;
const STORE_MODULE = /(^|\/)(store|db|database|storage)\.[cm]?[jt]s$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

// Features of a plan that touch stored data, merged into the ones already recorded (a recovery plan adds to them).
export async function dataFeatures(store, job, slices) {
  const known = job.dataFeatures ?? [];
  if (!job.followOn || !job.hadData) return known;
  const appDir = store.appDir(job.id);
  const files = (await store.git("ls-files").catch(() => "")).split("\n").filter((file) => file && !file.startsWith(".factory/") && !TEST_PATH.test(file));
  const found = [...known];
  for (const slice of slices) {
    if (found.some((item) => item.id === slice.id)) continue;
    let touches = slice.touchesData === true;
    for (const file of slice.writes && !touches ? files.filter((item) => writesCover(slice.writes, item)) : []) {
      if (STORE_MODULE.test(file) || DATA_SOURCE.test(await readFile(path.join(appDir, file), "utf8").catch(() => ""))) { touches = true; break; }
    }
    if (touches) found.push({ id: slice.id, title: slice.title });
  }
  return found;
}

export async function readConfirmation(jobDir) {
  return JSON.parse(await readFile(path.join(jobDir, CONFIRMATION), "utf8").catch(() => "null"));
}

// A separate file, so the owner's answer never races the running factory's state writes.
export async function writeConfirmation(jobDir, job) {
  const confirmation = { at: new Date().toISOString(), features: (job.dataFeatures ?? []).map((item) => item.id) };
  await writeFile(path.join(jobDir, CONFIRMATION), `${JSON.stringify(confirmation, null, 2)}\n`);
  return confirmation;
}

// Data features the owner has not confirmed a backup for. A first release or an empty data/ never asks (hadData is false).
export function unconfirmed(job, confirmation) {
  if (!job.followOn || !job.hadData) return [];
  return (job.dataFeatures ?? []).filter((item) => !confirmation?.features?.includes(item.id));
}

export function backupStatus(job, confirmation) {
  const features = job.followOn && job.hadData ? job.dataFeatures ?? [] : [];
  return { needed: features.length > 0, features, confirmedAt: features.length && !unconfirmed(job, confirmation).length ? confirmation.at : null };
}

// Ids and dates in names and keys collapse, so new records of the same kind keep the shape.
const collapse = (text) => text
  .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, "<date>")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
  .replace(/\d+/g, "<id>");

function keyPaths(value, at, out) {
  if (Array.isArray(value)) {
    out.add(`${at}: array`);
    for (const item of value) keyPaths(item, `${at}[]`, out);
  } else if (value && typeof value === "object") {
    out.add(`${at}: object`);
    for (const [key, item] of Object.entries(value)) keyPaths(item, `${at}.${collapse(key)}`, out);
  } else out.add(`${at}: ${value === null ? "null" : typeof value}`);
}

async function sqliteShape(file) {
  // node:sqlite is in Node 22.5+; without it a database is compared by its file pattern only.
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite) return [];
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    return db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map((row) => `${row.type} ${row.name}: ${String(row.sql ?? "").replace(/\s+/g, " ")}`);
  } catch { return []; } finally { db?.close(); }
}

const MAX_PARSE = 20 * 1024 * 1024;

// The shape of data/, never its content: file patterns, JSON key paths and types, SQLite schemas. Sorted lines.
export async function dataShape(appDir) {
  const root = path.join(appDir, "data");
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const out = new Set();
  for (const entry of entries.filter((item) => item.isFile())) {
    const file = path.join(entry.parentPath, entry.name);
    const pattern = collapse(path.relative(root, file).split(path.sep).join("/"));
    out.add(`file ${pattern}`);
    if ((await stat(file).catch(() => ({ size: Infinity }))).size > MAX_PARSE) continue;
    if (/\.jsonl?$/i.test(entry.name)) {
      const text = await readFile(file, "utf8").catch(() => "");
      const records = /\.jsonl$/i.test(entry.name) ? text.split("\n").filter((line) => line.trim()) : [text];
      for (const record of records) {
        try { const paths = new Set(); keyPaths(JSON.parse(record), "", paths); for (const item of paths) out.add(`${pattern} ${item}`); } catch { /* unparsed: its pattern stands */ }
      }
    } else if ((await readFile(file).catch(() => Buffer.alloc(0))).subarray(0, 15).toString() === "SQLite format 3") {
      for (const item of await sqliteShape(file)) out.add(`${pattern} ${item}`);
    }
  }
  return [...out].sort();
}

// Material changes between two shapes: added or removed lines (a changed type is one of each).
export function shapeChanges(before = [], after = []) {
  const was = new Set(before), now = new Set(after);
  return [...after.filter((item) => !was.has(item)).map((item) => `added ${item}`), ...before.filter((item) => !now.has(item)).map((item) => `removed ${item}`)];
}
