import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import {
  upsertMember,
  allMembers,
  deleteMember,
  getMember,
  follow,
  unfollow,
  isFollowing,
  followers,
  following,
  counts,
  getCampaign,
  saveCampaignMessage,
  recordSent,
  getNextBatch,
  getCampaignStats,
  addContacts,
  allEmails,
} from "./db.js";
import { sendEmail, hasSenders } from "./mailer.js";

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  OAUTH_CALLBACK_URL = "http://localhost:3000/auth/github/callback",
  SESSION_SECRET = "dev-secret",
  ADMIN_TOKEN,
  PORT = 3000,
} = process.env;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.error("Missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const app = express();
app.use(cookieParser(SESSION_SECRET));
app.use(express.urlencoded({ extended: false }));

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// The currently logged-in member (from the signed `uid` cookie), or null.
function currentUser(req) {
  const id = Number(req.signedCookies.uid);
  return id ? getMember(id) : null;
}

const page = (title, body) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1rem;line-height:1.5}
  a{color:#0969da} nav{margin-bottom:1.5rem;font-size:.9rem}
  .card{display:flex;align-items:center;gap:.75rem;border:1px solid #d0d7de;border-radius:.6rem;padding:.7rem 1rem;margin:.5rem 0}
  .card img{width:40px;height:40px;border-radius:50%}
  .grow{flex:1} .muted{color:#57606a;font-size:.85rem}
  .btn{border:1px solid #d0d7de;background:#f6f8fa;padding:.35rem .8rem;border-radius:.5rem;cursor:pointer;font-size:.85rem}
  .btn.primary{background:#1f2328;color:#fff;border-color:#1f2328}
  form{display:inline}
</style>
${body}`;

function memberActionButton(m, viewer) {
  if (!viewer || viewer.github_id === m.github_id) return "";
  const already = isFollowing(viewer.github_id, m.github_id);
  return `<form method="post" action="/${already ? "unfollow" : "follow"}/${m.github_id}">
    <button class="btn ${already ? "" : "primary"}">${already ? "Unfollow" : "Follow"}</button>
  </form>`;
}

function memberCard(m, viewer) {
  const c = counts(m.github_id);
  return `<div class="card">
    <img src="${esc(m.avatar_url)}" alt="">
    <div class="grow">
      <a href="/u/${m.github_id}"><strong>@${esc(m.login)}</strong></a>
      ${m.name ? `<span class="muted"> · ${esc(m.name)}</span>` : ""}
      <div class="muted">${c.followers} followers · ${c.following} following</div>
    </div>
    ${memberActionButton(m, viewer)}
  </div>`;
}

function navBar(viewer) {
  return `<nav>
    <a href="/directory">Directory</a>
    ${viewer ? ` · <a href="/u/${viewer.github_id}">@${esc(viewer.login)}</a> · <a href="/logout">Log out</a>` : ` · <a href="/auth/github">Sign in</a>`}
  </nav>`;
}

// --- Landing page: the consent point ---------------------------------------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Community sign-up</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
  .btn{display:inline-block;background:#1f2328;color:#fff;padding:.7rem 1.1rem;border-radius:.5rem;text-decoration:none;font-weight:600}
  .notice{background:#f6f8fa;border:1px solid #d0d7de;border-radius:.5rem;padding:1rem;font-size:.9rem;color:#57606a}
</style>
<h1>Join the community directory</h1>
<p>Sign in with GitHub to add yourself. We'll ask GitHub for your email, and
   <strong>you choose whether to approve it</strong>.</p>
<p><a class="btn" href="/auth/github">Sign in with GitHub</a></p>
<div class="notice">
  <strong>What we store:</strong> your GitHub username, name, avatar, and the email
  you consent to share. You can also add a LinkedIn link or phone number on your
  profile page — both optional. <strong>Why:</strong> so you appear in the member directory
  and other members can connect with you.
  You can remove your data anytime from your profile page. We never sell or share it.
</div>`);
});

// --- Step 1: redirect to GitHub with a signed anti-CSRF state ---------------
app.get("/auth/github", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    signed: true,
    maxAge: 10 * 60 * 1000,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", OAUTH_CALLBACK_URL);
  url.searchParams.set("scope", "read:user user:email"); // email requires explicit consent
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  res.redirect(url.toString());
});

// --- Step 2: GitHub redirects back; exchange code, read consented data ------
app.get("/auth/github/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.signedCookies.oauth_state) {
    return res.status(400).send("Invalid OAuth state. <a href='/'>Try again</a>.");
  }
  res.clearCookie("oauth_state");

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: OAUTH_CALLBACK_URL,
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error("No access token: " + JSON.stringify(token));

    const gh = (path) =>
      fetch("https://api.github.com" + path, {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "realman-bot",
        },
      }).then((r) => r.json());

    const user = await gh("/user");

    // Prefer the primary verified email the user consented to share.
    let email = user.email || null;
    if (!email) {
      const emails = await gh("/user/emails");
      if (Array.isArray(emails)) {
        const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
        email = primary ? primary.email : null;
      }
    }

    upsertMember({
      github_id: user.id,
      login: user.login,
      name: user.name,
      email,
      avatar_url: user.avatar_url,
    });

    // Log the member in so they can follow others.
    res.cookie("uid", String(user.id), {
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.type("html").send(`<!doctype html>
<meta charset="utf-8"><title>Thanks</title>
<style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
<h1>You're in, @${esc(user.login)} 👋</h1>
<p>Email on file: <strong>${esc(email || "(none shared)")}</strong></p>
<p>Changed your mind? <a href="/me/${esc(user.id)}/delete">Remove my data</a>.</p>
<p>Want other members to be able to connect with you? <a href="/u/${esc(user.id)}">Add your LinkedIn or phone number</a> (optional).</p>
<p><a href="/directory">Browse the member directory →</a></p>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Sign-in failed. <a href='/'>Try again</a>.");
  }
});

// --- Directory: browse members and follow them ------------------------------
app.get("/directory", (req, res) => {
  const viewer = currentUser(req);
  const cards = allMembers().map((m) => memberCard(m, viewer)).join("");
  res.type("html").send(
    page(
      "Member directory",
      navBar(viewer) +
        `<h1>Member directory</h1>` +
        (viewer ? "" : `<p class="muted">Sign in to follow members.</p>`) +
        (cards || `<p class="muted">No members yet.</p>`)
    )
  );
});

// --- A member's profile: their info + followers / following -----------------
app.get("/u/:id", (req, res) => {
  const viewer = currentUser(req);
  const member = getMember(Number(req.params.id));
  if (!member) return res.status(404).send(page("Not found", "<p>No such member. <a href='/directory'>Directory</a></p>"));

  const c = counts(member.github_id);
  const isSelf = viewer && viewer.github_id === member.github_id;
  const followerCards = followers(member.github_id).map((m) => memberCard(m, viewer)).join("");
  const followingCards = following(member.github_id).map((m) => memberCard(m, viewer)).join("");

  res.type("html").send(
    page(
      `@${member.login}`,
      navBar(viewer) +
        `<div class="card">
          <img src="${esc(member.avatar_url)}" alt="">
          <div class="grow">
            <strong>@${esc(member.login)}</strong>
            ${member.name ? `<span class="muted"> · ${esc(member.name)}</span>` : ""}
            <div class="muted">${c.followers} followers · ${c.following} following</div>
            ${isSelf && member.email ? `<div class="muted">${esc(member.email)}</div>` : ""}
          </div>
          ${memberActionButton(member, viewer)}
        </div>
        ${!isSelf && viewer && member.linkedin_url ? `<p><a href="${esc(member.linkedin_url)}" rel="noopener noreferrer" target="_blank">Connect on LinkedIn →</a></p>` : ""}
        ${isSelf ? `<h2>How to reach me (optional)</h2>
        ${req.query.saved ? `<p class="muted">✓ Saved.</p>` : ""}
        ${req.query.error ? `<p class="muted">⚠️ ${req.query.error === "linkedin" ? "That doesn't look like a linkedin.com/in/… profile link." : "That doesn't look like a phone number."}</p>` : ""}
        <form method="post" action="/me/contact" style="display:block">
          <p><label>LinkedIn profile<br>
            <input name="linkedin_url" value="${esc(member.linkedin_url)}" placeholder="https://www.linkedin.com/in/you" style="width:100%"></label><br>
            <span class="muted">Shown to signed-in members on your profile.</span></p>
          <p><label>Phone<br>
            <input name="phone" value="${esc(member.phone)}" placeholder="+1 555 123 4567" style="width:100%"></label><br>
            <span class="muted">Only the community organizer sees this. Never shown in the directory.</span></p>
          <button class="btn primary">Save</button>
          <span class="muted">Leave a field blank to remove it.</span>
        </form>
        <p class="muted"><a href="/me/${member.github_id}/delete">Remove my data</a></p>` : ""}
        <h2>Followers</h2>${followerCards || `<p class="muted">None yet.</p>`}
        <h2>Following</h2>${followingCards || `<p class="muted">None yet.</p>`}`
    )
  );
});

// --- Follow / unfollow (must be logged in) ----------------------------------
function requireLogin(req, res, next) {
  const viewer = currentUser(req);
  if (!viewer) return res.status(401).send(page("Sign in", "<p>Please <a href='/auth/github'>sign in</a> first.</p>"));
  req.viewer = viewer;
  next();
}

app.post("/follow/:id", requireLogin, (req, res) => {
  follow(req.viewer.github_id, Number(req.params.id));
  res.redirect(req.get("referer") || "/directory");
});

app.post("/unfollow/:id", requireLogin, (req, res) => {
  unfollow(req.viewer.github_id, Number(req.params.id));
  res.redirect(req.get("referer") || "/directory");
});

// --- Optional contact details: only ever entered by the member themselves ---
function parseLinkedIn(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
    const host = url.hostname.toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return undefined;
    if (!/^\/in\/[^/]+\/?$/.test(url.pathname)) return undefined;
    return "https://www.linkedin.com" + url.pathname.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function parsePhone(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (!/^\+?[\d\s().-]+$/.test(s) || digits.length < 7 || digits.length > 15) return undefined;
  return s;
}

app.post("/me/contact", requireLogin, (req, res) => {
  const id = req.viewer.github_id;
  const linkedin_url = parseLinkedIn(req.body.linkedin_url);
  const phone = parsePhone(req.body.phone);
  if (linkedin_url === undefined) return res.redirect(`/u/${id}?error=linkedin`);
  if (phone === undefined) return res.redirect(`/u/${id}?error=phone`);
  upsertMember({ github_id: id, linkedin_url, phone });
  res.redirect(`/u/${id}?saved=1`);
});

app.get("/logout", (req, res) => {
  res.clearCookie("uid");
  res.redirect("/");
});

// --- Self-service data deletion (privacy requirement) -----------------------
app.get("/me/:githubId/delete", (req, res) => {
  const removed = deleteMember(Number(req.params.githubId));
  res.type("html").send(
    `<p>${removed ? "Your data has been removed." : "Nothing to remove."} <a href="/">Home</a></p>`
  );
});

// --- Admin: view / export the opt-in list (token-protected) -----------------
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(403).send("Forbidden. Append ?token=YOUR_ADMIN_TOKEN");
  }
  next();
}

app.get("/admin/members", requireAdmin, (req, res) => {
  res.json(allMembers());
});

app.get("/admin/members.csv", requireAdmin, (req, res) => {
  const rows = allMembers();
  const header = "github_id,login,name,email,linkedin_url,phone,consented_at";
  const csv = [
    header,
    ...rows.map((r) =>
      [r.github_id, r.login, r.name, r.email, r.linkedin_url, r.phone, r.consented_at]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",")
    ),
  ].join("\n");
  res.type("text/csv").attachment("members.csv").send(csv);
});

// ── Campaign admin UI ─────────────────────────────────────────────────────────

app.get("/admin/campaign", requireAdmin, (req, res) => {
  const camp  = getCampaign();
  const stats = getCampaignStats();
  const { batch, reason, nextAt } = getNextBatch(3);
  const msg   = camp.message || { subject: "", body: "" };
  const notice = req.query.saved === "1"
    ? '<div class="notice">✓ Message saved.</div>'
    : req.query.added
    ? `<div class="notice">✓ ${esc(req.query.added)} address(es) added.</div>`
    : "";

  const recentSent = (camp.sent || []).slice(-10).reverse().map(s =>
    `<tr><td>${esc(s.to)}</td><td>${esc(s.sent_at?.slice(0,10))}</td><td>${esc(s.from||"")}</td></tr>`
  ).join("");

  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Campaign — Admin</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
  h1{margin-bottom:.5rem} h2{margin:1.5rem 0 .5rem;font-size:1rem}
  .btn{background:#1f2328;color:#fff;border:none;border-radius:.5rem;padding:.5rem 1.1rem;cursor:pointer;font:inherit;margin-right:.4rem}
  .btn.green{background:#1a7f37} .btn.blue{background:#2363eb}
  .notice{background:#dff7e2;border:1px solid #aef0b8;border-radius:.5rem;padding:.6rem 1rem;margin-bottom:1rem;color:#1a7f37}
  .stat{display:inline-block;background:#f6f8fa;border:1px solid #d0d7de;border-radius:.5rem;padding:.4rem .9rem;margin:.25rem .25rem 1rem 0;font-size:.9rem}
  input,textarea{width:100%;border:1px solid #d0d7de;border-radius:.4rem;padding:.45rem .65rem;font:inherit;margin-bottom:.5rem}
  table{border-collapse:collapse;width:100%;font-size:.85rem;margin-top:.5rem}
  th{text-align:left;padding:.3rem .5rem;border-bottom:2px solid #d0d7de;color:#57606a}
  td{padding:.3rem .5rem;border-bottom:1px solid #f0f2f4}
  tr:nth-child(even){background:#f6f8fa}
</style>
${notice}
<h1>📧 Email Campaign</h1>
<div>
  <span class="stat">📬 Total pool: <strong>${stats.total}</strong></span>
  <span class="stat">✅ Sent: <strong>${stats.sent}</strong></span>
  <span class="stat">⏳ Remaining: <strong>${stats.remaining}</strong></span>
</div>

<h2>Current message</h2>
<p style="color:#57606a;font-size:.85rem;margin-bottom:.75rem">
  Every 2 days, <strong>3 new addresses</strong> receive this message. Update it anytime — future batches use the new text. An address is <strong>never contacted twice</strong>.
</p>
<form method="post" action="/admin/campaign/save?token=${ADMIN_TOKEN}">
  <label style="font-weight:600;font-size:.85rem">Subject</label>
  <input name="subject" value="${esc(msg.subject)}" placeholder="Your subject line…">
  <label style="font-weight:600;font-size:.85rem">Message body</label>
  <textarea name="body" rows="8" placeholder="Write your message here…">${esc(msg.body)}</textarea>
  <button class="btn green" type="submit">💾 Save message</button>
</form>

<h2>Add recipients</h2>
<form method="post" action="/admin/campaign/add-recipients?token=${ADMIN_TOKEN}">
  <textarea name="emails" rows="3" placeholder="alice@example.com, bob@example.com…"></textarea>
  <button class="btn" type="submit">➕ Add addresses</button>
</form>

<h2>Send next batch of 3 now</h2>
<p style="color:#57606a;font-size:.85rem;margin-bottom:.5rem">
  ${reason === "too_soon"
    ? `⏳ Next batch can be sent after <strong>${nextAt?.toLocaleString()}</strong> (2-day gap).`
    : reason === "exhausted"
    ? "✅ All addresses have been sent to."
    : `Ready — next 3: <strong>${batch.map(b=>b.email).join(", ")}</strong>`}
  <br>${hasSenders() ? "✅ Gmail configured." : "⚠️ Set GMAIL_USER + GMAIL_APP_PASS in .env"}
</p>
<form method="post" action="/admin/campaign/run?token=${ADMIN_TOKEN}" style="display:inline">
  <button class="btn blue" type="submit" ${reason !== "ok" ? "disabled" : ""}>▶ Send batch now</button>
</form>

<h2>Recent sends (last 10)</h2>
<table>
  <thead><tr><th>Address</th><th>Date</th><th>From</th></tr></thead>
  <tbody>${recentSent || '<tr><td colspan="3" style="color:#57606a">No sends yet.</td></tr>'}</tbody>
</table>
<p style="margin-top:.75rem;font-size:.85rem">
  <a href="/admin/campaign/sent?token=${ADMIN_TOKEN}">Full send log (JSON)</a>
</p>`);
});

