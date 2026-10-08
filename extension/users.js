// users.js — Dashboard table logic

let allEmails  = [];
let sortCol    = 'seen_at';
let sortDir    = 'desc';
let filterMode = 'all';
let searchQ    = '';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function isSlack(e) { return e.profile && e.profile.includes('slack.com'); }

function avatarUrl(e) {
  if (e.avatar) return e.avatar;
  if (isSlack(e)) return `https://ui-avatars.com/api/?name=${encodeURIComponent(e.login || '?')}&size=56&background=4A154B&color=fff&bold=true`;
  return `https://github.com/${e.login || 'ghost'}.png?size=56`;
}

function makeRow(e) {
  const pill = isSlack(e)
    ? '<span class="pill-slack">Slack</span>'
    : '<span class="pill-gh">GitHub</span>';
  const date    = e.seen_at ? new Date(e.seen_at).toLocaleDateString() : '';
  const tw      = e.twitter ? `<a href="https://x.com/${esc(e.twitter)}" target="_blank">@${esc(e.twitter)}</a>` : '';
  const blocked = isBlocked(e);
  const rowStyle = blocked ? ' style="opacity:.45"' : '';
  const blockBadge = blocked ? ' <span title="Blocked region" style="font-size:11px">🚫</span>' : '';
  return `<tr${rowStyle}>
    <td class="avatar-cell">${pill}<br><img src="${esc(avatarUrl(e))}" loading="lazy"></td>
    <td class="login-cell"><a href="${esc(e.profile || '#')}" target="_blank">@${esc(e.login || '—')}</a></td>
    <td title="${esc(e.name)}">${esc(e.name || '')}</td>
    <td class="email-cell"><a href="mailto:${esc(e.email)}">${esc(e.email)}</a></td>
    <td title="${esc(e.location)}">${esc(e.location || '')}${blockBadge}</td>
    <td title="${esc(e.company)}">${esc(e.company || '')}</td>
    <td class="num">${e.followers ? Number(e.followers).toLocaleString() : ''}</td>
    <td class="num">${e.repos || ''}</td>
    <td style="text-align:center">${e.hireable ? '<span class="tag-yes">✓</span>' : ''}</td>
    <td>${tw}</td>
    <td style="color:var(--muted)">${date}</td>
    <td class="copy-cell"><button class="copy-email-btn" data-email="${esc(e.email)}">📋</button></td>
  </tr>`;
}

const BLOCKED_REGIONS = ['india','pakistan','africa','bangladesh','nepal','indonesia'];
function isBlocked(e) {
  const loc = String(e.location || '').toLowerCase();
  return BLOCKED_REGIONS.some(r => loc.includes(r));
}

function applyFilter(list) {
  return list.filter(e => {
    if (filterMode === 'gh'       && isSlack(e))  return false;
    if (filterMode === 'slack'    && !isSlack(e)) return false;
    if (filterMode === 'hireable' && !e.hireable) return false;
    if (filterMode === 'location' && !e.location) return false;
    if (filterMode === 'blocked'  && !isBlocked(e)) return false;
    if (searchQ) {
      const q = searchQ.toLowerCase();
      return ['login','name','email','location','company','bio','twitter']
        .some(k => String(e[k] || '').toLowerCase().includes(q));
    }
    return true;
  });
}

function applySort(list) {
  return [...list].sort((a, b) => {
    let av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
    const isNum = typeof av === 'number' || typeof bv === 'number';
    if (isNum) { av = Number(av || 0); bv = Number(bv || 0); }
    else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
    if (av < bv) return sortDir === 'asc' ? -1 :  1;
    if (av > bv) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });
}

const MAX_RENDER = 1000; // cap DOM rows so huge lists don't freeze the tab

