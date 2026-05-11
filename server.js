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
const DELAY = 350;
const TIMEOUT = 15000;
const SKIP = /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|zip|mp4|mp3|ico|woff2?|ttf|eot|xml|json|txt|gz|rss|atom)(\?|$)/i;
const SOCIAL = ['linkedin.com','facebook.com','twitter.com','x.com','instagram.com','youtube.com','pinterest.com','wa.me','t.me'];

// URLs to note but NOT crawl (waste of crawl budget — they exist but are low-value)
const SKIP_BUT_NOTE = /\/(table-of-content|toc|snapshot|methodology)\b/i;

// High-priority URL patterns — crawl these first
const PRIORITY_PATHS = /\/(report|reports|blog|insight|press-release|press|news|service|about|pricing|faq|contact|connect|industry)/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
    [/\/(location|city|area|region|near-me)/, 'Location Pages'],
    [/\/(event|webinar|workshop|conference)/, 'Events'],
    [/\/(glossary|dictionary|definition)/, 'Glossary'],
    [/\/(comparison|vs|versus|alternative)/, 'Comparison'],
    [/\/(integration|partner|marketplace)/, 'Integrations'],
    [/\/(industry|sector|vertical|cluster)/, 'Industry Pages'],
    [/\/(press-release|press|newsroom)/, 'Press Release'],
    [/\/(report-store|reports|download|whitepaper|ebook)/, 'Reports / Resources'],
    [/\/(sitemap|research-process|how-to-order|delivery)/, 'Utility Pages'],
  ];
  for (const [re, cat] of rules) if (re.test(p)) return cat;
  if (!p || p === '/') return 'Homepage';
  if ((p.match(/\//g) || []).length <= 1) return 'Top-Level Page';
  return 'Other';
}

// ════════════════════════════════════════════
// DEEP PAGE SCRAPER
// ════════════════════════════════════════════
async function scrapePage(url) {
  const pg = {
    url, status: null, redirect: null, error: null,
    // Meta
    title: '', title_len: 0, meta_desc: '', meta_desc_len: 0,
    meta_robots: '', canonical: '', has_og: false,
    og_title: '', og_image: '',
    has_hreflang: false, hreflang_langs: [],
    // Content
    h1: '', h1_count: 0,
    heading_tree: [],       // [{tag:'h1',text:'...'}, {tag:'h2',text:'...'}, ...]
    word_count: 0,
    content_body: '',       // Full extracted body text (up to 3000 chars)
    content_hash: '',       // For duplicate detection
    paragraph_count: 0,
    avg_para_words: 0,
    // Links
    internal_links: [],     // [{url, anchor}]
    external_links: [],     // [{url, anchor, domain}]
    int_link_count: 0, ext_link_count: 0,
    // Images
    images: [],             // [{src, alt, has_alt}]
    img_count: 0, img_no_alt: 0,
    // Technical
    is_csr: false,
    has_schema: false, schema_types: [], schema_raw: [],
    // Features
    features: {},
    category: categorize(url),
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer);

    pg.status = resp.status;
    if (resp.url !== url) pg.redirect = resp.url;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/html')) { pg.error = `Not HTML: ${ct.split(';')[0]}`; return pg; }
    if (resp.status !== 200) { pg.error = `HTTP ${resp.status}`; return pg; }

    const html = await resp.text();
    const $ = cheerio.load(html);
    const bd = domain(url);

    // ── Meta ──
    pg.title = $('title').text().trim(); pg.title_len = pg.title.length;
    pg.meta_desc = $('meta[name="description"]').attr('content')?.trim() || ''; pg.meta_desc_len = pg.meta_desc.length;
    pg.meta_robots = $('meta[name="robots"]').attr('content') || '';
    pg.canonical = $('link[rel="canonical"]').attr('href') || '';
    pg.has_og = !!$('meta[property^="og:"]').length;
    pg.og_title = $('meta[property="og:title"]').attr('content') || '';
    pg.og_image = $('meta[property="og:image"]').attr('content') || '';
    $('link[rel="alternate"][hreflang]').each((_, el) => { pg.hreflang_langs.push($(el).attr('hreflang')); });
    pg.has_hreflang = pg.hreflang_langs.length > 0;

    // ── Heading Tree ──
    $('h1, h2, h3, h4').each((_, el) => {
      const tag = el.tagName?.toLowerCase() || el.name?.toLowerCase();
      const text = $(el).text().trim().slice(0, 200);
      if (text) pg.heading_tree.push({ tag, text });
    });
    pg.h1 = $('h1').first().text().trim();
    pg.h1_count = $('h1').length;

    // ── Body Content ──
    const $clean = cheerio.load(html);
    $clean('script, style, nav, footer, header, aside, noscript, [class*="menu"], [class*="sidebar"]').remove();
    const bodyText = $clean('body').text().replace(/\s+/g, ' ').trim();
    const words = bodyText.split(/\s+/).filter(w => w.length > 0);
    pg.word_count = words.length;
    pg.content_body = words.slice(0, 600).join(' ');  // ~3000 chars
    pg.content_hash = hash(bodyText);

    // Paragraphs
    const paras = [];
    $('p').each((_, el) => { const t = $(el).text().trim(); if (t.length > 30) paras.push(t); });
    pg.paragraph_count = paras.length;
    pg.avg_para_words = paras.length ? Math.round(paras.reduce((a, p) => a + p.split(/\s+/).length, 0) / paras.length) : 0;

    // CSR detection
    if (pg.word_count < 50 && html.length > 5000) pg.is_csr = true;
    if ($('[class*="skeleton"], [class*="animate-pulse"]').length > 3) pg.is_csr = true;

    // ── Images ──
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      const alt = $(el).attr('alt')?.trim() || '';
      pg.images.push({ src: src.slice(0, 200), alt: alt.slice(0, 150), has_alt: !!alt });
    });
    pg.img_count = pg.images.length;
    pg.img_no_alt = pg.images.filter(i => !i.has_alt).length;

    // ── Links ──
    const seenI = new Set(), seenE = new Set();
    $('a[href]').each((_, el) => {
      let href = $(el).attr('href')?.trim();
      if (!href || /^(#|mailto:|tel:|javascript:)/.test(href)) return;
      const anchor = $(el).text().trim().slice(0, 100) || '[no text]';
      try {
        const full = new URL(href, url).href;
        const ld = domain(full);
        if (ld === bd) {
          const c = clean(full);
          if (!seenI.has(c)) { seenI.add(c); pg.internal_links.push({ url: c, anchor }); }
        } else if (!isSocial(ld)) {
          if (!seenE.has(full)) { seenE.add(full); pg.external_links.push({ url: full, anchor, domain: ld }); }
        }
      } catch {}
    });
    pg.int_link_count = pg.internal_links.length;
    pg.ext_link_count = pg.external_links.length;

    // ── Schema ──
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        const d = JSON.parse(raw);
        const extract = (obj) => {
          if (obj?.['@type']) {
            const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
            pg.schema_types.push(...types);
          }
          if (obj?.['@graph']) obj['@graph'].forEach(extract);
        };
        (Array.isArray(d) ? d : [d]).forEach(extract);
        pg.schema_raw.push(raw.slice(0, 500));
      } catch {}
    });
    pg.has_schema = pg.schema_types.length > 0;

    // ── Features ──
    const text = $('body').text().toLowerCase();
    const hl = html.toLowerCase();
    const f = {};
    f.testimonials = !!($('[class*="testimonial" i], [class*="review" i], [class*="quote" i], [id*="testimonial" i]').length || /testimonial|what .* say|client reviews|customer stories/i.test(text));
    f.trust_badges = !!($('[class*="badge" i], [class*="trust" i], [class*="certification" i], [class*="award" i]').length || /certified|accreditation|award|recognized|iso\s*\d/i.test(text));
    f.client_logos = !!($('[class*="client" i], [class*="partner" i], [class*="trusted" i]').length || /trusted by|our clients|brands we/i.test(text));
    f.stats_numbers = !!($('[class*="stat" i], [class*="counter" i], [class*="metric" i]').length || /\d{1,3}[,.]?\d*\s*(\+|%|projects|clients|years|countries|markets|reports|industries)/i.test(text));
    f.ratings = !!/★|⭐|rating|out of 5/i.test(text);
    f.cta_buttons = !!($('a[class*="btn" i], a[class*="button" i], a[class*="cta" i], button[class*="btn" i]').length);
    f.forms = $('form').length > 0;
    f.form_count = $('form').length;
    f.pricing_visible = !!($('[class*="pricing" i], [class*="plan" i], [class*="package" i]').length || /pricing|per month|\/mo|\/year|starter|enterprise plan/i.test(text));
    f.free_trial = !!/free trial|try free|start free|no credit card/i.test(text);
    f.newsletter = !!($('input[type="email"]').length || /newsletter|subscribe|stay updated/i.test(text));
    f.lead_magnet = !!/download .*(guide|ebook|whitepaper|checklist|template)|free resource/i.test(text);
    f.chat_widget = !!/intercom|drift|crisp|tawk|zendesk|livechat|hubspot.*chat|freshchat|tidio/i.test(hl);
    f.popup = !!$('[class*="modal" i], [class*="popup" i], [class*="lightbox" i]').length;
    f.toc = !!($('[class*="toc" i], [class*="table-of-contents" i]').length || /table of contents|in this article/i.test(text));
    f.faq = !!($('[class*="faq" i], [class*="accordion" i]').length || /frequently asked|common questions/i.test(text));
    f.video = !!($('iframe[src*="youtube" i], iframe[src*="vimeo" i], iframe[src*="wistia" i], video').length);
    f.author_box = !!($('[class*="author" i], [class*="byline" i]').length || /written by|authored by/i.test($('body').text()));
    f.publish_date = !!($('time').length || $('[class*="date" i], [class*="published" i]').length);
    f.last_updated = !!/last updated|updated on|modified|reviewed on/i.test(text);
    f.related_posts = !!$('[class*="related" i], [class*="recommended" i], [class*="also-read" i]').length;
    f.breadcrumbs = !!$('[class*="breadcrumb" i], nav[aria-label*="breadcrumb" i]').length;
    f.search_box = !!($('input[type="search"]').length || $('form[role="search"]').length);
    f.social_share = !!$('[class*="share" i], [class*="social-share" i]').length;
    f.lazy_loading = !!($('[loading="lazy"]').length || /lazyload|data-src/i.test(hl));
    f.media_citations = !!($('[class*="media" i][class*="mention" i], [class*="featured" i][class*="in" i], [class*="as-seen" i]').length || /forbes|bloomberg|reuters|yahoo finance|business insider|statista|economist|huffpost/i.test(text));
    f.case_studies = !!/case stud|success stor/i.test(text);
    f.sources_cited = !!/sources|references|bibliography|according to|study by/i.test(text);
    f.credentials = !!/phd|md|certified|licensed|years of experience/i.test(text);
    f.editorial_policy = !!/editorial (policy|guidelines)|fact.?check|medically reviewed/i.test(text);
    f.ga4 = !!/gtag|googletagmanager|G-[A-Z0-9]{6,}/i.test(hl);
    f.recaptcha = !!/recaptcha/i.test(hl);
    f.clarity = !!/clarity\.ms/i.test(hl);
    f.hubspot = !!/hs-scripts|hubspot/i.test(hl);
    f.payment_methods = !!($('img[alt*="payment" i], img[title*="payment" i]').length || /visa|mastercard|paypal|stripe|payment method/i.test(text));
    pg.features = f;

  } catch (e) {
    pg.error = e.name === 'AbortError' ? 'Timeout' : e.message?.slice(0, 100);
  }
  return pg;
}

