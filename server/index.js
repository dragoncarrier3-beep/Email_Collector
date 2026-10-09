require('dotenv').config();
const nodemailer = require('nodemailer');
const https = require('https');
const http  = require('http');
const fs   = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// ── Config ─────────────────────────────────────────────────────────────────
const GH_TOKEN         = process.env.GH_TOKEN         || '';
const SENDER_NAME      = process.env.SENDER_NAME       || 'Dragon94';

// ── Multi-account SMTP ────────────────────────────────────────────────────
const smtpAccounts = [];
for (let i = 1; i <= 20; i++) {
  const user = process.env['SMTP_' + i + '_USER'];
  if (!user) break;
  smtpAccounts.push({
    id:     i,
    host:   process.env['SMTP_' + i + '_HOST'] || 'smtp.gmail.com',
    port:   parseInt(process.env['SMTP_' + i + '_PORT'] || '587'),
    secure: process.env['SMTP_' + i + '_SECURE'] === 'true',
    user:   user,
    pass:   process.env['SMTP_' + i + '_PASS'] || '',
    name:   process.env['SMTP_' + i + '_NAME'] || SENDER_NAME,
    transporter: null,
    status: { ready: false, error: '', checkedAt: '' },
    enabled: false
  });
}
function initTransporters() {
  smtpAccounts.forEach(a => {
    if (!a.pass) { a.status = { ready: false, error: 'No password configured', checkedAt: new Date().toISOString() }; return; }
    a.transporter = nodemailer.createTransport({
      host: a.host, port: a.port, secure: a.secure,
      auth: { user: a.user, pass: a.pass },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      pool: false, maxConnections: 1, rateDelta: 60000, rateLimit: 5
    });
  });
}
function verifyAllAccounts() {
  smtpAccounts.forEach(a => {
    if (!a.transporter) return;
    a.transporter.verify().then(() => {
      a.status = { ready: true, error: '', checkedAt: new Date().toISOString() };
      log('SMTP auth OK — ' + a.user + ' via ' + a.host);
    }).catch(e => {
      a.status = { ready: false, error: e.message, checkedAt: new Date().toISOString() };
      const isLocal = e.message.includes('ETIMEDOUT') || e.message.includes('ECONNREFUSED');
      log('⚠ SMTP auth failed: ' + a.user + ' — ' + e.message + (isLocal ? ' (may work on VPS)' : ''));
    });
  });
}
function loadAccountStates() {
  const saved = getState('account_enabled', '');
  if (saved) {
    try {
      const map = JSON.parse(saved);
      smtpAccounts.forEach(a => { if (map[a.user] !== undefined) a.enabled = map[a.user]; });
    } catch(e) {}
  }
}
function saveAccountStates() {
  const map = {};
  smtpAccounts.forEach(a => map[a.user] = a.enabled);
  setState('account_enabled', JSON.stringify(map));
  dbSave();
}
function getReadyAccounts() {
  return smtpAccounts.filter(a => a.enabled && a.status.ready && a.transporter);
}
let accountRotation = 0;
// ── Safety limits (warm-up phase 1: weeks 1–2) ───────────────────────────
const DAILY_LIMIT          = 10;            // max emails/day across ALL accounts
const PER_ACCOUNT_DAILY    = 5;             // max emails/day per single account
const PER_ACCOUNT_HOURLY   = 2;             // max emails/hour per single account
const MIN_INTERVAL_MS      = 20 * 60000;    // minimum 20 min between any two sends
const SEND_INTERVAL_MS     = Math.floor(24 * 60 * 60 * 1000 / DAILY_LIMIT); // ~144 min target
const CONSECUTIVE_FAIL_MAX = 3;             // auto-disable account after 3 consecutive failures
let nextSendAt = null;
const GH_BATCH_SIZE    = 10;             // parallel profile fetches per batch

const SERVER_START_TIME = Date.now();

const CAMPAIGN_SUBJECT_DEFAULT = 'Working together';
const CAMPAIGN_BODY_DEFAULT =
`I came across your profile and wanted to reach out directly.

I'm a developer focused on freelance work and I've been looking for people open to collaborating on software projects — web development, automation, and API integrations mainly.

If that's something you'd consider, I'd be happy to share more details. No pitch, just genuinely curious whether there's a fit.`;
// Live values — read from DB state so dashboard edits take effect immediately
function getCampaignSubject() { return (db && getState('campaign_subject', '')) || CAMPAIGN_SUBJECT_DEFAULT; }
function getCampaignBody()    { return (db && getState('campaign_body',    '')) || CAMPAIGN_BODY_DEFAULT; }

// ── Storage ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'realman.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db; // sql.js Database instance — initialised in main()

