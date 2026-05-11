import { useState, useCallback } from 'react';
const F = "'JetBrains Mono', 'SF Mono', monospace";
const C1 = '#06b6d4', C2 = '#8b5cf6';
const SKIP = /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|zip|mp4|mp3|ico|woff2?|ttf|eot|xml|json|txt|gz|rss|atom)(\?|$)/i;

// Sleep utility to prevent hammering your API / Target site too hard
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Calculates SEO metrics completely locally in React!
function computeMetrics(pages) {
  const ok = pages.filter(p => p.status === 200);
  const n = Math.max(ok.length, 1);
  const wc = ok.map(p => p.word_count);
  return {
    crawled: n,
    avg_words: +(wc.reduce((a, b) => a + b, 0) / n).toFixed(0),
    thin: wc.filter(w => w < 300).length,
    thin_pct: +(wc.filter(w => w < 300).length / n * 100).toFixed(1),
    long: wc.filter(w => w > 1500).length,
    avg_int: +(ok.reduce((a, p) => a + p.int_link_count, 0) / n).toFixed(1),
    avg_ext: +(ok.reduce((a, p) => a + p.ext_link_count, 0) / n).toFixed(1),
    orphans: ok.filter(p => p.int_link_count < 3).length,
    no_title: ok.filter(p => !p.title).length,
    no_h1: ok.filter(p => !p.h1).length,
    no_meta: ok.filter(p => !p.meta_desc).length,
    no_canon: ok.filter(p => !p.canonical).length,
    noindex: ok.filter(p => p.meta_robots?.includes('noindex')).length,
    csr: ok.filter(p => p.is_csr).length,
    schema_pct: +(ok.filter(p => p.has_schema).length / n * 100).toFixed(1),
    alt_pct: +((1 - ok.reduce((a, p) => a + p.img_no_alt, 0) / Math.max(ok.reduce((a, p) => a + p.img_count, 0), 1)) * 100).toFixed(1),
    issues: [], features: {}, schema_types: {}, hreflang: [], categories: {}, duplicates: 0
  };
}

// Client-Side Crawl Loop (This completely avoids Vercel Timeouts)
async function crawlSiteClient(startUrl, maxPages, onProg, onLog) {
  const visited = new Set();
  const queue = [startUrl];
  const pages = [];
  const domain = new URL(startUrl).hostname.replace('www.', '');

  onLog(`Fetching sitemap for ${domain}...`);
  try {
    const smRes = await fetch(`/api/sitemap?url=${encodeURIComponent(startUrl)}`).then(r => r.json());
    if (smRes.urls?.length) {
      onLog(`Found ${smRes.urls.length} URLs in sitemap`);
      queue.push(...smRes.urls);
    }
  } catch (e) {
    onLog('No sitemap found, proceeding with spider crawl.');
  }

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    
    // Clean URL to prevent duplicate crawling of trailing slashes
    const cleanUrl = url.replace(/\/+$/, '');
    if (visited.has(cleanUrl) || SKIP.test(cleanUrl)) continue;
    
    // Ensure we stay on the same domain
    try { if (new URL(cleanUrl).hostname.replace('www.', '') !== domain) continue; } catch { continue; }
    
    visited.add(cleanUrl);
    onProg({ done: pages.length + 1, total: maxPages, url: cleanUrl, queued: queue.length });

    try {
      const res = await fetch(`/api/scrape-single?url=${encodeURIComponent(cleanUrl)}`);
      const data = await res.json();
      
      if (data.page) {
        pages.push(data.page);
        
        // Add new discovered internal links to the queue
        if (data.page.internal_links) {
          data.page.internal_links.forEach(l => {
            if (!visited.has(l.url.replace(/\/+$/, ''))) queue.push(l.url);
          });
        }
      }
    } catch (e) {
      console.warn('Scrape failed for', cleanUrl, e);
    }

    // Small delay to prevent rate-limiting Vercel or Target site
    await sleep(200); 
  }

  return { pages, metrics: computeMetrics(pages) };
}

