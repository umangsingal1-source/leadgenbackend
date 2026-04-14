// server.js — LeadGen enrichment backend
// 8 data sources running in parallel for maximum coverage

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ─────────────────────────────────────────────────────────────────
const NUMVERIFY_KEY = process.env.NUMVERIFY_KEY || '';
const HUNTER_KEY    = process.env.HUNTER_KEY    || '';  // hunter.io free: 25/month
const PORT          = process.env.PORT          || 3000;

// In-memory lead store (replace with PostgreSQL when scaling)
const leads = [];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/',         (req, res) => res.json({ status: 'LeadGen running', sources: 8 }));
app.get('/leads',    (req, res) => res.json(leads));
app.delete('/leads/:id', (req, res) => {
  const i = leads.findIndex(l => l.id === req.params.id);
  if (i > -1) leads.splice(i, 1);
  res.json({ success: true });
});

// ── Main search ─────────────────────────────────────────────────────────────
app.post('/search', async (req, res) => {
  const { name, company, location, profileUrl, headline } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  console.log(`\n── Searching: "${name}" @ "${company}" ──`);

  // Run all 8 sources in parallel
  const [mca, gmb, justdial, indiamart, gstin, sulekha, webcrawl, hunter] = await Promise.allSettled([
    searchMCA(name, company),
    searchGMB(name, company, location),
    searchJustDial(name, company, location),
    searchIndiaMART(name, company),
    searchGSTIN(name, company),
    searchSulekha(name, company, location),
    searchWebCrawl(name, company),
    searchHunter(name, company),
  ]);

  // Collect all results with source labels
  const allResults = [
    { label: 'MCA India',   data: mca.value       || {} },
    { label: 'Google GMB',  data: gmb.value        || {} },
    { label: 'JustDial',    data: justdial.value   || {} },
    { label: 'IndiaMART',   data: indiamart.value  || {} },
    { label: 'GSTIN',       data: gstin.value      || {} },
    { label: 'Sulekha',     data: sulekha.value    || {} },
    { label: 'Web crawl',   data: webcrawl.value   || {} },
    { label: 'Hunter.io',   data: hunter.value     || {} },
  ];

  // Log what each source found
  allResults.forEach(r => {
    if (r.data.phone || r.data.email) {
      console.log(`  ✓ ${r.label}: phone=${r.data.phone||'—'} email=${r.data.email||'—'}`);
    }
  });

  // Pick best phone — first valid 10-digit Indian mobile wins
  // Priority: GMB > JustDial > IndiaMART > Sulekha > MCA > GSTIN > WebCrawl
  const phoneOrder = ['Google GMB','JustDial','IndiaMART','Sulekha','MCA India','GSTIN','Web crawl'];
  let phone = null, phoneSource = null;
  for (const label of phoneOrder) {
    const r = allResults.find(x => x.label === label);
    if (r?.data?.phone && isValidIndianMobile(r.data.phone)) {
      phone = normalisePhone(r.data.phone);
      phoneSource = label;
      break;
    }
  }
  // Fallback: any phone from any source
  if (!phone) {
    for (const r of allResults) {
      if (r.data.phone) { phone = normalisePhone(r.data.phone); phoneSource = r.label; break; }
    }
  }

  // Pick best email — Hunter wins for quality, then others
  const emailOrder = ['Hunter.io','Google GMB','MCA India','Web crawl','JustDial','IndiaMART','Sulekha'];
  let email = null, emailSource = null;
  for (const label of emailOrder) {
    const r = allResults.find(x => x.label === label);
    if (r?.data?.email && isValidEmail(r.data.email)) {
      email = r.data.email.toLowerCase();
      emailSource = label;
      break;
    }
  }

  // Build source string
  const sources = [];
  if (phoneSource) sources.push(`${phoneSource} (phone)`);
  if (emailSource && emailSource !== phoneSource) sources.push(`${emailSource} (email)`);

  // Validate phone via NumVerify
  let verified = false;
  let carrierInfo = null;
  if (phone && NUMVERIFY_KEY) {
    try {
      const v = await validateNumVerify(phone);
      verified = v.valid;
      carrierInfo = v.carrier || null;
    } catch (e) { console.log('NumVerify error:', e.message); }
  }

  // Confidence score (0-100)
  const confidence = calcConfidence({ phone, email, verified, sourcesCount: sources.length });

  // Save lead
  const lead = {
    id: uuidv4(),
    name, company: company || '', location: location || '',
    headline: headline || '', profileUrl: profileUrl || '',
    phone:    phone  || null,
    email:    email  || null,
    sources:  sources.join(', ') || 'No match found',
    verified, carrierInfo, confidence,
    foundAt:  new Date().toISOString(),
    allSources: allResults.filter(r => r.data.phone || r.data.email)
                          .map(r => ({ label: r.label, phone: r.data.phone, email: r.data.email }))
  };

  leads.unshift(lead);
  console.log(`  Result: phone=${phone||'none'} email=${email||'none'} confidence=${confidence}%`);
  res.json(lead);
});

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 1 — MCA India (Ministry of Corporate Affairs)
// Director/company registrations — great for founders, CXOs, directors
// ══════════════════════════════════════════════════════════════════════════════
async function searchMCA(name, company) {
  const queries = [company, name].filter(Boolean);
  for (const q of queries) {
    try {
      const { data } = await axios.get(
        `https://www.zaubacorp.com/company-search/${encodeURIComponent(q)}`,
        { headers: HEADERS, timeout: 8000 }
      );
      const phone = extractPhone(data);
      const email = extractEmail(data);
      if (phone || email) return { phone, email };
    } catch (e) { /* continue */ }
  }
  return {};
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 2 — Google My Business
// Best for any business with a Maps/Google presence
// ══════════════════════════════════════════════════════════════════════════════
async function searchGMB(name, company, location) {
  const q = `${company || name} ${location || 'India'} phone contact`;
  try {
    const { data } = await axios.get(
      `https://www.google.com/search?q=${encodeURIComponent(q)}`,
      { headers: HEADERS, timeout: 8000 }
    );
    return { phone: extractPhone(data), email: extractEmail(data) };
  } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 3 — JustDial
// India's largest local business directory — excellent phone hit rate
// ══════════════════════════════════════════════════════════════════════════════
async function searchJustDial(name, company, location) {
  const biz = company || name;
  const loc = location || 'india';
  try {
    const { data } = await axios.get(
      `https://www.justdial.com/${encodeURIComponent(loc)}/${encodeURIComponent(biz)}`,
      { headers: HEADERS, timeout: 9000 }
    );
    return { phone: extractPhone(data), email: extractEmail(data) };
  } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 4 — IndiaMART
// Great for B2B traders, manufacturers, suppliers — your tile/bathroom niche
// ══════════════════════════════════════════════════════════════════════════════
async function searchIndiaMART(name, company) {
  const q = company || name;
  try {
    const { data } = await axios.get(
      `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(q)}`,
      { headers: HEADERS, timeout: 9000 }
    );
    return { phone: extractPhone(data), email: extractEmail(data) };
  } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 5 — GSTIN (GST Registration)
// Government database — businesses with GST registration often have phone
// ══════════════════════════════════════════════════════════════════════════════
async function searchGSTIN(name, company) {
  const q = company || name;
  try {
    const { data } = await axios.get(
      `https://www.mastergst.com/gstinlookup?tradename=${encodeURIComponent(q)}`,
      { headers: HEADERS, timeout: 8000 }
    );
    return { phone: extractPhone(data), email: extractEmail(data) };
  } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 6 — Sulekha
// Services directory — great for interior designers, contractors, consultants
// ══════════════════════════════════════════════════════════════════════════════
async function searchSulekha(name, company, location) {
  const biz = encodeURIComponent(company || name);
  const loc = encodeURIComponent(location || 'india');
  try {
    const { data } = await axios.get(
      `https://www.sulekha.com/${loc}/${biz}-services`,
      { headers: HEADERS, timeout: 9000 }
    );
    return { phone: extractPhone(data), email: extractEmail(data) };
  } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 7 — Web crawl (LinkedIn bio link + personal website)
// Many professionals list their website in LinkedIn bio — crawl it for contact
// ══════════════════════════════════════════════════════════════════════════════
async function searchWebCrawl(name, company) {
  const q = `"${name}" ${company || ''} contact email phone site:in`;
  try {
    const { data } = await axios.get(
      `https://www.google.com/search?q=${encodeURIComponent(q)}`,
      { headers: HEADERS, timeout: 8000 }
    );
    return { phone: extractPhone(data), email: extractEmail(data) };
  } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 8 — Hunter.io
// Best email lookup for anyone with a company domain — 25 free/month
// ══════════════════════════════════════════════════════════════════════════════
async function searchHunter(name, company) {
  if (!HUNTER_KEY || !company) return {};
  try {
    // First get the domain from the company name
    const domainRes = await axios.get(
      `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(company)}&api_key=${HUNTER_KEY}`,
      { timeout: 8000 }
    );
    const domain = domainRes.data?.data?.domain;
    if (!domain) return {};

    // Then find the email for the person
    const parts = name.trim().split(' ');
    const firstName = parts[0];
    const lastName  = parts[parts.length - 1];

    const emailRes = await axios.get(
      `https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${firstName}&last_name=${lastName}&api_key=${HUNTER_KEY}`,
      { timeout: 8000 }
    );
    const email = emailRes.data?.data?.email;
    return email ? { email } : {};
  } catch (e) { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// VALIDATION — NumVerify
// ══════════════════════════════════════════════════════════════════════════════
async function validateNumVerify(phone) {
  const n = phone.replace(/\D/g, '');
  const { data } = await axios.get(
    `http://apilayer.net/api/validate?access_key=${NUMVERIFY_KEY}&number=${n}&country_code=IN`,
    { timeout: 6000 }
  );
  return { valid: data?.valid === true, carrier: data?.carrier };
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function extractPhone(html) {
  const patterns = [
    /(\+91[\s\-]?[6-9]\d{9})/,
    /\b([6-9]\d{9})\b/,
    /\b(0[1-9]\d[\s\-]\d{7,8})\b/,
    /\b(1800[\s\-]?\d{3}[\s\-]?\d{4})\b/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[0].replace(/[\s\-]/g, '');
  }
  return null;
}

function extractEmail(html) {
  const m = html.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
  if (!m) return null;
  const e = m[1];
  const junk = ['example.com','sentry.io','w3.org','schema.org','google.com',
                 'pixel','noreply','support@','info@shopify','wixpress'];
  return junk.some(j => e.includes(j)) ? null : e;
}

function isValidIndianMobile(p) {
  return /^(\+91)?[6-9]\d{9}$/.test(p.replace(/[\s\-]/g, ''));
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function normalisePhone(p) {
  const d = p.replace(/\D/g, '');
  if (d.startsWith('91') && d.length === 12) return '+91' + d.slice(2);
  if (d.length === 10) return '+91' + d;
  return p;
}

function calcConfidence({ phone, email, verified, sourcesCount }) {
  let score = 0;
  if (phone) score += 40;
  if (email) score += 30;
  if (verified) score += 20;
  if (sourcesCount >= 2) score += 10;
  return Math.min(score, 100);
}

app.listen(PORT, '0.0.0.0', () => ...) console.log(`LeadGen backend on port ${PORT} — 8 sources active`));
