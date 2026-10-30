import { useState } from 'react';
import { ShieldCheck, UploadCloud, FileText, ScanSearch, Eraser, CheckCircle2, AlertTriangle, Download, RefreshCw, LockKeyhole, Eye, ShieldAlert } from 'lucide-react';

const API = (import.meta as any).env?.VITE_API_BASE_URL || '';
type Finding = { id: string; text: string; category: string; label?: string; confidence?: string; pageNumber?: number };
type Payload = Record<string, any>;

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [verification, setVerification] = useState<Payload | null>(null);
  const [report, setReport] = useState<Payload | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [stage, setStage] = useState(0);

  async function api(path: string, init?: RequestInit): Promise<Payload> {
    const response = await fetch(API + path, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
    return payload;
  }
  async function run(label: string, task: () => Promise<void>) {
    setBusy(label); setError('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'Unexpected error'); }
    finally { setBusy(''); }
  }
  function json(body: Payload): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  const scan = () => run('Scanning PDF…', async () => {
    if (!file) throw new Error('Choose a PDF first.');
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = ['image/png', 'image/jpeg'].includes(file.type) || /\.(png|jpe?g)$/i.test(file.name);
    if (!isPdf && !isImage) throw new Error('Choose a PDF, PNG, or JPEG image.');
    const form = new FormData(); form.append('file', file);
    const uploaded = await api(isImage ? '/api/upload-image' : '/api/upload', { method: 'POST', body: form });
    const id = uploaded.documentId;
    if (!id) throw new Error('Upload succeeded but the API did not return a document ID.');
    setDocumentId(id);
    const detected = await api('/api/detect', json({ documentId: id }));
    const items = Array.isArray(detected.items) ? detected.items : [];
    setFindings(items); setSelected(items.map((x: Finding) => x.id));
    setVerification(null); setReport(null); setStage(1);
  });
  const protect = () => run('Redacting and verifying…', async () => {
    if (!documentId) throw new Error('Upload and scan a PDF first.');
    await api('/api/redact', json({ documentId, mode: 'selective', selectedItemIds: selected }));
    const result = await api('/api/verify', json({ documentId, runOcrCheck: true }));
    setVerification(result.verification || {});
    setReport(result.report || {});
    setStage(2);
  });
  const reset = () => { setFile(null); setDocumentId(''); setFindings([]); setSelected([]); setVerification(null); setReport(null); setError(''); setStage(0); };
  const download = () => window.open(API + '/api/download/' + encodeURIComponent(documentId), '_blank', 'noopener,noreferrer');
  const remaining = verification?.remainingItems?.length ?? verification?.selectedStillDetectableCount ?? 0;
  const exportReport = () => {
    const blob = new Blob([JSON.stringify(report || verification, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'docshield-privacy-report.json'; anchor.click(); URL.revokeObjectURL(url);
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><ShieldCheck size={22}/></div><div><b>docshield</b><small>DOCUMENT PRIVACY</small></div></div>
      <div className="workspace-label">WORKSPACE</div><div className="nav-item active"><ScanSearch size={17}/> Leak inspector</div>
      <div className="nav-item"><LockKeyhole size={17}/> Privacy reports <span className="soon">MVP</span></div>
      <div className="sidebar-bottom"><div className="secure-icon"><ShieldCheck size={18}/></div><b>Privacy-first processing</b><p>Upload only documents you are authorized to process. Review backend retention settings before using real personal data.</p><small>DOCSHIELD WORKSPACE</small></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="crumb">Workspace</span><span className="slash">/</span><b>Leak inspector</b></div><div className="backend-status"><span/> API workflow</div></header>
      <section className="hero"><div className="eyebrow"><span className="eyebrow-dot"/> SMART DOCUMENT PRIVACY</div><h1>Share documents.<br/><em>Not your private data.</em></h1><p className="hero-copy">Find sensitive information, redact selected details, and verify the exported document before sharing.</p><div className="hero-pills"><span><ScanSearch size={14}/> Sensitive-data detection</span><span><Eraser size={14}/> Permanent redaction</span><span><ShieldCheck size={14}/> Post-redaction verification</span></div></section>
      <section className="steps">{[['01','Upload','Choose a PDF'],['02','Inspect','Review possible leaks'],['03','Protect','Redact and verify']].map((s,i)=><div key={s[0]} className={'step '+(stage===i?'current':stage>i?'complete':'')}><div className="step-num">{stage>i?'✓':s[0]}</div><div><b>{s[1]}</b><small>{s[2]}</small></div></div>)}</section>
      {error && <div className="error-banner"><AlertTriangle size={18}/><span>{error}</span><button onClick={()=>setError('')}>Dismiss</button></div>}
      <div className="content-grid">
        <section className="panel upload-panel"><div className="panel-head"><div><div className="section-kicker">01 / DOCUMENT</div><h2>Inspect a document</h2><p>Upload a PDF, screenshot, or photo to extract sensitive information with OCR.</p></div><div className="panel-icon"><FileText size={20}/></div></div>
          <label className="dropzone"><input type="file" accept="application/pdf,.pdf,image/png,image/jpeg,.png,.jpg,.jpeg" onChange={e=>{setFile(e.target.files?.[0] || null);setError('');}}/><div className="upload-icon"><UploadCloud size={25}/></div><b>{file ? file.name : 'Choose a PDF or image to begin'}</b><span>{file ? (file.size/1024/1024).toFixed(2)+' MB · Ready to scan' : 'Click here to browse files'}</span><small>PDF only · Server size limits apply</small></label>
          <button className="primary-btn full" disabled={!file || !!busy} onClick={scan}>{busy ? <><RefreshCw className="spin" size={17}/>{busy}</> : <><ScanSearch size={17}/> Extract & scan sensitive data <span>→</span></>}</button>
          <div className="privacy-note"><LockKeyhole size={15}/><span>Use sample or authorized documents. Automated detection can miss information; review the output before sharing.</span></div>
          {documentId && <div className="doc-chip"><CheckCircle2 size={16}/><span><b>Document scanned</b><small>{documentId}</small></span></div>}
        </section>
        <section className="panel findings-panel"><div className="panel-head"><div><div className="section-kicker">02 / FINDINGS</div><h2>Privacy findings <span className="count">{findings.length}</span></h2><p>Select the items you want the backend to redact.</p></div><div className="panel-icon"><Eye size={20}/></div></div>
          {!findings.length ? <div className="empty-state"><div className="empty-graphic"><ScanSearch size={30}/></div><b>Scan results appear here</b><p>Upload a PDF to review detected sensitive fields.</p></div> : <><div className="findings-toolbar"><span>{selected.length} of {findings.length} selected</span><button onClick={()=>setSelected(selected.length===findings.length?[]:findings.map(x=>x.id))}>{selected.length===findings.length?'Deselect all':'Select all'}</button></div><div className="findings-list">{findings.map(f=><label className="finding" key={f.id}><input type="checkbox" checked={selected.includes(f.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,f.id]:old.filter(id=>id!==f.id))}/><span className="finding-detail"><b>{f.text || f.label || f.category}</b><small>{(f.label || f.category || 'Sensitive field').replaceAll('_',' ')} · Page {f.pageNumber ?? '—'}</small></span><span className={'confidence '+(f.confidence==='HIGH'?'high':'medium')}>{f.confidence || 'REVIEW'}</span></label>)}</div><button className="primary-btn full" disabled={!documentId || !!busy || selected.length===0} onClick={protect}><Eraser size={17}/>{busy || 'Redact selected & verify'} <span>→</span></button></>}
        </section>
      </div>
      <section className="bottom-grid"><div className="panel feature-panel"><div className="feature-icon purple"><Eye size={19}/></div><div><h3>Hidden-content checks</h3><p>Current verification re-extracts content and can run OCR on the redacted PDF. Metadata, embedded files and every visual leak require separate validation.</p><span className="feature-tag">VERIFY THE OUTPUT</span></div></div><div className="panel feature-panel"><div className="feature-icon green"><ShieldAlert size={19}/></div><div><h3>Re-identification awareness</h3><p>Removing a name may not be enough. Combinations of location, institution and rare details can still identify someone; treat these as review risks.</p><span className="feature-tag">HUMAN REVIEW</span></div></div></section>
      {verification && <section className="panel results-panel"><div className="panel-head"><div><div className="section-kicker">03 / VERIFICATION</div><h2>Protection results</h2><p>Based on the backend verification response.</p></div><div className="result-status"><CheckCircle2 size={16}/>{remaining ? 'Review remaining exposure' : 'No matching residual patterns reported'}</div></div>
        <div className="metrics"><div><small>Selected for redaction</small><b>{verification.selectedItemsCount ?? selected.length}</b></div><div><small>Successfully removed</small><b>{verification.successfullyRemovedCount ?? '—'}</b></div><div><small>Remaining findings</small><b className={remaining?'warn':''}>{remaining}</b></div><div><small>Pages checked</small><b>{verification.postExtractionSummary?.pageCount ?? verification.pageCount ?? '—'}</b></div></div>
        <p className="result-disclaimer">{verification.verificationDisclaimer || 'Automated verification is not a guarantee of privacy. Inspect the downloaded PDF visually and avoid sharing until remaining findings are resolved.'}</p><div className="result-actions"><button className="primary-btn" onClick={download}><Download size={17}/> Download protected PDF</button><button className="secondary-btn" onClick={exportReport}><FileText size={17}/> Export report</button><button className="secondary-btn" onClick={reset}>New document</button></div>
      </section>}
      <footer><div className="footer-brand"><ShieldCheck size={16}/> DOCSHIELD</div><span>Built to reduce accidental exposure, not guarantee anonymity.</span><span>SHA-256 integrity · OCR-assisted checks</span></footer>
    </main>
  </div>;
}