async function callAI(system, prompt) {
  const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system, prompt }) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d.text;
}

// Markdown formatting helper
function Md({ text }) {
  if (!text) return null;
  return <div style={{ lineHeight: 1.75 }}>{text.split('\n').map((l, i) => {
    const t = l.trim();
    if (!t) return <div key={i} style={{ height: 6 }} />;
    if (t.startsWith('## ')) return <h2 key={i} style={{ fontSize: 15, fontWeight: 700, color: '#e4e4e7', margin: '18px 0 6px', borderBottom: '1px solid #1e1e2e', paddingBottom: 4 }}>{t.slice(3)}</h2>;
    if (t.startsWith('- ')) return <div key={i} style={{ paddingLeft: 16, marginBottom: 2, fontSize: 12, color: '#a1a1aa' }}>• {t.slice(2)}</div>;
    return <p key={i} style={{ fontSize: 12, color: '#a1a1aa', marginBottom: 2 }}>{t}</p>;
  })}</div>;
}

function S({ label, a, b, la, lb, low }) {
  const w = low ? (a < b ? 1 : b < a ? 2 : 0) : (a > b ? 1 : b > a ? 2 : 0);
  return <div style={{ background: '#0f0f14', border: '1px solid #1e1e2e', borderRadius: 8, padding: 10 }}>
    <div style={{ fontSize: 10, color: '#3f3f46', marginBottom: 6 }}>{label}</div>
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <div><div style={{ fontSize: 16, fontWeight: 700, color: w === 1 ? '#22c55e' : '#e4e4e7' }}>{a}</div><div style={{ fontSize: 9, color: '#27272a' }}>{la}</div></div>
      <div style={{ textAlign: 'right' }}><div style={{ fontSize: 16, fontWeight: 700, color: w === 2 ? '#22c55e' : '#e4e4e7' }}>{b}</div><div style={{ fontSize: 9, color: '#27272a' }}>{lb}</div></div>
    </div>
  </div>;
}

