// Every verdict, against a fake Moltbook on localhost. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "survived-"));
const receipt = (id, parent = "p1") => { const f = join(dir, `${id}.json`);
  writeFileSync(f, JSON.stringify({ success: true, comment: { id, post_id: "post1", parent_id: parent, created_at: "2026-10-31T00:00:00Z" } })); return f; };
const tree = { comments: [{ id: "p1", verification_status: "verified", replies: [
  { id: "ok", verification_status: "verified", replies: [] }, { id: "failedbutshown", verification_status: "failed", replies: [] },
  { id: "deleted", verification_status: "failed", is_deleted: true, content: "Deleted comment", replies: [] }] }], has_more: false };
const feed = { comments: [{ id: "ok", verification_status: "verified" }, { id: "dropped", verification_status: "verified" }, { id: "pending", verification_status: "pending" }, { id: "flagged", verification_status: "verified", is_spam: true }] };
const server = createServer((req, res) => res.end(JSON.stringify(req.url.startsWith("/posts/") ? tree : feed)));
await new Promise((r) => server.listen(0, r));
// Async on purpose: a sync spawn would block this process, and the fake server in it could never answer.
const run = (...a) => new Promise((resolve) => execFile(process.execPath, [new URL("./survived.mjs", import.meta.url).pathname, ...a],
  { env: { ...process.env, MOLTBOOK_API: `http://127.0.0.1:${server.address().port}`, MOLTBOOK_API_KEY: "test" }, timeout: 10_000 },
  (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));

test("in the thread: survived, exit 0", async () => { const r = await run(receipt("ok")); assert.equal(r.status, 0); assert.match(r.stdout, /SURVIVED/); assert.match(r.stdout, /depth\s+1/); });
test("in the thread with a failed status: survived, and says so", async () => { const r = await run(receipt("failedbutshown")); assert.equal(r.status, 0); assert.match(r.stdout, /"failed"/); });
test("deleted, so only a stub in the thread: deleted, exit 1", async () => { const r = await run(receipt("deleted")); assert.equal(r.status, 1); assert.match(r.stdout, /^DELETED/m); assert.match(r.stdout, /depth\s+1/); assert.doesNotMatch(r.stdout, /SURVIVED/); });
test("in my feed, not in the thread: dropped, exit 1", async () => { const r = await run(receipt("dropped")); assert.equal(r.status, 1); assert.match(r.stdout, /DROPPED FROM THREAD/); });
test("in my feed, flagged as spam, not in the thread: dropped, and says why", async () => { const r = await run(receipt("flagged")); assert.equal(r.status, 1); assert.match(r.stdout, /DROPPED FROM THREAD.*is_spam/); assert.match(r.stdout, /own_feed\s+present, verified, is_spam/); });
test("not in the thread, feed says pending: absent, with the status", async () => { const r = await run(receipt("pending")); assert.equal(r.status, 1); assert.match(r.stdout, /ABSENT FROM THREAD.*pending/); });
test("in neither: never landed", async () => { const r = await run(receipt("ghost")); assert.equal(r.status, 1); assert.match(r.stdout, /NEVER LANDED/); });
test("no HTTP status in the receipt: says so, never guesses", async () => { assert.match((await run(receipt("ok"))).stdout, /not in receipt/); assert.match((await run(receipt("ok"), "--status", "201")).stdout, /http_status\s+201/); });
test("not a receipt: no verdict, exit 2", async () => { const f = join(dir, "x.json"); writeFileSync(f, `{"success":true}`); const r = await run(f); assert.equal(r.status, 2); assert.match(r.stderr, /no verdict/); });
test("no receipt file: no verdict, exit 2", async () => { assert.equal((await run(join(dir, "missing.json"))).status, 2); });
test.after(() => server.close());
