// background.js — persistent collection via chrome.storage + alarms

// ── Badge ──────────────────────────────────────────────────────────────────
function refreshBadge() {
  chrome.storage.local.get(['emails'], d => {
    const n = (d.emails||[]).length;
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#5B6AF0' });
  });
}
refreshBadge();

// ── Job storage ────────────────────────────────────────────────────────────
// Job: { source, target, ghToken, logins[], index, found, completed, stopped }
const JOB_KEY = 'collectJob';
const getJob  = () => new Promise(r => chrome.storage.local.get([JOB_KEY], d => r(d[JOB_KEY]||null)));
const setJob  = j  => new Promise(r => chrome.storage.local.set({ [JOB_KEY]: j }, r));
const clearJob= () => new Promise(r => chrome.storage.local.remove([JOB_KEY], r));

// ── Helpers ────────────────────────────────────────────────────────────────
function toPopup(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

function buildEntry(u) {
  return {
    login:     u.login                || '',
    name:      u.name                 || '',
    email:     u.email                || '',
    location:  u.location             || '',
    company:   (u.company||'').replace(/^@/,''),
    bio:       u.bio                  || '',
    blog:      u.blog                 || '',
    twitter:   u.twitter_username     || '',
    followers: u.followers            || 0,
    repos:     u.public_repos         || 0,
    hireable:  u.hireable             || false,
    avatar:    u.avatar_url           || '',
    profile:   `https://github.com/${u.login}`,
    seen_at:   new Date().toISOString()
  };
}

async function ghFetch(path, token) {
  const res = await fetch('https://api.github.com' + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── In-memory email cache with batched writes ───────────────────────────────
// Writing the whole emails array to storage on every found email is O(n²) and
// freezes the scan once the list grows large. Instead we keep the array + a
// Set of seen addresses in memory, and flush to storage on a throttle.
let emailCache  = null;   // array of entries (newest first)
let emailSet    = null;   // Set of lowercased emails for O(1) dedup
let loginSet    = null;   // Set of lowercased logins already in cache (skip re-fetch)
let emailsDirty = false;
let flushTimer  = null;

async function ensureCache() {
  if (emailCache) return;
  const d = await new Promise(r => chrome.storage.local.get(['emails'], r));
  emailCache = d.emails || [];
  emailSet   = new Set(emailCache.map(e => (e.email || '').toLowerCase()));
  loginSet   = new Set(emailCache.map(e => (e.login || '').toLowerCase()).filter(Boolean));
}

async function flushEmails() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!emailsDirty || !emailCache) return;
  emailsDirty = false;
  await new Promise(r => chrome.storage.local.set({ emails: emailCache }, r));
  chrome.action.setBadgeText({ text: emailCache.length ? String(emailCache.length) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#5B6AF0' });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushEmails(); }, 1500);
}

// Returns true if the email was newly added, false if it was a duplicate.
async function persistEmail(entry) {
  await ensureCache();
  const key = (entry.email || '').toLowerCase();
  if (!key || emailSet.has(key)) return false;
  emailSet.add(key);
  if (entry.login) loginSet.add(entry.login.toLowerCase());
  emailCache.unshift(entry);
  emailsDirty = true;
  scheduleFlush();
  return true;
}

// ── Collection loop (processes one user at a time, saves after each) ───────
let isProcessing = false;
let stopRequested = false;

async function runLoop() {
  if (isProcessing) return;
  isProcessing = true;
  stopRequested = false;

  try {
    while (true) {
      const job = await getJob();
      if (!job || job.completed || job.stopped || stopRequested) break;

      const { logins, index, found, ghToken } = job;

      if (index >= logins.length) {
        // All done
        await setJob({ ...job, completed: true });
        chrome.alarms.clear('collect-tick');
        toPopup({ type:'COLLECT_DONE', done:logins.length, total:logins.length, found, text:`✓ Done — ${found} email(s) found` });
        break;
      }

      // Process one login
      const login = logins[index];
      let newFound = found;

      // Skip profile fetch if we already have this login in cache
      if (loginSet && loginSet.has(login.toLowerCase())) {
        const newIndex = index + 1;
        await setJob({ ...job, index: newIndex, found: newFound });
        toPopup({ type:'COLLECT_PROGRESS', done:newIndex, total:logins.length, found:newFound,
          text:`${newIndex} / ${logins.length} checked — ${newFound} found` });
        await sleep(30);
        continue;
      }

      try {
        const u = await ghFetch(`/users/${login}`, ghToken);
        if (u.email) {
          const entry = buildEntry(u);
          const added = await persistEmail(entry);
          if (added) { newFound++; toPopup({ type:'COLLECT_EMAIL', entry }); }
        } else if (u.login) {
          // Mark login as seen even without email so we don't re-fetch next scan
          if (loginSet) loginSet.add(u.login.toLowerCase());
        }
      } catch {}

      const newIndex = index + 1;
      await setJob({ ...job, index:newIndex, found:newFound });

      toPopup({
        type:  'COLLECT_PROGRESS',
        done:  newIndex,
        total: logins.length,
        found: newFound,
        text:  `${newIndex} / ${logins.length} checked — ${newFound} found`
      });

      await sleep(220);
    }
  } finally {
    await flushEmails();
    isProcessing = false;
  }
}

// ── Alarm: resumes loop if service worker was killed mid-collection ─────────
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'collect-tick') {
    const job = await getJob();
    if (!job || job.completed || job.stopped) { chrome.alarms.clear('collect-tick'); return; }
    if (job.source === 'github-all') {
      if (!allRunning) startGitHubAll(job.ghToken);
    } else {
      if (!isProcessing) runLoop();
    }
  }
  if (alarm.name === 'campaign-tick') {
    await campaignTick();
  }
});

