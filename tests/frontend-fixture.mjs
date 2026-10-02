export const source = `import {useState} from 'react';
export default function Screen(){const [open,setOpen]=useState(false);return <main className="p-6 bg-slate-100" data-canvy-name="Dashboard">
<section className="bg-white p-4 rounded-xl shadow-md" id="card"><header><svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 3h18v18H3z" fill="#2563eb"/></svg><h1>Reservations</h1></header>
<div className="grid grid-cols-1 md:grid-cols-2 gap-4"><article id="summary"><strong>Outstanding</strong><p>€50.00</p></article><article><img src="/badge.svg" width="32" height="32"/><p>Paid today</p></article></div>
<button id="details" onClick={()=>setOpen(true)}>View details</button>{open&&<div role="dialog"><p>Payment details</p><input aria-label="Reference"/><button onClick={()=>setOpen(false)}>Close</button></div>}
</section></main>}`;
export const css = `@font-face{font-family:Fixture;src:url('/fixture.ttf');font-weight:400}@font-face{font-family:Fixture;src:url('/fixture-bold.ttf');font-weight:700}body{font-family:Fixture}h1{font-size:24px;line-height:32px;margin:0}header{display:flex;gap:12px;align-items:center;margin-bottom:24px}p{margin:8px 0}button{background:#2563eb;color:white;border:0;border-radius:6px;padding:10px 16px}[role=dialog]{position:fixed;inset:20px;background:white;padding:20px;border:1px solid #ddd}`;
export const badge = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#16a34a"/></svg>';
