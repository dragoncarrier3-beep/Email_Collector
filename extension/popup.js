// popup.js

const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $   = id => document.getElementById(id);
const get = keys => new Promise(r => chrome.storage.local.get(keys, r));
const set = obj  => new Promise(r => chrome.storage.local.set(obj, r));

// ── Table view ─────────────────────────────────────────────────────────────
function openTable() { chrome.tabs.create({ url: chrome.runtime.getURL('users.html') }); }
$('open-table-btn').addEventListener('click',  openTable);
$('open-table-btn2').addEventListener('click', openTable);

// ── Tabs ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'saved')    renderSaved();
    if (tab.dataset.tab === 'send')     renderSendTab();
    if (tab.dataset.tab === 'settings') loadSettings();
  });
});

// ── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  const d = await get(['ghToken','slackToken','senderEmail']);
  $('token-input').value  = d.ghToken     || '';
  $('slack-token').value  = d.slackToken  || '';
  $('sender-email').value = d.senderEmail || '';
}
loadSettings();

$('save-settings').addEventListener('click', async () => {
  await set({
    ghToken:     $('token-input').value.trim(),
    slackToken:  $('slack-token').value.trim(),
    senderEmail: $('sender-email').value.trim()
  });
  $('save-msg').style.display = 'inline';
  setTimeout(() => $('save-msg').style.display = 'none', 2000);
});

$('slack-help-link').addEventListener('click', e => {
  e.preventDefault();
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
  document.querySelector('[data-tab="settings"]').classList.add('active');
  $('tab-settings').classList.add('active');
  loadSettings();
  $('slack-token').focus();
});

// ── Email row HTML ─────────────────────────────────────────────────────────
function memberRow(e) {
  const isSlack  = e.profile && e.profile.includes('slack.com');
  const pillCls  = isSlack ? 'src-pill slack' : 'src-pill gh';
  const pillTxt  = isSlack ? 'Slack' : 'GitHub';
  const avatar   = e.avatar
    ? esc(e.avatar)
    : isSlack
      ? `https://ui-avatars.com/api/?name=${encodeURIComponent(e.login||'?')}&size=56&background=4A154B&color=fff&bold=true`
      : `https://github.com/${esc(e.login||'ghost')}.png?size=56`;

  const meta = [
    e.name     ? esc(e.name)     : null,
    e.location ? `📍 ${esc(e.location)}` : null,
    e.company  ? `🏢 ${esc(e.company)}`  : null,
    e.twitter  ? `𝕏 @${esc(e.twitter)}` : null,
  ].filter(Boolean).join(' · ');

  const stats = [
    e.followers ? `${e.followers.toLocaleString()} followers` : null,
    e.repos     ? `${e.repos} repos` : null,
    e.hireable  ? '✅ hireable' : null,
  ].filter(Boolean).join(' · ');

  const bio = e.bio ? `<div class="row-bio">${esc(e.bio)}</div>` : '';

  return `<div class="row-item">
    <div class="avatar"><img src="${avatar}" loading="lazy"></div>
    <div class="info">
      <div class="login">@${esc(e.login||'—')}${e.name ? ` <span class="real-name">${esc(e.name)}</span>` : ''}</div>
      <div class="email-txt" title="${esc(e.email)}">${esc(e.email)}</div>
      ${meta  ? `<div class="row-meta">${meta}</div>`  : ''}
      ${stats ? `<div class="row-stats">${stats}</div>` : ''}
      ${bio}
    </div>
    <span class="${pillCls}">${pillTxt}</span>
    <button class="copy-btn" data-email="${esc(e.email)}" title="Copy email">📋</button>
  </div>`;
}

function bindCopy(container) {
  container.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.email);
      btn.textContent = '✓';
      setTimeout(() => btn.textContent = '📋', 1500);
    });
  });
}

// ── Saved tab ──────────────────────────────────────────────────────────────
async function renderSaved() {
  const { emails=[] } = await get(['emails']);
  $('badge').textContent = emails.length ? `(${emails.length})` : '';
  const list = $('saved-list');
  if (!emails.length) {
    list.innerHTML = '<div class="empty"><span class="empty-icon">💌</span>No emails saved yet.</div>';
    return;
  }
  list.innerHTML = emails.map(memberRow).join('');
  bindCopy(list);
}
renderSaved();

