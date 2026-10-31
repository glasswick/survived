#!/usr/bin/env node
// Did my Moltbook reply survive? Re-reads the thread and your own comment feed, and gives a verdict that
// rests on a receipt: the JSON Moltbook returned when you posted. No receipt, no verdict.
// Usage: MOLTBOOK_API_KEY=... node survived.mjs receipt.json [--status 201] [--log checks.jsonl]
// Exit: 0 survived, 1 dropped, deleted, never landed or not published, 2 no usable receipt or a fetch failed.
import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const API = process.env.MOLTBOOK_API ?? "https://www.moltbook.com/api/v1";  // overridable for tests
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith("--") && !["--status", "--log"].includes(args[i - 1]));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const die = (m) => { console.error(m); process.exit(2); };

if (!file) die("usage: node survived.mjs receipt.json [--status 201] [--log checks.jsonl]\nThe receipt is the JSON Moltbook returned when you posted the comment.");
let raw, receipt;
try { raw = readFileSync(file, "utf8"); receipt = JSON.parse(raw); } catch (e) { die(`no verdict: can't read the receipt ${file} (${e.message})`); }
const c = receipt.comment ?? receipt;
if (!c?.id || !c?.post_id) die(`no verdict: ${file} has no comment id and post id, so it isn't a receipt of a posted comment`);
const key = process.env.MOLTBOOK_API_KEY;
if (!key) die("no verdict: set MOLTBOOK_API_KEY (the account that posted, so your own feed can be read)");

const get = async (path) => {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${key}` } });
  const body = await r.text();
  if (!r.ok) die(`no verdict: GET ${path} returned ${r.status}`);
  return { body, json: JSON.parse(body) };
};

// 1. The thread, as a reader gets it.
const tree = await get(`/posts/${c.post_id}/comments?sort=new&limit=100`);
const depthOf = {}, treeStatus = {}, deleted = {};
const walk = (cs, d) => { for (const x of cs ?? []) { depthOf[x.id] = d; treeStatus[x.id] = x.verification_status; deleted[x.id] = x.is_deleted === true; walk(x.replies, d + 1); } };
walk(tree.json.comments, 0);
// 2. Your own feed: does the comment exist at all, and was it published? It's paged, newest first, 20 rows a
// page; reading only the first page called every older comment "never landed" (0.1.3 and earlier). Page until
// it's found, the rows are older than the comment, or 50 pages (1,000 rows).
const MAX_FEED_PAGES = 50;
const feedBodies = [];
let own, cursor, feedEnded = false;
for (let i = 0; i < MAX_FEED_PAGES && !own && !feedEnded; i++) {
  const page = await get(`/agents/me/comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  feedBodies.push(page.body);
  const rows = page.json.comments ?? [];
  own = rows.find((x) => x.id === c.id);
  const oldest = rows.at(-1)?.created_at;
  cursor = page.json.next_cursor;
  feedEnded = !page.json.has_more || !cursor || (oldest && c.created_at && oldest < c.created_at);
}
const feedUnread = !own && !feedEnded;  // ran out of pages before reaching the comment's time

// A deleted comment stays in the tree, but readers see only a "Deleted comment" stub in its place.
const stub = deleted[c.id] === true;
const inTree = c.id in depthOf && !stub;
const parentDepth = c.parent_id ? depthOf[c.parent_id] : null;
const fields = {
  post_timestamp: c.created_at ?? "not in receipt",
  http_status: opt("--status") ?? "not in receipt (pass --status)",
  comment_id: c.id,
  depth: c.id in depthOf ? depthOf[c.id] : c.parent_id ? (parentDepth === undefined ? "parent not in tree either" : parentDepth + 1) : 0,
  tree_reread: stub ? "present, is_deleted (shown as \"Deleted comment\")" : inTree ? "present" : `absent (${Object.keys(depthOf).length} comments read, has_more ${tree.json.has_more})`,
};
const status = own?.verification_status;
const verdict =
  inTree ? `SURVIVED: in the thread readers see${treeStatus[c.id] && treeStatus[c.id] !== "verified" ? ` (its status there is "${treeStatus[c.id]}")` : ""}`
  : stub ? "DELETED: the thread readers see shows only a \"Deleted comment\" stub where it was"
  : status && status !== "verified" ? `ABSENT FROM THREAD: your feed says verification_status "${status}"`
  : own?.is_spam ? "DROPPED FROM THREAD: your feed marks it is_spam: true, and the thread readers see doesn't show it"
  : own ? "DROPPED FROM THREAD: it exists in your own feed, but the thread readers see doesn't show it"
  : tree.json.has_more ? "UNKNOWN: not in the first page of the thread, and the thread has more"
  : feedUnread ? `UNKNOWN: not in the thread, and not in the first ${MAX_FEED_PAGES} pages of your feed, which has more`
  : "NEVER LANDED: in neither the thread nor your own feed";

const record = { checked_at: new Date().toISOString(), ...fields, verdict, own_feed: own ? `present, ${status ?? "no status"}${own.is_spam ? ", is_spam" : ""}` : "absent",
  receipt_sha256: sha(raw), thread_sha256: sha(tree.body), own_feed_sha256: sha(feedBodies.join("\n")), own_feed_pages: feedBodies.length };
for (const [k, v] of Object.entries(fields)) console.log(`${k.padEnd(15)} ${v}`);
console.log(`${"own_feed".padEnd(15)} ${record.own_feed}`);
console.log(`\n${verdict}`);
console.log(`receipt sha256 ${record.receipt_sha256.slice(0, 16)}…  thread as read sha256 ${record.thread_sha256.slice(0, 16)}…`);
if (opt("--log")) appendFileSync(opt("--log"), JSON.stringify(record) + "\n");
process.exit(inTree ? 0 : 1);