// ════════════════════════════════════════════
// SITEMAP DISCOVERY
// ════════════════════════════════════════════
async function findSitemapUrls(homepage) {
  const base = new URL(homepage).origin;
  const paths = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap/sitemap.xml', '/sitemapindex.xml'];
  try {
    const r = await fetch(base + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (r.ok) { const t = await r.text(); t.split('\n').forEach(l => { if (/^sitemap:/i.test(l.trim())) paths.unshift(l.split(':').slice(1).join(':').trim()); }); }
  } catch {}

  for (const p of paths) {
    try {
      const u = p.startsWith('http') ? p : base + p;
      const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const xml = await r.text();
      if (!/<urlset|<sitemapindex/i.test(xml)) continue;
      return await parseSitemap(xml, u);
    } catch {}
  }
  return [];
}

async function parseSitemap(xml, url, depth = 0) {
  if (depth > 3) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = [];
  for (const el of $('sitemap loc').toArray()) {
    try {
      const r = await fetch($(el).text().trim(), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (r.ok) urls.push(...await parseSitemap(await r.text(), $(el).text().trim(), depth + 1));
    } catch {}
  }
  $('url loc').each((_, el) => urls.push($(el).text().trim()));
  return [...new Set(urls)];
}

// ════════════════════════════════════════════
// SPIDER CRAWL (SSE)
// ════════════════════════════════════════════
async function crawl(startUrl, maxPages, send) {
  const visited = new Set();
  const queue = [startUrl];
  const pages = [];
  const bd = domain(startUrl);
  const notedUrls = []; // URLs we skip but note (toc, snapshot, methodology)

  send('log', `Checking sitemap for ${bd}...`);
  const smUrls = await findSitemapUrls(startUrl);
  if (smUrls.length) {
    send('log', `Sitemap: ${smUrls.length} URLs found`);

    // Sort sitemap URLs: priority paths first, skip-but-note last
    const priority = [], normal = [];
    smUrls.forEach(u => {
      if (SKIP_BUT_NOTE.test(u)) {
        notedUrls.push({ url: u, type: u.match(SKIP_BUT_NOTE)?.[1] || 'noted' });
      } else if (PRIORITY_PATHS.test(u)) {
        priority.push(u);
      } else {
        normal.push(u);
      }
    });
    // Priority URLs go to front of queue
    [...priority, ...normal].forEach(u => { if (!queue.includes(u)) queue.push(u); });

    if (notedUrls.length) {
      send('log', `Noted ${notedUrls.length} URLs (toc/snapshot/methodology) — skipping crawl but recorded`);
    }
  } else {
    send('log', 'No sitemap — spider crawling');
  }

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    const c = clean(url);
    if (visited.has(c) || SKIP.test(c)) continue;
    try { if (domain(c) !== bd) continue; } catch { continue; }

    // Skip-but-note: don't waste crawl budget on toc/snapshot pages
    if (SKIP_BUT_NOTE.test(c)) {
      if (!notedUrls.find(n => n.url === c)) {
        notedUrls.push({ url: c, type: c.match(SKIP_BUT_NOTE)?.[1] || 'noted' });
      }
      visited.add(c);
      continue;
    }

    visited.add(c);

    send('progress', { done: pages.length + 1, total: maxPages, url: c, queued: queue.length });
    const pg = await scrapePage(c);
    pages.push(pg);

    // Queue discovered internal links with priority sorting
    if (pg.internal_links) {
      const newPriority = [], newNormal = [];
      pg.internal_links.forEach(l => {
        const lc = clean(l.url);
        if (visited.has(lc) || queue.includes(lc)) return;
        if (SKIP_BUT_NOTE.test(lc)) {
          if (!notedUrls.find(n => n.url === lc)) {
            notedUrls.push({ url: lc, type: lc.match(SKIP_BUT_NOTE)?.[1] || 'noted' });
          }
          return;
        }
        if (PRIORITY_PATHS.test(lc)) newPriority.push(lc);
        else newNormal.push(lc);
      });
      // Insert priority URLs at the FRONT of the queue
      queue.unshift(...newPriority);
      queue.push(...newNormal);
    }

    await sleep(DELAY);
  }

  // Attach noted URLs to the crawl result for display
  pages._notedUrls = notedUrls;
  return pages;
}

// ════════════════════════════════════════════
// COMPUTE METRICS
// ════════════════════════════════════════════
function metrics(pages) {
  const ok = pages.filter(p => p.status === 200);
  const n = Math.max(ok.length, 1);
  const cats = {}; ok.forEach(p => cats[p.category] = (cats[p.category] || 0) + 1);
  const wc = ok.map(p => p.word_count);

  // Features
  const fk = Object.keys(ok[0]?.features || {});
  const feats = {}; fk.forEach(k => { const c = ok.filter(p => p.features?.[k]).length; feats[k] = { count: c, pct: +(c / n * 100).toFixed(1) }; });

  // Schema
  const st = {}; ok.forEach(p => (p.schema_types || []).forEach(t => st[t] = (st[t] || 0) + 1));

  // CTAs
  const ctas = {}; ok.forEach(p => (p.features?.cta_texts || []).forEach(c => ctas[c.toLowerCase()] = (ctas[c.toLowerCase()] || 0) + 1));

  // Duplicates
  const hashes = {}; ok.forEach(p => { if (p.content_hash) hashes[p.content_hash] = (hashes[p.content_hash] || []).concat(p.url); });
  const dupes = Object.values(hashes).filter(v => v.length > 1);

  // Issues
  const issues = [];
  ok.filter(p => !p.title).forEach(p => issues.push({ type: 'Missing Title', url: p.url, sev: 'high' }));
  ok.filter(p => !p.h1).forEach(p => issues.push({ type: 'Missing H1', url: p.url, sev: 'high' }));
  ok.filter(p => p.h1_count > 1).forEach(p => issues.push({ type: `Multiple H1s (${p.h1_count})`, url: p.url, sev: 'medium' }));
  ok.filter(p => !p.meta_desc).forEach(p => issues.push({ type: 'Missing Meta Description', url: p.url, sev: 'high' }));
  ok.filter(p => p.title_len > 60).forEach(p => issues.push({ type: `Title Too Long (${p.title_len} chars)`, url: p.url, sev: 'low' }));
  ok.filter(p => p.meta_desc_len > 160).forEach(p => issues.push({ type: `Meta Desc Too Long (${p.meta_desc_len})`, url: p.url, sev: 'low' }));
  ok.filter(p => p.word_count < 300 && !['Homepage', 'Contact / CTA', 'Legal / Policy', 'Utility Pages'].includes(p.category)).forEach(p => issues.push({ type: `Thin Content (${p.word_count}w)`, url: p.url, sev: 'medium' }));
  ok.filter(p => p.is_csr).forEach(p => issues.push({ type: 'Client-Side Rendered', url: p.url, sev: 'high' }));
  ok.filter(p => p.meta_robots.includes('noindex')).forEach(p => issues.push({ type: 'Noindex', url: p.url, sev: 'info' }));
  ok.filter(p => !p.canonical).forEach(p => issues.push({ type: 'Missing Canonical', url: p.url, sev: 'medium' }));
  ok.filter(p => p.int_link_count < 3).forEach(p => issues.push({ type: `Orphan Risk (${p.int_link_count} int links)`, url: p.url, sev: 'medium' }));
  ok.filter(p => p.img_no_alt > 0).forEach(p => issues.push({ type: `${p.img_no_alt} Images No Alt`, url: p.url, sev: 'low' }));
  dupes.forEach(urls => issues.push({ type: `Duplicate Content (${urls.length} pages)`, url: urls.join(' | '), sev: 'high' }));

  return {
    total: pages.length, crawled: n, errors: pages.filter(p => p.error).length,
    categories: cats,
    avg_words: +(wc.reduce((a, b) => a + b, 0) / n).toFixed(0),
    thin: wc.filter(w => w < 300).length, thin_pct: +(wc.filter(w => w < 300).length / n * 100).toFixed(1),
    long: wc.filter(w => w > 1500).length, long_pct: +(wc.filter(w => w > 1500).length / n * 100).toFixed(1),
    avg_int: +(ok.reduce((a, p) => a + p.int_link_count, 0) / n).toFixed(1),
    avg_ext: +(ok.reduce((a, p) => a + p.ext_link_count, 0) / n).toFixed(1),
    orphans: ok.filter(p => p.int_link_count < 3).length,
    no_title: ok.filter(p => !p.title).length, no_h1: ok.filter(p => !p.h1).length,
    no_meta: ok.filter(p => !p.meta_desc).length, no_canon: ok.filter(p => !p.canonical).length,
    noindex: ok.filter(p => p.meta_robots.includes('noindex')).length,
    csr: ok.filter(p => p.is_csr).length,
    hreflang: [...new Set(ok.flatMap(p => p.hreflang_langs))],
    schema_pct: +(ok.filter(p => p.has_schema).length / n * 100).toFixed(1),
    schema_types: st,
    og_pct: +(ok.filter(p => p.has_og).length / n * 100).toFixed(1),
    alt_pct: +((1 - ok.reduce((a, p) => a + p.img_no_alt, 0) / Math.max(ok.reduce((a, p) => a + p.img_count, 0), 1)) * 100).toFixed(1),
    duplicates: dupes.length,
    features: feats, issues,
  };
}

// ════════════════════════════════════════════
// API: CRAWL (SSE)
// ════════════════════════════════════════════
app.get('/api/crawl', async (req, res) => {
  const { url, max } = req.query;
  if (!url) return res.status(400).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const pages = await crawl(url, Math.min(+max || 200, 1000), send);
    const m = metrics(pages);
    const notedUrls = pages._notedUrls || [];
    m.noted_urls = notedUrls;
    m.has_toc = notedUrls.some(n => /toc|table-of-content/i.test(n.type));
    m.has_snapshot = notedUrls.some(n => /snapshot/i.test(n.type));
    m.has_methodology = notedUrls.some(n => /methodology/i.test(n.type));

    // Send pages WITHOUT content_body to keep SSE payload manageable
    const lightPages = pages.map(p => ({ ...p, content_body: undefined, schema_raw: undefined, images: p.images?.slice(0, 5) }));
    send('done', { metrics: m, pages: lightPages, fullPageCount: pages.length });
    // Store full pages in memory for AI audit (keyed by URL)
    crawlCache.set(domain(url), pages);
  } catch (e) { send('error', { message: e.message }); }
  res.end();
});

