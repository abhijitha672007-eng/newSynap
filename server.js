// ============================================================
// NeuSynap DB — Backend Server
// Middleman between your webpage and NCBI/AI services.
// Fixes CORS and keeps API keys safe.
// ============================================================

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── API KEYS — set these in Render.com, NEVER paste them here
const NCBI_KEY      = process.env.NCBI_API_KEY      || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const NCBI_TOOL     = 'NeuSynapDB';
const NCBI_EMAIL    = process.env.CONTACT_EMAIL || 'neusynap@research.org';

// ── SETUP ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const wait       = ms => new Promise(r => setTimeout(r, ms));
const ncbiSuffix = () => `&tool=${NCBI_TOOL}&email=${NCBI_EMAIL}${NCBI_KEY ? '&api_key=' + NCBI_KEY : ''}`;

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status : 'online',
    service: 'NeuSynap DB Backend v1.0',
    ncbi   : NCBI_KEY      ? 'API key configured ✓' : 'No API key ✗',
    ai     : ANTHROPIC_KEY ? 'API key configured ✓' : 'No API key ✗',
    time   : new Date().toISOString()
  });
});

// ── POST /blast ───────────────────────────────────────────────
app.post('/blast', async (req, res) => {
  const { sequence, program='blastp', database='refseq_protein',
          organism='', evalue='0.01', hitlist='20' } = req.body;

  if (!sequence || sequence.trim().length < 10)
    return res.status(400).json({ error: 'Sequence too short (min 10 chars).' });

  const clean = sequence.split('\n').filter(l => !l.startsWith('>')).join('').replace(/\s/g,'').toUpperCase();
  console.log(`[BLAST] ${clean.length} chars | ${program} | ${database}`);

  try {
    // 1. Submit to NCBI
    const params = new URLSearchParams({ CMD:'Put', PROGRAM:program, DATABASE:database,
      QUERY:clean, FORMAT_TYPE:'JSON2', HITLIST_SIZE:hitlist, EXPECT:evalue,
      WORD_SIZE: program==='blastn' ? '11' : '6', FILTER:'L', tool:NCBI_TOOL, email:NCBI_EMAIL });
    if (NCBI_KEY)              params.append('api_key', NCBI_KEY);
    if (organism && organism.trim()) params.append('EQ_MENU', organism);

    const sub  = await fetch('https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi',
      { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:params });
    const stxt = await sub.text();
    // Parse RID carefully - must start with a letter and be 6+ chars (not RTOE which is digits only)
    const ridMatch = stxt.match(/\bRID\s*=\s*([A-Z][A-Z0-9]{5,})/);
    const rid      = ridMatch ? ridMatch[1] : null;
    const rtoeMatch = stxt.match(/RTOE\s*=\s*(\d+)/);
    const rtoe     = rtoeMatch ? parseInt(rtoeMatch[1]) * 1000 : 12000;

    if (!rid) return res.status(500).json({ error: 'NCBI did not return a job ID.' });
    console.log(`[BLAST] RID=${rid} | wait=${rtoe/1000}s`);

    // 2. Poll
    await wait(Math.min(rtoe, 10000));
    for (let i=1; i<=30; i++) {
      console.log(`[BLAST] Poll ${i}/30`);
      const pr  = await fetch(`https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi?CMD=Get&FORMAT_TYPE=JSON2&RID=${rid}&HITLIST_SIZE=${hitlist}${ncbiSuffix()}`);
      const pt  = await pr.text();
      if (pt.includes('Status=WAITING')) { await wait(5000); continue; }
      if (pt.includes('Status=FAILED'))  return res.status(500).json({ error:'BLAST job failed.', rid });

      const jm = pt.match(/\{[\s\S]*"BlastOutput2"[\s\S]*\}/);
      if (jm) {
        try {
          const jd   = JSON.parse(jm[0]);
          const hits = jd.BlastOutput2[0].report.results.iterations[0].hits || [];
          return res.json({
            status:'success', rid, ncbi_url:`https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi?CMD=Get&RID=${rid}`,
            query_len:clean.length, program, database, total_hits:hits.length,
            hits: hits.slice(0,20).map(h => {
              const hsp=h.hsps[0], desc=h.description[0];
              return {
                accession:desc.accession, title:desc.title, sciname:desc.sciname||'',
                score:parseFloat(hsp.bit_score.toFixed(1)), evalue:hsp.evalue,
                identity:Math.round((hsp.identity/hsp.align_len)*100),
                align_len:hsp.align_len, gaps:hsp.gaps,
                coverage:Math.round((hsp.align_len/clean.length)*100),
                qseq:hsp.qseq, midline:hsp.midline, hseq:hsp.hseq,
                ncbi_url:`https://www.ncbi.nlm.nih.gov/protein/${desc.accession}`
              };
            })
          });
        } catch(_) {}
      }
      await wait(5000);
    }

    return res.json({ status:'timeout', rid,
      ncbi_url:`https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi?CMD=Get&RID=${rid}`,
      message:'BLAST is still running. View results on NCBI via the link.' });

  } catch(e) { return res.status(500).json({ error:e.message }); }
});