function dbSave() {
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function dbInit(SQL) {
  const existing = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : null;
  db = existing ? new SQL.Database(existing) : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS emails (
    email     TEXT PRIMARY KEY,
    login     TEXT, name TEXT, location TEXT, country TEXT,
    company   TEXT, bio TEXT, blog TEXT, twitter TEXT,
    followers INTEGER DEFAULT 0, repos INTEGER DEFAULT 0,
    hireable  INTEGER DEFAULT 0, avatar TEXT, profile TEXT,
    seen_at   TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sent (
    email TEXT PRIMARY KEY,
    sent_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  // Migrate: add columns if not present
  try { db.run(`ALTER TABLE sent ADD COLUMN subject TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE sent ADD COLUMN body    TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE sent ADD COLUMN send_type TEXT DEFAULT 'campaign'`); } catch(e) {}
  try { db.run(`ALTER TABLE sent ADD COLUMN status TEXT DEFAULT 'sent'`); } catch(e) {}
  try { db.run(`ALTER TABLE sent ADD COLUMN error TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE sent ADD COLUMN sender TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE emails ADD COLUMN telegram TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE emails ADD COLUMN phone TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE emails ADD COLUMN linkedin TEXT DEFAULT ''`); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS send_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    error TEXT,
    failed_at TEXT
  )`);
  // Indexes for fast filtering
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_emails_country ON emails(country)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_emails_login ON emails(login)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_emails_seen ON emails(seen_at DESC)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_sent_email ON sent(email)`); } catch(e) {}
  dbSave();
}

// State helpers (lastId, dailyCount, dailyDate)
function getState(key, def) {
  const r = db.exec(`SELECT value FROM state WHERE key='${key}'`);
  return (r.length && r[0].values.length) ? r[0].values[0][0] : def;
}
function setState(key, value) {
  db.run(`INSERT OR REPLACE INTO state(key,value) VALUES(?,?)`, [key, String(value)]);
}

// Convenience wrappers
function dbAllEmails() {
  const r = db.exec('SELECT * FROM emails ORDER BY seen_at DESC');
  if (!r.length) return [];
  const cols = r[0].columns;
  return r[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    obj.hireable = !!obj.hireable;
    return obj;
  });
}
function dbEmailExists(email) {
  const r = db.exec(`SELECT 1 FROM emails WHERE email=? LIMIT 1`, [email.toLowerCase()]);
  return r.length && r[0].values.length > 0;
}
function dbLoginExists(login) {
  const r = db.exec(`SELECT 1 FROM emails WHERE login=? LIMIT 1`, [login.toLowerCase()]);
  return r.length && r[0].values.length > 0;
}
let _dbDirty = false;
function dbInsertEmail(e) {
  db.run(`INSERT OR IGNORE INTO emails
    (email,login,name,location,country,company,bio,blog,twitter,telegram,phone,linkedin,followers,repos,hireable,avatar,profile,seen_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.email.toLowerCase(), e.login, e.name, e.location, e.country,
     e.company, e.bio, e.blog, e.twitter, e.telegram || '', e.phone || '', e.linkedin || '',
     e.followers, e.repos, e.hireable ? 1 : 0,
     e.avatar, e.profile, e.seen_at]);
  _dbDirty = true;
}
setInterval(() => { if (_dbDirty) { dbSave(); _dbDirty = false; } }, 5000);
function dbIsSent(email) {
  const r = db.exec(`SELECT 1 FROM sent WHERE email=? LIMIT 1`, [email.toLowerCase()]);
  return r.length && r[0].values.length > 0;
}
function dbMarkSent(email, subject, body, sendType, status, error, sender) {
  db.run(`INSERT OR REPLACE INTO sent(email,sent_at,subject,body,send_type,status,error,sender) VALUES(?,?,?,?,?,?,?,?)`,
    [email.toLowerCase(), new Date().toISOString(), subject||'', body||'', sendType||'campaign', status||'sent', error||'', sender||'']);
  dbSave();
}
function dbSentCount() {
  const r = db.exec('SELECT COUNT(*) FROM sent');
  return r.length ? r[0].values[0][0] : 0;
}
function dbSentToday() {
  const today = new Date().toISOString().slice(0,10);
  const r = db.exec(`SELECT COUNT(*) FROM sent WHERE sent_at LIKE '${today}%'`);
  return r.length ? r[0].values[0][0] : 0;
}

function dbSentTodayByAccount(sender) {
  const today = new Date().toISOString().slice(0,10);
  const r = db.exec(`SELECT COUNT(*) FROM sent WHERE sender=? AND status='sent' AND sent_at LIKE '${today}%'`, [sender]);
  return r.length ? r[0].values[0][0] : 0;
}
function dbSentLastHourByAccount(sender) {
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const r = db.exec(`SELECT COUNT(*) FROM sent WHERE sender=? AND status='sent' AND sent_at > ?`, [sender, oneHourAgo]);
  return r.length ? r[0].values[0][0] : 0;
}
function dbLastSendTime() {
  const r = db.exec(`SELECT sent_at FROM sent WHERE status='sent' ORDER BY sent_at DESC LIMIT 1`);
  return (r.length && r[0].values.length) ? new Date(r[0].values[0][0]).getTime() : 0;
}

function dbMarkFailed(email, error) {
  db.run(`INSERT INTO send_failures(email,error,failed_at) VALUES(?,?,?)`,
    [email.toLowerCase(), error||'', new Date().toISOString()]);
  dbSave();
}
function dbFailedToday() {
  const today = new Date().toISOString().slice(0,10);
  const r = db.exec(`SELECT COUNT(*) FROM send_failures WHERE failed_at LIKE '${today}%'`);
  return r.length ? r[0].values[0][0] : 0;
}
function dbFailedTotal() {
  const r = db.exec('SELECT COUNT(*) FROM send_failures');
  return r.length ? r[0].values[0][0] : 0;
}
function dbDailyHistory(days) {
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0,10);
    const label = d.toLocaleDateString('en', { month:'short', day:'numeric' });
    const sr = db.exec(`SELECT COUNT(*) FROM sent WHERE sent_at LIKE '${ds}%'`);
    const fr = db.exec(`SELECT COUNT(*) FROM send_failures WHERE failed_at LIKE '${ds}%'`);
    rows.push({ date: ds, label, sent: sr.length ? sr[0].values[0][0] : 0, failed: fr.length ? fr[0].values[0][0] : 0 });
  }
  return rows;
}

function dbRealCount() {
  const r = db.exec("SELECT COUNT(*) FROM emails WHERE email NOT LIKE '_no_email_%'");
  return r.length ? r[0].values[0][0] : 0;
}

let emails = [];
let state  = { sent: [], dailyCount: 0, dailyDate: '', lastId: 0 };
function syncState() {
  state.lastId    = parseInt(getState('lastId', '0')) || 0;
  state.dailyCount = dbSentToday();
  state.dailyDate  = new Date().toDateString();
  state.sent       = [];
  emails           = { length: dbRealCount(), filter: () => ({ length: dbRealCount() }) };
}
function saveState(s) {
  if (s.lastId !== undefined) setState('lastId', s.lastId);
}

// ── SMTP (multi-account init happens in main()) ──────────────────────────

// ── GitHub API ─────────────────────────────────────────────────────────────
// Live rate-limit tracking (from response headers) so we wait exactly as
// long as GitHub requires instead of guessing.
const ghLimits = {
  core:   { remaining: 5000, reset: 0 },
  search: { remaining: 30,   reset: 0 },
};

function ghGet(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Realman/1.0'
      }
    };
    https.get(opts, res => {
      const resource = res.headers['x-ratelimit-resource'] === 'search' ? 'search' : 'core';
      const rem   = parseInt(res.headers['x-ratelimit-remaining']);
      const reset = parseInt(res.headers['x-ratelimit-reset']);
      if (!isNaN(rem))   ghLimits[resource].remaining = rem;
      if (!isNaN(reset)) ghLimits[resource].reset     = reset;
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
        } else {
          reject(new Error(`GitHub ${res.statusCode}: ${body.slice(0,120)}`));
        }
      });
    }).on('error', reject);
  });
}

// Wait only if the given rate-limit pool is (nearly) exhausted
async function ghWait(resource, minRemaining) {
  const lim = ghLimits[resource];
  if (lim.remaining > minRemaining) return;
  const ms = Math.max(lim.reset * 1000 - Date.now(), 0) + 2000;
  log(`GitHub ${resource} rate limit low — waiting ${Math.ceil(ms/1000)}s`);
  await sleep(ms);
  lim.remaining = minRemaining + 1; // assume refreshed; headers will correct it
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Best-effort country extraction from GitHub's free-form location string
const COUNTRY_MAP = {
  'usa':'USA','united states':'USA','us':'USA','america':'USA',
  'uk':'UK','united kingdom':'UK','england':'UK','britain':'UK','scotland':'UK',
  'canada':'Canada','germany':'Germany','deutschland':'Germany',
  'france':'France','australia':'Australia',
  'netherlands':'Netherlands','brazil':'Brazil','brasil':'Brazil',
  'spain':'Spain','italy':'Italy','russia':'Russia',
  'china':'China','japan':'Japan','sweden':'Sweden','norway':'Norway',
  'denmark':'Denmark','finland':'Finland','switzerland':'Switzerland',
  'austria':'Austria','poland':'Poland','turkey':'Turkey','portugal':'Portugal',
  'south korea':'South Korea','korea':'South Korea',
  'new zealand':'New Zealand','singapore':'Singapore',
  'israel':'Israel','ukraine':'Ukraine','czech':'Czech Republic',
  'argentina':'Argentina','mexico':'Mexico','méxico':'Mexico',
  'colombia':'Colombia','nigeria':'Nigeria',
  'indonesia':'Indonesia','malaysia':'Malaysia','thailand':'Thailand',
  'chile':'Chile','peru':'Peru','ecuador':'Ecuador','uruguay':'Uruguay',
  'venezuela':'Venezuela','bolivia':'Bolivia','paraguay':'Paraguay',
  'costa rica':'Costa Rica','panama':'Panama',
  'dominican republic':'Dominican Republic','guatemala':'Guatemala',
  'puerto rico':'Puerto Rico',
  'romania':'Romania','hungary':'Hungary','greece':'Greece',
  'belgium':'Belgium','ireland':'Ireland','croatia':'Croatia',
  'serbia':'Serbia','bulgaria':'Bulgaria','slovakia':'Slovakia',
  'lithuania':'Lithuania','latvia':'Latvia','estonia':'Estonia',
  'slovenia':'Slovenia','iceland':'Iceland','luxembourg':'Luxembourg',
  'malta':'Malta','belarus':'Belarus','moldova':'Moldova',
  'georgia':'Georgia','tbilisi':'Georgia',
  'vietnam':'Vietnam','viet nam':'Vietnam',
  'philippines':'Philippines','taiwan':'Taiwan',
  'hong kong':'Hong Kong','uae':'UAE','united arab emirates':'UAE',
  'dubai':'UAE','saudi arabia':'Saudi Arabia','iran':'Iran',
  'nepal':'Nepal','sri lanka':'Sri Lanka','cambodia':'Cambodia',
  'myanmar':'Myanmar','kazakhstan':'Kazakhstan','uzbekistan':'Uzbekistan',
  'south africa':'South Africa','kenya':'Kenya','egypt':'Egypt',
  'ghana':'Ghana','ethiopia':'Ethiopia','tanzania':'Tanzania',
  'morocco':'Morocco','tunisia':'Tunisia','uganda':'Uganda',
  'rwanda':'Rwanda','senegal':'Senegal','cameroon':'Cameroon',
};
function extractCountry(location) {
  if (!location) return '';
  const l = location.toLowerCase();
  for (const [key, val] of Object.entries(COUNTRY_MAP)) {
    // Match as whole word to avoid 'us' inside 'Austria', 'russia', etc.
    const re = new RegExp(`(?:^|[\\s,])${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:[\\s,]|$)`);
    if (re.test(l)) return val;
  }
  return '';
}

function extractTelegram(bio, blog) {
  const combined = bio + ' ' + blog;
  const m = combined.match(/(?:t\.me\/|telegram[:\s]*@?|tg[:\s]*@?)([a-zA-Z][a-zA-Z0-9_]{3,31})/i);
  if (m) return m[1];
  const m2 = combined.match(/telegram[:\s]+([a-zA-Z][a-zA-Z0-9_]{3,31})/i);
  if (m2) return m2[1];
  return '';
}

function extractPhone(bio, blog) {
  const combined = (bio || '') + ' ' + (blog || '');
  const m = combined.match(/(?:phone|tel|mobile|cell|whatsapp|call|contact)[:\s]*([+]?[\d][\d\s\-().]{6,18}\d)/i);
  if (m) return m[1].replace(/[\s()-]/g, '').replace(/^00/, '+');
  const m2 = combined.match(/(\+\d[\d\s\-().]{7,18}\d)/);
  if (m2) return m2[1].replace(/[\s()-]/g, '');
  return '';
}

function extractLinkedin(bio, blog) {
  const combined = (bio || '') + ' ' + (blog || '');
  const m = combined.match(/linkedin\.com\/in\/([a-zA-Z0-9_-]{3,100})/i);
  if (m) return m[1].replace(/\/+$/, '');
  const m2 = combined.match(/linkedin[:\s]*(?:@|\/in\/)?([a-zA-Z0-9_-]{3,100})/i);
  if (m2 && !m2[1].match(/^(com|in|profile)$/i)) return m2[1];
  return '';
}

// ── Collector: GitHub Search API, targeted by country/region ───────────────
// We search `type:user location:<place>` so every profile fetch is already a
// candidate from the selected countries. Each query is segmented by follower
// count to work around the Search API's 1000-result cap per query
// (each segment = up to 10 pages × 100 users).
const COUNTRY_SEARCH = {
  // Americas
  'USA': ['USA','"United States"','"New York"','California','Texas','"San Francisco"',
    'Seattle','Chicago','Boston','Austin','"Los Angeles"','Denver','Portland',
    'Atlanta','Florida','NYC','"Washington DC"','Colorado','Ohio','Michigan',
    'Georgia','"North Carolina"','Virginia','Pennsylvania','Arizona','Utah',
    'Minnesota','Oregon','Brooklyn','"San Diego"','Dallas','Houston',
    'Philadelphia','Phoenix','"Salt Lake City"','Nashville','Pittsburgh',
    'Detroit','Miami','Indianapolis','"Kansas City"','Baltimore','Raleigh'],
  'Canada':        ['Canada','Toronto','Vancouver','Montreal','Ottawa','Calgary','Waterloo','Edmonton','Winnipeg'],
  'Brazil':        ['Brazil','Brasil','"São Paulo"','"Sao Paulo"','"Rio de Janeiro"','"Belo Horizonte"','Curitiba','Brasilia','Recife','Fortaleza'],
  'Argentina':     ['Argentina','"Buenos Aires"','Cordoba','Rosario','Mendoza'],
  'Mexico':        ['Mexico','México','CDMX','Guadalajara','Monterrey','Puebla','Tijuana'],
  'Colombia':      ['Colombia','Bogota','Bogotá','Medellin','Medellín','Cali','Barranquilla'],
  'Chile':         ['Chile','Santiago','Valparaiso'],
  'Peru':          ['Peru','Lima','Arequipa','Cusco'],
  'Ecuador':       ['Ecuador','Quito','Guayaquil'],
  'Uruguay':       ['Uruguay','Montevideo'],
  'Venezuela':     ['Venezuela','Caracas'],
  'Bolivia':       ['Bolivia','"La Paz"','"Santa Cruz"'],
  'Paraguay':      ['Paraguay','Asuncion','Asunción'],
  'Costa Rica':    ['"Costa Rica"','"San Jose"','Costa Rica'],
  'Panama':        ['Panama','Panama City'],
  'Dominican Republic': ['"Dominican Republic"','"Santo Domingo"'],
  'Guatemala':     ['Guatemala'],
  'Puerto Rico':   ['"Puerto Rico"'],
  // Europe
  'UK':            ['UK','"United Kingdom"','London','England','Manchester','Scotland','Edinburgh','Bristol','Leeds','Birmingham','Glasgow'],
  'Germany':       ['Germany','Berlin','Munich','Hamburg','Cologne','Frankfurt','Deutschland','Stuttgart','Dusseldorf','Leipzig'],
  'France':        ['France','Paris','Lyon','Toulouse','Bordeaux','Nantes','Marseille','Strasbourg'],
  'Netherlands':   ['Netherlands','Amsterdam','Rotterdam','Utrecht','Eindhoven','"The Hague"'],
  'Spain':         ['Spain','Madrid','Barcelona','Valencia','Sevilla','Bilbao','Malaga'],
  'Italy':         ['Italy','Milan','Rome','Turin','Bologna','Florence','Naples'],
  'Sweden':        ['Sweden','Stockholm','Gothenburg','Malmo'],
  'Norway':        ['Norway','Oslo','Bergen','Trondheim'],
  'Denmark':       ['Denmark','Copenhagen','Aarhus'],
  'Finland':       ['Finland','Helsinki','Tampere','Turku'],
  'Switzerland':   ['Switzerland','Zurich','Geneva','Lausanne','Bern','Basel'],
  'Austria':       ['Austria','Vienna','Graz','Linz'],
  'Poland':        ['Poland','Warsaw','Krakow','Wroclaw','Gdansk','Poznan','Lodz'],
  'Portugal':      ['Portugal','Lisbon','Porto','Braga'],
  'Ukraine':       ['Ukraine','Kyiv','Kiev','Lviv','Kharkiv','Odessa','Dnipro'],
  'Czech Republic':['Czech','Prague','Brno','Ostrava'],
  'Romania':       ['Romania','Bucharest','Cluj','Timisoara','Iasi'],
  'Hungary':       ['Hungary','Budapest','Debrecen'],
  'Greece':        ['Greece','Athens','Thessaloniki'],
  'Belgium':       ['Belgium','Brussels','Antwerp','Ghent'],
  'Ireland':       ['Ireland','Dublin','Cork','Galway'],
  'Croatia':       ['Croatia','Zagreb','Split'],
  'Serbia':        ['Serbia','Belgrade','"Novi Sad"'],
  'Bulgaria':      ['Bulgaria','Sofia','Plovdiv','Varna'],
  'Slovakia':      ['Slovakia','Bratislava','Kosice'],
  'Lithuania':     ['Lithuania','Vilnius','Kaunas'],
  'Latvia':        ['Latvia','Riga'],
  'Estonia':       ['Estonia','Tallinn','Tartu'],
  'Slovenia':      ['Slovenia','Ljubljana'],
  'Iceland':       ['Iceland','Reykjavik'],
  'Luxembourg':    ['Luxembourg'],
  'Malta':         ['Malta','Valletta'],
  'Belarus':       ['Belarus','Minsk'],
  'Moldova':       ['Moldova','Chisinau'],
  'Georgia':       ['Tbilisi'],
  // Asia
  'Turkey':        ['Turkey','Istanbul','Ankara','Izmir','Antalya'],
  'China':         ['China','Beijing','Shanghai','Shenzhen','Hangzhou','Guangzhou','Chengdu','Nanjing','Wuhan','Xian'],
  'Japan':         ['Japan','Tokyo','Osaka','Kyoto','Nagoya','Fukuoka','Yokohama','Sapporo'],
  'South Korea':   ['Korea','Seoul','Busan','Incheon','Daejeon'],
  'Singapore':     ['Singapore'],
  'Indonesia':     ['Indonesia','Jakarta','Bandung','Surabaya','Yogyakarta'],
  'Malaysia':      ['Malaysia','"Kuala Lumpur"','Penang','Johor'],
  'Thailand':      ['Thailand','Bangkok','Chiang Mai','Phuket'],
  'Vietnam':       ['Vietnam','Hanoi','"Ho Chi Minh"','Saigon','"Da Nang"'],
  'Philippines':   ['Philippines','Manila','Cebu','Davao','Quezon'],
  'Taiwan':        ['Taiwan','Taipei','Taichung','Kaohsiung'],
  'Hong Kong':     ['"Hong Kong"'],
  'Israel':        ['Israel','"Tel Aviv"','Jerusalem','Haifa'],
  'UAE':           ['UAE','"United Arab Emirates"','Dubai','"Abu Dhabi"'],
  'Saudi Arabia':  ['"Saudi Arabia"','Riyadh','Jeddah'],
  'Iran':          ['Iran','Tehran','Isfahan'],
  'Nepal':         ['Nepal','Kathmandu'],
  'Sri Lanka':     ['"Sri Lanka"','Colombo'],
  'Cambodia':      ['Cambodia','"Phnom Penh"'],
  'Myanmar':       ['Myanmar','Yangon'],
  'Kazakhstan':    ['Kazakhstan','Almaty','Astana'],
  'Uzbekistan':    ['Uzbekistan','Tashkent'],
  // Oceania
  'Australia':     ['Australia','Sydney','Melbourne','Brisbane','Perth','Adelaide','Canberra'],
  'New Zealand':   ['"New Zealand"','Auckland','Wellington','Christchurch'],
  // Africa
  'Nigeria':       ['Nigeria','Lagos','Abuja'],
  'South Africa':  ['"South Africa"','Johannesburg','"Cape Town"','Durban','Pretoria'],
  'Kenya':         ['Kenya','Nairobi','Mombasa'],
  'Egypt':         ['Egypt','Cairo','Alexandria'],
  'Ghana':         ['Ghana','Accra'],
  'Ethiopia':      ['Ethiopia','"Addis Ababa"'],
  'Tanzania':      ['Tanzania','"Dar es Salaam"'],
  'Morocco':       ['Morocco','Casablanca','Rabat','Marrakech'],
  'Tunisia':       ['Tunisia','Tunis'],
  'Uganda':        ['Uganda','Kampala'],
  'Rwanda':        ['Rwanda','Kigali'],
  'Senegal':       ['Senegal','Dakar'],
  'Cameroon':      ['Cameroon','Douala','Yaounde'],
  // Other
  'Russia':        ['Russia','Moscow','"Saint Petersburg"','Novosibirsk','Kazan'],
};
const REGIONS = {
  'Americas': ['USA','Canada','Brazil','Argentina','Mexico','Colombia','Chile','Peru',
               'Ecuador','Uruguay','Venezuela','Bolivia','Paraguay','Costa Rica','Panama',
               'Dominican Republic','Guatemala','Puerto Rico'],
  'Europe':   ['UK','Germany','France','Netherlands','Spain','Italy','Sweden','Norway','Denmark',
               'Finland','Switzerland','Austria','Poland','Portugal','Ukraine','Czech Republic',
               'Romania','Hungary','Greece','Belgium','Ireland','Croatia','Serbia','Bulgaria',
               'Slovakia','Lithuania','Latvia','Estonia','Slovenia','Iceland','Luxembourg',
               'Malta','Belarus','Moldova','Georgia'],
  'Asia':     ['Turkey','China','Japan','South Korea','Singapore','Indonesia','Malaysia',
               'Thailand','Vietnam','Philippines','Taiwan','Hong Kong','Israel','UAE',
               'Saudi Arabia','Iran','Nepal','Sri Lanka','Cambodia','Myanmar',
               'Kazakhstan','Uzbekistan'],
  'Oceania':  ['Australia','New Zealand'],
  'Africa':   ['Nigeria','South Africa','Kenya','Egypt','Ghana','Ethiopia','Tanzania',
               'Morocco','Tunisia','Uganda','Rwanda','Senegal','Cameroon'],
  'Russia & CIS': ['Russia'],
};
const FOLLOWER_BUCKETS = ['0..2','3..9','10..29','30..99','100..299','300..999','>=1000'];

function getTargets() {
  try {
    const t = JSON.parse(getState('targets', '["USA"]'));
    const valid = (Array.isArray(t) ? t : []).filter(c => COUNTRY_SEARCH[c]);
    if (valid.length) return valid;
  } catch(e) {}
  return ['USA'];
}

function getSendTargets() {
  try {
    const t = JSON.parse(getState('send_targets', '[]'));
    const valid = (Array.isArray(t) ? t : []).filter(c => COUNTRY_SEARCH[c]);
    if (valid.length) return valid;
  } catch(e) {}
  return [];
}

// Segments: [{ q, country }] — round-robin across countries for even collection
function buildSegments(targets) {
  const perCountry = targets.map(country => {
    const items = [];
    for (const loc of COUNTRY_SEARCH[country])
      for (const fb of FOLLOWER_BUCKETS)
        items.push({ q: `type:user location:${loc} followers:${fb}`, country });
    return items;
  });
  const segs = [];
  const maxLen = Math.max(...perCountry.map(a => a.length));
  for (let i = 0; i < maxLen; i++)
    for (const items of perCountry)
      if (i < items.length) segs.push(items[i]);
  return segs;
}

let collecting = false;
let targetsVersion = 0; // bumped when targets change so the collector rebuilds
let collectProgress = { segIdx: 0, segPage: 1, total: 1 };

function saveProfile(profile, segCountry, targetSet) {
  // Search matched one of the target location terms; extractCountry catches
  // mixed locations like "London, UK" that slip through substring matching.
  const country = extractCountry(profile.location || '') || segCountry;
  if (!targetSet.has(country) || !profile.email) {
    if (profile.login) {
      // mark login seen so we never refetch this profile
      db.run(`INSERT OR IGNORE INTO emails(email,login,country,seen_at) VALUES(?,?,?,?)`,
        ['_no_email_' + profile.login, profile.login, country, new Date().toISOString()]);
    }
    return false;
  }
  if (dbEmailExists(profile.email)) return false;
  const tg = extractTelegram(profile.bio || '', profile.blog || '');
  const ph = extractPhone(profile.bio || '', profile.blog || '');
  const li = extractLinkedin(profile.bio || '', profile.blog || '');
  dbInsertEmail({
    login:    profile.login              || '',
    name:     profile.name               || '',
    email:    profile.email,
    location: profile.location           || '',
    country:  country,
    company:  (profile.company||'').replace(/^@/,''),
    bio:      profile.bio                || '',
    blog:     profile.blog               || '',
    twitter:  profile.twitter_username   || '',
    telegram: tg,
    phone:    ph,
    linkedin: li,
    followers:profile.followers          || 0,
    repos:    profile.public_repos       || 0,
    hireable: profile.hireable           || false,
    avatar:   profile.avatar_url         || '',
    profile:  'https://github.com/' + profile.login,
    seen_at:  new Date().toISOString()
  });
  syncState();
  log(`+ ${profile.email} (${profile.login}) [${country}] — total: ${emails.length}`);
  return true;
}

async function collectLoop() {
  if (collecting) return;
  collecting = true;
  syncState();
  let targets  = getTargets();
  let targetSet = new Set(targets);
  let segments = buildSegments(targets);
  let myVersion = targetsVersion;
  let segIdx  = parseInt(getState('segIdx',  '0')) || 0;
  let segPage = parseInt(getState('segPage', '1')) || 1;
  if (segIdx >= segments.length) segIdx = 0;
  log(`Collector started → ${targets.join(', ')}. Segment ${segIdx+1}/${segments.length}, page ${segPage}`);

  while (collecting) {
    // Targets changed from the dashboard — rebuild segments and restart scan
    if (myVersion !== targetsVersion) {
      targets   = getTargets();
      targetSet = new Set(targets);
      segments  = buildSegments(targets);
      myVersion = targetsVersion;
      segIdx = 0; segPage = 1;
      log(`Targets changed → ${targets.join(', ')} — restarting scan.`);
    }
    collectProgress = { segIdx, segPage, total: segments.length };
    const { q, country: segCountry } = segments[segIdx];
    await ghWait('search', 2);

    let result;
    try {
      result = await ghGet(`/search/users?q=${encodeURIComponent(q)}&per_page=100&page=${segPage}`);
    } catch(e) {
      const msg = e.message || '';
      if (msg.includes('403') || msg.includes('429')) {
        ghLimits.search.remaining = 0;
        await ghWait('search', 2);
      } else if (msg.includes('422')) {
        // past the 1000-result cap — move to next segment
        segIdx++; segPage = 1;
      } else {
        log('GitHub search error — waiting 10s:', msg);
        await sleep(10000);
      }
      continue;
    }

    const items = Array.isArray(result.items) ? result.items : [];
    const fresh = items.filter(u => u.login && !dbLoginExists(u.login));

    for (let i = 0; i < fresh.length && collecting; i += GH_BATCH_SIZE) {
      await ghWait('core', 20);
      const batch = fresh.slice(i, i + GH_BATCH_SIZE);
      const profiles = await Promise.all(
        batch.map(u => ghGet(`/users/${u.login}`).catch(() => null))
      );
      for (const p of profiles) if (p) saveProfile(p, segCountry, targetSet);
      await sleep(300);
    }

    if (items.length < 100 || segPage >= 10) {
      segIdx = (segIdx + 1) % segments.length;
      segPage = 1;
      if (segIdx === 0) log('All search segments scanned — restarting from the first.');
    } else {
      segPage++;
    }
    setState('segIdx', segIdx);
    setState('segPage', segPage);
    dbSave();

    await sleep(2100); // search API: 30 requests/min
  }
  collecting = false;
}

// ── Campaign: sends DAILY_LIMIT emails/day ────────────────────────────────
let sendingNow  = null; // { email, name } while SMTP in flight
let lastSent    = null; // { email, name, at } of most recent successful send
async function campaignTick() {
  // ── Safety check 1: global daily cap ──
  const todayCount = dbSentToday();
  if (todayCount >= DAILY_LIMIT) {
    log('Daily limit reached (' + DAILY_LIMIT + ' sent today) — resuming tomorrow.');
    return;
  }

  // ── Safety check 2: minimum interval between any two sends ──
  const lastTime = dbLastSendTime();
  if (lastTime && (Date.now() - lastTime) < MIN_INTERVAL_MS) {
    const waitMin = Math.ceil((MIN_INTERVAL_MS - (Date.now() - lastTime)) / 60000);
    log('Too soon since last send — waiting ' + waitMin + ' more min (min interval: ' + Math.round(MIN_INTERVAL_MS/60000) + ' min).');
    return;
  }

  // ── Safety check 3: pick an account that hasn't hit its limits ──
  const ready = getReadyAccounts();
  if (!ready.length) {
    log('No enabled & ready SMTP accounts — enable at least one on the dashboard.');
    return;
  }
  let acct = null;
  for (let i = 0; i < ready.length; i++) {
    const candidate = ready[(accountRotation + i) % ready.length];
    const acctToday = dbSentTodayByAccount(candidate.user);
    const acctHour  = dbSentLastHourByAccount(candidate.user);
    if (acctToday >= PER_ACCOUNT_DAILY) continue;
    if (acctHour >= PER_ACCOUNT_HOURLY) continue;
    acct = candidate;
    accountRotation = (accountRotation + i + 1);
    break;
  }
  if (!acct) {
    log('All accounts at their per-account limit (daily: ' + PER_ACCOUNT_DAILY + ', hourly: ' + PER_ACCOUNT_HOURLY + ') — waiting.');
    return;
  }

  // ── Pick next unsent recipient ──
  const sendTgts = getSendTargets();
  let pickSql = `SELECT * FROM emails
     WHERE email NOT LIKE '_no_email_%'
       AND email NOT IN (SELECT email FROM sent WHERE status='sent')`;
  const pickParams = [];
  if (sendTgts.length) {
    pickSql += ' AND country IN (' + sendTgts.map(() => '?').join(',') + ')';
    pickParams.push(...sendTgts);
  }
  pickSql += ' ORDER BY seen_at ASC LIMIT 1';
  const r2 = db.exec(pickSql, pickParams);
  if (!r2.length || !r2[0].values.length) {
    log('No unsent emails — waiting for collector to find more…');
    return;
  }
  const cols = r2[0].columns;
  const row  = r2[0].values[0];
  const r    = {};
  cols.forEach((c, i) => r[c] = row[i]);

  const total    = dbSentCount();
  const subject  = getCampaignSubject();
  const greeting = r.name ? 'Hi ' + r.name.split(' ')[0] + ',\n\n' : '';
  const body     = greeting + getCampaignBody();
  const senderDomain = acct.user.split('@')[1] || 'ravk.io';

  sendingNow = { email: r.email, name: r.name || r.login || r.email, via: acct.user };
  const msgId = '<' + Date.now() + '.' + Math.random().toString(36).slice(2,10) + '@' + senderDomain + '>';
  try {
    await acct.transporter.sendMail({
      from:       '"' + acct.name + '" <' + acct.user + '>',
      to:         r.email,
      replyTo:    acct.user,
      subject:    subject,
      messageId:  msgId,
      text:       body
    });
    acct._consecutiveFails = 0;
    dbMarkSent(r.email, subject, body, 'campaign', 'sent', '', acct.user);
    lastSent   = { email: r.email, name: r.name || r.login || r.email, at: new Date().toISOString(), via: acct.user };
    sendingNow = null;
    log('✓ Sent to ' + r.email + ' via ' + acct.user + ' — today: ' + (todayCount+1) + '/' + DAILY_LIMIT + ', total: ' + (total+1));
  } catch(e) {
    sendingNow = null;
    acct._consecutiveFails = (acct._consecutiveFails || 0) + 1;
    const isNetworkBlock = e.message.includes('ETIMEDOUT') || e.message.includes('ECONNREFUSED');
    if (isNetworkBlock) {
      dbMarkFailed(r.email, e.message);
      log('✗ SMTP blocked via ' + acct.user + ' (' + e.message + ') — will retry next tick');
    } else {
      dbMarkFailed(r.email, e.message);
      dbMarkSent(r.email, subject, body, 'campaign', 'failed', e.message, acct.user);
      log('✗ Failed ' + r.email + ' via ' + acct.user + ': ' + e.message);
    }
    // ── Safety: auto-disable account after consecutive failures ──
    if (acct._consecutiveFails >= CONSECUTIVE_FAIL_MAX) {
      acct.enabled = false;
      saveAccountStates();
      log('⚠ Auto-disabled ' + acct.user + ' after ' + CONSECUTIVE_FAIL_MAX + ' consecutive failures — re-enable manually after checking.');
    }
  }
}

// ── Logger ─────────────────────────────────────────────────────────────────
const logBuffer = [];
function log(...args) {
  const ts  = new Date().toISOString().replace('T',' ').slice(0,19);
  const line = `[${ts}] ${args.join(' ')}`;
  console.log(line);
  logBuffer.unshift(line);
  if (logBuffer.length > 200) logBuffer.pop();
}

// ── Dashboard (http://localhost:3000) ──────────────────────────────────────
function realEmails() {
  return { length: dbRealCount(), toLocaleString: () => dbRealCount().toLocaleString() };
}

function dashboardHTML() {
  syncState();
  const real = realEmails();
  const totalSent = dbSentCount();
  const daily     = dbSentToday();
  const r = db.exec(
    `SELECT COUNT(*) FROM emails WHERE email NOT LIKE '_no_email_%' AND email NOT IN (SELECT email FROM sent WHERE status='sent')`
  );
  const unsent   = r.length ? r[0].values[0][0] : 0;
  const nextSend  = nextSendAt ? new Date(nextSendAt).toLocaleTimeString() : '—';
  const logLines  = logBuffer.slice(0, 80);
  const nowStr    = new Date().toLocaleString();
  const countryCounts = {};
  try {
    const cr = db.exec("SELECT country, COUNT(*) FROM emails WHERE email NOT LIKE '_no_email_%' GROUP BY country");
    if (cr.length) cr[0].values.forEach(row => { countryCounts[row[0] || 'Unknown'] = row[1]; });
  } catch(e) {}

  const logHTML = logLines.map(l => {
    const cls = l.includes('✓') ? 'ok' : l.includes('✗') || l.includes('⚠') ? 'err' : '';
    return '<div class="log-line ' + cls + '">' + l.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>';
  }).join('');

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Realman</title>
<script>
  (function(){ document.documentElement.setAttribute('data-theme', localStorage.getItem('rm-theme')||'light'); })();
</script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  ::selection{background:var(--accent);color:#fff}
  ::-webkit-scrollbar{width:6px;height:6px}
  ::-webkit-scrollbar-track{background:var(--bg)}
  ::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px;border:1px solid var(--bg)}
  ::-webkit-scrollbar-thumb:hover{background:var(--muted)}
  ::-webkit-scrollbar-corner{background:var(--bg)}

  :root{
    --bg:#f4f6fa;--bg-2:#eaecf4;--card:#ffffff;--card-2:#f8f9fc;
    --border:#e2e5f0;--border-2:#eceef6;
    --ink:#111827;--ink-2:#374151;--muted:#6b7280;--faint:#9ca3af;
    --accent:#0891b2;--accent-hover:#0e7490;--accent-bg:rgba(8,145,178,.06);--accent-glow:rgba(8,145,178,.18);
    --green:#059669;--green-bg:rgba(5,150,105,.07);
    --blue:#2563eb;--blue-bg:rgba(37,99,235,.07);
    --red:#dc2626;--red-bg:rgba(220,38,38,.07);
    --orange:#d97706;--orange-bg:rgba(217,119,6,.07);
    --purple:#7c3aed;--purple-bg:rgba(124,58,237,.07);
    --shadow:0 1px 3px rgba(0,0,0,.04),0 6px 24px -4px rgba(0,0,0,.07);
    --shadow-sm:0 1px 2px rgba(0,0,0,.03);
    --shadow-lg:0 4px 16px rgba(0,0,0,.06),0 24px 48px -8px rgba(0,0,0,.1);
    --radius:12px;--radius-sm:8px;--radius-xs:6px;
    --transition:all .2s cubic-bezier(.4,0,.2,1);
    --hdr-bg:linear-gradient(135deg,#0e7490,#0891b2);
  }
  @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#0b0f19;--bg-2:#111827;--card:#1f2937;--card-2:#1a2332;
    --border:#374151;--border-2:#2d3748;
    --ink:#f1f5f9;--ink-2:#cbd5e1;--muted:#94a3b8;--faint:#64748b;
    --accent:#22d3ee;--accent-hover:#67e8f9;--accent-bg:rgba(34,211,238,.08);--accent-glow:rgba(34,211,238,.2);
    --green:#34d399;--green-bg:rgba(52,211,153,.1);
    --blue:#60a5fa;--blue-bg:rgba(96,165,250,.1);
    --red:#f87171;--red-bg:rgba(248,113,113,.1);
    --orange:#fbbf24;--orange-bg:rgba(251,191,36,.1);
    --purple:#a78bfa;--purple-bg:rgba(167,139,250,.1);
    --shadow:0 1px 3px rgba(0,0,0,.4),0 6px 24px -4px rgba(0,0,0,.5);
    --shadow-sm:0 1px 2px rgba(0,0,0,.3);
    --shadow-lg:0 4px 16px rgba(0,0,0,.4),0 24px 48px -8px rgba(0,0,0,.6);
    --hdr-bg:linear-gradient(135deg,#164e63,#155e75);
  }}
  :root[data-theme="dark"]{
    --bg:#0b0f19;--bg-2:#111827;--card:#1f2937;--card-2:#1a2332;
    --border:#374151;--border-2:#2d3748;
    --ink:#f1f5f9;--ink-2:#cbd5e1;--muted:#94a3b8;--faint:#64748b;
    --accent:#22d3ee;--accent-hover:#67e8f9;--accent-bg:rgba(34,211,238,.08);--accent-glow:rgba(34,211,238,.2);
    --green:#34d399;--green-bg:rgba(52,211,153,.1);
    --blue:#60a5fa;--blue-bg:rgba(96,165,250,.1);
    --red:#f87171;--red-bg:rgba(248,113,113,.1);
    --orange:#fbbf24;--orange-bg:rgba(251,191,36,.1);
    --purple:#a78bfa;--purple-bg:rgba(167,139,250,.1);
    --shadow:0 1px 3px rgba(0,0,0,.4),0 6px 24px -4px rgba(0,0,0,.5);
    --shadow-sm:0 1px 2px rgba(0,0,0,.3);
    --shadow-lg:0 4px 16px rgba(0,0,0,.4),0 24px 48px -8px rgba(0,0,0,.6);
    --hdr-bg:linear-gradient(135deg,#164e63,#155e75);
  }

  body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.55;min-height:100vh;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
  header{position:sticky;top:0;z-index:20;background:var(--hdr-bg);padding:0 28px;height:60px;display:flex;align-items:center;justify-content:space-between;gap:14px;box-shadow:0 2px 16px rgba(0,0,0,.18);backdrop-filter:blur(12px)}
  .logo{display:flex;align-items:center;gap:12px}
  .logo-icon{width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.18);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:900;color:#fff;border:1px solid rgba(255,255,255,.25);box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .logo-name{font-size:1.05rem;font-weight:800;color:#fff;letter-spacing:-.01em}
  .logo-sub{font-size:.6rem;color:rgba(255,255,255,.6);letter-spacing:.04em;font-weight:500}
  .hdr-right{display:flex;align-items:center;gap:10px}
  .hdr-controls{display:flex;gap:6px}
  .badge{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:99px;font-size:.66rem;font-weight:600;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.6);background:rgba(255,255,255,.06);transition:var(--transition);backdrop-filter:blur(4px)}
  .badge.on{border-color:rgba(52,211,153,.5);color:#34d399;background:rgba(52,211,153,.15);box-shadow:0 0 12px rgba(52,211,153,.15)}
  .pulse{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 1.8s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes slideUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
  @keyframes glowPulse{0%,100%{box-shadow:0 0 4px var(--accent-glow)}50%{box-shadow:0 0 12px var(--accent-glow)}}
  #theme-toggle{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:99px;padding:5px 14px;font-size:.72rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:var(--transition)}
  #theme-toggle:hover{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.35)}

  main{max-width:1440px;margin:0 auto;padding:22px 28px 48px;display:flex;gap:0}
  .main-content{flex:1;min-width:0;padding-left:24px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px 18px 16px;transition:var(--transition);position:relative;overflow:hidden}
  .stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--border);transition:var(--transition)}
  .stat:hover{box-shadow:var(--shadow);transform:translateY(-2px)}
  .stat:hover::before{background:var(--accent)}
  .stat.accent::before{background:var(--accent)}
  .stat.accent{border-left:3px solid var(--accent)}
  .stat-val{font-size:1.85rem;font-weight:900;line-height:1;margin-bottom:6px;letter-spacing:-.03em;color:var(--ink)}
  .stat-lbl{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}

  .daily-chart{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;margin-bottom:20px;box-shadow:var(--shadow-sm);transition:var(--transition)}
  .daily-chart:hover{box-shadow:var(--shadow)}
  .daily-chart-title{font-size:.78rem;font-weight:800;color:var(--ink);margin-bottom:4px;display:flex;align-items:center;gap:8px}
  .daily-chart-grid{display:flex;gap:8px;align-items:flex-end;height:110px;padding:8px 4px 0}
  .daily-bar-group{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%}
  .daily-bar-wrap{flex:1;width:100%;display:flex;gap:3px;align-items:flex-end;justify-content:center}
  .daily-bar{border-radius:5px 5px 2px 2px;min-width:16px;transition:height .5s cubic-bezier(.4,0,.2,1),opacity .3s,transform .2s;position:relative;cursor:default}
  .daily-bar:hover{transform:scaleX(1.1) scaleY(1.02)}
  .daily-bar.sent-bar{background:linear-gradient(180deg,#34d399,#059669)}
  .daily-bar.fail-bar{background:linear-gradient(180deg,#f87171,#dc2626)}
  .daily-bar-label{font-size:.6rem;font-weight:700;color:var(--faint);text-align:center;white-space:nowrap}
  .daily-bar-val{position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:.58rem;font-weight:700;white-space:nowrap;opacity:0;transition:opacity .15s}
  .daily-bar:hover .daily-bar-val{opacity:1}
  .daily-legend{display:flex;gap:16px;margin-top:12px;justify-content:center}
  .daily-legend-item{display:flex;align-items:center;gap:5px;font-size:.66rem;font-weight:600;color:var(--muted)}
  .daily-legend-dot{width:10px;height:10px;border-radius:3px}
  .daily-summary{display:flex;gap:24px;margin-bottom:16px;justify-content:center;flex-wrap:wrap}
  .daily-summary-item{text-align:center;padding:8px 16px;background:var(--bg);border-radius:10px;min-width:90px}
  .daily-summary-val{font-size:1.7rem;font-weight:900;line-height:1;letter-spacing:-.02em}
  .daily-summary-lbl{font-size:.58rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-top:3px}

  .controls{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
  .ctrl-btn{padding:8px 18px;border-radius:var(--radius-sm);border:none;font-size:.76rem;font-weight:700;cursor:pointer;transition:all .2s cubic-bezier(.4,0,.2,1);display:inline-flex;align-items:center;gap:6px;letter-spacing:.01em}
  .ctrl-btn:hover{transform:translateY(-1px);box-shadow:var(--shadow)}
  .ctrl-btn:active{transform:translateY(0) scale(.97)}
  .ctrl-btn:disabled{opacity:.35;cursor:default;transform:none;box-shadow:none}
  .ctrl-btn.green{background:#059669;color:#fff}
  .ctrl-btn.green:hover{background:#047857}
  .ctrl-btn.blue{background:#0891b2;color:#fff}
  .ctrl-btn.blue:hover{background:#0e7490}
  .ctrl-btn.red{background:#dc2626;color:#fff}
  .ctrl-btn.red:hover{background:#b91c1c}
  .ctrl-btn.accent{background:var(--accent);color:#fff}
  .ctrl-btn.accent:hover{background:var(--accent-hover)}
  .hdr-btn{font-size:.72rem;padding:7px 16px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.2);letter-spacing:.02em}
  .hdr-btn.green{background:rgba(5,150,105,.9)}
  .hdr-btn.green:hover{background:#059669;box-shadow:0 2px 12px rgba(5,150,105,.4)}
  .hdr-btn.blue{background:rgba(8,145,178,.85)}
  .hdr-btn.blue:hover{background:#0891b2;box-shadow:0 2px 12px rgba(8,145,178,.4)}
  .hdr-btn.red{background:rgba(220,38,38,.85)}
  .hdr-btn.red:hover{background:#dc2626;box-shadow:0 2px 12px rgba(220,38,38,.4)}

  .panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-sm);transition:var(--transition)}
  .panel:hover{box-shadow:var(--shadow)}
  .sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .sec-title{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}

  .status-row{display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap;align-items:center;padding:10px 16px;background:var(--card);border:1px solid var(--border);border-radius:10px}
  .status-item{display:flex;align-items:center;gap:7px;font-size:.78rem;font-weight:600;color:var(--muted)}
  .status-dot{width:8px;height:8px;border-radius:50%;background:var(--border);display:inline-block;flex-shrink:0;transition:var(--transition)}
  .status-dot.active{animation:pulse 1.4s ease-in-out infinite}

  .progress-wrap{margin-bottom:20px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;transition:var(--transition)}
  .progress-bar{height:5px;background:var(--bg-2);border-radius:99px;overflow:hidden}
  .progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),#06b6d4);border-radius:99px;transition:width .6s cubic-bezier(.4,0,.2,1);position:relative}
  .progress-fill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent);background-size:200% 100%;animation:shimmer 2s infinite linear}

  table{width:100%;border-collapse:collapse;font-size:.72rem;table-layout:fixed}
  .table-scroll{overflow-x:hidden;border-radius:0 0 var(--radius) var(--radius)}
  th{padding:7px 6px;text-align:left;font-size:.58rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);white-space:nowrap;border-bottom:2px solid var(--border);background:var(--card-2);position:sticky;top:0;z-index:1;overflow:hidden}
  td{padding:7px 6px;border-bottom:1px solid var(--border-2);color:var(--ink-2);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background .15s}
  tr:last-child td{border:none}
  tr:nth-child(even) td{background:var(--card-2)}
  tr:hover td{background:var(--accent-bg)}
  .filter-row td{padding:3px 4px;background:var(--card-2);border-bottom:1px solid var(--border)}
  .col-filter-styled{width:100%;background:var(--card);border:1px solid var(--border);color:var(--ink);border-radius:var(--radius-xs);padding:3px 5px;font-size:.66rem;outline:none;transition:var(--transition)}
  .col-filter-styled:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-bg)}
  .av{width:26px;height:26px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:5px;background:var(--bg-2);border:1.5px solid var(--border);transition:var(--transition)}
  tr:hover .av{border-color:var(--accent)}
  td:hover .av+a,td:hover span>.av+a{opacity:1!important}
  .av-ph{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--bg-2),var(--card-2));display:inline-flex;align-items:center;justify-content:center;font-size:.62rem;color:var(--faint);vertical-align:middle;margin-right:5px;font-weight:700;border:1.5px solid var(--border)}

  .log-wrap{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow-sm);transition:var(--transition)}
  .log-wrap:hover{box-shadow:var(--shadow)}
  .log-scroll{max-height:400px;overflow-y:auto;padding:14px 18px}
  .log-line{font-family:'JetBrains Mono','Courier New',monospace;font-size:.7rem;line-height:1.9;white-space:pre-wrap;word-break:break-all;color:var(--muted);border-bottom:1px solid var(--border-2);padding:3px 0;transition:all .15s}
  .log-line:last-child{border:none}
  .log-line:hover{background:var(--accent-bg);padding-left:6px}
  .log-line.ok{color:var(--green);font-weight:500}
  .log-line.err{color:var(--red);font-weight:600;background:var(--red-bg);padding:2px 6px;border-radius:4px;margin:1px 0}

  .btn-action{background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);padding:7px 18px;font-size:.76rem;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:5px;transition:all .2s cubic-bezier(.4,0,.2,1);letter-spacing:.01em}
  .btn-action:hover{background:var(--accent-hover);transform:translateY(-1px);box-shadow:0 3px 12px var(--accent-glow)}
  .btn-upload{background:var(--card-2);border:1px solid var(--border);color:var(--ink);border-radius:var(--radius-sm);padding:6px 16px;font-size:.76rem;font-weight:600;cursor:pointer;transition:var(--transition)}
  .btn-upload:hover{border-color:var(--accent);color:var(--accent)}
  code{background:var(--bg-2);padding:2px 6px;border-radius:4px;font-size:.74rem;font-family:'JetBrains Mono',monospace}
  footer{text-align:center;padding:28px 0;font-size:.7rem;color:var(--faint)}
  footer a{color:var(--accent);font-weight:600;text-decoration:none;transition:color .15s}
  footer a:hover{color:var(--accent-hover)}
  @media(max-width:900px){
    header{height:auto;flex-wrap:wrap;padding:10px 16px;gap:8px}
    .hdr-controls{order:10;width:100%;display:flex;justify-content:stretch}
    .hdr-controls .ctrl-btn{flex:1;justify-content:center;font-size:.7rem;padding:6px 8px}
  }
  @media(max-width:768px){
    main{flex-direction:column;padding:16px 16px 48px}
    .main-nav{flex-direction:row;position:static;min-width:auto;overflow-x:auto;border-radius:12px;padding:6px}
    .main-nav .nav-sep{display:none}
    .main-content{padding-left:0;padding-top:16px}
    .nav-btn{white-space:nowrap;text-align:center;flex-direction:column;gap:2px;padding:8px 12px;font-size:.72rem}
    .nav-btn .nav-icon{font-size:.9rem}
    .stats{grid-template-columns:repeat(3,1fr)}
    .daily-summary{gap:12px}
  }

  .main-nav{display:flex;flex-direction:column;gap:2px;position:sticky;top:72px;align-self:flex-start;z-index:15;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:10px 8px;min-width:190px;box-shadow:var(--shadow)}
  .nav-btn{background:none;border:none;border-radius:10px;padding:11px 14px;font-size:.8rem;font-weight:600;color:var(--muted);cursor:pointer;transition:all .18s cubic-bezier(.4,0,.2,1);text-align:left;white-space:nowrap;display:flex;align-items:center;gap:10px;position:relative;letter-spacing:.01em}
  .nav-btn .nav-icon{font-size:1.05rem;width:24px;text-align:center;flex-shrink:0;transition:transform .2s}
  .nav-btn .nav-label{flex:1}
  .nav-btn .nav-count{font-size:.62rem;font-weight:700;background:var(--bg-2);color:var(--faint);padding:2px 8px;border-radius:99px;transition:var(--transition);min-width:24px;text-align:center}
  .nav-btn.active{background:var(--accent);color:#fff;box-shadow:0 3px 14px var(--accent-glow);font-weight:700}
  .nav-btn.active .nav-icon{transform:scale(1.15)}
  .nav-btn.active .nav-count{background:rgba(255,255,255,.22);color:#fff}
  .nav-btn:hover:not(.active){background:var(--bg-2);color:var(--ink);transform:translateX(3px)}
  .nav-btn:hover:not(.active) .nav-icon{transform:scale(1.1);color:var(--accent)}
  .nav-sep{height:1px;background:var(--border);margin:5px 12px}
  .nav-page{animation:slideUp .3s cubic-bezier(.4,0,.2,1)}
  .pagination{display:flex;align-items:center;justify-content:center;gap:4px;padding:12px 16px;flex-wrap:wrap}
  .pg-btn{background:var(--card-2);border:1px solid var(--border);color:var(--ink-2);border-radius:var(--radius-xs);padding:4px 9px;font-size:.7rem;font-weight:600;cursor:pointer;transition:var(--transition);min-width:28px;text-align:center}
  .pg-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-bg)}
  .pg-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 1px 4px var(--accent-glow)}
  .pg-btn:disabled{opacity:.35;cursor:default}
  .pg-info{font-size:.73rem;color:var(--muted);font-weight:600;padding:0 8px}
  .pg-size{border:1px solid var(--border);border-radius:var(--radius-xs);padding:4px 8px;font-size:.73rem;background:var(--card);color:var(--ink);outline:none;transition:var(--transition)}
  .pg-size:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-bg)}

  .target-panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:20px;box-shadow:var(--shadow-sm);transition:var(--transition)}
  .target-panel:hover{box-shadow:var(--shadow)}
  .region-group{margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border-2)}
  .region-group:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
  .region-header{display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;user-select:none;padding:6px 8px;border-radius:var(--radius-sm);transition:background .15s}
  .region-header:hover{background:var(--bg-2)}
  .region-header h3{font-size:.78rem;font-weight:700;color:var(--ink);margin:0}
  .region-count{font-size:.62rem;font-weight:600;color:var(--faint);background:var(--bg-2);padding:1px 7px;border-radius:99px;margin-left:4px}
  .region-check{accent-color:var(--accent);width:16px;height:16px;cursor:pointer}
  .country-pills{display:flex;flex-wrap:wrap;gap:6px;padding-left:26px}
  .country-pill{display:inline-flex;align-items:center;gap:4px;padding:5px 13px;border-radius:99px;font-size:.72rem;font-weight:600;border:1px solid var(--border);color:var(--muted);cursor:pointer;transition:all .18s cubic-bezier(.4,0,.2,1);background:var(--card-2)}
  .country-pill:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,.06)}
  .country-pill.selected{background:var(--accent-bg);border-color:var(--accent);color:var(--accent);box-shadow:0 2px 8px var(--accent-glow);font-weight:700}
  .country-pill .pill-count{font-size:.65rem;color:var(--faint);font-weight:400}

  .filter-bar{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;background:var(--card-2);border-bottom:1px solid var(--border);align-items:center}
  .filter-bar select,.filter-bar input{border:1px solid var(--border);border-radius:var(--radius-xs);padding:7px 11px;font-size:.73rem;outline:none;background:var(--card);color:var(--ink);transition:var(--transition);font-family:inherit}
  .filter-bar select:focus,.filter-bar input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}

  #send-toast{position:fixed;bottom:28px;right:28px;background:var(--green);color:#fff;padding:14px 24px;border-radius:12px;font-size:.8rem;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,.25);opacity:0;transform:translateY(20px) scale(.95);transition:opacity .3s ease,transform .3s cubic-bezier(.4,0,.2,1);pointer-events:none;z-index:9999;backdrop-filter:blur(8px)}

  .tpl-panel{padding:20px}
  .tpl-label{font-size:.68rem;font-weight:700;color:var(--faint);display:block;margin-bottom:5px;letter-spacing:.07em;text-transform:uppercase}
  .tpl-input{width:100%;border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;font-size:.84rem;outline:none;background:var(--card);color:var(--ink);transition:var(--transition);font-family:inherit}
  .tpl-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
  .tpl-textarea{width:100%;border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;font-size:.82rem;font-family:inherit;outline:none;resize:vertical;line-height:1.6;background:var(--card);color:var(--ink);transition:var(--transition)}
  .tpl-textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
  .tpl-preview{padding:14px 16px;background:var(--bg-2);border-radius:var(--radius-sm);border:1px solid var(--border-2);margin-top:14px}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">&#9889;</div>
    <div>
      <div class="logo-name">Realman</div>
      <div class="logo-sub">Email Collector &amp; Campaign</div>
    </div>
  </div>
  <div class="hdr-right">
    <div class="hdr-controls">
      <button id="btn-collect" class="ctrl-btn hdr-btn green" onclick="ctrlAction('collect-start')">&#9654; Collect</button>
      <button id="btn-send" class="ctrl-btn hdr-btn blue" onclick="ctrlAction('campaign-start')">&#9993; Send</button>
      <button id="btn-stop" class="ctrl-btn hdr-btn red" onclick="ctrlAction('stop-all')">&#9724; Stop</button>
    </div>
    <div style="display:flex;gap:6px">
      <span class="badge ${collecting?'on':''}">
        <span class="pulse"></span>${collecting?'Collecting':'Idle'}
      </span>
      <span class="badge ${campaignRunning?'on':''}">
        <span class="pulse"></span>${campaignRunning?'Campaign On':'Campaign Off'}
      </span>
    </div>
    <button id="theme-toggle">
      <span id="theme-icon">&#127769;</span><span id="theme-label">Dark</span>
    </button>
  </div>
</header>

<main>
  <!-- ── Main Nav ──────────────────────────────────────────────────────── -->
  <div class="main-nav">
    <button class="nav-btn active" data-nav="dashboard" onclick="switchNav('dashboard')">
      <span class="nav-icon">&#9671;</span><span class="nav-label">Dashboard</span>
    </button>
    <button class="nav-btn" data-nav="collected" onclick="switchNav('collected')">
      <span class="nav-icon">&#128229;</span><span class="nav-label">Collected</span><span class="nav-count" id="visible-count">${real.length.toLocaleString()}</span>
    </button>
    <button class="nav-btn" data-nav="sent" onclick="switchNav('sent')">
      <span class="nav-icon">&#128228;</span><span class="nav-label">Sent</span><span class="nav-count" id="sent-count">0</span>
    </button>
    <div class="nav-sep"></div>
    <button class="nav-btn" data-nav="targets" onclick="switchNav('targets')">
      <span class="nav-icon">&#127760;</span><span class="nav-label">Targets</span>
    </button>
    <button class="nav-btn" data-nav="test" onclick="switchNav('test')">
      <span class="nav-icon">&#9993;</span><span class="nav-label">Test Email</span>
    </button>
    <div class="nav-sep"></div>
    <button class="nav-btn" data-nav="logs" onclick="switchNav('logs')">
      <span class="nav-icon">&#128196;</span><span class="nav-label">Logs</span>
    </button>
    <button class="nav-btn" data-nav="settings" onclick="switchNav('settings')">
      <span class="nav-icon">&#9881;</span><span class="nav-label">Settings</span>
    </button>
  </div>

  <div class="main-content">
  <!-- Toast -->
  <div id="send-toast"></div>

  <!-- ── Live Progress Banners (visible on ALL tabs) ── -->
  <div id="progress-banners" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
    <!-- Collecting Progress -->
    <div id="collect-banner" style="display:none;background:linear-gradient(135deg,rgba(16,185,129,.08),rgba(16,185,129,.02));border:1px solid rgba(16,185,129,.2);border-radius:var(--radius);padding:14px 18px;box-shadow:0 2px 12px rgba(16,185,129,.08)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:rgba(16,185,129,.15);font-size:.85rem;animation:spin 2s linear infinite">&#10227;</span>
          <div>
            <span style="font-size:.82rem;font-weight:700;color:#10b981;display:block">Collecting Emails</span>
            <span id="cb-detail" style="font-size:.7rem;color:var(--muted)">Starting&hellip;</span>
          </div>
        </div>
        <span id="cb-pct" style="font-size:.95rem;font-weight:800;color:#10b981;background:rgba(16,185,129,.1);padding:4px 12px;border-radius:99px">0%</span>
      </div>
      <div style="width:100%;height:5px;background:rgba(16,185,129,.1);border-radius:99px;overflow:hidden">
        <div id="cb-fill" style="width:0%;height:100%;background:linear-gradient(90deg,#10b981,#34d399);border-radius:99px;transition:width .5s ease"></div>
      </div>
    </div>
    <!-- Sending Progress -->
    <div id="send-banner" style="display:none;background:linear-gradient(135deg,rgba(59,130,246,.08),rgba(59,130,246,.02));border:1px solid rgba(59,130,246,.2);border-radius:var(--radius);padding:14px 18px;box-shadow:0 2px 12px rgba(59,130,246,.08)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:rgba(59,130,246,.15);font-size:.85rem">&#9993;</span>
          <div>
            <span style="font-size:.82rem;font-weight:700;color:#3b82f6;display:block">Sending Campaign</span>
            <span id="sb-detail" style="font-size:.7rem;color:var(--muted)">Waiting&hellip;</span>
          </div>
        </div>
        <span id="sb-count" style="font-size:.95rem;font-weight:800;color:#3b82f6;background:rgba(59,130,246,.1);padding:4px 12px;border-radius:99px">0 / 0</span>
      </div>
      <div style="width:100%;height:5px;background:rgba(59,130,246,.1);border-radius:99px;overflow:hidden">
        <div id="sb-fill" style="width:0%;height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);border-radius:99px;transition:width .5s ease"></div>
      </div>
    </div>
  </div>

  <!-- ════════════ DASHBOARD TAB ════════════ -->
  <div id="nav-dashboard" class="nav-page">
    <div class="stats">
      <div class="stat accent">
        <div class="stat-val">${real.length.toLocaleString()}</div>
        <div class="stat-lbl">Collected</div>
      </div>
      <div class="stat">
        <div class="stat-val">${totalSent.toLocaleString()}</div>
        <div class="stat-lbl">All-time Sent</div>
      </div>
      <div class="stat">
        <div class="stat-val">${daily}</div>
        <div class="stat-lbl">Sent Today</div>
      </div>
      <div class="stat">
        <div class="stat-val">${unsent.toLocaleString()}</div>
        <div class="stat-lbl">Unsent</div>
      </div>
      <div class="stat">
        <div class="stat-val">${DAILY_LIMIT}<span style="font-size:1rem;font-weight:600;color:var(--faint)">/day</span></div>
        <div class="stat-lbl">Daily Limit</div>
      </div>
      <div class="stat">
        <div class="stat-val" style="font-size:1.3rem">${nextSend}</div>
        <div class="stat-lbl">Next Send</div>
      </div>
    </div>

    <!-- Daily Stats Chart -->
    <div class="daily-chart">
      <div class="daily-chart-title">
        <span>&#9889; Daily Activity</span>
        <span style="margin-left:auto;font-size:.65rem;font-weight:600;color:var(--faint)">Last 7 days</span>
      </div>
      <div class="daily-summary" id="daily-summary">
        <div class="daily-summary-item">
          <div class="daily-summary-val" style="color:var(--green)" id="ds-sent-today">0</div>
          <div class="daily-summary-lbl">Sent Today</div>
        </div>
        <div class="daily-summary-item">
          <div class="daily-summary-val" style="color:var(--red)" id="ds-failed-today">0</div>
          <div class="daily-summary-lbl">Failed Today</div>
        </div>
        <div class="daily-summary-item">
          <div class="daily-summary-val" style="color:var(--accent)" id="ds-success-rate">—</div>
          <div class="daily-summary-lbl">Success Rate</div>
        </div>
      </div>
      <div class="daily-chart-grid" id="daily-chart-bars"></div>
      <div class="daily-legend">
        <div class="daily-legend-item"><span class="daily-legend-dot" style="background:var(--green)"></span> Sent</div>
        <div class="daily-legend-item"><span class="daily-legend-dot" style="background:var(--red)"></span> Failed</div>
      </div>
    </div>

    <!-- Sender Accounts -->
    <div class="sec-hdr" style="margin-bottom:12px">
      <span class="sec-title">&#128272; Sender Accounts</span>
      <button class="btn-action" onclick="recheckSmtp()" style="font-size:.72rem;padding:5px 14px">&#8635; Re-check</button>
    </div>
    <div id="accounts-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:22px"></div>

    <span id="ctrl-msg" style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:8px"></span>
    <!-- Status row -->
    <div class="status-row">
      <div class="status-item">
        <span id="dot-collect" class="status-dot"></span>
        <span id="label-collect">Collector: Idle</span>
      </div>
      <div class="status-item">
        <span id="dot-send" class="status-dot"></span>
        <span id="label-send">Campaign: Off</span>
      </div>
      <span id="sending-banner" style="display:none;font-size:.8rem;font-weight:700;color:var(--orange);animation:pulse 1s infinite">&#10227; Sending&hellip;</span>
    </div>

    <!-- Collector progress bar -->
    <div id="collect-progress" class="progress-wrap" style="display:none">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:.75rem;font-weight:700;color:var(--accent)">&#10227; Scanning GitHub&hellip;</span>
        <span id="cp-label" style="font-size:.72rem;color:var(--muted);font-weight:600"></span>
      </div>
      <div class="progress-bar">
        <div id="cp-fill" class="progress-fill" style="width:0%"></div>
      </div>
      <div id="cp-detail" style="font-size:.68rem;color:var(--faint);margin-top:5px;font-weight:500"></div>
    </div>

  </div>

  <!-- ════════════ COLLECTED TAB ════════════ -->
  <div id="nav-collected" class="nav-page" style="display:none">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span class="sec-title">Collected Emails</span>
      <a href="/export.csv" class="btn-action" style="text-decoration:none;font-size:.72rem;padding:5px 14px">&#11015; Export CSV</a>
    </div>

  <!-- Collected panel -->
  <div id="panel-collected" class="panel" style="overflow:hidden;margin-bottom:24px;border-top-left-radius:0;border-top-right-radius:0">
    <!-- Country/Region filter bar -->
    <div class="filter-bar" id="country-filter-bar">
      <select id="filter-region" style="min-width:100px">
        <option value="">All Regions</option>
        ${Object.keys(REGIONS).map(r => '<option value="'+r+'">'+r+'</option>').join('')}
      </select>
      <select id="filter-country" style="min-width:120px">
        <option value="">All Countries</option>
        ${Object.keys(countryCounts).sort().map(c => '<option value="'+c+'">'+c+' ('+countryCounts[c]+')</option>').join('')}
      </select>
      <input id="filter-telegram" placeholder="telegram&hellip;" style="width:100px">
      <span style="font-size:.68rem;color:var(--faint);margin-left:auto" id="filter-summary"></span>
    </div>
    <div class="table-scroll">
      <table id="email-table">
        <colgroup>
          <col style="width:12%"><col style="width:10%"><col style="width:16%"><col style="width:12%">
          <col style="width:7%"><col style="width:9%"><col style="width:4%"><col style="width:4%">
          <col style="width:3.5%"><col style="width:4%"><col style="width:8%"><col style="width:6%"><col style="width:4.5%">
        </colgroup>
        <thead>
          <tr>
            <th>User</th><th>Name</th><th>Email</th><th>Location</th><th>Country</th><th>Company</th><th>Flw</th><th>Rp</th><th>H</th><th>Sent</th><th>Telegram</th><th>Seen</th><th></th>
          </tr>
          <tr class="filter-row">
            <td><input class="col-filter" data-col="0" placeholder="login"></td>
            <td><input class="col-filter" data-col="1" placeholder="name"></td>
            <td><input class="col-filter" data-col="2" placeholder="email"></td>
            <td><input class="col-filter" data-col="3" placeholder="location"></td>
            <td></td>
            <td><input class="col-filter" data-col="4" placeholder="company"></td>
            <td><input class="col-filter" data-col="5" placeholder="min"></td>
            <td></td>
            <td>
              <select class="col-filter" data-col="7"><option value="">-</option><option value="yes">y</option><option value="no">n</option></select>
            </td>
            <td>
              <select class="col-filter" data-col="8"><option value="">-</option><option value="sent">y</option><option value="-">n</option></select>
            </td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        </thead>
        <tbody id="email-tbody">
          <tr><td colspan="13" style="text-align:center;color:var(--faint);padding:20px">Loading&hellip;</td></tr>
        </tbody>
      </table>
    </div>
    <!-- Pagination -->
    <div id="pagination" class="pagination"></div>
    <div id="table-footer" style="padding:10px 16px;font-size:.75rem;color:var(--faint)"></div>
  </div>
  </div>

  <!-- ════════════ SENT TAB ════════════ -->
  <div id="nav-sent" class="nav-page" style="display:none">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span class="sec-title">Sent History</span>
    </div>
    <div class="panel" style="overflow:hidden;margin-bottom:24px">
      <div class="filter-bar">
        <input id="sf-email" placeholder="email&hellip;" style="flex:1">
        <input id="sf-name" placeholder="name&hellip;" style="flex:1">
        <input id="sf-country" placeholder="country&hellip;" style="flex:1">
        <input id="sf-location" placeholder="location&hellip;" style="flex:1">
      </div>
      <div class="table-scroll">
      <table>
        <colgroup>
          <col style="width:13%"><col style="width:8%"><col style="width:16%"><col style="width:7%">
          <col style="width:5%"><col style="width:5%"><col style="width:12%"><col style="width:10%">
          <col style="width:14%"><col style="width:10%">
        </colgroup>
        <thead>
          <tr><th>User</th><th>Name</th><th>Email</th><th>Country</th><th>Type</th><th>Status</th><th>Sender</th><th>Subject</th><th>Preview</th><th>Sent At</th></tr>
        </thead>
        <tbody id="sent-tbody">
          <tr><td colspan="10" style="text-align:center;color:var(--faint);padding:20px">Loading&hellip;</td></tr>
        </tbody>
      </table>
      </div>
      <div id="sent-footer" style="padding:10px 16px;font-size:.75rem;color:var(--faint)"></div>
    </div>
  </div>

  <!-- ════════════ TARGETS TAB ════════════ -->
  <div id="nav-targets" class="nav-page" style="display:none">
    <div class="sec-hdr" style="margin-bottom:12px">
      <span class="sec-title">&#127760; Collection Targets</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span id="collect-target-count" style="font-size:.68rem;font-weight:600;color:var(--muted)"></span>
        <button id="target-save-btn" class="btn-action" onclick="saveTargets()" style="font-size:.72rem;padding:5px 16px">Save Targets</button>
      </div>
    </div>
    <div class="target-panel" id="target-panel">
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:14px">Select countries or regions, then click <b>Save Targets</b> before collecting.</div>
      <div id="target-regions"></div>
      <span id="target-msg" style="font-size:.78rem;color:var(--muted);margin-top:10px;display:block"></span>
    </div>

    <div class="sec-hdr" style="margin-top:30px;margin-bottom:12px">
      <span class="sec-title">&#128228; Send Targets</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span id="send-target-count" style="font-size:.68rem;font-weight:600;color:var(--muted)"></span>
        <button id="send-target-save-btn" class="btn-action" onclick="saveSendTargets()" style="font-size:.72rem;padding:5px 16px">Save Send Targets</button>
      </div>
    </div>
    <div class="target-panel" id="send-target-panel">
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:14px">Select countries to <b>send emails to</b>. If none selected, sends to all collected emails.</div>
      <div id="send-target-regions"></div>
      <span id="send-target-msg" style="font-size:.78rem;color:var(--muted);margin-top:10px;display:block"></span>
    </div>
  </div>

  <!-- ════════════ TEST EMAIL TAB ════════════ -->
  <div id="nav-test" class="nav-page" style="display:none">
    <div class="sec-hdr" style="margin-bottom:14px">
      <span class="sec-title">&#9993; Send Test Email</span>
    </div>
    <div class="panel" style="padding:24px;margin-bottom:16px;max-width:700px">
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:.72rem;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">Recipient</label>
          <input id="test-email-to" type="email" placeholder="Recipient email address" style="width:100%;padding:9px 14px;font-size:.82rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--ink);outline:none" />
        </div>
        <div>
          <label style="font-size:.72rem;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">Send From</label>
          <select id="test-email-from" style="width:100%;padding:9px 14px;font-size:.82rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--ink)"></select>
        </div>
        <div>
          <label style="font-size:.72rem;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">Subject</label>
          <input id="test-email-subject" type="text" placeholder="Email subject" style="width:100%;padding:9px 14px;font-size:.82rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--ink);outline:none" />
        </div>
        <div>
          <label style="font-size:.72rem;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">Message Body</label>
          <textarea id="test-email-body" rows="8" placeholder="Type your message here..." style="width:100%;padding:9px 14px;font-size:.82rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--ink);outline:none;resize:vertical;font-family:inherit;line-height:1.6"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:4px">
          <button class="btn-action accent" onclick="sendTestEmail()" id="test-email-btn" style="font-size:.8rem;padding:8px 24px">&#9993; Send Test</button>
          <span id="test-email-msg" style="font-size:.78rem;color:var(--muted);display:none"></span>
        </div>
      </div>
    </div>
    <div class="panel" style="padding:16px;max-width:700px">
      <p style="font-size:.75rem;color:var(--muted);margin:0">
        Test emails are recorded in Sent History with type <b>Test</b>. They do not count toward daily campaign limits but recipients who receive a test will not get a campaign email (no duplicates).
      </p>
    </div>
  </div>

  <!-- ════════════ LOGS TAB ════════════ -->
  <div id="nav-logs" class="nav-page" style="display:none">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="sec-title">Live Log</span>
        <span id="log-count" style="font-size:.62rem;font-weight:700;background:var(--bg-2);color:var(--faint);padding:2px 8px;border-radius:99px"></span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span id="log-updated" style="color:var(--faint);font-size:.68rem"></span>
        <label style="display:flex;align-items:center;gap:4px;font-size:.7rem;color:var(--muted);cursor:pointer;user-select:none">
          <input type="checkbox" id="log-autoscroll" checked style="accent-color:var(--accent)"> Auto-scroll
        </label>
        <button class="btn-action" onclick="fetchLogs()" style="font-size:.72rem;padding:4px 12px">&#8635; Refresh</button>
        <button class="btn-upload" onclick="clearLogView()" style="font-size:.72rem;padding:4px 12px">Clear</button>
      </div>
    </div>
    <div class="log-wrap" style="margin-bottom:24px">
      <div class="log-scroll" id="log-container" style="max-height:calc(100vh - 200px)">
        <div class="log-line" style="color:var(--faint)">Loading&hellip;</div>
      </div>
    </div>
  </div>

  <!-- ════════════ SETTINGS TAB ════════════ -->
  <div id="nav-settings" class="nav-page" style="display:none">

    <!-- Safety Limits -->
    <div class="sec-hdr" style="margin-bottom:12px">
      <span class="sec-title">&#128274; Sending Safety Limits</span>
    </div>
    <div class="panel" style="padding:16px;margin-bottom:24px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
        <div style="background:var(--bg-3);border-radius:var(--radius-sm);padding:12px;text-align:center">
          <div style="font-size:1.3rem;font-weight:700;color:var(--accent)">${DAILY_LIMIT}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:2px">Max emails/day (global)</div>
        </div>
        <div style="background:var(--bg-3);border-radius:var(--radius-sm);padding:12px;text-align:center">
          <div style="font-size:1.3rem;font-weight:700;color:var(--accent)">${PER_ACCOUNT_DAILY}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:2px">Max/day per account</div>
        </div>
        <div style="background:var(--bg-3);border-radius:var(--radius-sm);padding:12px;text-align:center">
          <div style="font-size:1.3rem;font-weight:700;color:var(--accent)">${PER_ACCOUNT_HOURLY}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:2px">Max/hour per account</div>
        </div>
        <div style="background:var(--bg-3);border-radius:var(--radius-sm);padding:12px;text-align:center">
          <div style="font-size:1.3rem;font-weight:700;color:var(--accent)">${Math.round(MIN_INTERVAL_MS/60000)} min</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:2px">Min gap between sends</div>
        </div>
      </div>
      <p style="color:var(--muted);font-size:.75rem;margin-top:12px;margin-bottom:0">
        Warm-up Phase 1 (weeks 1–2). Accounts auto-disable after ${CONSECUTIVE_FAIL_MAX} consecutive failures. No duplicates — each recipient receives only one email.
      </p>
    </div>

    <!-- Email Template Editor -->
    <div class="sec-hdr" style="margin-top:28px;margin-bottom:12px">
      <span class="sec-title">&#9993; Email Template</span>
    </div>
    <div class="panel tpl-panel" id="template-panel" style="margin-bottom:24px">
      <div id="tpl-lock-msg" style="display:none;align-items:center;gap:8px;padding:10px 14px;background:var(--red-bg,rgba(220,38,38,.08));border:1px solid var(--red,#dc2626);border-radius:var(--radius-sm);margin-bottom:12px;font-size:.78rem;color:var(--red,#dc2626);font-weight:600">
        &#9888; Campaign is running — stop it first to edit the template.
      </div>
      <div style="margin-bottom:12px">
        <label class="tpl-label">Subject</label>
        <input id="tpl-subject" class="tpl-input" value="">
      </div>
      <div style="margin-bottom:12px">
        <label class="tpl-label">Body <span style="font-weight:400;color:var(--faint);text-transform:none;letter-spacing:0">(use {name} for personalization)</span></label>
        <textarea id="tpl-body" rows="9" class="tpl-textarea"></textarea>
      </div>
      <div style="display:flex;gap:12px;align-items:center">
        <button onclick="saveTemplate()" class="ctrl-btn accent" style="font-size:.8rem;padding:7px 18px">Save Template</button>
        <span id="tpl-msg" style="font-size:.78rem;color:var(--muted)"></span>
      </div>
      <div class="tpl-preview">
        <div style="font-size:.68rem;font-weight:700;color:var(--faint);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Preview (sample name)</div>
        <div id="tpl-preview" style="font-size:.8rem;color:var(--ink-2);white-space:pre-wrap;font-family:inherit;line-height:1.6"></div>
      </div>
    </div>

    <!-- CSV Import -->
    <div class="sec-hdr" style="margin-bottom:10px">
      <span class="sec-title">Import CSV</span>
    </div>
    <div class="panel" style="padding:16px;margin-bottom:24px">
      <p style="color:var(--muted);font-size:.8rem;margin-bottom:12px">
        Upload a CSV file with an <code>email</code> column (and optionally <code>name</code>, <code>login</code>, <code>location</code>).
      </p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="btn-upload" for="csv-file">Choose CSV</label>
        <input type="file" id="csv-file" accept=".csv,text/csv" style="display:none">
        <span id="csv-name" style="color:var(--muted);font-size:.8rem">No file chosen</span>
        <button class="btn-action" id="csv-import-btn" disabled>Import</button>
        <span id="csv-msg" style="font-size:.8rem"></span>
      </div>
    </div>
  </div>
  </div>
</main>

<footer>
  <div style="display:flex;align-items:center;justify-content:center;gap:8px">
    <span style="font-weight:700;color:var(--muted)">&#9889; Realman</span>
    <span style="color:var(--border)">&middot;</span>
    <a href="/">Refresh</a>
    <span style="color:var(--border)">&middot;</span>
    <span id="footer-uptime" style="color:var(--faint);font-size:.68rem"></span>
  </div>
</footer>
<script>
// ── Theme ────────────────────────────────────────────────────────────────
(function(){
  function applyTheme(t){
    document.documentElement.setAttribute('data-theme',t);
    localStorage.setItem('rm-theme',t);
    var ic=document.getElementById('theme-icon'), lb=document.getElementById('theme-label');
    if(ic)ic.innerHTML=t==='dark'?'&#9728;':'&#127769;';
    if(lb)lb.textContent=t==='dark'?'Light':'Dark';
  }
  applyTheme(localStorage.getItem('rm-theme')||'light');
  document.getElementById('theme-toggle').addEventListener('click',function(){
    applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');
  });
})();

// ── Status dots ──────────────────────────────────────────────────────────
function setStatusDot(id,active,label){
  var dot=document.getElementById('dot-'+id), lbl=document.getElementById('label-'+id);
  if(!dot||!lbl)return;
  if(active){
    dot.style.background=id==='collect'?'var(--green)':'var(--blue)';
    dot.classList.add('active');
    lbl.style.color='var(--ink)';
  } else {
    dot.style.background='var(--border)';
    dot.classList.remove('active');
    lbl.style.color='var(--muted)';
  }
  lbl.textContent=label;
}

// ── Polling ──────────────────────────────────────────────────────────────
var _lastSentEmail=null, _pollTimer=null, campaignActiveHint=false, _lastCollected=0, _lastSentCount=0;
function schedulePoll(ms){clearTimeout(_pollTimer);_pollTimer=setTimeout(pollStatus,ms)}
async function pollStatus(){
  try{
    var r=await fetch('/api/stats');var d=await r.json();
    setStatusDot('collect',d.collecting,d.collecting?'Collecting…':'Collector: Idle');
    if(d.sendingNow){
      setStatusDot('send',true,'Sending to '+d.sendingNow.email+'…');
    }else{
      setStatusDot('send',d.campaignRunning,d.campaignRunning?'Campaign Running':'Campaign: Off');
    }
    if(d.lastSent&&d.lastSent.email!==_lastSentEmail){
      _lastSentEmail=d.lastSent.email;
      showToast('✓ Sent to '+d.lastSent.email);
      if(currentNav==='sent')fetchSent();
    }
    // Update stat tiles
    var statVals=document.querySelectorAll('.stat-val');
    if(statVals.length>=4){
      statVals[0].textContent=d.collected.toLocaleString();
      statVals[1].textContent=d.sent.toLocaleString();
      statVals[2].textContent=d.daily;
      statVals[3].textContent=d.unsent.toLocaleString();
    }
    // ── Update logs tab if active ──
    if(currentNav==='logs'&&d.logs){
      var lc=document.getElementById('log-container');
      var lu=document.getElementById('log-updated');
      var lcnt=document.getElementById('log-count');
      if(lc)lc.innerHTML=d.logs.map(logLineHTML).join('');
      if(lu)lu.textContent='Updated '+new Date().toLocaleTimeString();
      if(lcnt)lcnt.textContent=d.logs.length+' entries';
      var autoS=document.getElementById('log-autoscroll');
      if(lc&&autoS&&autoS.checked)lc.scrollTop=lc.scrollHeight;
    }
    // ── Collect progress banner ──
    var cbEl=document.getElementById('collect-banner');
    if(cbEl){
      if(d.collecting&&d.collectProgress){
        var cp=d.collectProgress;
        cbEl.style.display='';
        document.getElementById('cb-fill').style.width=cp.pct.toFixed(2)+'%';
        document.getElementById('cb-pct').textContent=cp.pct.toFixed(1)+'%';
        document.getElementById('cb-detail').textContent=
          'Segment '+(cp.seg+1)+'/'+cp.total+' · page '+cp.page+'/10 · '+d.collected.toLocaleString()+' emails found';
      }else cbEl.style.display='none';
    }
    // ── Send progress banner ──
    var sbEl=document.getElementById('send-banner');
    if(sbEl){
      if(d.campaignRunning){
        sbEl.style.display='';
        var pct=d.dailyLimit>0?Math.min(100,(d.daily/d.dailyLimit)*100):0;
        document.getElementById('sb-fill').style.width=pct.toFixed(1)+'%';
        document.getElementById('sb-count').textContent=d.daily+' / '+d.dailyLimit+' today';
        var detail='';
        if(d.sendingNow) detail='Sending to '+d.sendingNow.email+' via '+d.sendingNow.via+'…';
        else if(d.nextSendAt){
          var ms=new Date(d.nextSendAt).getTime()-Date.now();
          if(ms>0) detail='Next send in '+Math.ceil(ms/60000)+' min · min gap: '+d.minIntervalMin+' min';
          else detail='Sending soon…';
        }else detail='Waiting for next interval…';
        if(d.lastSent) detail+=' · Last: '+d.lastSent.email;
        document.getElementById('sb-detail').textContent=detail;
      }else sbEl.style.display='none';
    }
    // Old progress bar compat
    var cpWrap=document.getElementById('collect-progress');
    if(cpWrap){
      if(d.collecting&&d.collectProgress){
        var cp2=d.collectProgress;
        cpWrap.style.display='';
        document.getElementById('cp-fill').style.width=cp2.pct.toFixed(2)+'%';
        document.getElementById('cp-label').textContent=cp2.pct.toFixed(1)+'%';
        document.getElementById('cp-detail').textContent=
          'Segment '+(cp2.seg+1)+' / '+cp2.total+' · page '+cp2.page+'/10 · '+d.collected.toLocaleString()+' emails';
      }else cpWrap.style.display='none';
    }
    var btnC=document.getElementById('btn-collect'),btnS=document.getElementById('btn-send');
    if(btnC)btnC.innerHTML=d.collecting?'↻ Collecting…':'▶ Get Emails';
    if(btnS)btnS.innerHTML=d.sendingNow?'↻ Sending…':(d.campaignRunning?'↻ Campaign On':'✉ Send Emails');
    var tplSubj=document.getElementById('tpl-subject'),tplBody=document.getElementById('tpl-body'),tplSaveBtn=document.querySelector('#template-panel .ctrl-btn');
    var tplLock=document.getElementById('tpl-lock-msg');
    if(d.campaignRunning){
      if(tplSubj)tplSubj.disabled=true;
      if(tplBody)tplBody.disabled=true;
      if(tplSaveBtn)tplSaveBtn.disabled=true;
      if(tplLock)tplLock.style.display='flex';
    }else{
      if(tplSubj)tplSubj.disabled=false;
      if(tplBody)tplBody.disabled=false;
      if(tplSaveBtn)tplSaveBtn.disabled=false;
      if(tplLock)tplLock.style.display='none';
    }
    document.getElementById('visible-count').textContent=d.collected.toLocaleString();
    var sc=document.getElementById('sent-count');if(sc)sc.textContent=d.sent.toLocaleString();
    // Daily chart
    if(d.dailyHistory){
      var dsS=document.getElementById('ds-sent-today');
      var dsF=document.getElementById('ds-failed-today');
      var dsR=document.getElementById('ds-success-rate');
      if(dsS)dsS.textContent=d.daily;
      if(dsF)dsF.textContent=d.dailyFailed||0;
      var totalAttempts=d.daily+(d.dailyFailed||0);
      if(dsR)dsR.textContent=totalAttempts>0?Math.round((d.daily/totalAttempts)*100)+'%':'—';
      var chart=document.getElementById('daily-chart-bars');
      if(chart){
        var maxVal=1;
        d.dailyHistory.forEach(function(h){maxVal=Math.max(maxVal,h.sent,h.failed)});
        var html='';
        d.dailyHistory.forEach(function(h){
          var sH=Math.max(2,Math.round((h.sent/maxVal)*90));
          var fH=Math.max(0,Math.round((h.failed/maxVal)*90));
          if(h.failed===0)fH=0;
          html+='<div class="daily-bar-group">';
          html+='<div class="daily-bar-wrap">';
          html+='<div class="daily-bar sent-bar" style="height:'+sH+'px" title="Sent: '+h.sent+'"><span class="daily-bar-val" style="color:var(--green)">'+h.sent+'</span></div>';
          if(fH>0)html+='<div class="daily-bar fail-bar" style="height:'+fH+'px" title="Failed: '+h.failed+'"><span class="daily-bar-val" style="color:var(--red)">'+h.failed+'</span></div>';
          html+='</div>';
          html+='<div class="daily-bar-label">'+h.label+'</div>';
          html+='</div>';
        });
        chart.innerHTML=html;
      }
    }
    if(d.accounts){
      var list=document.getElementById('accounts-list');
      var sel=document.getElementById('test-email-from');
      if(list){
        list.innerHTML=d.accounts.map(function(a){
          var statusColor=!a.configured?'var(--faint)':a.ready?'var(--green)':'var(--red)';
          var statusText=!a.configured?'No Password':a.ready?'Ready':'Error';
          var toggleChecked=a.enabled?'checked':'';
          var toggleDisabled=!a.ready?'disabled':'';
          return '<div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-sm);transition:var(--transition)" onmouseenter="this.style.boxShadow=\'var(--shadow)\'" onmouseleave="this.style.boxShadow=\'var(--shadow-sm)\'">'
            +'<div style="width:10px;height:10px;border-radius:50%;background:'+statusColor+';box-shadow:0 0 6px '+statusColor+';flex-shrink:0"></div>'
            +'<div style="flex:1;min-width:0">'
            +'<div style="font-size:.82rem;font-weight:700;color:var(--ink)">'+a.user+'</div>'
            +'<div style="font-size:.68rem;color:var(--faint);margin-top:2px">'+a.host+':'+a.port
            +(a.error&&!a.ready?' &mdash; <span style="color:var(--red)">'+a.error.slice(0,60)+'</span>':'')
            +'</div></div>'
            +'<span style="font-size:.66rem;font-weight:700;padding:3px 10px;border-radius:99px;letter-spacing:.03em;background:'
            +(!a.configured?'rgba(150,150,150,.12)':a.ready?'rgba(34,197,94,.12)':'rgba(239,68,68,.12)')
            +';color:'+statusColor+'">'+statusText+'</span>'
            +'<label style="position:relative;width:36px;height:20px;flex-shrink:0;cursor:'+(a.ready?'pointer':'not-allowed')+'">'
            +'<input type="checkbox" '+toggleChecked+' '+toggleDisabled+' onchange="toggleAccount(\\\''+a.user+'\\\',this.checked)" style="display:none">'
            +'<span style="position:absolute;inset:0;border-radius:10px;transition:.2s;background:'+(a.enabled?'var(--accent)':'var(--border)')+'">'
            +'<span style="position:absolute;top:2px;left:'+(a.enabled?'18px':'2px')+';width:16px;height:16px;border-radius:50%;background:white;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>'
            +'</span></label>'
            +'</div>';
        }).join('');
      }
      if(sel){
        var prev=sel.value;
        sel.innerHTML=d.accounts.filter(function(a){return a.ready}).map(function(a){
          return '<option value="'+a.user+'"'+(a.user===prev?' selected':'')+'>'+a.user+'</option>';
        }).join('');
      }
    }
    if(d.collected!==_lastCollected||d.sent!==_lastSentCount){
      _lastCollected=d.collected;_lastSentCount=d.sent;
      if(currentNav==='collected')fetchEmails();
      else if(currentNav==='sent')fetchSent();
    }
    var uf=document.getElementById('footer-uptime');
    if(uf&&d.uptime){
      var s=Math.floor(d.uptime/1000),m=Math.floor(s/60),h=Math.floor(m/60),dy=Math.floor(h/24);
      uf.textContent='Uptime: '+(dy>0?dy+'d ':'')+(h%24)+'h '+(m%60)+'m';
    }
    schedulePoll((campaignActiveHint||d.collecting)?3000:10000);return;
  }catch(e){}
  schedulePoll(campaignActiveHint?3000:10000);
}
function showToast(msg){
  var t=document.getElementById('send-toast');if(!t)return;
  t.textContent=msg;t.style.opacity='1';t.style.transform='translateY(0) scale(1)';
  setTimeout(function(){t.style.opacity='0';t.style.transform='translateY(20px) scale(.95)'},4000);
}
async function recheckSmtp(){
  showToast('Re-checking all accounts…');
  try{await fetch('/api/smtp-recheck',{method:'POST'});
    setTimeout(pollStatus,3000);
  }catch(e){showToast('Error: '+e.message)}
}
async function toggleAccount(user,enabled){
  try{var r=await fetch('/api/account-toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:user,enabled:enabled})});
    var d=await r.json();
    if(!d.ok){showToast(d.msg);pollStatus();return}
    showToast(d.msg);pollStatus();
  }catch(e){showToast('Error: '+e.message);pollStatus()}
}
async function sendTestEmail(){
  var inp=document.getElementById('test-email-to');
  var subj=document.getElementById('test-email-subject');
  var body=document.getElementById('test-email-body');
  var fromSel=document.getElementById('test-email-from');
  var btn=document.getElementById('test-email-btn');
  var msg=document.getElementById('test-email-msg');
  var to=(inp.value||'').trim();
  if(!to||to.indexOf('@')<1){msg.style.display='inline';msg.style.color='var(--red)';msg.textContent='Enter a valid email.';return}
  if(!(subj.value||'').trim()){msg.style.display='inline';msg.style.color='var(--red)';msg.textContent='Enter a subject.';return}
  btn.disabled=true;btn.textContent='Sending…';msg.style.display='inline';msg.style.color='var(--muted)';msg.textContent='';
  var payload={to:to,subject:subj.value.trim(),body:body.value.trim()};
  if(fromSel&&fromSel.value)payload.from=fromSel.value;
  try{var r=await fetch('/api/send-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    var d=await r.json();
    msg.style.color=d.ok?'var(--green)':'var(--red)';msg.textContent=d.ok?d.msg:d.msg;
    if(d.ok)showToast(d.msg);
  }catch(e){msg.style.color='var(--red)';msg.textContent='Error: '+e.message}
  btn.disabled=false;btn.textContent='\\u2709 Send Test';
}
async function loadTestDefaults(){
  try{var r=await fetch('/api/template');var d=await r.json();
    var s=document.getElementById('test-email-subject');var b=document.getElementById('test-email-body');
    if(s&&!s.value)s.value=d.subject||'';
    if(b&&!b.value)b.value=d.body||'';
  }catch(e){}
}
loadTestDefaults();
schedulePoll(3000);pollStatus();loadTargets();

// ── Control buttons ──────────────────────────────────────────────────────
async function ctrlAction(action){
  var msg=document.getElementById('ctrl-msg');
  document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=true});
  msg.style.color='var(--muted)';msg.textContent='…';
  try{
    var res=await fetch('/ctrl/'+action,{method:'POST'});var data=await res.json();
    msg.style.color=data.ok?'var(--green)':'var(--red)';
    msg.textContent=data.msg||(data.ok?'Done.':'Error');
    if(action==='campaign-start'){campaignActiveHint=true;schedulePoll(2000)}
    if(action==='stop-all')campaignActiveHint=false;
    pollStatus();
  }catch(e){msg.style.color='var(--red)';msg.textContent='Failed: '+e.message}
  document.querySelectorAll('.ctrl-btn').forEach(function(b){b.disabled=false});
}

// ── Tabs ─────────────────────────────────────────────────────────────────
// ── Main Navigation ──────────────────────────────────────────────────────
var currentNav='dashboard';
function switchNav(nav){
  currentNav=nav;
  document.querySelectorAll('.nav-page').forEach(function(p){p.style.display='none'});
  document.getElementById('nav-'+nav).style.display='';
  document.querySelectorAll('.nav-btn').forEach(function(b){b.classList.remove('active')});
  document.querySelector('[data-nav="'+nav+'"]').classList.add('active');
  if(nav==='collected')fetchEmails();
  if(nav==='sent')fetchSent();
  if(nav==='targets')loadTargets();
  if(nav==='test')loadTestDefaults();
  if(nav==='logs')fetchLogs();
  try{localStorage.setItem('rm-nav',nav)}catch(e){}
}
(function(){try{var n=localStorage.getItem('rm-nav');if(n&&document.getElementById('nav-'+n))switchNav(n)}catch(e){}})();

// ── Pagination state ────────────────────────────────────────────────────
var _currentPage=1, _pageSize=50, _totalPages=1;

// ── Target country/region picker ─────────────────────────────────────────
var _regions={};var _countries=[];var _selected=new Set();
async function loadTargets(){
  try{
    var r=await fetch('/api/targets');var d=await r.json();
    _regions=d.regions;_countries=d.countries;_selected=new Set(d.selected);
    _sendSelected=new Set(d.sendSelected||[]);
    renderTargets();renderSendTargets();
  }catch(e){}
}
function renderTargets(){
  var html='';
  for(var reg in _regions){
    var clist=_regions[reg];
    var allSel=clist.every(function(c){return _selected.has(c)});
    var someSel=clist.some(function(c){return _selected.has(c)});
    html+='<div class="region-group">';
    html+='<div class="region-header" onclick="toggleRegion(\\\''+reg+'\\\')">';
    html+='<input type="checkbox" class="region-check" '+(allSel?'checked':'')+(someSel&&!allSel?' style="opacity:.5"':'')
      +' onclick="event.stopPropagation();toggleRegion(\\\''+reg+'\\\')">';
    var selCount=clist.filter(function(c){return _selected.has(c)}).length;
    html+='<h3>'+reg+'</h3>';
    html+='<span class="region-count">'+selCount+' / '+clist.length+'</span>';
    html+='</div>';
    html+='<div class="country-pills">';
    for(var i=0;i<clist.length;i++){
      var c=clist[i];
      html+='<span class="country-pill'+((_selected.has(c))?' selected':'')+'" onclick="toggleCountry(\\\''+c+'\\\')">'
        +c+'</span>';
    }
    html+='</div></div>';
  }
  document.getElementById('target-regions').innerHTML=html;
  var ctc=document.getElementById('collect-target-count');
  if(ctc)ctc.textContent=_selected.size?_selected.size+' selected':'';
}
function toggleRegion(reg){
  var clist=_regions[reg];if(!clist)return;
  var allSel=clist.every(function(c){return _selected.has(c)});
  clist.forEach(function(c){if(allSel)_selected.delete(c);else _selected.add(c)});
  renderTargets();
}
function toggleCountry(c){
  if(_selected.has(c))_selected.delete(c);else _selected.add(c);
  renderTargets();
}
async function saveTargets(){
  var msg=document.getElementById('target-msg');
  var arr=Array.from(_selected);
  if(!arr.length){msg.style.color='var(--red)';msg.textContent='Select at least one country.';return}
  msg.style.color='var(--muted)';msg.textContent='Saving…';
  try{
    var r=await fetch('/api/targets',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({countries:arr})});
    var d=await r.json();
    msg.style.color=d.ok?'var(--green)':'var(--red)';msg.textContent=d.msg;
  }catch(e){msg.style.color='var(--red)';msg.textContent='Error: '+e.message}
}
loadTargets();

// ── Send Target country/region picker ────────────────────────────────────
var _sendSelected=new Set();
function renderSendTargets(){
  var html='';
  for(var reg in _regions){
    var clist=_regions[reg];
    var allSel=clist.every(function(c){return _sendSelected.has(c)});
    var someSel=clist.some(function(c){return _sendSelected.has(c)});
    html+='<div class="region-group">';
    html+='<div class="region-header" onclick="toggleSendRegion(\\\''+reg+'\\\')">';
    html+='<input type="checkbox" class="region-check" '+(allSel?'checked':'')+(someSel&&!allSel?' style="opacity:.5"':'')
      +' onclick="event.stopPropagation();toggleSendRegion(\\\''+reg+'\\\')">';
    var selCount2=clist.filter(function(c){return _sendSelected.has(c)}).length;
    html+='<h3>'+reg+'</h3>';
    html+='<span class="region-count">'+selCount2+' / '+clist.length+'</span>';
    html+='</div>';
    html+='<div class="country-pills">';
    for(var i=0;i<clist.length;i++){
      var c=clist[i];
      html+='<span class="country-pill'+((_sendSelected.has(c))?' selected':'')+'" onclick="toggleSendCountry(\\\''+c+'\\\')">'
        +c+'</span>';
    }
    html+='</div></div>';
  }
  document.getElementById('send-target-regions').innerHTML=html;
  var stc=document.getElementById('send-target-count');
  if(stc)stc.textContent=_sendSelected.size?_sendSelected.size+' selected':'all countries';
}
function toggleSendRegion(reg){
  var clist=_regions[reg];if(!clist)return;
  var allSel=clist.every(function(c){return _sendSelected.has(c)});
  clist.forEach(function(c){if(allSel)_sendSelected.delete(c);else _sendSelected.add(c)});
  renderSendTargets();
}
function toggleSendCountry(c){
  if(_sendSelected.has(c))_sendSelected.delete(c);else _sendSelected.add(c);
  renderSendTargets();
}
async function saveSendTargets(){
  var msg=document.getElementById('send-target-msg');
  var arr=Array.from(_sendSelected);
  msg.style.color='var(--muted)';msg.textContent='Saving…';
  try{
    var r=await fetch('/api/send-targets',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({countries:arr})});
    var d=await r.json();
    msg.style.color=d.ok?'var(--green)':'var(--red)';msg.textContent=d.msg;
  }catch(e){msg.style.color='var(--red)';msg.textContent='Error: '+e.message}
}

// ── Country/Region filter for collected table ────────────────────────────
var filterRegionEl=document.getElementById('filter-region');
var filterCountryEl=document.getElementById('filter-country');
var filterTelegramEl=document.getElementById('filter-telegram');
if(filterRegionEl)filterRegionEl.addEventListener('change',function(){
  if(this.value)filterCountryEl.value='';
  triggerFetch();
});
if(filterCountryEl)filterCountryEl.addEventListener('change',function(){
  if(this.value)filterRegionEl.value='';
  triggerFetch();
});
if(filterTelegramEl)filterTelegramEl.addEventListener('input',function(){
  clearTimeout(fetchTimer);fetchTimer=setTimeout(fetchEmails,350);
});
function triggerFetch(){_currentPage=1;clearTimeout(fetchTimer);fetchTimer=setTimeout(fetchEmails,100)}

// ── Table rendering ──────────────────────────────────────────────────────
var tbody=document.getElementById('email-tbody');
var footer=document.getElementById('table-footer');
var vcnt=document.getElementById('visible-count');
var fetchTimer=null;

function buildRow(e){
  var avUrl=e.avatar?(e.avatar+(e.avatar.indexOf('?')>-1?'&':'?')+'s=56'):'';
  var av=avUrl
    ?'<img class="av" src="'+avUrl+'" alt="'+(e.login||'')+'" loading="lazy" referrerpolicy="no-referrer">'
    :'<span class="av-ph">'+(e.login||'?').slice(0,1).toUpperCase()+'</span>';
  var extras=[];
  if(e.phone)extras.push('Phone: '+e.phone);
  if(e.linkedin)extras.push('LinkedIn: '+e.linkedin);
  var tip=extras.length?' title="'+extras.join(' | ')+'"':'';
  var userCell=av+(e.login
    ?'<a href="'+(e.profile||'')+'" target="_blank" style="color:var(--accent);font-size:.7rem;font-weight:600"'+tip+'>@'+e.login+'</a>'
    :'&mdash;');
  var tgCell=e.telegram?'<a href="https://t.me/'+e.telegram+'" target="_blank" style="color:var(--blue);font-size:.68rem">@'+e.telegram+'</a>':'&mdash;';
  var seenAt=(e.seen_at||'').replace('T',' ').slice(0,10);
  return '<tr>'
    +'<td>'+userCell+'</td>'
    +'<td style="font-size:.72rem" title="'+(e.name||'')+'">'+((e.name)||'&mdash;')+'</td>'
    +'<td><a href="mailto:'+(e.email||'')+'" style="color:var(--accent);font-size:.7rem" title="'+(e.email||'')+'">'+(e.email||'')+'</a></td>'
    +'<td style="font-size:.7rem;color:var(--muted)" title="'+(e.location||'')+'">'+(e.location||'&mdash;')+'</td>'
    +'<td><span style="background:var(--accent-bg);color:var(--accent);padding:1px 6px;border-radius:99px;font-size:.62rem;font-weight:600">'+(e.country||'?')+'</span></td>'
    +'<td style="font-size:.7rem;color:var(--muted)" title="'+(e.company||'')+'">'+(e.company||'&mdash;')+'</td>'
    +'<td style="font-size:.7rem;text-align:center">'+(e.followers||0).toLocaleString()+'</td>'
    +'<td style="font-size:.7rem;text-align:center">'+(e.repos||0)+'</td>'
    +'<td style="text-align:center">'+(e.hireable?'<span style="color:var(--green);font-size:.66rem;font-weight:700">&#10003;</span>':'&mdash;')+'</td>'
    +'<td style="text-align:center">'+(e.is_sent?'<span style="background:rgba(16,185,129,.12);color:#10b981;padding:1px 6px;border-radius:99px;font-size:.6rem;font-weight:700">Sent</span>':'<span style="color:var(--border);font-size:.68rem">&ndash;</span>')+'</td>'
    +'<td>'+tgCell+'</td>'
    +'<td style="font-size:.64rem;color:var(--faint)">'+seenAt+'</td>'
    +'<td style="text-align:center"><a href="/avatar/'+e.login+'.png" title="Download avatar" style="color:var(--accent);font-size:.68rem;text-decoration:none">&#8681;</a></td>'
    +'</tr>';
}

async function fetchEmails(page){
  if(page!==undefined)_currentPage=page;
  var params=new URLSearchParams();
  params.set('page',_currentPage);
  params.set('pageSize',_pageSize);
  document.querySelectorAll('.col-filter').forEach(function(el){
    var v=el.value.trim();if(!v)return;
    var col=el.dataset.col;
    if(col==='0')params.set('login',v);
    else if(col==='1')params.set('name',v);
    else if(col==='2')params.set('email',v);
    else if(col==='3')params.set('location',v);
    else if(col==='4')params.set('company',v);
    else if(col==='5')params.set('minFollowers',v);
    else if(col==='7')params.set('hireable',v);
    else if(col==='8')params.set('sent',el.value);
  });
  var reg=filterRegionEl?filterRegionEl.value:'';
  var cty=filterCountryEl?filterCountryEl.value:'';
  if(cty){params.set('country',cty)}
  else if(reg&&_regions[reg]){params.set('country',_regions[reg].join(','))}
  var tg=filterTelegramEl?filterTelegramEl.value.trim():'';
  if(tg)params.set('telegram',tg);

  try{
    var res=await fetch('/api/emails?'+params.toString());var data=await res.json();
    _totalPages=data.totalPages||1;
    _currentPage=data.page||1;
    tbody.innerHTML=data.rows.length
      ?data.rows.map(buildRow).join('')
      :'<tr><td colspan="15" style="text-align:center;color:var(--faint);padding:20px">No results</td></tr>';
    vcnt.textContent='('+data.total.toLocaleString()+')';
    renderPagination(data);
    var sum=document.getElementById('filter-summary');
    if(sum)sum.textContent=data.rows.length+' of '+data.total.toLocaleString()+(reg?' · '+reg:'')+(cty?' · '+cty:'');
  }catch(err){
    tbody.innerHTML='<tr><td colspan="15" style="color:var(--red);padding:16px">Error: '+err.message+'</td></tr>';
  }
}
function renderPagination(data){
  var pg=document.getElementById('pagination');if(!pg)return;
  var p=data.page,tp=data.totalPages,total=data.total;
  if(tp<=1){pg.innerHTML='<span class="pg-info">'+total+' total</span>';return}
  var h='<button class="pg-btn" onclick="fetchEmails(1)"'+(p<=1?' disabled':'')+'>&#171;</button>';
  h+='<button class="pg-btn" onclick="fetchEmails('+(p-1)+')"'+(p<=1?' disabled':'')+'>&#8249;</button>';
  var start=Math.max(1,p-3),end=Math.min(tp,p+3);
  if(start>1)h+='<span class="pg-info">...</span>';
  for(var i=start;i<=end;i++){
    h+='<button class="pg-btn'+(i===p?' active':'')+'" onclick="fetchEmails('+i+')">'+i+'</button>';
  }
  if(end<tp)h+='<span class="pg-info">...</span>';
  h+='<button class="pg-btn" onclick="fetchEmails('+(p+1)+')"'+(p>=tp?' disabled':'')+'>&#8250;</button>';
  h+='<button class="pg-btn" onclick="fetchEmails('+tp+')"'+(p>=tp?' disabled':'')+'>&#187;</button>';
  h+='<span class="pg-info">Page '+p+' of '+tp+' ('+total.toLocaleString()+' total)</span>';
  h+='<select class="pg-size" onchange="_pageSize=+this.value;fetchEmails(1)">';
  [25,50,100,200].forEach(function(n){h+='<option value="'+n+'"'+(n===_pageSize?' selected':'')+'>'+n+'/page</option>'});
  h+='</select>';
  pg.innerHTML=h;
}

document.querySelectorAll('.col-filter').forEach(function(el){
  el.className+=' col-filter-styled';
  el.addEventListener('input',function(){_currentPage=1;clearTimeout(fetchTimer);fetchTimer=setTimeout(fetchEmails,350)});
});

// ── Sent history ─────────────────────────────────────────────────────────
var sentTimer=null;
async function fetchSent(){
  var stbody=document.getElementById('sent-tbody');
  var sfoot=document.getElementById('sent-footer');
  var scnt=document.getElementById('sent-count');
  var params=new URLSearchParams();
  var vEmail=document.getElementById('sf-email'),vName=document.getElementById('sf-name');
  var vCnt=document.getElementById('sf-country'),vLoc=document.getElementById('sf-location');
  if(vEmail&&vEmail.value.trim())params.set('email',vEmail.value.trim());
  if(vName&&vName.value.trim())params.set('name',vName.value.trim());
  if(vCnt&&vCnt.value.trim())params.set('country',vCnt.value.trim());
  if(vLoc&&vLoc.value.trim())params.set('location',vLoc.value.trim());
  try{
    var res=await fetch('/api/sent?'+params.toString());var data=await res.json();
    if(scnt)scnt.textContent=data.total.toLocaleString();
    stbody.innerHTML=data.rows.length?data.rows.map(function(e){
      var av=e.avatar
        ?'<img class="av" src="'+e.avatar+'&s=56" alt="" loading="lazy">'
        :'<span class="av-ph">'+(e.login||e.email||'?').slice(0,1).toUpperCase()+'</span>';
      var tipParts=[];
      if(e.telegram)tipParts.push('TG: @'+e.telegram);
      var userTip=tipParts.length?' title="'+tipParts.join(' | ')+'"':'';
      var userCell=av+(e.login
        ?'<a href="'+(e.profile||'')+'" target="_blank" style="color:var(--accent);font-size:.7rem;font-weight:600"'+userTip+'>@'+e.login+'</a>'
        :'<span style="font-size:.7rem;color:var(--faint)"'+userTip+'>'+e.email+'</span>');
      var sentAt=(e.sent_at||'').replace('T',' ').slice(0,16);
      var bodyText=(e.body||'');
      var preview=bodyText.slice(0,60).replace(/</g,'&lt;')+(bodyText.length>60?'…':'');
      return '<tr>'
        +'<td>'+userCell+'</td>'
        +'<td style="font-size:.7rem" title="'+(e.name||'')+'">'+(e.name||'&mdash;')+'</td>'
        +'<td><a href="mailto:'+e.email+'" style="color:var(--accent);font-size:.7rem" title="'+e.email+'">'+e.email+'</a></td>'
        +'<td style="font-size:.7rem">'+(e.country||'&mdash;')+'</td>'
        +'<td><span style="font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:99px;letter-spacing:.02em;'
          +(e.send_type==='test'?'background:rgba(37,99,235,.1);color:var(--blue)':'background:rgba(5,150,105,.1);color:var(--green)')
          +'">'+(e.send_type==='test'?'Test':'Cmpn')+'</span></td>'
        +'<td><span style="font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:99px;letter-spacing:.02em;'
          +(e.status==='failed'?'background:rgba(220,38,38,.1);color:var(--red)':'background:rgba(5,150,105,.1);color:var(--green)')
          +'" title="'+(e.error||'')+'">'+(e.status==='failed'?'\\u2717':'\\u2713')+'</span></td>'
        +'<td style="font-size:.64rem;color:var(--muted)" title="'+(e.sender||'')+'">'+(e.sender||'&mdash;')+'</td>'
        +'<td style="font-size:.7rem;color:var(--muted)" title="'+(e.subject||'')+'">'+(e.subject||'&mdash;')+'</td>'
        +'<td style="font-size:.68rem;color:var(--muted)" title="'+bodyText.replace(/"/g,'&quot;').slice(0,200)+'">'+preview+'</td>'
        +'<td style="font-size:.66rem;color:var(--faint)">'+sentAt+'</td>'
        +'</tr>';
    }).join(''):'<tr><td colspan="10" style="text-align:center;color:var(--faint);padding:20px">No sent emails yet</td></tr>';
    sfoot.textContent=data.total>500?'Showing 500 of '+data.total.toLocaleString():'';
  }catch(err){stbody.innerHTML='<tr><td colspan="10" style="color:var(--red);padding:16px">Error: '+err.message+'</td></tr>'}
}
['sf-email','sf-name','sf-country','sf-location'].forEach(function(id){
  var el=document.getElementById(id);
  if(el)el.addEventListener('input',function(){clearTimeout(sentTimer);sentTimer=setTimeout(fetchSent,350)});
});

// ── CSV import ───────────────────────────────────────────────────────────
var fileInput=document.getElementById('csv-file');
var csvName=document.getElementById('csv-name');
var importBtn=document.getElementById('csv-import-btn');
var csvMsg=document.getElementById('csv-msg');
fileInput.addEventListener('change',function(){
  var f=fileInput.files[0];
  csvName.textContent=f?f.name:'No file chosen';
  importBtn.disabled=!f;
});
importBtn.addEventListener('click',async function(){
  var f=fileInput.files[0];if(!f)return;
  importBtn.disabled=true;
  csvMsg.style.color='var(--muted)';csvMsg.textContent='Parsing…';
  var text=await f.text();
  var lines=text.split(String.fromCharCode(10)).map(function(s){return s.trim()}).filter(Boolean);
  if(!lines.length){csvMsg.textContent='Empty file';importBtn.disabled=false;return}
  var header=lines[0].split(',').map(function(h){return h.trim().toLowerCase().replace(/"/g,'')});
  var emailCol=header.findIndex(function(h){return h.includes('email')});
  var nameCol=header.findIndex(function(h){return h.includes('name')});
  var loginCol=header.findIndex(function(h){return h.includes('login')||h.includes('username')});
  var locCol=header.findIndex(function(h){return h.includes('location')||h.includes('country')});
  if(emailCol===-1){csvMsg.style.color='var(--red)';csvMsg.textContent='No "email" column found';importBtn.disabled=false;return}
  function cell(cells,idx){return idx===-1||!cells[idx]?'':cells[idx].trim().replace(/^"|"$/g,'')}
  var entries=[];
  for(var i=1;i<lines.length;i++){
    var c=lines[i].split(',');var email=cell(c,emailCol);
    if(!email||!email.includes('@'))continue;
    entries.push({email:email,name:cell(c,nameCol),login:cell(c,loginCol),location:cell(c,locCol)});
  }
  if(!entries.length){csvMsg.textContent='No valid emails found';importBtn.disabled=false;return}
  csvMsg.textContent='Importing '+entries.length+' entries…';
  var res=await fetch('/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entries:entries})});
  var data=await res.json();
  csvMsg.style.color=data.added>0?'var(--green)':'var(--muted)';
  csvMsg.textContent='✓ Added '+data.added+' new · skipped '+data.skipped+' duplicates';
  importBtn.disabled=false;
  setTimeout(function(){location.reload()},1500);
});

// ── Email Template Editor ────────────────────────────────────────────────
async function loadTemplate(){
  try{
    var r=await fetch('/api/template');var d=await r.json();
    document.getElementById('tpl-subject').value=d.subject||'';
    document.getElementById('tpl-body').value=d.body||'';
    updatePreview();
  }catch(e){}
}
function updatePreview(){
  var s=document.getElementById('tpl-subject').value;
  var b=document.getElementById('tpl-body').value;
  var preview='Subject: '+s+'\\n\\nHi Alex,\\n\\n'+b;
  document.getElementById('tpl-preview').textContent=preview;
}
document.getElementById('tpl-subject').addEventListener('input',updatePreview);
document.getElementById('tpl-body').addEventListener('input',updatePreview);
async function saveTemplate(){
  var msg=document.getElementById('tpl-msg');
  var s=document.getElementById('tpl-subject').value.trim();
  var b=document.getElementById('tpl-body').value.trim();
  if(!s||!b){msg.style.color='var(--red)';msg.textContent='Subject and body required.';return}
  msg.style.color='var(--muted)';msg.textContent='Saving…';
  try{
    var r=await fetch('/api/template',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({subject:s,body:b})});
    var d=await r.json();
    msg.style.color=d.ok?'var(--green)':'var(--red)';
    msg.textContent=d.ok?'✓ Saved — next send will use this template.':d.msg;
  }catch(e){msg.style.color='var(--red)';msg.textContent='Error: '+e.message}
}
loadTemplate();

// ── Logs tab ──────────────────────────────────────────────────────────────
function logLineHTML(l){
  var cls='';
  if(/✓|OK|STARTED|auth OK/.test(l))cls='ok';
  if(/✗|ERROR|failed|⚠|blocked/.test(l))cls='err';
  return '<div class="log-line '+cls+'">'+l.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>';
}
async function fetchLogs(){
  try{
    var r=await fetch('/api/stats');var d=await r.json();
    var container=document.getElementById('log-container');
    var updated=document.getElementById('log-updated');
    var countEl=document.getElementById('log-count');
    if(!container)return;
    if(d.logs&&d.logs.length){
      container.innerHTML=d.logs.map(logLineHTML).join('');
      if(countEl)countEl.textContent=d.logs.length+' entries';
      var autoScroll=document.getElementById('log-autoscroll');
      if(autoScroll&&autoScroll.checked)container.scrollTop=container.scrollHeight;
    }else{
      container.innerHTML='<div class="log-line" style="color:var(--faint)">No log entries yet.</div>';
      if(countEl)countEl.textContent='';
    }
    if(updated)updated.textContent='Updated '+new Date().toLocaleTimeString();
  }catch(e){}
}
function clearLogView(){
  var container=document.getElementById('log-container');
  if(container)container.innerHTML='<div class="log-line" style="color:var(--faint)">Cleared — will refresh on next poll.</div>';
}
</script>
</body>
</html>
`;
}


function startDashboard(port = 3000) {
  const server = http.createServer((req, res) => {

    // ── GET /api/stats ─────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/stats') {
      syncState();
      const r2 = db.exec(
        `SELECT COUNT(*) FROM emails WHERE email NOT LIKE '_no_email_%' AND email NOT IN (SELECT email FROM sent WHERE status='sent')`
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        collected:       dbRealCount(),
        sent:            dbSentCount(),
        daily:           dbSentToday(),
        dailyFailed:     dbFailedToday(),
        totalFailed:     dbFailedTotal(),
        dailyHistory:    dbDailyHistory(7),
        unsent:          r2.length ? r2[0].values[0][0] : 0,
        lastId:          state.lastId,
        collecting:      collecting,
        targets:         getTargets(),
        collectProgress: {
          seg:   collectProgress.segIdx,
          page:  collectProgress.segPage,
          total: collectProgress.total,
          pct:   Math.min(100, ((collectProgress.segIdx * 10 + (collectProgress.segPage - 1)) / (collectProgress.total * 10)) * 100)
        },
        campaignRunning: campaignRunning,
        sendingNow:      sendingNow,
        lastSent:        lastSent,
        nextSendAt:      nextSendAt ? new Date(nextSendAt).toISOString() : null,
        dailyLimit:      DAILY_LIMIT,
        perAccountDaily: PER_ACCOUNT_DAILY,
        perAccountHourly:PER_ACCOUNT_HOURLY,
        minIntervalMin:  Math.round(MIN_INTERVAL_MS / 60000),
        accounts: smtpAccounts.map(a => ({
          user: a.user, host: a.host, port: a.port, name: a.name,
          ready: a.status.ready, error: a.status.error, checked: a.status.checkedAt,
          enabled: a.enabled, configured: !!a.pass
        })),
        logs:            logBuffer.slice(0, 100),
        uptime:          Date.now() - SERVER_START_TIME
      }));
      return;
    }

    // ── GET /api/targets ───────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/targets') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        selected:     getTargets(),
        sendSelected: getSendTargets(),
        countries:    Object.keys(COUNTRY_SEARCH),
        regions:      REGIONS
      }));
      return;
    }

    // ── POST /api/targets ──────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/targets') {
      let raw = '';
      req.on('data', d => raw += d);
      req.on('end', () => {
        try {
          const sel = (JSON.parse(raw).countries || []).filter(c => COUNTRY_SEARCH[c]);
          if (!sel.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Select at least one country.' }));
            return;
          }
          setState('targets', JSON.stringify(sel));
          setState('segIdx', 0);
          setState('segPage', 1);
          dbSave();
          targetsVersion++;
          log('Collection targets set → ' + sel.join(', '));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Targets saved: ' + sel.join(', ') }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Invalid request.' }));
        }
      });
      return;
    }

    // ── POST /api/send-targets ────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/send-targets') {
      let raw = '';
      req.on('data', d => raw += d);
      req.on('end', () => {
        try {
          const sel = (JSON.parse(raw).countries || []).filter(c => COUNTRY_SEARCH[c]);
          setState('send_targets', JSON.stringify(sel));
          dbSave();
          log('Send targets set → ' + (sel.length ? sel.join(', ') : 'ALL countries'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: sel.length ? 'Send targets: ' + sel.join(', ') : 'Sending to ALL countries' }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Invalid request.' }));
        }
      });
      return;
    }

    // ── POST /api/smtp-recheck ───────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/smtp-recheck') {
      verifyAllAccounts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: 'Re-checking all accounts…' }));
      return;
    }

    // ── POST /api/account-toggle ─────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/account-toggle') {
      let raw = '';
      req.on('data', d => raw += d);
      req.on('end', () => {
        try {
          const { user, enabled } = JSON.parse(raw);
          const acct = smtpAccounts.find(a => a.user === user);
          if (!acct) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, msg: 'Account not found' })); return; }
          if (enabled && !acct.status.ready) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, msg: 'Cannot enable — account is not ready (' + (acct.status.error || 'not verified') + ')' })); return; }
          acct.enabled = !!enabled;
          saveAccountStates();
          log((acct.enabled ? '✓ Enabled' : '✗ Disabled') + ' sender: ' + acct.user);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: acct.user + ' ' + (acct.enabled ? 'enabled' : 'disabled') }));
        } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, msg: e.message })); }
      });
      return;
    }

    // ── POST /api/send-test ───────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/send-test') {
      let raw = '';
      req.on('data', d => raw += d);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const to = parsed.to;
          if (!to || !to.includes('@')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Invalid email address' }));
            return;
          }
          const subject = parsed.subject || getCampaignSubject();
          const body = parsed.body || getCampaignBody();
          const fromUser = parsed.from;
          const acct = fromUser
            ? smtpAccounts.find(a => a.user === fromUser && a.status.ready && a.transporter)
            : smtpAccounts.find(a => a.status.ready && a.transporter);
          if (!acct) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'No ready SMTP account available' }));
            return;
          }
          const senderDomain = acct.user.split('@')[1] || 'ravk.io';
          const msgId = '<' + Date.now() + '.' + Math.random().toString(36).slice(2,10) + '@' + senderDomain + '>';
          acct.transporter.sendMail({
            from:       '"' + acct.name + '" <' + acct.user + '>',
            to:         to,
            replyTo:    acct.user,
            subject:    subject,
            messageId:  msgId,
            text:       body
          }).then(info => {
            dbMarkSent(to, subject, body, 'test', 'sent', '', acct.user);
            log('✓ Test email sent to ' + to + ' via ' + acct.user);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, msg: 'Sent to ' + to + ' via ' + acct.user }));
          }).catch(e => {
            dbMarkSent(to, subject, body, 'test', 'failed', e.message, acct.user);
            log('✗ Test email failed via ' + acct.user + ': ' + e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: e.message }));
          });
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Bad request' }));
        }
      });
      return;
    }

    // ── GET /api/template ──────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/template') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ subject: getCampaignSubject(), body: getCampaignBody() }));
      return;
    }

    // ── GET /api/sent ──────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/api/sent')) {
      const qs = new URL('http://x' + req.url).searchParams;
      const conditions = [];
      const params = [];
      const like = (col, val) => { conditions.push('LOWER('+col+') LIKE ?'); params.push('%'+val.toLowerCase()+'%'); };
      if (qs.get('email'))    like('s.email', qs.get('email'));
      if (qs.get('name'))     like('e.name',  qs.get('name'));
      if (qs.get('country'))  like('e.country', qs.get('country'));
      if (qs.get('location')) like('e.location', qs.get('location'));
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const sql = 'SELECT s.email, s.sent_at, s.subject, s.body, s.send_type, s.status, s.error, s.sender, e.name, e.avatar, e.country, e.location, e.company, e.login, e.profile, e.followers, e.hireable, e.telegram '
        + 'FROM sent s LEFT JOIN emails e ON s.email=e.email ' + where
        + ' ORDER BY s.sent_at DESC LIMIT 500';
      let rows = [];
      try {
        const r = db.exec(sql, params);
        if (r.length) {
          const cols = r[0].columns;
          rows = r[0].values.map(row => { const o={}; cols.forEach((c,i)=>o[c]=row[i]); return o; });
        }
      } catch(e) {}
      const total = db.exec('SELECT COUNT(*) FROM sent s LEFT JOIN emails e ON s.email=e.email ' + where, params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows, total: total.length ? total[0].values[0][0] : 0 }));
      return;
    }

    // ── GET /api/emails ────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/api/emails')) {
      const qs  = new URL('http://x' + req.url).searchParams;
      const conditions = ["emails.email NOT LIKE '_no_email_%'"];
      const params = [];
      const like = (col, val) => { conditions.push('LOWER(emails.'+col+') LIKE ?'); params.push('%'+val.toLowerCase()+'%'); };
      if (qs.get('login'))       like('login', qs.get('login'));
      if (qs.get('name'))        like('name',  qs.get('name'));
      if (qs.get('email'))       like('email', qs.get('email'));
      if (qs.get('location'))    like('location', qs.get('location'));
      if (qs.get('company'))     like('company',  qs.get('company'));
      if (qs.get('minFollowers')) { conditions.push('emails.followers >= ?'); params.push(parseInt(qs.get('minFollowers'))||0); }
      if (qs.get('hireable') === 'yes') { conditions.push('emails.hireable = 1'); }
      if (qs.get('hireable') === 'no')  { conditions.push('emails.hireable = 0'); }
      if (qs.get('country')) {
        const countries = qs.get('country').split(',').map(c => c.trim()).filter(Boolean);
        if (countries.length === 1) {
          conditions.push('emails.country = ?');
          params.push(countries[0]);
        } else if (countries.length > 1) {
          conditions.push('emails.country IN (' + countries.map(() => '?').join(',') + ')');
          params.push(...countries);
        }
      }
      if (qs.get('telegram'))  like('telegram', qs.get('telegram'));
      const sentFilter = qs.get('sent');
      if (sentFilter === 'sent')   conditions.push('emails.email IN (SELECT email FROM sent)');
      if (sentFilter === 'unsent') conditions.push("emails.email NOT IN (SELECT email FROM sent WHERE status='sent')");
      const page = Math.max(1, parseInt(qs.get('page')) || 1);
      const pageSize = Math.min(200, Math.max(10, parseInt(qs.get('pageSize')) || 50));
      const offset = (page - 1) * pageSize;
      const where = 'WHERE ' + conditions.join(' AND ');
      const sql = 'SELECT emails.email, emails.login, emails.name, emails.location, emails.country, emails.company, emails.followers, emails.repos, emails.hireable, emails.avatar, emails.profile, emails.telegram, emails.phone, emails.linkedin, emails.seen_at, (emails.email IN (SELECT email FROM sent)) as is_sent FROM emails ' + where + ' ORDER BY emails.seen_at DESC LIMIT ? OFFSET ?';
      params.push(pageSize, offset);
      let rows = [];
      try {
        const r = db.exec(sql, params);
        if (r.length) {
          const cols = r[0].columns;
          rows = r[0].values.map(row => { const o={}; cols.forEach((c,i)=>o[c]=row[i]); return o; });
        }
      } catch(e) { console.error('api/emails SQL error:', e.message); }
      const totalR = db.exec('SELECT COUNT(*) FROM emails ' + where, params.slice(0, -2));
      const total = totalR.length ? totalR[0].values[0][0] : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }));
      return;
    }

    // ── GET /avatar/:login.png ───────────────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/avatar/')) {
      const m = req.url.match(/^\/avatar\/([a-zA-Z0-9_-]+)\.(png|jpg)$/);
      if (m) {
        const login = m[1], ext = m[2];
        const avatarUrl = `https://avatars.githubusercontent.com/${login}?s=400`;
        https.get(avatarUrl, proxyRes => {
          if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            https.get(proxyRes.headers.location, finalRes => {
              res.writeHead(200, {
                'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
                'Content-Disposition': `attachment; filename="${login}.${ext}"`
              });
              finalRes.pipe(res);
            }).on('error', () => { res.writeHead(502); res.end('Failed'); });
            return;
          }
          res.writeHead(200, {
            'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
            'Content-Disposition': `attachment; filename="${login}.${ext}"`
          });
          proxyRes.pipe(res);
        }).on('error', () => { res.writeHead(502); res.end('Failed'); });
        return;
      }
    }

    // ── GET /export.csv ────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/export.csv') {
      const allRows = dbAllEmails().filter(e => !e.email.startsWith('_no_email_'));
      const COLS = ['email','name','login','location','country','company','followers','repos','hireable','profile','telegram','phone','linkedin','seen_at'];
      const csv  = [COLS.join(','),
        ...allRows.map(e => COLS.map(k => '"' + String(e[k]??'').replace(/"/g,'""') + '"').join(','))
      ].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="realman-emails-' + new Date().toISOString().slice(0,10) + '.csv"'
      });
      res.end(csv);
      return;
    }

    // ── POST /import ───────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/import') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { entries = [] } = JSON.parse(body);
          let added = 0, skipped = 0;
          for (const e of entries) {
            const key = (e.email || '').toLowerCase().trim();
            if (!key || !key.includes('@')) { skipped++; continue; }
            if (dbEmailExists(key)) { skipped++; continue; }
            dbInsertEmail({
              email: key, login: e.login || '', name: e.name || '',
              location: e.location || '', country: extractCountry(e.location || ''),
              company: '', bio: '', blog: '', twitter: '',
              followers: 0, repos: 0, hireable: false, avatar: '', profile: '',
              seen_at: new Date().toISOString()
            });
            added++;
          }
          syncState();
          log('CSV import: +' + added + ' added, ' + skipped + ' skipped — total: ' + emails.length);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ added, skipped, total: emails.length }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ── POST /api/template ─────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/template') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          if (campaignRunning) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Stop the campaign first before editing the template.' }));
            return;
          }
          const { subject, body: bodyText } = JSON.parse(body);
          if (subject) setState('campaign_subject', subject.trim());
          if (bodyText) setState('campaign_body', bodyText.trim());
          dbSave();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Template saved.' }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: e.message }));
        }
      });
      return;
    }

    // ── POST /ctrl/* ───────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url.startsWith('/ctrl/')) {
      const action = req.url.slice(6);
      let ok = true, msg = '';
      if (action === 'collect-start') {
        if (collecting) {
          msg = 'Collector already running.';
        } else {
          if (!GH_TOKEN) { ok=false; msg='GH_TOKEN not set in .env'; }
          else { collectLoop().catch(e => log('Collector error:', e.message)); msg = 'Collector started — scanning GitHub (US only)…'; }
        }
      } else if (action === 'campaign-start') {
        startCampaign();
        msg = campaignRunning ? 'Campaign started — max ' + DAILY_LIMIT + '/day, ' + PER_ACCOUNT_DAILY + '/acct/day, min ' + Math.round(MIN_INTERVAL_MS/60000) + ' min between sends.' : 'Campaign already running.';
      } else if (action === 'stop-all') {
        collecting = false;
        stopCampaign();
        msg = 'Collector and campaign stopped.';
      } else {
        ok = false; msg = 'Unknown action: ' + action;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, msg }));
      return;
    }

    // ── GET / (dashboard) ──────────────────────────────────────────────────
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHTML());
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      log(`Port ${port} in use — trying ${port + 1}`);
      startDashboard(port + 1);
    } else {
      log('Dashboard error:', e.message);
    }
  });
  server.listen(port, () => {
    log(`Dashboard → http://localhost:${port}`);
  });
}

