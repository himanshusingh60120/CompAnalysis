import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import * as cheerio from 'cheerio';

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 8000; // Vercel times out at 10s, so we must abort at 8s
const SOCIAL = ['linkedin.com','facebook.com','twitter.com','x.com','instagram.com','youtube.com','pinterest.com','wa.me','t.me'];

const clean = u => { try { const p = new URL(u); return (p.origin + p.pathname).replace(/\/+$/, '') || p.origin; } catch { return u; } };
const domain = u => { try { return new URL(u).hostname.replace('www.', ''); } catch { return ''; } };
const isSocial = h => SOCIAL.some(s => h.replace('www.', '').includes(s));
const hash = t => createHash('md5').update(t.slice(0, 5000)).digest('hex');

// ════════════════════════════════════════════
// URL CATEGORIZER
// ════════════════════════════════════════════
function categorize(url) {
  const p = new URL(url).pathname.toLowerCase().replace(/\/+$/, '');
  const rules = [
    [/\/(blog|article|post|news|insight|resource|learn|guide|how-to|tips)/, 'Blog / Content'],
    [/\/(service|solution|offering|what-we-do|capabilities|expertise)/, 'Service Pages'],
    [/\/(product|tool|feature|platform|software|app)/, 'Product Pages'],
    [/\/(case-stud|portfolio|work|project|success-stor|testimonial)/, 'Case Studies'],
    [/\/(about|team|career|job|culture|who-we-are|leadership)/, 'About / Careers'],
    [/\/(contact|get-in-touch|request|demo|consultation|free-trial|connect)/, 'Contact / CTA'],
    [/\/(pricing|plan|package|cost|quote|license|variant|checkout|order|buy)/, 'Pricing / Purchase'],
    [/\/(faq|help|support|knowledge-base|documentation|docs)/, 'FAQ / Support'],
    [/\/(categor|tag|author|archive|page\/\d)/, 'Taxonomy'],
    [/\/(legal|privacy|terms|cookie|disclaimer|policy|gdpr|return)/, 'Legal / Policy'],
    [/\/(location|city|area|region|near-me)/, 'Location Pages']
  ];
  for (const [re, cat] of rules) if (re.test(p)) return cat;
  if (!p || p === '/') return 'Homepage';
  return 'Other';
}

// ════════════════════════════════════════════
// DEEP PAGE SCRAPER
// ════════════════════════════════════════════
async function scrapePage(url) {
  const pg = {
    url, status: null, redirect: null, error: null,
    title: '', title_len: 0, meta_desc: '', meta_desc_len: 0,
    meta_robots: '', canonical: '', has_og: false,
    og_title: '', og_image: '', has_hreflang: false, hreflang_langs: [],
    h1: '', h1_count: 0, heading_tree: [], word_count: 0,
    content_body: '', content_hash: '', paragraph_count: 0, avg_para_words: 0,
    internal_links: [], external_links: [], int_link_count: 0, ext_link_count: 0,
    images: [], img_count: 0, img_no_alt: 0,
    is_csr: false, has_schema: false, schema_types: [],
    features: {}, category: categorize(url),
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer);

    pg.status = resp.status;
    if (resp.url !== url) pg.redirect = resp.url;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/html')) { pg.error = `Not HTML`; return pg; }
    if (resp.status !== 200) { pg.error = `HTTP ${resp.status}`; return pg; }

    const html = await resp.text();
    const $ = cheerio.load(html);
    const bd = domain(url);

    pg.title = $('title').text().trim(); pg.title_len = pg.title.length;
    pg.meta_desc = $('meta[name="description"]').attr('content')?.trim() || ''; pg.meta_desc_len = pg.meta_desc.length;
    pg.meta_robots = $('meta[name="robots"]').attr('content') || '';
    pg.canonical = $('link[rel="canonical"]').attr('href') || '';
    pg.has_og = !!$('meta[property^="og:"]').length;
    $('link[rel="alternate"][hreflang]').each((_, el) => { pg.hreflang_langs.push($(el).attr('hreflang')); });
    pg.has_hreflang = pg.hreflang_langs.length > 0;

    $('h1, h2, h3').each((_, el) => {
      const tag = el.tagName?.toLowerCase() || el.name?.toLowerCase();
      const text = $(el).text().trim().slice(0, 100);
      if (text) pg.heading_tree.push({ tag, text });
    });
    pg.h1 = $('h1').first().text().trim();
    pg.h1_count = $('h1').length;

    const $clean = cheerio.load(html);
    $clean('script, style, nav, footer, header, aside, noscript').remove();
    const bodyText = $clean('body').text().replace(/\s+/g, ' ').trim();
    const words = bodyText.split(/\s+/).filter(w => w.length > 0);
    pg.word_count = words.length;
    pg.content_body = words.slice(0, 600).join(' '); // Sent for AI audit later
    pg.content_hash = hash(bodyText);

    $('img').each((_, el) => {
      const src = $(el).attr('src') || ''; const alt = $(el).attr('alt')?.trim() || '';
      pg.images.push({ src: src.slice(0, 100), alt: alt.slice(0, 100), has_alt: !!alt });
    });
    pg.img_count = pg.images.length;
    pg.img_no_alt = pg.images.filter(i => !i.has_alt).length;

    const seenI = new Set(), seenE = new Set();
    $('a[href]').each((_, el) => {
      let href = $(el).attr('href')?.trim();
      if (!href || /^(#|mailto:|tel:|javascript:)/.test(href)) return;
      try {
        const full = new URL(href, url).href;
        const ld = domain(full);
        if (ld === bd) {
          const c = clean(full);
          if (!seenI.has(c)) { seenI.add(c); pg.internal_links.push({ url: c, anchor: $(el).text().trim().slice(0, 50) }); }
        } else if (!isSocial(ld)) {
          if (!seenE.has(full)) { seenE.add(full); pg.external_links.push({ url: full, domain: ld }); }
        }
      } catch {}
    });
    pg.int_link_count = pg.internal_links.length;
    pg.ext_link_count = pg.external_links.length;

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const d = JSON.parse($(el).html());
        const extract = (obj) => {
          if (obj?.['@type']) {
            const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
            pg.schema_types.push(...types);
          }
          if (obj?.['@graph']) obj['@graph'].forEach(extract);
        };
        (Array.isArray(d) ? d : [d]).forEach(extract);
      } catch {}
    });
    pg.has_schema = pg.schema_types.length > 0;

    // A few basic features for the matrix
    const text = $('body').text().toLowerCase();
    pg.features.testimonials = /testimonial|what .* say|client reviews/i.test(text);
    pg.features.pricing_visible = /pricing|per month|\/mo|starter plan/i.test(text);
    pg.features.case_studies = /case stud|success stor/i.test(text);
    pg.features.faq = /frequently asked|common questions/i.test(text);

  } catch (e) {
    pg.error = e.name === 'AbortError' ? 'Timeout' : e.message?.slice(0, 100);
  }
  return pg;
}