// ── Start GitHub org/user collection ──────────────────────────────────────
async function startGitHub(target, ghToken) {
  let logins;
  if (target.includes(',')) {
    logins = target.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    toPopup({ type:'COLLECT_PROGRESS', done:0, total:0, found:0, text:`Fetching @${target} member list…` });
    try {
      const all = []; let page = 1;
      while (true) {
        const b = await ghFetch(`/orgs/${target}/members?per_page=100&page=${page}`, ghToken);
        if (!Array.isArray(b) || !b.length) break;
        all.push(...b.map(m => m.login));
        if (b.length < 100) break;
        page++;
      }
      logins = all;
    } catch { logins = [target]; }
  }

  await setJob({ source:'github', target, ghToken, logins, index:0, found:0, completed:false, stopped:false });
  toPopup({ type:'COLLECT_PROGRESS', done:0, total:logins.length, found:0, text:`Starting — ${logins.length} members to check` });
  chrome.alarms.create('collect-tick', { periodInMinutes: 0.5 });
  runLoop();
}

// ── Scan ALL GitHub users by user ID (no filter) ──────────────────────────
// GitHub's /users?since=<id> lists every registered user in signup order.
// We save lastId to storage so it resumes exactly where it left off.
let allRunning = false;
let allStop    = false;