// POST /admin/campaign/save — save single message
app.post("/admin/campaign/save", requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  saveCampaignMessage(
    String(req.body.subject ?? "").trim(),
    String(req.body.body    ?? "").trim()
  );
  res.redirect(`/admin/campaign?token=${ADMIN_TOKEN}&saved=1`);
});

// POST /admin/campaign/save-json — from extension
app.post("/admin/campaign/save-json", requireAdmin, express.json(), (req, res) => {
  saveCampaignMessage(
    String(req.body.subject ?? "").trim(),
    String(req.body.body    ?? "").trim()
  );
  res.json({ ok: true });
});

// POST /admin/campaign/add-recipients
app.post("/admin/campaign/add-recipients", requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  const list = String(req.body.emails ?? "")
    .split(/[\n,]+/).map(s => s.trim()).filter(s => s.includes("@"))
    .map(email => ({ email }));
  const added = addContacts(list);
  res.redirect(`/admin/campaign?token=${ADMIN_TOKEN}&added=${added}`);
});

// POST /admin/campaign/run — send next batch of 3
// Responds JSON when Accept:application/json or ?fmt=json; HTML otherwise (admin UI).
app.post("/admin/campaign/run", requireAdmin, async (req, res) => {
  const wantsJson = req.query.fmt === "json" ||
    (req.headers.accept || "").includes("application/json");

  const { batch, reason, nextAt } = getNextBatch(3);
  const camp = getCampaign();
  const msg  = camp.message;

  if (reason !== "ok") {
    const errMsg = reason === "too_soon"
      ? `Too soon — next batch after ${nextAt?.toLocaleString()}`
      : "All addresses already sent to.";
    if (wantsJson) return res.json({ error: errMsg, reason });
    return res.type("html").send(`<p style="font-family:system-ui;padding:2rem">
      ${reason === "too_soon" ? `⏳ ${errMsg}` : `✅ ${errMsg}`}
      <br><br><a href="/admin/campaign?token=${ADMIN_TOKEN}">← Back</a></p>`);
  }

  if (!msg?.subject || !msg?.body) {
    if (wantsJson) return res.json({ error: "No message saved yet." });
    return res.type("html").send(`<p style="font-family:system-ui;padding:2rem">
      ⚠️ Save your message first. <a href="/admin/campaign?token=${ADMIN_TOKEN}">← Back</a></p>`);
  }

  const results = [];
  for (const { email, login } of batch) {
    try {
      const from = await sendEmail({ to: email, subject: msg.subject, body: msg.body });
      recordSent(email, from);
      results.push({ email, login, status: "sent", from });
      console.log(`[campaign] sent → ${email} (from ${from})`);
    } catch (err) {
      results.push({ email, status: "error", error: err.message });
      console.error(`[campaign] failed ${email}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (wantsJson) return res.json({ sent: results.filter(r=>r.status==="sent").length, results });

  res.type("html").send(`<!doctype html><meta charset="utf-8">
<style>body{font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}
.ok{color:#1a7f37}.err{color:#cf222e}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #d0d7de}</style>
<h2>Batch sent — ${results.filter(r=>r.status==="sent").length} / ${results.length}</h2>
<table><thead><tr><th>Address</th><th>Result</th></tr></thead><tbody>
${results.map(r=>`<tr><td>${esc(r.email)}</td><td class="${r.status==="sent"?"ok":"err"}">${esc(r.status)}</td></tr>`).join("")}
</tbody></table>
<p style="margin-top:1rem"><a href="/admin/campaign?token=${ADMIN_TOKEN}">← Back to campaign</a></p>`);
});

// GET /admin/campaign/sent
app.get("/admin/campaign/sent", requireAdmin, (req, res) => {
  res.json(getCampaign().sent);
});

// POST /admin/contacts/import — from extension (JSON)
app.post("/admin/contacts/import", requireAdmin, express.json(), (req, res) => {
  const added = addContacts(Array.isArray(req.body) ? req.body : []);
  res.json({ added });
});

// POST /admin/collect/slack — pull emails from a Slack workspace
// Body: { slack_token: "xoxb-..." }
app.post("/admin/collect/slack", requireAdmin, express.json(), async (req, res) => {
  const slackToken = String(req.body?.slack_token ?? "").trim();
  if (!slackToken) return res.json({ error: "slack_token required" });

  const contacts = [];
  let cursor = "";
  try {
    do {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const r = await fetch(`https://slack.com/api/users.list?${params}`, {
        headers: { Authorization: `Bearer ${slackToken}` },
      });
      const data = await r.json();
      if (!data.ok) throw new Error("Slack: " + (data.error || "unknown"));
      for (const m of data.members ?? []) {
        if (m.is_bot || m.deleted || !m.profile?.email) continue;
        contacts.push({ email: m.profile.email, login: m.name });
      }
      cursor = data.response_metadata?.next_cursor ?? "";
      if (cursor) await new Promise(r2 => setTimeout(r2, 300));
    } while (cursor);

    const added = addContacts(contacts);
    res.json({ found: contacts.length, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-scheduler: every hour, check if 2 days have passed → send next batch ─
async function runScheduler() {
  const { batch, reason } = getNextBatch(3);
  if (reason !== "ok") return;
  const msg = getCampaign().message;
  if (!msg?.subject || !msg?.body) return;
  console.log(`[scheduler] sending batch of ${batch.length}`);
  for (const { email } of batch) {
    try {
      const from = await sendEmail({ to: email, subject: msg.subject, body: msg.body });
      recordSent(email, from);
      console.log(`[scheduler] sent → ${email}`);
    } catch (err) {
      console.error(`[scheduler] failed ${email}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

setInterval(runScheduler, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  console.log(`Campaign admin: http://localhost:${PORT}/admin/campaign?token=${ADMIN_TOKEN}`);
  console.log(`Export list:    http://localhost:${PORT}/admin/members.csv?token=${ADMIN_TOKEN}`);
});