// ── GET /ncbi/gene?term=alzheimer ─────────────────────────────
app.get('/ncbi/gene', async (req, res) => {
  const { term, retmax=20 } = req.query;
  if (!term) return res.status(400).json({ error:'No term.' });
  try {
    const s = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gene&term=${encodeURIComponent(term)}&retmax=${retmax}&retmode=json${ncbiSuffix()}`)).json();
    const ids = s.esearchresult.idlist;
    if (!ids.length) return res.json({ results:[], total:0 });
    const m = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${ids.join(',')}&retmode=json${ncbiSuffix()}`)).json();
    res.json({ results: m.result.uids.filter(u=>m.result[u]?.status!=='discontinued').map(u=>({uid:u,...m.result[u]})), total:s.esearchresult.count });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── GET /ncbi/protein?term=tau ────────────────────────────────
app.get('/ncbi/protein', async (req, res) => {
  const { term, retmax=12 } = req.query;
  if (!term) return res.status(400).json({ error:'No term.' });
  try {
    const s = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=protein&term=${encodeURIComponent(term)}&retmax=${retmax}&retmode=json${ncbiSuffix()}`)).json();
    const ids = s.esearchresult.idlist;
    if (!ids.length) return res.json({ results:[], total:0 });
    const m = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=protein&id=${ids.join(',')}&retmode=json${ncbiSuffix()}`)).json();
    res.json({ results: m.result.uids.filter(u=>m.result[u]).map(u=>({uid:u,...m.result[u]})), total:s.esearchresult.count });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── GET /ncbi/clinvar?gene=SNCA ───────────────────────────────
app.get('/ncbi/clinvar', async (req, res) => {
  const { gene, retmax=20 } = req.query;
  if (!gene) return res.status(400).json({ error:'No gene.' });
  try {
    const term = `${gene}[gene] AND (pathogenic[clinsig] OR "likely pathogenic"[clinsig])`;
    const s = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar&term=${encodeURIComponent(term)}&retmax=${retmax}&retmode=json${ncbiSuffix()}`)).json();
    const ids = s.esearchresult.idlist;
    if (!ids.length) return res.json({ results:[], total:0 });
    const m = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&id=${ids.join(',')}&retmode=json${ncbiSuffix()}`)).json();
    res.json({ results: m.result.uids.filter(u=>m.result[u]).map(u=>({uid:u,...m.result[u]})), total:s.esearchresult.count });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── GET /ncbi/pubmed?term=tau&filter=5 ───────────────────────
app.get('/ncbi/pubmed', async (req, res) => {
  const { term, retmax=15, filter='' } = req.query;
  if (!term) return res.status(400).json({ error:'No term.' });
  try {
    const yr = new Date().getFullYear();
    let q = `${term} AND (neurological[TIAB] OR neurodegenerative[TIAB] OR neuron[TIAB])`;
    if (filter==='1')       q += ` AND ("${yr-1}"[PDAT]:"${yr}"[PDAT])`;
    else if(filter==='5')   q += ` AND ("${yr-5}"[PDAT]:"${yr}"[PDAT])`;
    else if(filter==='10')  q += ` AND ("${yr-10}"[PDAT]:"${yr}"[PDAT])`;
    else if(filter==='review') q += ' AND Review[ptyp]';
    else if(filter==='free')   q += ' AND free full text[filter]';

    const s   = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmax=${retmax}&sort=relevance&retmode=json${ncbiSuffix()}`)).json();
    const ids = s.esearchresult.idlist;
    if (!ids.length) return res.json({ results:[], total:0 });

    const m = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json${ncbiSuffix()}`)).json();

    // Fetch abstracts
    let abstracts = {};
    try {
      const xml = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&retmode=xml&rettype=abstract${ncbiSuffix()}`)).text();
      for (const art of xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)) {
        const pmid = (art[1].match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1];
        const abs  = (art[1].match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g) || []).map(a=>a.replace(/<[^>]+>/g,'')).join(' ');
        if (pmid) abstracts[pmid] = abs || null;
      }
    } catch(_) {}

    res.json({
      results: m.result.uids.filter(u=>m.result[u]).map(u => {
        const p = m.result[u];
        return { uid:u, title:p.title, authors:(p.authors||[]).slice(0,5).map(a=>a.name),
          journal:p.fulljournalname||p.source||'', year:(p.pubdate||'').substring(0,4),
          volume:p.volume||'', issue:p.issue||'', pmc:p.pmc||null,
          abstract:abstracts[u]||null, url:`https://pubmed.ncbi.nlm.nih.gov/${u}/` };
      }),
      total: s.esearchresult.count
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── POST /ai/analyze ──────────────────────────────────────────
app.post('/ai/analyze', async (req, res) => {
  const { sequence, type='protein' } = req.body;
  if (!sequence)      return res.status(400).json({ error:'No sequence.' });
  if (!ANTHROPIC_KEY) return res.status(503).json({ error:'AI not configured on server.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model:'claude-sonnet-4-20250514', max_tokens:1000,
        messages:[{ role:'user', content:`Neurological disease bioinformatics expert. Analyze this ${type} sequence. Return ONLY valid JSON, no markdown:\n{"protein_name":"","gene_symbol":"","organism":"","disease_relevance":"","key_features":"","homologs":"","confidence":"high|medium|low"}\n\nSequence:\n${sequence.substring(0,200)}` }]
      })
    });
    const d = await r.json();
    res.json(JSON.parse(d.content[0].text.replace(/```json|```/g,'').trim()));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅  NeuSynap Backend on port ${PORT}`));
