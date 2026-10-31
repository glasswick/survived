// Read-only re-check of what Moltbook does with comments, across many threads. No writes.
// Usage: MOLTBOOK_API_KEY=... node readcheck.mjs [boards...]  -> readcheck.json
// The key is only sent as the Authorization header; nothing is posted.
import fs from "node:fs";
const API = "https://www.moltbook.com/api/v1", key = process.env.MOLTBOOK_API_KEY;
const boards = process.argv.slice(2).length ? process.argv.slice(2) : ["general", "memory", "tooling", "agents", "agentskills", "debugging-wins", "continuity", "coding"];
const get = async (p) => { const r = await fetch(API + p, { headers: { Authorization: `Bearer ${key}` } }); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };
const out = { checked_at: new Date().toISOString(), boards, truncation: [], threads: [] };
for (const b of boards) {
  const list = await get(`/posts?submolt=${b}&sort=new&limit=10`);
  for (const p of list.posts) {
    const full = (await get(`/posts/${p.id}`)).post;
    out.truncation.push({ id: p.id, list_len: (p.content ?? "").length, full_len: (full.content ?? "").length });
    if (!full.comment_count) continue;
    const t = await get(`/posts/${p.id}/comments?sort=new&limit=100`);
    const rows = []; const walk = (cs, d) => { for (const c of cs ?? []) { rows.push({ ...c, d }); walk(c.replies, d + 1); } };
    walk(t.comments, 0);
    const n = (f) => rows.filter(f).length;
    out.threads.push({ id: p.id, board: b, comment_count: full.comment_count, served: rows.length, has_more: t.has_more ?? null,
      verified: n((c) => c.verification_status === "verified" && !c.is_deleted), pending: n((c) => c.verification_status === "pending" && !c.is_deleted),
      failed: n((c) => c.verification_status === "failed" && !c.is_deleted), deleted: n((c) => c.is_deleted),
      deleted_placeholder: n((c) => c.is_deleted && c.content === "Deleted comment"),
      updated_moved: n((c) => c.updated_at !== c.created_at), max_depth: rows.reduce((m, c) => Math.max(m, c.d), -1),
      spam_served: n((c) => c.is_spam === true) });
  }
}
const T = out.threads, sum = (k) => T.reduce((s, t) => s + t[k], 0);
out.summary = {
  posts_read: out.truncation.length,
  list_body_max: Math.max(...out.truncation.map((x) => x.list_len)),
  posts_longer_than_500: out.truncation.filter((x) => x.full_len > 500).length,
  of_those_cut_to_500_in_list: out.truncation.filter((x) => x.full_len > 500 && x.list_len === 500).length,
  threads: T.length, served: sum("served"), verified: sum("verified"), pending: sum("pending"), failed: sum("failed"),
  deleted: sum("deleted"), deleted_placeholder: sum("deleted_placeholder"), updated_at_moved: sum("updated_moved"),
  max_depth_served: Math.max(...T.map((t) => t.max_depth)), spam_flagged_rows_served: sum("spam_served"),
  threads_count_above_served: T.filter((t) => t.comment_count > t.served && !t.has_more).length,
};
fs.writeFileSync("readcheck.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.summary, null, 1));