$('export-btn').addEventListener('click', async () => {
  const { emails=[] } = await get(['emails']);
  const COLS = ['login','name','email','location','company','bio','blog','twitter','followers','repos','hireable','profile','seen_at'];
  const csv = [COLS.join(','),
    ...emails.map(e => COLS.map(k => `"${String(e[k]??'').replace(/"/g,'""')}"`).join(','))
  ].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  Object.assign(document.createElement('a'), { href:url, download:`emails-${new Date().toISOString().slice(0,10)}.csv` }).click();
  URL.revokeObjectURL(url);
});

$('copy-all-btn').addEventListener('click', async () => {
  const { emails=[] } = await get(['emails']);
  navigator.clipboard.writeText(emails.map(e => e.email).join('\n'));
  $('copy-all-btn').textContent = '✓ Copied!';
  setTimeout(() => $('copy-all-btn').textContent = '📋 Copy All', 1500);
});

$('add-email-btn').addEventListener('click', async () => {
  const raw = $('add-email-input').value.trim();
  if (!raw) return;

  // Accept "Name <email>" or just "email"
  const match = raw.match(/^(.*?)\s*<([^>]+)>\s*$/) || raw.match(/^()([\w.+-]+@[\w.-]+\.[a-z]{2,})$/i);
  if (!match) { $('add-email-msg').style.color = 'var(--red)'; $('add-email-msg').textContent = '✗ Invalid format'; return; }

  const name  = (match[1] || '').trim();
  const email = (match[2] || '').trim().toLowerCase();

  const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'ADD_CONTACT', entry: { name, email } }, r));
  if (res && res.added) {
    $('add-email-input').value = '';
    $('add-email-msg').style.color = 'var(--green)';
    $('add-email-msg').textContent = `✓ ${email} added`;
    renderSaved();
    setTimeout(() => $('add-email-msg').textContent = '', 3000);
  } else {
    $('add-email-msg').style.color = 'var(--red)';
    $('add-email-msg').textContent = '✗ Already in list';
  }
});

