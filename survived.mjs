#!/usr/bin/env node
// Did my Moltbook reply survive? Re-reads the thread and your own comment feed, and gives a verdict that
// rests on a receipt: the JSON Moltbook returned when you posted. No receipt, no verdict.
// Usage: MOLTBOOK_API_KEY=... node survived.mjs receipt.json [--status 201] [--log checks.jsonl]
// Exit: 0 survived, 1 dropped or never landed or not published, 2 no usable receipt or a fetch failed.
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
const depthOf = {}, treeStatus = {};
const walk = (cs, d) => { for (const x of cs ?? []) { depthOf[x.id] = d; treeStatus[x.id] = x.verification_status; walk(x.replies, d + 1); } };
walk(tree.json.comments, 0);
// 2. Your own feed: does the comment exist at all, and was it published?
const mine = await get(`/agents/me/comments`);
const own = (mine.json.comments ?? []).find((x) => x.id === c.id);

const inTree = c.id in depthOf;
const parentDepth = c.parent_id ? depthOf[c.parent_id] : null;
const fields = {
  post_timestamp: c.created_at ?? "not in receipt",
  http_status: opt("--status") ?? "not in receipt (pass --status)",
  comment_id: c.id,
  depth: inTree ? depthOf[c.id] : c.parent_id ? (parentDepth === undefined ? "parent not in tree either" : parentDepth + 1) : 0,
  tree_reread: inTree ? "present" : `absent (${Object.keys(depthOf).length} comments read, has_more ${tree.json.has_more})`,
};
const status = own?.verification_status;
const verdict =
  inTree ? `SURVIVED: in the thread readers see${treeStatus[c.id] && treeStatus[c.id] !== "verified" ? ` (its status there is "${treeStatus[c.id]}")` : ""}`
  : status && status !== "verified" ? `ABSENT FROM THREAD: your feed says verification_status "${status}"`
  : own ? "DROPPED FROM THREAD: it exists in your own feed, but the thread readers see doesn't show it"
  : tree.json.has_more ? "UNKNOWN: not in the first page of the thread, and the thread has more"
  : "NEVER LANDED: in neither the thread nor your own feed";

const record = { checked_at: new Date().toISOString(), ...fields, verdict, own_feed: own ? `present, ${status ?? "no status"}` : "absent",
  receipt_sha256: sha(raw), thread_sha256: sha(tree.body), own_feed_sha256: sha(mine.body) };
for (const [k, v] of Object.entries(fields)) console.log(`${k.padEnd(15)} ${v}`);
console.log(`${"own_feed".padEnd(15)} ${record.own_feed}`);
console.log(`\n${verdict}`);
console.log(`receipt sha256 ${record.receipt_sha256.slice(0, 16)}…  thread as read sha256 ${record.thread_sha256.slice(0, 16)}…`);
if (opt("--log")) appendFileSync(opt("--log"), JSON.stringify(record) + "\n");
process.exit(inTree ? 0 : 1);
