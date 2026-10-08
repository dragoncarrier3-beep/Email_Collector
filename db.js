import fs from "node:fs";

// Dependency-free JSON store (no native build needed). Fine for a member directory.
const FILE = "data.json";

function load() {
  try {
    const state = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state.members  ??= [];
    state.follows  ??= [];
    state.contacts ??= []; // { email, login?, added_at }
    state.campaign ??= {};
    state.campaign.message ??= { subject: '', body: '', updated_at: null };
    state.campaign.sent    ??= []; // { to, from, sent_at } — one entry per address, ever
    return state;
  } catch {
    return { members: [], follows: [], contacts: [], campaign: { message: { subject:'', body:'', updated_at:null }, sent:[] } };
  }
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function upsertMember(m) {
  const state = load();
  const now = new Date().toISOString();
  const existing = state.members.find((x) => x.github_id === m.github_id);
  if (existing) {
    Object.assign(existing, m, { updated_at: now });
  } else {
    state.members.push({ ...m, consented_at: now, updated_at: now });
  }
  save(state);
}

export function allMembers() {
  return load().members.sort((a, b) => (a.consented_at < b.consented_at ? 1 : -1));
}

export function getMember(githubId) {
  return load().members.find((x) => x.github_id === githubId) || null;
}

export function deleteMember(githubId) {
  const state = load();
  const before = state.members.length;
  state.members = state.members.filter((x) => x.github_id !== githubId);
  // Clean up any follow edges involving this member.
  state.follows = state.follows.filter(
    (f) => f.follower_id !== githubId && f.following_id !== githubId
  );
  save(state);
  return before - state.members.length;
}

// --- Follow relationships ---------------------------------------------------
export function follow(followerId, followingId) {
  if (followerId === followingId) return false; // can't follow yourself
  const state = load();
  const exists = state.follows.some(
    (f) => f.follower_id === followerId && f.following_id === followingId
  );
  if (!exists) {
    state.follows.push({
      follower_id: followerId,
      following_id: followingId,
      created_at: new Date().toISOString(),
    });
    save(state);
  }
  return !exists;
}

export function unfollow(followerId, followingId) {
  const state = load();
  const before = state.follows.length;
  state.follows = state.follows.filter(
    (f) => !(f.follower_id === followerId && f.following_id === followingId)
  );
  save(state);
  return before - state.follows.length > 0;
}

export function isFollowing(followerId, followingId) {
  return load().follows.some(
    (f) => f.follower_id === followerId && f.following_id === followingId
  );
}

// Members who follow `githubId`.
export function followers(githubId) {
  const state = load();
  const ids = state.follows.filter((f) => f.following_id === githubId).map((f) => f.follower_id);
  return state.members.filter((m) => ids.includes(m.github_id));
}

// Members that `githubId` follows.
export function following(githubId) {
  const state = load();
  const ids = state.follows.filter((f) => f.follower_id === githubId).map((f) => f.following_id);
  return state.members.filter((m) => ids.includes(m.github_id));
}

export function counts(githubId) {
  const state = load();
  return {
    followers: state.follows.filter((f) => f.following_id === githubId).length,
    following: state.follows.filter((f) => f.follower_id === githubId).length,
  };
}

// ── Campaign ──────────────────────────────────────────────────────────────

// All unique email addresses (from members + contacts list)
export function allEmails() {
  const state = load();
  const map = new Map();
  for (const m of state.members)
    if (m.email) map.set(m.email.toLowerCase(), { email: m.email, login: m.login });
  for (const c of state.contacts)
    if (c.email) map.set(c.email.toLowerCase(), { email: c.email, login: c.login || '' });
  return [...map.values()];
}

// Add emails from an array [{email, login?}]
export function addContacts(list) {
  const state = load();
  let added = 0;
  const existing = new Set(state.contacts.map(c => c.email.toLowerCase()));
  for (const c of list) {
    if (!c.email) continue;
    const key = c.email.toLowerCase();
    if (!existing.has(key)) {
      state.contacts.push({ email: c.email, login: c.login || '', added_at: new Date().toISOString() });
      existing.add(key);
      added++;
    }
  }
  save(state);
  return added;
}

export function getCampaign() { return load().campaign; }

// Save the single current message (subject + body)
export function saveCampaignMessage(subject, body) {
  const state = load();
  state.campaign.message = { subject, body, updated_at: new Date().toISOString() };
  save(state);
}

// Record that an address was sent to; returns false if already sent (duplicate guard)
export function recordSent(to, from) {
  const state = load();
  const key = to.toLowerCase();
  if (state.campaign.sent.some(s => s.to === key)) return false;
  state.campaign.sent.push({ to: key, from, sent_at: new Date().toISOString() });
  save(state);
  return true;
}

// Returns the next batch of up to `batchSize` addresses that have NEVER been sent to.
// Also checks that at least 2 days have passed since the last batch was sent.
export function getNextBatch(batchSize = 3) {
  const state = load();
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

  // When was the last send?
  if (state.campaign.sent.length > 0) {
    const lastSentAt = Math.max(...state.campaign.sent.map(s => new Date(s.sent_at).getTime()));
    if (Date.now() - lastSentAt < TWO_DAYS) return { batch: [], reason: 'too_soon', nextAt: new Date(lastSentAt + TWO_DAYS) };
  }

  const sentSet = new Set(state.campaign.sent.map(s => s.to));
  const all = allEmails();
  const unsent = all.filter(e => !sentSet.has(e.email.toLowerCase()));
  const batch = unsent.slice(0, batchSize);
  return { batch, reason: batch.length ? 'ok' : 'exhausted', nextAt: null };
}

export function getCampaignStats() {
  const state = load();
  const total = allEmails().length;
  const sent  = state.campaign.sent.length;
  return { total, sent, remaining: total - sent };
}