export default function App() {
  const [phase, setPhase] = useState('input');
  const [url1, setUrl1] = useState(''); const [url2, setUrl2] = useState('');
  const [max, setMax] = useState(50); // Lowered default for faster testing
  const [status, setStatus] = useState(''); const [prog, setProg] = useState(null); const [crawlN, setCrawlN] = useState(0);
  const [d1, setD1] = useState(null); const [d2, setD2] = useState(null);
  const [tab, setTab] = useState('dash'); const [err, setErr] = useState('');
  const [aiText, setAiText] = useState(''); const [aiLoading, setAiLoading] = useState(false);
  const [auditText, setAuditText] = useState(''); const [auditLoading, setAuditLoading] = useState(false); const [auditProg, setAuditProg] = useState('');

  const ok = url1.startsWith('http') && url2.startsWith('http');
  const dom = u => { try { return new URL(u).hostname.replace('www.', ''); } catch { return u; } };
  const l1 = dom(url1), l2 = dom(url2);

  const run = useCallback(async () => {
    setPhase('crawl'); setErr(''); setD1(null); setD2(null); setAiText(''); setAuditText('');
    try {
      setCrawlN(1); setProg(null);
      const r1 = await crawlSiteClient(url1, max, setProg, setStatus);
      setD1(r1);
      
      setCrawlN(2); setProg(null);
      const r2 = await crawlSiteClient(url2, max, setProg, setStatus);
      setD2(r2);
      
      setPhase('results'); setTab('dash');
    } catch (e) { setErr(e.message); setPhase('err'); }
  }, [url1, url2, max, l1, l2]);

  const runAI = async () => {
    if (!d1?.metrics || !d2?.metrics) return;
    setAiLoading(true);
    const sum = m => `Pages:${m.crawled} AvgWords:${m.avg_words} Thin:${m.thin}(${m.thin_pct}%) IntLinks:${m.avg_int} Orphans:${m.orphans} NoTitle:${m.no_title} NoH1:${m.no_h1} NoMeta:${m.no_meta} NoCanon:${m.no_canon}`;
    try {
      const t = await callAI('You are an SEO Consultant comparing real crawl data.', `## ${l1}\n${sum(d1.metrics)}\n\n## ${l2}\n${sum(d2.metrics)}\n\nProvide a comparison and action plan.`);
      setAiText(t);
    } catch (e) { setAiText(`Error: ${e.message}`); }
    setAiLoading(false);
  };

  const runAudit = async (domainIndex) => {
    setAuditLoading(true); setAuditText('');
    const pages = domainIndex === 1 ? d1.pages : d2.pages;
    const okPages = pages.filter(p => p.status === 200 && p.word_count > 50);
    
    let all = '', idx = 0, batchSize = 5;
    
    while (idx * batchSize < okPages.length) {
      setAuditProg(`Auditing batch ${idx + 1}...`);
      const batch = okPages.slice(idx * batchSize, (idx + 1) * batchSize);
      try {
        const r = await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pagesBatch: batch }) });
        const data = await r.json();
        all += (data.text || '') + '\n\n';
        setAuditText(all);
        idx++;
      } catch (e) { 
        all += `\nError: ${e.message}\n`; setAuditText(all); break; 
      }
    }
    setAuditProg(`Done — audited ${okPages.length} pages.`);
    setAuditLoading(false);
  };

  const m1 = d1?.metrics, m2 = d2?.metrics;

  return <div style={{ fontFamily: F, background: '#09090b', color: '#e4e4e7', minHeight: '100vh' }}>
    <div style={{ background: '#0f0f14', borderBottom: '1px solid #141418', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 18 }}>🔬</span>
      <span style={{ fontSize: 13, fontWeight: 700 }}>SEO Intelligence (Serverless Edition)</span>
    </div>

    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 14px' }}>
      
      {/* INPUT */}
      {phase === 'input' && <div>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800 }}>Full Site Crawler</h1>
        </div>
        {[['YOUR SITE', url1, setUrl1, C1], ['COMPETITOR', url2, setUrl2, C2]].map(([lbl, val, set, c], i) => <div key={i} style={{ marginBottom: i === 0 ? 8 : 16 }}>
          <input value={val} onChange={e => set(e.target.value)} placeholder={`https://${lbl.toLowerCase()}.com`} style={{ width: '100%', padding: '11px 12px', borderRadius: 8, border: '1px solid #1e1e2e', background: '#0f0f14', color: '#e4e4e7', fontFamily: F, outline: 'none' }} />
        </div>)}
        <select value={max} onChange={e => setMax(+e.target.value)} style={{ width: '100%', marginBottom: 16, padding: '11px', borderRadius: 8, background: '#0f0f14', color: '#e4e4e7', border: '1px solid #1e1e2e' }}>
          {[10, 50, 100, 200, 500, 1000].map(n => <option key={n} value={n}>Crawl up to {n} pages per site</option>)}
        </select>
        <button onClick={run} disabled={!ok} style={{ width: '100%', padding: 14, borderRadius: 10, background: ok ? C1 : '#1e1e2e', color: ok ? '#000' : '#3f3f46', fontWeight: 700, cursor: ok ? 'pointer' : 'not-allowed' }}>Start Crawl</button>
      </div>}

      {/* CRAWL STATUS */}
      {phase === 'crawl' && <div style={{ textAlign: 'center', marginTop: 50 }}>
        <h2>Crawling Site {crawlN}/2</h2>
        <p style={{ color: '#71717a', fontSize: 12 }}>{status}</p>
        {prog && <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, color: C1, marginBottom: 8 }}>Scraping page {prog.done} of {prog.total}</div>
          <div style={{ fontSize: 10, color: '#3f3f46' }}>Queue size: {prog.queued}</div>
          <div style={{ fontSize: 10, color: '#52525b', wordBreak: 'break-all', marginTop: 10 }}>{prog.url}</div>
        </div>}
      </div>}

      {/* RESULTS DASHBOARD */}
      {phase === 'results' && <div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <button onClick={() => setTab('dash')} style={{ padding: 8, background: tab==='dash'?'#1e1e2e':'transparent', color: '#fff', border: '1px solid #1e1e2e', borderRadius: 6, cursor: 'pointer' }}>Dashboard</button>
          <button onClick={() => setTab('audit')} style={{ padding: 8, background: tab==='audit'?'#1e1e2e':'transparent', color: '#fff', border: '1px solid #1e1e2e', borderRadius: 6, cursor: 'pointer' }}>Content AI Audit</button>
          <button onClick={() => setTab('ai')} style={{ padding: 8, background: tab==='ai'?'#1e1e2e':'transparent', color: '#fff', border: '1px solid #1e1e2e', borderRadius: 6, cursor: 'pointer' }}>Strategy AI</button>
          <button onClick={() => setPhase('input')} style={{ padding: 8, marginLeft: 'auto', background: 'transparent', color: '#71717a', border: '1px solid #1e1e2e', borderRadius: 6, cursor: 'pointer' }}>New Crawl</button>
        </div>

        {tab === 'dash' && <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 10 }}>
            <S label="Pages" a={m1.crawled} b={m2.crawled} la={l1} lb={l2} />
            <S label="Avg Words" a={m1.avg_words} b={m2.avg_words} la={l1} lb={l2} />
            <S label="Schema %" a={m1.schema_pct+'%'} b={m2.schema_pct+'%'} la={l1} lb={l2} />
            <S label="Avg Int Links" a={m1.avg_int} b={m2.avg_int} la={l1} lb={l2} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 10 }}>
            <S label="Thin (<300w)" a={m1.thin} b={m2.thin} la={l1} lb={l2} low />
            <S label="No H1" a={m1.no_h1} b={m2.no_h1} la={l1} lb={l2} low />
            <S label="No Meta Desc" a={m1.no_meta} b={m2.no_meta} la={l1} lb={l2} low />
            <S label="Orphan Risk" a={m1.orphans} b={m2.orphans} la={l1} lb={l2} low />
          </div>
        </div>}

        {tab === 'audit' && <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <button onClick={() => runAudit(1)} disabled={auditLoading} style={{ flex: 1, padding: 12, borderRadius: 8, background: auditLoading?'#1e1e2e':C1, color: '#000', fontWeight: 'bold' }}>
              {auditLoading ? auditProg : `📝 Audit ${l1}`}
            </button>
            <button onClick={() => runAudit(2)} disabled={auditLoading} style={{ flex: 1, padding: 12, borderRadius: 8, background: auditLoading?'#1e1e2e':C2, color: '#000', fontWeight: 'bold' }}>
              {auditLoading ? auditProg : `📝 Audit ${l2}`}
            </button>
          </div>
          {auditText && <div style={{ background: '#0f0f14', border: '1px solid #1e1e2e', borderRadius: 8, padding: 16 }}><Md text={auditText} /></div>}
        </div>}

        {tab === 'ai' && <div>
          {!aiText && <button onClick={runAI} disabled={aiLoading} style={{ width: '100%', padding: 14, borderRadius: 8, background: '#1e1e2e', color: '#fff' }}>{aiLoading ? 'Analyzing...' : '🧠 Generate Strategy Comparison'}</button>}
          {aiText && <div style={{ background: '#0f0f14', border: '1px solid #1e1e2e', borderRadius: 8, padding: 16 }}><Md text={aiText} /></div>}
        </div>}
      </div>}
    </div>
  </div>;
}
