import { useState, useCallback, useRef } from 'react';
const F = "'JetBrains Mono', 'SF Mono', monospace";
const C1 = '#06b6d4', C2 = '#8b5cf6';

function crawlSite(url, max, onProg, onLog) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/crawl?url=${encodeURIComponent(url)}&max=${max}`);
    es.addEventListener('progress', e => onProg(JSON.parse(e.data)));
    es.addEventListener('log', e => onLog(JSON.parse(e.data)));
    es.addEventListener('done', e => { es.close(); resolve(JSON.parse(e.data)); });
    es.addEventListener('error', e => { try { reject(new Error(JSON.parse(e.data).message)); } catch { reject(new Error('Connection lost')); } es.close(); });
    es.onerror = () => { es.close(); reject(new Error('Server connection lost')); };
  });
}
async function callAI(system, prompt) {
  const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system, prompt }) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d.text;
}
async function auditBatch(dom, idx) {
  const r = await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: dom, batchIndex: idx }) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
}

const SYS = 'You are a world-class Technical SEO Consultant analyzing REAL crawl data extracted from actual HTML source code. Every observation must cite specific numbers. Never guess.';

function Md({ text }) {
  if (!text) return null;
  return <div style={{ lineHeight: 1.75 }}>{text.split('\n').map((l, i) => {
    const t = l.trim();
    if (!t) return <div key={i} style={{ height: 6 }} />;
    if (t.startsWith('## ')) return <h2 key={i} style={{ fontSize: 15, fontWeight: 700, color: '#e4e4e7', margin: '18px 0 6px', borderBottom: '1px solid #1e1e2e', paddingBottom: 4 }}>{t.slice(3)}</h2>;
    if (t.startsWith('### ') || t.startsWith('━')) return <h3 key={i} style={{ fontSize: 13, fontWeight: 600, color: '#a1a1aa', margin: '12px 0 4px' }}>{t.replace(/━/g, '').slice(t.startsWith('###') ? 4 : 0)}</h3>;
    if (t.startsWith('- ')) return <div key={i} style={{ paddingLeft: 16, marginBottom: 2, fontSize: 12, color: '#a1a1aa', position: 'relative' }}><span style={{ position: 'absolute', left: 2, color: C1 }}>•</span>{inl(t.slice(2))}</div>;
    if (/^\d+\.\s/.test(t)) return <div key={i} style={{ paddingLeft: 20, marginBottom: 3, fontSize: 12, color: '#a1a1aa', position: 'relative' }}><span style={{ position: 'absolute', left: 0, color: C2, fontWeight: 700 }}>{t.match(/^\d+/)[0]}.</span>{inl(t.replace(/^\d+\.\s*/, ''))}</div>;
    return <p key={i} style={{ fontSize: 12, color: '#a1a1aa', marginBottom: 2 }}>{inl(t)}</p>;
  })}</div>;
}
function inl(t) { return t.split(/(\*\*[^*]+\*\*)/g).map((p, j) => p.startsWith('**') && p.endsWith('**') ? <strong key={j} style={{ color: '#d4d4d8' }}>{p.slice(2, -2)}</strong> : p); }

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
  const [max, setMax] = useState(200);
  const [status, setStatus] = useState(''); const [prog, setProg] = useState(null); const [crawlN, setCrawlN] = useState(0);
  const [d1, setD1] = useState(null); const [d2, setD2] = useState(null);
  const [tab, setTab] = useState('dash'); const [err, setErr] = useState('');
  const [aiText, setAiText] = useState(''); const [aiLoading, setAiLoading] = useState(false);
  const [auditText, setAuditText] = useState(''); const [auditLoading, setAuditLoading] = useState(false); const [auditProg, setAuditProg] = useState('');
  const [expanded, setExpanded] = useState(null);

  const ok = url1.startsWith('http') && url2.startsWith('http');
  const dom = u => { try { return new URL(u).hostname.replace('www.', ''); } catch { return u; } };
  const l1 = dom(url1), l2 = dom(url2);

  const run = useCallback(async () => {
    setPhase('crawl'); setErr(''); setD1(null); setD2(null); setAiText(''); setAuditText('');
    try {
      setCrawlN(1); setStatus(`Crawling ${l1}...`); setProg(null);
      const r1 = await crawlSite(url1, max, setProg, d => setStatus(d));
      setD1(r1);
      setCrawlN(2); setStatus(`Crawling ${l2}...`); setProg(null);
      const r2 = await crawlSite(url2, max, setProg, d => setStatus(d));
      setD2(r2);
      setPhase('results'); setTab('dash');
    } catch (e) { setErr(e.message); setPhase('err'); }
  }, [url1, url2, max, l1, l2]);

  // AI summary from metrics
  const runAI = async () => {
    if (!d1?.metrics || !d2?.metrics) return;
    setAiLoading(true);
    const sum = m => `Pages:${m.crawled} Words:${m.avg_words} Thin:${m.thin}(${m.thin_pct}%) Long:${m.long} IntLinks:${m.avg_int} ExtLinks:${m.avg_ext} Orphans:${m.orphans} NoTitle:${m.no_title} NoH1:${m.no_h1} NoMeta:${m.no_meta} NoCanon:${m.no_canon} Noindex:${m.noindex} CSR:${m.csr} Schema:${m.schema_pct}% Types:${JSON.stringify(m.schema_types)} Hreflang:${m.hreflang.join(',')||'none'} OG:${m.og_pct}% Alt:${m.alt_pct}% Dupes:${m.duplicates} Cats:${JSON.stringify(m.categories)}\nFeatures:${JSON.stringify(m.features)}\nIssues(${m.issues.length}):${m.issues.slice(0,25).map(i=>`${i.type}:${i.url}`).join(' | ')}`;
    try {
      const t = await callAI(SYS, `Compare these sites using REAL crawl data:\n\n## ${l1} (OUR SITE)\n${sum(d1.metrics)}\n\n## ${l2} (COMPETITOR)\n${sum(d2.metrics)}\n\nProvide:\n## Scorecard (1-10 each site, per category)\n## Content Gap Analysis\n## Technical SEO Issues (cite exact numbers)\n## Feature Gap Matrix\n## Action Plan: This Week (5) | 30 Days (5) | 90 Days (3)\nEach action: What | Why (cite data) | Impact H/M/L`);
      setAiText(t);
    } catch (e) { setAiText(`Error: ${e.message}`); }
    setAiLoading(false);
  };

  // Batch content audit
  const runAudit = async (dom) => {
    setAuditLoading(true); setAuditText('');
    let all = '', idx = 0, done = false;
    while (!done) {
      setAuditProg(`Auditing batch ${idx + 1}...`);
      try {
        const r = await auditBatch(dom, idx);
        all += (r.text || '') + '\n\n';
        setAuditText(all);
        done = r.done;
        idx++;
      } catch (e) { all += `\nError on batch ${idx + 1}: ${e.message}\n`; setAuditText(all); done = true; }
    }
    setAuditProg(`Done — ${idx} batches`);
    setAuditLoading(false);
  };

  const m1 = d1?.metrics, m2 = d2?.metrics;
  const TABS = [
    { id: 'dash', label: 'Dashboard', icon: '📊' },
    { id: 'feat', label: 'Features', icon: '🛡️' },
    { id: 'pg1', label: l1 || 'Site 1', icon: '📄' },
    { id: 'pg2', label: l2 || 'Site 2', icon: '📄' },
    { id: 'issues', label: 'Issues', icon: '⚠️' },
    { id: 'audit', label: 'Content Audit', icon: '📝' },
    { id: 'ai', label: 'AI Summary', icon: '🧠' },
  ];

  return <div style={{ fontFamily: F, background: '#09090b', color: '#e4e4e7', minHeight: '100vh' }}>
    <div style={{ background: 'linear-gradient(90deg, rgba(6,182,212,0.04), rgba(139,92,246,0.04))', borderBottom: '1px solid #141418', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 18 }}>🔬</span>
      <span style={{ fontSize: 13, fontWeight: 700 }}>SEO Intelligence</span>
      <span style={{ fontSize: 9, color: '#27272a', marginLeft: 4 }}>v3 — REAL CRAWLER</span>
    </div>

    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 14px' }}>

      {/* INPUT */}
      {phase === 'input' && <div>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, background: 'linear-gradient(135deg,#06b6d4,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: 6 }}>Full Site Crawler + AI Content Audit</h1>
          <p style={{ fontSize: 11, color: '#3f3f46' }}>Every page. Every heading. Every link. Real HTML source code → AI assessment.</p>
        </div>
        {[['YOUR SITE', url1, setUrl1, C1], ['COMPETITOR', url2, setUrl2, C2]].map(([lbl, val, set, c], i) => <div key={i} style={{ background: '#0f0f14', border: '1px solid #1e1e2e', borderRadius: 12, padding: 16, marginBottom: i === 0 ? 8 : 16 }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: c, marginBottom: 8 }}>{lbl}</div>
          <input value={val} onChange={e => set(e.target.value)} placeholder="https://example.com" style={{ width: '100%', padding: '11px 12px', borderRadius: 8, border: `2px solid ${val.startsWith('http') ? '#22c55e30' : '#1e1e2e'}`, background: '#09090b', color: '#e4e4e7', fontSize: 12, fontFamily: F, outline: 'none' }} />
        </div>)}

        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: '#3f3f46', marginBottom: 4 }}>MAX PAGES</div>
            <select value={max} onChange={e => setMax(+e.target.value)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #1e1e2e', background: '#0f0f14', color: '#a1a1aa', fontFamily: F, fontSize: 11 }}>
              {[50,100,200,500,1000].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        <button onClick={run} disabled={!ok} style={{ width: '100%', padding: 14, borderRadius: 10, border: 'none', cursor: ok ? 'pointer' : 'not-allowed', background: ok ? 'linear-gradient(135deg,#06b6d4,#8b5cf6)' : '#1e1e2e', color: ok ? '#fff' : '#3f3f46', fontSize: 14, fontWeight: 700, fontFamily: F }}>
          {ok ? '🕷️ Start Full Crawl' : 'Enter both URLs'}
        </button>
      </div>}

      {/* CRAWLING */}
      {phase === 'crawl' && <div>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 26, marginBottom: 6 }}>🕷️</div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Crawling Site {crawlN}/2</div>
          <div style={{ fontSize: 11, color: '#3f3f46', marginTop: 4 }}>{status}</div>
        </div>
        <div style={{ background: '#0f0f14', border: '1px solid #1e1e2e', borderRadius: 12, padding: 16 }}>
          {prog && <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: C1 }}>{prog.done}/{prog.total}</span>
              <span style={{ color: '#27272a' }}>{prog.queued} queued</span>
            </div>
            <div style={{ height: 5, background: '#1e1e2e', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', width: `${(prog.done / prog.total) * 100}%`, background: `linear-gradient(90deg,${C1},${C2})`, transition: 'width 0.3s' }} />
            </div>
            <div style={{ fontSize: 10, color: '#27272a', wordBreak: 'break-all' }}>{prog.url}</div>
          </>}
          {d1 && <div style={{ marginTop: 10, fontSize: 11, color: '#22c55e' }}>✓ {l1}: {d1.metrics.crawled} pages</div>}
        </div>
      </div>}

      {/* ERROR */}
      {phase === 'err' && <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>⚠️</div>
        <p style={{ color: '#f87171', fontSize: 13, marginBottom: 16 }}>{err}</p>
        <button onClick={() => setPhase('input')} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #27272a', background: 'transparent', color: '#71717a', fontFamily: F, cursor: 'pointer' }}>Retry</button>
      </div>}

      {/* RESULTS */}
      {phase === 'results' && m1 && m2 && <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div><div style={{ fontSize: 9, color: '#22c55e', letterSpacing: 2 }}>CRAWL COMPLETE</div><div style={{ fontSize: 16, fontWeight: 700 }}>{l1} <span style={{ color: '#27272a', fontWeight: 400, fontSize: 12 }}>vs</span> {l2}</div></div>
          <button onClick={() => setPhase('input')} style={{ fontSize: 10, padding: '4px 12px', borderRadius: 6, border: '1px solid #1e1e2e', background: 'transparent', color: '#3f3f46', fontFamily: F, cursor: 'pointer' }}>New</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 14, overflowX: 'auto', background: '#0a0a0f', borderRadius: 8, padding: 2, border: '1px solid #141418' }}>
          {TABS.map(t => <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: '0 0 auto', padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: F, fontSize: 10, fontWeight: 600, background: tab === t.id ? 'rgba(6,182,212,0.1)' : 'transparent', color: tab === t.id ? '#e4e4e7' : '#27272a', whiteSpace: 'nowrap' }}>{t.icon} {t.label}</button>)}
        </div>

        {/* DASHBOARD */}
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
            <S label="CSR Pages" a={m1.csr} b={m2.csr} la={l1} lb={l2} low />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 10 }}>
            <S label="Orphan Risk" a={m1.orphans} b={m2.orphans} la={l1} lb={l2} low />
            <S label="Noindex" a={m1.noindex} b={m2.noindex} la={l1} lb={l2} />
            <S label="Alt Text %" a={m1.alt_pct+'%'} b={m2.alt_pct+'%'} la={l1} lb={l2} />
            <S label="Duplicates" a={m1.duplicates} b={m2.duplicates} la={l1} lb={l2} low />
          </div>
          {/* Schema + Hreflang */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            {[{m:m1,l:l1},{m:m2,l:l2}].map(({m,l})=><div key={l} style={{ background:'#0f0f14', border:'1px solid #1e1e2e', borderRadius:8, padding:10 }}>
              <div style={{ fontSize:10, color:'#3f3f46', marginBottom:4 }}>Schema — {l}</div>
              {Object.keys(m.schema_types||{}).length ? Object.entries(m.schema_types).map(([t,c])=><div key={t} style={{fontSize:11,color:'#a1a1aa'}}>✓ {t} ({c})</div>) : <div style={{fontSize:11,color:'#f87171'}}>❌ None</div>}
              <div style={{fontSize:10,color:'#3f3f46',marginTop:6}}>Hreflang: {(m.hreflang||[]).length ? m.hreflang.join(', ') : '❌ None'}</div>
              {(m.has_toc || m.has_snapshot || m.has_methodology) && <div style={{marginTop:6,paddingTop:6,borderTop:'1px solid #1e1e2e'}}>
                <div style={{fontSize:10,color:'#3f3f46',marginBottom:2}}>Noted Features:</div>
                {m.has_toc && <div style={{fontSize:10,color:'#22c55e'}}>✓ Table of Content pages present</div>}
                {m.has_snapshot && <div style={{fontSize:10,color:'#22c55e'}}>✓ Snapshot pages present</div>}
                {m.has_methodology && <div style={{fontSize:10,color:'#22c55e'}}>✓ Methodology pages present</div>}
              </div>}
              {(m.noted_urls||[]).length > 0 && <div style={{fontSize:9,color:'#27272a',marginTop:4}}>{m.noted_urls.length} URLs noted but skipped (toc/snapshot)</div>}
            </div>)}
          </div>
        </div>}

        {/* FEATURES */}
        {tab === 'feat' && <div style={{ background:'#0f0f14', border:'1px solid #1e1e2e', borderRadius:10, padding:12, overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead><tr>{['Feature',`${l1} %`,`${l2} %`,'Winner'].map(h=><th key={h} style={{textAlign:h==='Feature'?'left':'center',padding:'6px 8px',borderBottom:'1px solid #1e1e2e',color:'#3f3f46'}}>{h}</th>)}</tr></thead>
            <tbody>{Object.keys(m1.features).map(k=>{
              const a=m1.features[k]?.pct||0,b=m2.features[k]?.pct||0;
              const w=a>b?l1:b>a?l2:a===0&&b===0?'—':'Tie';
              return <tr key={k} style={{borderBottom:'1px solid #0f0f14'}}>
                <td style={{padding:'4px 8px',color:'#a1a1aa'}}>{k.replace(/_/g,' ')}</td>
                <td style={{textAlign:'center',color:a>=50?'#22c55e':a===0?'#f87171':'#71717a'}}>{a}%</td>
                <td style={{textAlign:'center',color:b>=50?'#22c55e':b===0?'#f87171':'#71717a'}}>{b}%</td>
                <td style={{textAlign:'center',color:'#3f3f46',fontSize:10}}>{w}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}

        {/* PAGES (expandable) */}
        {(tab === 'pg1' || tab === 'pg2') && (() => {
          const d = tab === 'pg1' ? d1 : d2;
          const lbl = tab === 'pg1' ? l1 : l2;
          return <div>
            <div style={{fontSize:12,color:'#52525b',marginBottom:8}}>{lbl} — {d.pages.length} pages crawled</div>
            <div style={{background:'#0f0f14',border:'1px solid #1e1e2e',borderRadius:10,overflow:'hidden'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:10}}>
                <thead><tr style={{background:'#141418'}}>
                  {['','URL','Cat','Words','H1','Int','Ext','Schema','Issues'].map(h=><th key={h} style={{textAlign:'left',padding:'5px 6px',color:'#27272a',fontWeight:600}}>{h}</th>)}
                </tr></thead>
                <tbody>{d.pages.map((p,i)=>{
                  const iss=[];
                  if(!p.title)iss.push('No title');if(!p.h1)iss.push('No H1');if(!p.meta_desc)iss.push('No meta');
                  if(p.word_count<300&&p.category!=='Homepage')iss.push('Thin');if(p.is_csr)iss.push('CSR');
                  if(p.meta_robots.includes('noindex'))iss.push('Noindex');
                  const isExp = expanded === `${tab}-${i}`;
                  return [
                    <tr key={i} onClick={()=>setExpanded(isExp?null:`${tab}-${i}`)} style={{borderBottom:'1px solid #0d0d12',cursor:'pointer',background:isExp?'#141420':'transparent'}}>
                      <td style={{padding:'4px 6px',color:'#27272a'}}>{isExp?'▼':'▶'}</td>
                      <td style={{padding:'4px 6px',color:'#71717a',maxWidth:250,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{new URL(p.url).pathname||'/'}</td>
                      <td style={{padding:'4px 6px',color:'#3f3f46'}}>{p.category}</td>
                      <td style={{padding:'4px 6px',color:p.word_count<300?'#f87171':'#a1a1aa'}}>{p.word_count}</td>
                      <td style={{padding:'4px 6px',color:'#3f3f46',maxWidth:150,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.h1||'—'}</td>
                      <td style={{padding:'4px 6px',color:'#71717a'}}>{p.int_link_count}</td>
                      <td style={{padding:'4px 6px',color:'#71717a'}}>{p.ext_link_count}</td>
                      <td style={{padding:'4px 6px',color:p.has_schema?'#22c55e':'#27272a',fontSize:9}}>{p.schema_types?.join(', ')||'—'}</td>
                      <td style={{padding:'4px 6px'}}>{iss.map(s=><span key={s} style={{display:'inline-block',fontSize:8,background:'#1c1013',color:'#f87171',borderRadius:3,padding:'1px 4px',marginRight:2}}>{s}</span>)}</td>
                    </tr>,
                    isExp && <tr key={`exp-${i}`}><td colSpan={9} style={{padding:12,background:'#0d0d16',borderBottom:'2px solid #1e1e2e'}}>
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,fontSize:11}}>
                        <div>
                          <div style={{color:'#52525b',marginBottom:4}}>META</div>
                          <div style={{color:'#a1a1aa'}}>Title: <span style={{color:'#d4d4d8'}}>{p.title}</span> ({p.title_len}c)</div>
                          <div style={{color:'#a1a1aa'}}>Desc: <span style={{color:'#71717a'}}>{p.meta_desc||'MISSING'}</span> ({p.meta_desc_len}c)</div>
                          <div style={{color:'#a1a1aa'}}>Robots: {p.meta_robots||'index,follow'}</div>
                          <div style={{color:'#a1a1aa'}}>Canonical: {p.canonical||<span style={{color:'#f87171'}}>MISSING</span>}</div>
                          <div style={{color:'#a1a1aa'}}>OG: {p.has_og?'✓':'❌'} | Hreflang: {p.has_hreflang?p.hreflang_langs.join(','):'—'}</div>
                        </div>
                        <div>
                          <div style={{color:'#52525b',marginBottom:4}}>HEADING TREE</div>
                          {(p.heading_tree||[]).slice(0,15).map((h,j)=><div key={j} style={{color:'#71717a',paddingLeft:({h1:0,h2:12,h3:24,h4:36}[h.tag]||0),fontSize:h.tag==='h1'?12:10}}>
                            <span style={{color:h.tag==='h1'?C1:'#3f3f46'}}>{h.tag.toUpperCase()}</span> {h.text}
                          </div>)}
                        </div>
                        <div>
                          <div style={{color:'#52525b',marginBottom:4}}>IMAGES ({p.img_count}, {p.img_no_alt} no alt)</div>
                          {(p.images||[]).slice(0,5).map((img,j)=><div key={j} style={{fontSize:10,color:img.has_alt?'#71717a':'#f87171'}}>
                            {img.has_alt?'✓':'❌'} {img.alt||'[no alt]'}
                          </div>)}
                        </div>
                        <div>
                          <div style={{color:'#52525b',marginBottom:4}}>FEATURES</div>
                          {Object.entries(p.features||{}).filter(([_,v])=>v===true||(typeof v==='number'&&v>0)).map(([k])=><span key={k} style={{display:'inline-block',fontSize:9,background:'#0f1f15',color:'#22c55e',borderRadius:3,padding:'1px 5px',margin:'0 3px 3px 0'}}>{k}</span>)}
                        </div>
                      </div>
                    </td></tr>
                  ];
                })}</tbody>
              </table>
            </div>
          </div>;
        })()}

        {/* ISSUES */}
        {tab === 'issues' && <div>
          {[{m:m1,l:l1,c:C1},{m:m2,l:l2,c:C2}].map(({m,l,c})=><div key={l} style={{marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:600,color:c,marginBottom:6}}>{l} — {m.issues.length} issues</div>
            <div style={{background:'#0f0f14',border:'1px solid #1e1e2e',borderRadius:10,padding:10}}>
              {!m.issues.length?<div style={{color:'#22c55e',fontSize:11}}>✓ Clean</div>:
              m.issues.map((iss,i)=><div key={i} style={{fontSize:10,padding:'3px 0',borderBottom:'1px solid #0d0d12',display:'flex',gap:6}}>
                <span style={{color:{high:'#f87171',medium:'#fbbf24',low:'#71717a',info:'#3f3f46'}[iss.sev],minWidth:180}}>{iss.type}</span>
                <span style={{color:'#27272a',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{iss.url}</span>
              </div>)}
            </div>
          </div>)}
        </div>}

        {/* CONTENT AUDIT */}
        {tab === 'audit' && <div>
          <p style={{fontSize:11,color:'#3f3f46',marginBottom:12}}>Sends actual page content (headings, body text, links) to GPT-4o in batches for per-page scoring.</p>
          <div style={{display:'flex',gap:10,marginBottom:16}}>
            <button onClick={()=>runAudit(l1)} disabled={auditLoading} style={{flex:1,padding:12,borderRadius:8,border:'none',cursor:'pointer',background:auditLoading?'#1e1e2e':`linear-gradient(135deg,${C1},#0ea5e9)`,color:'#fff',fontFamily:F,fontSize:12,fontWeight:600}}>
              {auditLoading?auditProg:`📝 Audit ${l1}`}
            </button>
            <button onClick={()=>runAudit(l2)} disabled={auditLoading} style={{flex:1,padding:12,borderRadius:8,border:'none',cursor:'pointer',background:auditLoading?'#1e1e2e':`linear-gradient(135deg,${C2},#7c3aed)`,color:'#fff',fontFamily:F,fontSize:12,fontWeight:600}}>
              {auditLoading?auditProg:`📝 Audit ${l2}`}
            </button>
          </div>
          {auditText && <div style={{background:'#0f0f14',border:'1px solid #1e1e2e',borderRadius:10,padding:16,maxHeight:600,overflowY:'auto'}}>
            <Md text={auditText} />
          </div>}
        </div>}

        {/* AI SUMMARY */}
        {tab === 'ai' && <div>
          {!aiText && <div style={{textAlign:'center',padding:32}}>
            <p style={{fontSize:11,color:'#3f3f46',marginBottom:12}}>Sends aggregated crawl metrics to GPT-4o for competitive analysis.</p>
            <button onClick={runAI} disabled={aiLoading} style={{padding:'12px 36px',borderRadius:10,border:'none',cursor:'pointer',background:aiLoading?'#1e1e2e':'linear-gradient(135deg,#06b6d4,#8b5cf6)',color:'#fff',fontSize:13,fontWeight:700,fontFamily:F}}>
              {aiLoading?'Analyzing...':'🧠 Run AI Comparison'}
            </button>
          </div>}
          {aiText && <div style={{background:'#0f0f14',border:'1px solid #1e1e2e',borderRadius:10,padding:16}}>
            <Md text={aiText} />
          </div>}
        </div>}
      </div>}
    </div>
  </div>;
}