// In-memory cache for full page data (for AI audit)
const crawlCache = new Map();

// ════════════════════════════════════════════
// API: AI ANALYZE (metrics-based)
// ════════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY missing in .env file. Add it and restart the server.' });
  if (!key.startsWith('sk-')) return res.status(500).json({ error: `Invalid API key format. Key should start with "sk-". Your key starts with "${key.slice(0, 5)}..."` });

  const { system, prompt } = req.body;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000); // 2 min timeout

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4096, temperature: 0.3, messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt.slice(0, 80000) } // Prevent token overflow
      ] }),
    });
    clearTimeout(timer);

    const d = await r.json();
    if (!r.ok) {
      const msg = d?.error?.message || `OpenAI returned HTTP ${r.status}`;
      console.error('OpenAI error:', msg);
      throw new Error(msg);
    }
    res.json({ text: d.choices?.[0]?.message?.content || '' });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'OpenAI request timed out (120s). Try reducing the data sent.' : e.message;
    console.error('Analyze error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ════════════════════════════════════════════
// API: CONTENT AUDIT (batch pages to AI)
// ════════════════════════════════════════════
app.post('/api/audit', async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY missing in .env file.' });
  if (!key.startsWith('sk-')) return res.status(500).json({ error: 'Invalid API key format.' });

  const { domain: dom, batchIndex, batchSize = 5 } = req.body;
  const pages = crawlCache.get(dom);
  if (!pages) return res.status(404).json({ error: `No crawl data for "${dom}". Crawl the site first.` });

  const ok = pages.filter(p => p.status === 200 && p.word_count > 50);
  const start = batchIndex * batchSize;
  const batch = ok.slice(start, start + batchSize);
  if (!batch.length) return res.json({ text: '', done: true, totalBatches: Math.ceil(ok.length / batchSize) });

  const pageSummaries = batch.map(p => {
    const headings = (p.heading_tree || []).slice(0, 12).map(h => `${'  '.repeat({ h1: 0, h2: 1, h3: 2, h4: 3 }[h.tag] || 0)}${h.tag.toUpperCase()}: ${h.text}`).join('\n');
    const intAnchors = (p.internal_links || []).slice(0, 8).map(l => {
      try { return `  "${l.anchor}" → ${new URL(l.url).pathname}`; } catch { return `  "${l.anchor}"`; }
    }).join('\n');
    return `
━━━ PAGE: ${p.url} ━━━
Category: ${p.category} | Words: ${p.word_count} | Paragraphs: ${p.paragraph_count}
Title: "${p.title}" (${p.title_len}c)
Meta: "${(p.meta_desc || '').slice(0, 180)}" (${p.meta_desc_len}c)
Robots: ${p.meta_robots || 'index,follow'} | Canonical: ${p.canonical || 'MISSING'}
Schema: ${(p.schema_types || []).join(', ') || 'NONE'}

HEADINGS:
${headings || '  [NONE]'}

CONTENT:
${(p.content_body || '').slice(0, 1800)}

INT LINKS (${p.int_link_count}):
${intAnchors || '  [NONE]'}
Ext: ${p.ext_link_count} | Imgs: ${p.img_count} (${p.img_no_alt} no alt)
Features: ${Object.entries(p.features || {}).filter(([_, v]) => v === true || (typeof v === 'number' && v > 0)).map(([k]) => k).join(', ') || 'none'}
`;
  }).join('\n');

  const prompt = `Audit these real website pages (HTML source data). For EACH page:
1. Content Quality Score (1-10)
2. Title & Meta Assessment
3. Heading Structure
4. Content Depth
5. Internal Linking quality
6. Technical Issues
7. Top 3 Specific Fixes

${pageSummaries}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4096, temperature: 0.3, messages: [
        { role: 'system', content: 'Senior SEO auditor. Review real HTML-extracted content. Be specific, cite actual content, give actionable fixes.' },
        { role: 'user', content: prompt.slice(0, 60000) }
      ] }),
    });
    clearTimeout(timer);
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `OpenAI ${r.status}`);
    res.json({ text: d.choices?.[0]?.message?.content || '', done: start + batchSize >= ok.length, totalBatches: Math.ceil(ok.length / batchSize), batchIndex });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Timed out' : e.message;
    console.error('Audit error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── Static + Start ──
const dist = join(__dirname, 'dist');
if (existsSync(dist)) { app.use(express.static(dist)); app.get('*', (_, r) => r.sendFile(join(dist, 'index.html'))); }

app.listen(PORT, async () => {
  const k = process.env.OPENAI_API_KEY;
  console.log(`\n══════════════════════════════════════\n🔬 SEO Intelligence v3 — Real Crawler\n══════════════════════════════════════\n   API:  http://localhost:${PORT}\n   App:  http://localhost:5173`);

  if (!k) {
    console.log('   Key:  ❌ MISSING — create .env with OPENAI_API_KEY=sk-...');
    console.log('         (Crawling works without it. AI tabs need it.)');
  } else if (!k.startsWith('sk-')) {
    console.log(`   Key:  ⚠️  Invalid format — should start with "sk-"`);
  } else {
    // Quick validation: hit OpenAI with a tiny request
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${k}` },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) console.log('   Key:  ✅ Valid and working');
      else {
        const d = await r.json().catch(() => ({}));
        console.log(`   Key:  ❌ ${d?.error?.message || `HTTP ${r.status}`}`);
      }
    } catch (e) {
      console.log(`   Key:  ⚠️  Could not verify (${e.message})`);
    }
  }
  console.log('══════════════════════════════════════\n');
});