async function startGitHubAll(ghToken) {
  if (allRunning) return;

  // Load resume position from storage
  const d = await new Promise(r => chrome.storage.local.get(['ghAllLastId','ghAllFound'], r));
  let lastId = d.ghAllLastId || 0;
  let found  = d.ghAllFound  || 0;

  allRunning = true;
  allStop    = false;

  await ensureCache();

  // Persist job marker so alarm can resume if killed
  await setJob({ source:'github-all', ghToken, logins:[], index:0, found, completed:false, stopped:false });
  chrome.alarms.create('collect-tick', { periodInMinutes: 0.5 });

  toPopup({ type:'COLLECT_ALL_STATUS', lastId, found, text:`Scanning all GitHub users… (resumed from ID ${lastId})` });

  let lastCheckpoint = 0;
  let lastStatusMsg  = 0;

  // Flush found emails, then persist the resume position. Emails are flushed
  // FIRST so lastId is never ahead of what's actually saved — on resume we
  // may re-scan a handful of users, never skip them.
  async function checkpoint(force) {
    const now = Date.now();
    if (!force && now - lastCheckpoint < 1500) return;
    lastCheckpoint = now;
    await flushEmails();
    await new Promise(r => chrome.storage.local.set({ ghAllLastId: lastId, ghAllFound: found }, r));
  }

  try {
    while (!allStop) {
      // Fetch a page of 100 users starting after lastId
      let users;
      try {
        users = await ghFetch(`/users?per_page=100&since=${lastId}`, ghToken);
      } catch(e) {
        toPopup({ type:'COLLECT_ALL_STATUS', lastId, found, text:`Rate limited — waiting 60s…` });
        await sleep(60000);
        continue;
      }

      if (!Array.isArray(users) || !users.length) {
        await checkpoint(true);
        toPopup({ type:'COLLECT_ALL_STATUS', lastId, found, text:`✓ Scanned all GitHub users — ${found} emails found` });
        await setJob({ source:'github-all', ghToken, logins:[], index:0, found, completed:true, stopped:false });
        break;
      }

      // Check each user for public email
      for (const u of users) {
        if (allStop) break;
        lastId = u.id; // track position

        // Skip profile fetch if we already have this login
        if (loginSet && loginSet.has((u.login || '').toLowerCase())) {
          await checkpoint(false);
          await sleep(30);
          continue;
        }

        try {
          const profile = await ghFetch(`/users/${u.login}`, ghToken);
          if (profile.email) {
            const entry = buildEntry(profile);
            const added = await persistEmail(entry);
            if (added) { found++; toPopup({ type:'COLLECT_EMAIL', entry }); }
          } else if (profile.login) {
            // Mark as seen without email to avoid re-fetching
            if (loginSet) loginSet.add(profile.login.toLowerCase());
          }
        } catch {}

        // Throttled: persist progress at most every 1.5s instead of every user
        await checkpoint(false);

        // Throttled: status message at most ~every 800ms
        const now = Date.now();
        if (now - lastStatusMsg > 800) {
          lastStatusMsg = now;
          toPopup({ type:'COLLECT_ALL_STATUS', lastId, found,
            text:`Scanned ${lastId.toLocaleString()} users — ${found} emails found` });
        }

        await sleep(220); // ~4-5 users/sec
      }
    }
  } finally {
    await checkpoint(true);
    allRunning = false;
    if (allStop) {
      toPopup({ type:'COLLECT_ALL_STATUS', lastId, found, text:`Stopped at user #${lastId.toLocaleString()} — ${found} emails saved` });
      await setJob({ source:'github-all', ghToken, logins:[], index:0, found, completed:true, stopped:true });
    }
    chrome.alarms.clear('collect-tick');
  }
}

// ── Slack collection ───────────────────────────────────────────────────────
let slackStop = false;

async function runSlack(slackToken) {
  slackStop = false;
  let found = 0, cursor = '';
  try {
    do {
      if (slackStop) break;
      const url = new URL('https://slack.com/api/users.list');
      url.searchParams.set('limit','200');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res  = await fetch(url.toString(), { headers:{ Authorization:`Bearer ${slackToken}` } });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Slack error');
      for (const m of data.members||[]) {
        if (slackStop) break;
        if (m.is_bot || m.deleted || !m.profile?.email) continue;
        const entry = { login:m.name, email:m.profile.email, profile:`https://slack.com/team/${m.id}`, seen_at:new Date().toISOString() };
        const added = await persistEmail(entry);
        if (added) {
          found++;
          toPopup({ type:'SLACK_STATUS', found, text:`${found} found…` });
          toPopup({ type:'COLLECT_EMAIL', entry });
        }
      }
      cursor = data.response_metadata?.next_cursor || '';
      if (cursor) await sleep(300);
    } while (cursor && !slackStop);
    await flushEmails();
    toPopup({ type:'SLACK_DONE', found, text: slackStop ? `Stopped — ${found} saved` : `✓ ${found} email(s) saved` });
  } catch(e) {
    await flushEmails();
    toPopup({ type:'SLACK_DONE', found, text:'✗ ' + e.message, error:true });
  }
}