$('add-email-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('add-email-btn').click(); });

$('clear-all-btn').addEventListener('click', async () => {
  if (!confirm('Delete all saved emails?')) return;
  await set({ emails:[], campaignSent:[], campaignLastBatch:null });
  chrome.action.setBadgeText({ text:'' });
  renderSaved();
});

// ── Send tab (campaign dashboard) ──────────────────────────────────────────
function setCampaignUI(running) {
  const btn = $('campaign-btn');
  const dot = $('campaign-dot');
  const lbl = $('campaign-state-label');
  if (running) {
    btn.textContent = '■ Stop Campaign';
    btn.style.background = 'var(--red)';
    dot.style.background = 'var(--green)';
    dot.style.boxShadow  = '0 0 0 3px rgba(14,163,113,.25)';
    lbl.textContent = 'Running';
  } else {
    btn.textContent = '▶ Start Campaign';
    btn.style.background = 'var(--green)';
    dot.style.background = 'var(--muted)';
    dot.style.boxShadow  = 'none';
    lbl.textContent = 'Stopped';
  }
}

async function renderSendTab() {
  const d = await get(['emails','campaignSent','campaignDailyCount','campaignDailyDate','campaignRunning']);
  const today = new Date().toDateString();
  $('stat-total').textContent = (d.emails||[]).length;
  $('stat-sent').textContent  = (d.campaignSent||[]).length;
  $('stat-daily').textContent = d.campaignDailyDate === today ? (d.campaignDailyCount || 0) : 0;
  setCampaignUI(!!d.campaignRunning);
}
renderSendTab();

$('campaign-btn').addEventListener('click', async () => {
  const d = await get(['campaignRunning']);
  $('campaign-btn').disabled = true;
  if (d.campaignRunning) {
    await new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_CAMPAIGN' }, r));
    setCampaignUI(false);
    $('campaign-status-text').textContent = 'Campaign stopped.';
    $('send-footer').textContent = 'Campaign stopped.';
  } else {
    $('campaign-status-text').textContent = 'Starting — authorizing Gmail…';
    await new Promise(r => chrome.runtime.sendMessage({ type: 'START_CAMPAIGN' }, r));
    setCampaignUI(true);
    $('campaign-status-text').textContent = 'Authorizing… first email sends momentarily.';
  }
  $('campaign-btn').disabled = false;
  renderSendTab();
});

// ── Collect UI helpers ─────────────────────────────────────────────────────
function setProgress(done, total, text, found) {
  $('progress-wrap').classList.add('visible');
  const pct = total > 0 ? Math.round(done/total*100) : 0;
  $('pbar').style.width = pct + '%';

  // Show indeterminate sweep while total is unknown, hide once we have totals
  const ind = $('prog-indeterminate');
  ind.style.display = (total === 0) ? 'block' : 'none';

  // Pulse only while active
  const isDone = done > 0 && done >= total;
  $('pbar').classList.toggle('pulse', !isDone);

  $('plabel').textContent = text || '';
  $('prog-sub').textContent = total > 0 ? `${done} of ${total} checked (${pct}%)` : '';
  if (found !== undefined) $('prog-found').textContent = found;
}

function addCollectRow(e) {
  if ($('collect-list').querySelector('.empty')) $('collect-list').innerHTML = '';
  $('collect-list').insertAdjacentHTML('afterbegin', memberRow(e));
  bindCopy($('collect-list'));
}

function setCollectRunning(running) {
  $('start-btn').style.display = running ? 'none' : 'inline-flex';
  $('stop-btn').style.display  = running ? 'inline-flex' : 'none';
}

// ── GitHub Collect — delegated to background ───────────────────────────────
$('start-btn').addEventListener('click', async () => {
  const { ghToken } = await get(['ghToken']);
  if (!ghToken) { alert('Add your GitHub token in ⚙️ Settings first.'); return; }

  $('collect-list').innerHTML = '';
  $('prog-found').textContent = '0';
  setCollectRunning(true);
  setProgress(0, 0, 'Starting…', 0);
  $('prog-indeterminate').style.display = 'block';

  const target = $('target').value.trim();
  if (target) {
    chrome.runtime.sendMessage({ type:'START_COLLECT_GITHUB', target, ghToken });
  } else {
    chrome.runtime.sendMessage({ type:'START_COLLECT_ALL', ghToken });
  }
});

$('stop-btn').addEventListener('click', async () => {
  // Update UI immediately — don't wait for a background round-trip
  setCollectRunning(false);
  $('prog-indeterminate').style.display = 'none';
  $('pbar').classList.remove('pulse');
  $('plabel').textContent = 'Stopped.';

  // Tell background to stop (it will clear the alarm and set allStop)
  chrome.runtime.sendMessage({ type:'STOP_COLLECT' }, () => { chrome.runtime.lastError; });

  // Also write stopped flag directly to storage so any alarm-triggered
  // resume also bails out, even if the background message was lost
  const d = await get(['collectJob']);
  if (d.collectJob && !d.collectJob.completed) {
    await set({ collectJob: { ...d.collectJob, stopped:true, completed:true } });
  }
});

$('clear-collect').addEventListener('click', () => {
  $('collect-list').innerHTML = '<div class="empty"><span class="empty-icon">🔍</span>Click Start to begin scanning.</div>';
  $('progress-wrap').classList.remove('visible');
});

// ── Slack Collect — delegated to background ────────────────────────────────
$('slack-btn').addEventListener('click', async () => {
  const { slackToken } = await get(['slackToken']);
  if (!slackToken) {
    alert('Add your Slack Bot Token in ⚙️ Settings first.\n\nClick "See Settings → Slack" for instructions.');
    return;
  }
  $('slack-btn').style.display      = 'none';
  $('slack-stop-btn').style.display = 'inline-flex';
  $('slack-status').textContent     = 'Connecting…';
  chrome.runtime.sendMessage({ type:'START_COLLECT_SLACK', slackToken });
});

$('slack-stop-btn').addEventListener('click', () => {
  $('slack-btn').style.display      = 'inline-flex';
  $('slack-stop-btn').style.display = 'none';
  $('slack-status').textContent     = 'Stopped.';
  chrome.runtime.sendMessage({ type:'STOP_COLLECT' }, () => { chrome.runtime.lastError; });
});

// ── Messages from background ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  // GitHub progress
  if (msg.type === 'COLLECT_PROGRESS') {
    setProgress(msg.done, msg.total, msg.text, msg.found);
  }
  if (msg.type === 'COLLECT_EMAIL') {
    addCollectRow(msg.entry);
    get(['emails']).then(d => {
      const n = (d.emails||[]).length;
      $('badge').textContent = `(${n})`;
      $('prog-found').textContent = String($('collect-list').children.length);
    });
  }
  if (msg.type === 'COLLECT_DONE') {
    setProgress(msg.done, msg.total, msg.text, msg.found);
    $('prog-indeterminate').style.display = 'none';
    $('pbar').classList.remove('pulse');
    setCollectRunning(false);
  }

  // All-GitHub scan status
  if (msg.type === 'COLLECT_ALL_STATUS') {
    $('progress-wrap').classList.add('visible');
    $('prog-indeterminate').style.display = 'block';
    $('pbar').style.width = '0%';
    $('plabel').textContent = msg.text;
    $('prog-found').textContent = String(msg.found || 0);
    $('prog-sub').textContent   = `User ID reached: #${(msg.lastId||0).toLocaleString()}`;
    const finished = msg.text.startsWith('✓') || msg.text.startsWith('Stopped');
    if (finished) {
      $('prog-indeterminate').style.display = 'none';
      $('pbar').classList.remove('pulse');
      setCollectRunning(false);
    } else {
      setCollectRunning(true);
    }
  }

  // Slack progress
  if (msg.type === 'SLACK_STATUS') {
    $('slack-status').textContent = msg.text;
  }
  if (msg.type === 'SLACK_DONE') {
    $('slack-status').textContent     = msg.text;
    $('slack-btn').style.display      = 'inline-flex';
    $('slack-stop-btn').style.display = 'none';
    get(['emails']).then(d => {
      $('badge').textContent = `(${(d.emails||[]).length})`;
    });
  }

  // Campaign live status from background
  if (msg.type === 'CAMPAIGN_STATUS') {
    $('send-footer').textContent = msg.text;
    if (msg.total !== undefined) $('stat-sent').textContent  = msg.total;
    if (msg.daily !== undefined) $('stat-daily').textContent = msg.daily;
    try { $('campaign-status-text').textContent = msg.text; } catch {}
    if (msg.error) setCampaignUI(false);
  }

  // Content script
  if (msg.type === 'EMAIL_FOUND') {
    get(['emails']).then(d => {
      $('badge').textContent = `(${(d.emails||[]).length})`;
    });
  }
});