// ════════════════════════════════════════════
// APIs for VERCEL SERVERLESS
// ════════════════════════════════════════════

// 1. Get Sitemap URLs (Fast)
app.get('/api/sitemap', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing URL' });
  try {
    const base = new URL(url).origin;
    let urls = [];
    const r = await fetch(base + '/sitemap.xml', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const xml = await r.text();
      const $ = cheerio.load(xml, { xmlMode: true });
      $('url loc').each((_, el) => urls.push($(el).text().trim()));
    }
    res.json({ urls: [...new Set(urls)].slice(0, 500) }); // Cap sitemap seed
  } catch {
    res.json({ urls: [] });
  }
});

// 2. Scrape Single Page (Fast)
app.get('/api/scrape-single', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing URL' });
  try {
    const page = await scrapePage(url);
    res.json({ page });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. AI Analyze Overall Metrics
app.post('/api/analyze', async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY missing' });

  const { system, prompt } = req.body;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4096, temperature: 0.3, messages: [
        { role: 'system', content: system || '' },
        { role: 'user', content: prompt.slice(0, 60000) }
      ] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message);
    res.json({ text: d.choices?.[0]?.message?.content || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Content Audit (Stateless - React sends the data)
app.post('/api/audit', async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY missing' });

  const { pagesBatch } = req.body; // Array of 5 pages sent from React
  if (!pagesBatch || !pagesBatch.length) return res.json({ text: '' });

  const summaries = pagesBatch.map(p => `
━━━ PAGE: ${p.url} ━━━
Cat: ${p.category} | Words: ${p.word_count}
Title: "${p.title}"
Meta: "${p.meta_desc}"
HEADINGS: ${(p.heading_tree || []).slice(0, 5).map(h => `${h.tag}: ${h.text}`).join(' | ')}
BODY: ${(p.content_body || '').slice(0, 1500)}
`).join('\n');

  const prompt = `Audit these real website pages (HTML source data):\n${summaries}`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4000, temperature: 0.3, messages: [
        { role: 'system', content: 'Senior SEO auditor. Review extracted content. Be specific.' },
        { role: 'user', content: prompt }
      ] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message);
    res.json({ text: d.choices?.[0]?.message?.content || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Static + Start ──
const dist = join(__dirname, 'dist');
if (existsSync(dist)) { app.use(express.static(dist)); app.get('*', (_, r) => r.sendFile(join(dist, 'index.html'))); }

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Running locally on ${PORT}`));
}

export default app;