// ── Gmail send (via Gmail API + OAuth) ─────────────────────────────────────
async function getAuthToken(interactive) {
  // If a specific sender email is stored, find that account and skip the picker
  try {
    const { senderEmail } = await new Promise(r => chrome.storage.local.get(['senderEmail'], r));
    if (senderEmail) {
      const accounts = await new Promise(r => chrome.identity.getAccounts(r));
      const match = accounts && accounts.find(
        a => a.email && a.email.toLowerCase() === senderEmail.trim().toLowerCase()
      );
      if (match) {
        return new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive, account: match }, token => {
            if (chrome.runtime.lastError || !token)
              reject(new Error(chrome.runtime.lastError?.message || 'No auth token'));
            else resolve(token);
          });
        });
      }
    }
  } catch {}

  // Fallback: let Chrome show the account picker
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError || !token)
        reject(new Error(chrome.runtime.lastError?.message || 'No auth token'));
      else resolve(token);
    });
  });
}

// Encode subject as an RFC 2047 word if it has non-ASCII characters.
function encodeSubject(s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return `=?UTF-8?B?${b64}?=`;
}

function base64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildRawMessage({ to, from, subject, body }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"'
  ];
  return base64url(headers.join('\r\n') + '\r\n\r\n' + body);
}

// Sends each recipient a SEPARATE email (never one message to many strangers —
// that leaks addresses and is a strong spam signal). Appends an opt-out line.
async function sendCampaign({ recipients, subject, body }) {
  let token;
  try {
    token = await getAuthToken(true);
  } catch (e) {
    throw new Error('AUTH_FAILED: ' + e.message);
  }

  // Who are we sending as?
  let from = 'me';
  try {
    const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json());
    if (prof.emailAddress) from = prof.emailAddress;
  } catch {}

  const results = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    toPopup({ type: 'SEND_PROGRESS', current: i + 1, total: recipients.length, email: r.email });

    const greeting = r.name ? `Hi ${r.name.split(' ')[0]},\n\n` : '';
    const raw = buildRawMessage({
      to: r.email,
      from,
      subject,
      body: greeting + body
    });
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }
      results.push({ email: r.email, status: 'sent' });
      toPopup({ type: 'SEND_PROGRESS', current: i + 1, total: recipients.length, email: r.email, done: true });
    } catch (e) {
      results.push({ email: r.email, status: 'error', error: e.message });
      toPopup({ type: 'SEND_PROGRESS', current: i + 1, total: recipients.length, email: r.email, error: e.message });
    }
    if (i < recipients.length - 1) await sleep(1200); // gentle pacing between sends
  }

  return { from, results };
}

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAIGN MESSAGE — edit here to change what gets sent
// ═══════════════════════════════════════════════════════════════════════════
const CAMPAIGN_SUBJECT = 'Working together';
const CAMPAIGN_BODY =
`I came across your profile and wanted to reach out directly.

I'm a developer focused on freelance work and I've been looking for people open to collaborating on software projects — web development, automation, and API integrations mainly.

If that's something you'd consider, I'd be happy to share more details. No pitch, just genuinely curious whether there's a fit.`;
// ═══════════════════════════════════════════════════════════════════════════

const SEND_INTERVAL_MIN = 6;   // 1 email every 6 min = 10/hr = 240/day
const BLOCKED_BG = ['india','pakistan','africa','bangladesh','nepal','indonesia'];
let campaignTickRunning = false;