// ── Restore UI when popup reopens ─────────────────────────────────────────
// Read storage directly — works even if the service worker was killed between
// alarm ticks. If a job exists and isn't finished, show its current progress.
(async () => {
  const d = await get(['collectJob', 'ghAllLastId', 'ghAllFound', 'emails']);
  const job    = d.collectJob;
  const lastId = d.ghAllLastId || 0;
  const found  = d.ghAllFound  || 0;

  if (!job || job.completed || job.stopped) return;

  // Job is active (running now or will resume on next alarm tick)
  setCollectRunning(true);
  $('progress-wrap').classList.add('visible');

  if (job.source === 'github-all') {
    $('prog-indeterminate').style.display = 'block';
    $('pbar').classList.add('pulse');
    $('plabel').textContent     = lastId > 0
      ? `Scanning all GitHub… — at user #${lastId.toLocaleString()}`
      : 'Scanning all GitHub users…';
    $('prog-found').textContent = String(found);
    $('prog-sub').textContent   = lastId > 0
      ? `User ID reached: #${lastId.toLocaleString()}`
      : 'Starting…';
  } else if (job.source === 'github') {
    const done  = job.index || 0;
    const total = (job.logins || []).length;
    $('prog-indeterminate').style.display = 'none';
    setProgress(done, total,
      `${done} / ${total} checked — ${job.found || 0} found`, job.found || 0);
  } else if (job.source === 'slack') {
    $('slack-btn').style.display      = 'none';
    $('slack-stop-btn').style.display = 'inline-flex';
    $('slack-status').textContent     = 'Collection in progress…';
    return;
  }

  // Show already-collected emails in the list
  const emails = d.emails || [];
  if (emails.length) {
    $('collect-list').innerHTML = emails.slice(0, 60).map(memberRow).join('');
    bindCopy($('collect-list'));
  }
})();