// ── Startup validation ─────────────────────────────────────────────────────
function validate() {
  const missing = [];
  if (!GH_TOKEN)  missing.push('GH_TOKEN');
  if (!smtpAccounts.length) missing.push('At least one SMTP account (SMTP_1_USER)');
  if (missing.length) {
    console.error('ERROR: Missing .env variables:', missing.join(', '));
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
}

// ── Campaign scheduler ─────────────────────────────────────────────────────
let campaignRunning = false;
let campaignTimer   = null;

function jitteredInterval() {
  const jitter = Math.floor(SEND_INTERVAL_MS * 0.15 * (Math.random() * 2 - 1));
  return SEND_INTERVAL_MS + jitter;
}
function scheduleNextSend() {
  const delay = jitteredInterval();
  nextSendAt = Date.now() + delay;
  campaignTimer = setTimeout(async () => {
    if (!campaignRunning) return;
    await campaignTick();
    scheduleNextSend();
  }, delay);
}
function startCampaign() {
  if (campaignRunning) { log('Campaign already running.'); return; }
  campaignRunning = true;
  log('Campaign STARTED — max ' + DAILY_LIMIT + '/day global, ' + PER_ACCOUNT_DAILY + '/day per account, ' + PER_ACCOUNT_HOURLY + '/hr per account, min ' + Math.round(MIN_INTERVAL_MS/60000) + ' min gap');
  campaignTick();
  scheduleNextSend();
}

function stopCampaign() {
  if (!campaignRunning) { log('Campaign is not running.'); return; }
  campaignRunning = false;
  clearTimeout(campaignTimer);
  campaignTimer = null;
  nextSendAt    = null;
  log('Campaign STOPPED.');
}

// ── CLI keyboard commands ──────────────────────────────────────────────────
function startCLI() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  console.log('Commands: start | stop | status | quit');
  rl.on('line', line => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'start')  startCampaign();
    else if (cmd === 'stop')   stopCampaign();
    else if (cmd === 'status') {
      syncState();
      log('Collected: ' + dbRealCount() + ' | Sent: ' + dbSentCount() + ' | Today: ' + dbSentToday() + ' | Campaign: ' + (campaignRunning?'running':'stopped'));
    }
    else if (cmd === 'quit' || cmd === 'exit') process.exit(0);
    else console.log('Unknown command. Try: start | stop | status | quit');
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  validate();
  const SQL = await initSqlJs();
  dbInit(SQL);
  syncState();
  log('Realman server starting…');
  log('DB: ' + dbRealCount() + ' emails | ' + dbSentCount() + ' sent');
  log('Campaign: ' + DAILY_LIMIT + '/day global · ' + PER_ACCOUNT_DAILY + '/day per-acct · ' + PER_ACCOUNT_HOURLY + '/hr per-acct · min ' + Math.round(MIN_INTERVAL_MS/60000) + ' min gap · auto-disable after ' + CONSECUTIVE_FAIL_MAX + ' fails');
  log(smtpAccounts.length + ' SMTP account(s) configured');

  initTransporters();
  loadAccountStates();

  startDashboard(3000);

  verifyAllAccounts();

  log('Ready. Use the dashboard buttons or type: start | stop | status | quit');

  // Start CLI
  startCLI();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