// ── Continuous campaign: 1 email per 6 min (10/hr, 240/day) ──────────────
async function campaignTick() {
  if (campaignTickRunning) return;
  campaignTickRunning = true;
  try {
    const d = await new Promise(r => chrome.storage.local.get(
      ['emails','campaignSent','campaignLog','campaignDailyCount','campaignDailyDate','ghToken','campaignRunning'], r
    ));
    if (!d.campaignRunning) { chrome.alarms.clear('campaign-tick'); return; }

    const sentSet = new Set((d.campaignSent || []).map(e => e.toLowerCase()));
    const unsent  = (d.emails || []).filter(e =>
      e.email && !sentSet.has(e.email.toLowerCase()) &&
      !BLOCKED_BG.some(b => (e.location || '').toLowerCase().includes(b))
    );

    if (!unsent.length) {
      // List exhausted — start a new scan automatically
      toPopup({ type: 'CAMPAIGN_STATUS', text: 'List exhausted — starting new scan…', total: sentSet.size, daily: 0 });
      if (d.ghToken && !allRunning) startGitHubAll(d.ghToken);
      return; // alarm keeps firing; when new emails arrive, next tick will send
    }

    const r = unsent[0];

    let token;
    try { token = await getAuthToken(false); }
    catch {
      try { token = await getAuthToken(true); }
      catch(e) {
        toPopup({ type: 'CAMPAIGN_STATUS', text: '⚠ Auth expired — open extension to re-authorize.', total: sentSet.size, daily: 0, error: true });
        chrome.alarms.clear('campaign-tick');
        await new Promise(res => chrome.storage.local.set({ campaignRunning: false }, res));
        return;
      }
    }

    let from = 'me';
    try {
      const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',
        { headers: { Authorization: `Bearer ${token}` } }).then(p => p.json());
      if (prof.emailAddress) from = prof.emailAddress;
    } catch {}

    const greeting = r.name ? `Hi ${r.name.split(' ')[0]},\n\n` : '';
    const raw = buildRawMessage({ to: r.email, from, subject: CAMPAIGN_SUBJECT, body: greeting + CAMPAIGN_BODY });

    let sendError = null;
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `HTTP ${res.status}`); }
    } catch(e) { sendError = e.message; }

    // Always mark as sent (even on error) to avoid infinite retry on bad addresses
    const today     = new Date().toDateString();
    const prevCount = d.campaignDailyDate === today ? (d.campaignDailyCount || 0) : 0;
    const logEntry  = { id: Date.now(), sent_at: new Date().toISOString(),
      subject: CAMPAIGN_SUBJECT, body: CAMPAIGN_BODY,
      recipients: [{ login: r.login, name: r.name, email: r.email,
        location: r.location, company: r.company, profile: r.profile }] };
    await new Promise(res => chrome.storage.local.set({
      campaignSent:       [...(d.campaignSent || []), r.email.toLowerCase()],
      campaignLastBatch:  Date.now(),
      campaignLog:        [...(d.campaignLog || []), logEntry],
      campaignDailyCount: prevCount + 1,
      campaignDailyDate:  today
    }, res));

    const newTotal = sentSet.size + 1;
    const newDaily = prevCount + 1;
    toPopup({ type: 'CAMPAIGN_STATUS',
      text: sendError
        ? `✗ ${r.email}: ${sendError}`
        : `✓ ${r.name || r.email} — ${unsent.length - 1} left in list`,
      total: newTotal, daily: newDaily
    });
  } finally {
    campaignTickRunning = false;
  }
}