function render() {
  const filtered = applySort(applyFilter(allEmails));
  const tbody = document.getElementById('tbody');
  const empty  = document.getElementById('empty');

  const shown = filtered.slice(0, MAX_RENDER);
  const truncated = filtered.length > MAX_RENDER;

  document.getElementById('count-badge').textContent =
    (truncated ? `showing ${MAX_RENDER} of ${filtered.length}` : `${filtered.length} of ${allEmails.length}`) + ' users';

  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    let html = shown.map(makeRow).join('');
    if (truncated) {
      html += `<tr><td colspan="12" style="text-align:center;padding:14px;color:var(--muted)">
        Showing first ${MAX_RENDER.toLocaleString()} of ${filtered.length.toLocaleString()} — refine your search or filter to see more.</td></tr>`;
    }
    tbody.innerHTML = html;
  }

  document.querySelectorAll('th[data-col]').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (!icon) return;
    icon.textContent = th.dataset.col === sortCol ? (sortDir === 'asc' ? '▲' : '▼') : '↕';
  });
}

function setStatus(text) {
  document.getElementById('topbar-sub').textContent = text;
}

// RFC-4180-compatible CSV row parser (handles quoted fields with commas/newlines)
function parseCSVRow(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

async function load() {
  try {
    const result = await chrome.storage.local.get('emails');
    allEmails = result.emails || [];
  } catch (err) {
    console.error('Realman storage error:', err);
    allEmails = [];
  }
  setStatus(allEmails.length + ' user' + (allEmails.length !== 1 ? 's' : '') + ' collected');
  render();
}

function init() {
  // Delegated copy handler (one listener for the whole table, not per row)
  document.getElementById('tbody').addEventListener('click', e => {
    const btn = e.target.closest('.copy-email-btn');
    if (!btn) return;
    navigator.clipboard.writeText(btn.dataset.email);
    btn.textContent = '✓';
    setTimeout(() => (btn.textContent = '📋'), 1500);
  });

  // Page tab switching
  document.querySelectorAll('.page-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchPage(tab.dataset.page);
      if (tab.dataset.page === 'history') loadHistory();
    });
  });

  // Clear history
  document.getElementById('clear-log-btn').addEventListener('click', () => {
    if (!confirm('Delete all sent history? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_CAMPAIGN_LOG' }, () => {
      campaignLog = [];
      renderHistory();
    });
  });

  // Sort headers
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      sortDir = sortCol === th.dataset.col ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
      sortCol = th.dataset.col;
      render();
    });
  });

  // Filter pills
  document.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      filterMode = p.dataset.filter;
      render();
    });
  });

  // Search
  document.getElementById('search').addEventListener('input', e => {
    searchQ = e.target.value.trim();
    render();
  });

  // CSV
  document.getElementById('export-btn').addEventListener('click', () => {
    const visible = applySort(applyFilter(allEmails));
    const COLS = ['login','name','email','location','company','bio','blog','twitter','followers','repos','hireable','profile','seen_at'];
    const csv = [COLS.join(','),
      ...visible.map(e => COLS.map(k => `"${String(e[k] ?? '').replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), {
      href: url,
      download: `realman-users-${new Date().toISOString().slice(0, 10)}.csv`
    }).click();
    URL.revokeObjectURL(url);
  });

  // Copy emails
  document.getElementById('copy-emails-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(applyFilter(allEmails).map(e => e.email).join('\n'));
    const btn = document.getElementById('copy-emails-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => (btn.textContent = '📋 Copy Emails'), 1800);
  });

  // Import CSV
  document.getElementById('import-csv').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = ''; // reset so same file can be re-imported

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { alert('CSV appears empty or has no data rows.'); return; }

    // Parse header
    const headers = parseCSVRow(lines[0]);
    const rows = lines.slice(1).map(l => {
      const vals = parseCSVRow(l);
      const obj = {};
      headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
      return obj;
    }).filter(r => r.email); // must have at least an email

    if (!rows.length) { alert('No rows with an email address found.'); return; }

    const entries = rows.map(r => ({
      login:    r.login    || r.username || '',
      name:     r.name     || '',
      email:    r.email,
      location: r.location || '',
      company:  r.company  || '',
      bio:      r.bio      || '',
      blog:     r.blog     || r.website || '',
      twitter:  r.twitter  || '',
      followers: Number(r.followers) || 0,
      repos:     Number(r.repos)     || 0,
      hireable:  r.hireable === 'true' || r.hireable === '1',
      avatar:   r.avatar   || '',
      profile:  r.profile  || r.url || '',
      seen_at:  r.seen_at  || new Date().toISOString(),
    }));

    // Merge through the background so the in-memory cache stays consistent
    const res = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'IMPORT_EMAILS', entries }, r)
    );
    const added = (res && res.added) || 0;

    if (!added) {
      alert(`All ${rows.length} row(s) already exist — nothing new to add.`);
      return;
    }
    await load();
    alert(`✓ Imported ${added} new contact(s). ${rows.length - added} duplicate(s) skipped.`);
  });

  // Clear all
  document.getElementById('clear-btn').addEventListener('click', () => {
    if (!confirm('Delete all collected users? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_EMAILS' }, () => {
      allEmails = [];
      setStatus('0 users collected');
      render();
    });
  });

  // Real-time updates via storage change listener (debounced to coalesce
  // rapid writes during a scan into one render).
  let liveTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.emails) {
      allEmails = changes.emails.newValue || [];
      setStatus(allEmails.length + ' user' + (allEmails.length !== 1 ? 's' : '') + ' collected');
      if (liveTimer) return;
      liveTimer = setTimeout(() => { liveTimer = null; render(); }, 400);
    }
  });

  load();
}

// ── Page tabs ──────────────────────────────────────────────────────────────
function switchPage(name) {
  document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  document.getElementById('users-actions').style.display   = name === 'users'   ? '' : 'none';
  document.getElementById('history-actions').style.display = name === 'history' ? '' : 'none';
}

// ── Sent history ────────────────────────────────────────────────────────────
let campaignLog = [];

function ghAvatar(login) {
  return `https://github.com/${login || 'ghost'}.png?size=40`;
}

function renderHistory() {
  const wrap  = document.getElementById('history-wrap');
  const empty = document.getElementById('history-empty');
  const sorted = [...campaignLog].sort((a, b) => b.id - a.id);

  // Remove old cards (keep the empty message node)
  wrap.querySelectorAll('.log-card').forEach(c => c.remove());

  if (!sorted.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  sorted.forEach(entry => {
    const date = new Date(entry.sent_at).toLocaleString();
    const card = document.createElement('div');
    card.className = 'log-card';

    const recipientsHtml = (entry.recipients || []).map(r => `
      <div class="recipient-chip">
        <img src="${esc(ghAvatar(r.login))}" loading="lazy">
        <div>
          <div class="r-name">${esc(r.name || r.login || '—')}</div>
          <div class="r-email">${esc(r.email)}</div>
          ${r.location ? `<div style="font-size:10px;color:var(--muted)">📍 ${esc(r.location)}</div>` : ''}
        </div>
      </div>`).join('');

    card.innerHTML = `
      <div class="log-header">
        <span class="log-date">📨 ${esc(date)}</span>
        <span class="log-subject">${esc(entry.subject || '(no subject)')}</span>
        <span class="log-count">${(entry.recipients || []).length} recipient${(entry.recipients || []).length !== 1 ? 's' : ''}</span>
      </div>
      <div class="log-body">
        <div class="log-subject-full">${esc(entry.subject || '(no subject)')}</div>
        <div class="log-msg">${esc(entry.body || '')}</div>
        <div class="log-recipients">${recipientsHtml}</div>
      </div>`;

    // Toggle expand/collapse
    card.querySelector('.log-header').addEventListener('click', () => {
      card.querySelector('.log-body').classList.toggle('open');
    });

    wrap.appendChild(card);
  });
}

async function loadHistory() {
  const d = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_CAMPAIGN_LOG' }, r));
  campaignLog = (d && d.log) || [];
  renderHistory();
}

document.addEventListener('DOMContentLoaded', init);