// ── Message router ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_COLLECT_GITHUB') {
    startGitHub(msg.target, msg.ghToken);
    sendResponse({ ok:true });
  }
  if (msg.type === 'START_COLLECT_ALL') {
    startGitHubAll(msg.ghToken);
    sendResponse({ ok:true });
  }
  if (msg.type === 'START_COLLECT_SLACK') {
    runSlack(msg.slackToken);
    sendResponse({ ok:true });
  }
  if (msg.type === 'STOP_COLLECT') {
    stopRequested = true;
    slackStop     = true;
    allStop       = true;
    chrome.alarms.clear('collect-tick');
    getJob().then(async job => {
      if (job && !job.completed) await setJob({ ...job, stopped:true, completed:true });
      sendResponse({ ok:true });
    });
    return true; // keep channel open for async sendResponse
  }
  if (msg.type === 'GET_STATE') {
    getJob().then(job => {
      const running = isProcessing || (job && !job.completed && !job.stopped);
      sendResponse({ running, source: job?.source || null, job: job || null });
    });
    return true; // async sendResponse
  }
  if (msg.type === 'EMAIL_FOUND') {
    refreshBadge();
  }
  if (msg.type === 'GET_EMAILS') {
    // Return the in-memory cache when present (it holds unflushed entries);
    // otherwise fall back to storage.
    (async () => {
      if (emailCache) { sendResponse({ emails: emailCache }); return; }
      const d = await new Promise(r => chrome.storage.local.get(['emails'], r));
      sendResponse({ emails: d.emails || [] });
    })();
    return true;
  }
  if (msg.type === 'START_CAMPAIGN') {
    (async () => {
      await new Promise(r => chrome.storage.local.set({ campaignRunning: true }, r));
      chrome.alarms.clear('campaign-tick');
      chrome.alarms.create('campaign-tick', { delayInMinutes: 1, periodInMinutes: SEND_INTERVAL_MIN });
      sendResponse({ ok: true }); // respond before long async auth+send to avoid channel timeout
      campaignTick();             // fire first tick in background; CAMPAIGN_STATUS messages update popup
    })();
    return true;
  }
  if (msg.type === 'STOP_CAMPAIGN') {
    chrome.alarms.clear('campaign-tick');
    chrome.storage.local.set({ campaignRunning: false }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_CAMPAIGN_STATE') {
    chrome.storage.local.get(['campaignRunning','campaignSent','campaignDailyCount','campaignDailyDate'], d => {
      const today = new Date().toDateString();
      sendResponse({
        running: !!d.campaignRunning,
        total:   (d.campaignSent || []).length,
        daily:   d.campaignDailyDate === today ? (d.campaignDailyCount || 0) : 0
      });
    });
    return true;
  }
  if (msg.type === 'IMPORT_EMAILS') {
    (async () => {
      await ensureCache();
      let added = 0;
      for (const entry of (msg.entries || [])) {
        const key = (entry.email || '').toLowerCase();
        if (!key || emailSet.has(key)) continue;
        emailSet.add(key);
        emailCache.unshift(entry);
        added++;
      }
      if (added) { emailsDirty = true; await flushEmails(); }
      sendResponse({ added, total: emailCache.length });
    })();
    return true;
  }
  if (msg.type === 'ADD_CONTACT') {
    (async () => {
      await ensureCache();
      const entry = {
        login:   msg.entry.login   || '',
        name:    msg.entry.name    || '',
        email:   msg.entry.email   || '',
        location:'',
        company: '',
        bio:     '',
        blog:    '',
        twitter: '',
        followers: 0,
        repos:   0,
        hireable: false,
        avatar:  '',
        profile: '',
        seen_at: new Date().toISOString(),
      };
      const added = await persistEmail(entry);
      if (added) await flushEmails();
      sendResponse({ added });
    })();
    return true;
  }
  if (msg.type === 'GET_CAMPAIGN_LOG') {
    chrome.storage.local.get(['campaignLog'], d => {
      sendResponse({ log: d.campaignLog || [] });
    });
    return true;
  }
  if (msg.type === 'CLEAR_CAMPAIGN_LOG') {
    chrome.storage.local.remove(['campaignLog'], () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'CLEAR_EMAILS') {
    // Reset the in-memory cache too, or a running scan would rewrite old data.
    emailCache = [];
    emailSet   = new Set();
    emailsDirty = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    chrome.storage.local.set(
      { emails: [], campaignSent: [], campaignLastBatch: null },
      () => {
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
      }
    );
    return true;
  }
  return false;
});

// On startup: resume any unfinished collection job
getJob().then(job => {
  if (!job || job.completed || job.stopped) return;
  chrome.alarms.create('collect-tick', { periodInMinutes: 0.5 });
  if (job.source === 'github-all') startGitHubAll(job.ghToken);
  else runLoop();
});

// On startup: resume campaign if it was running before Chrome restarted
chrome.storage.local.get(['campaignRunning'], d => {
  if (d.campaignRunning) {
    chrome.alarms.create('campaign-tick', { delayInMinutes: 1, periodInMinutes: SEND_INTERVAL_MIN });
  }
});
