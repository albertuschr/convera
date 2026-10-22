const dl = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
export const downloadJson = (name, obj) => dl(name, JSON.stringify(obj, null, 2), 'application/json');
export const downloadCsv = (name, headers, rows) => {
  const quote = (value) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const text = '\ufeff' + [headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
  dl(name, text, 'text/csv;charset=utf-8');
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Laporan → jendela cetak (pilih "Simpan sebagai PDF")
export function printReport({ title, range, kpis, top, note }) {
  const w = window.open('', '_blank'); if (!w) return false;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px system-ui,sans-serif;color:#1d1c1a;max-width:760px;margin:32px auto;padding:0 20px}h1{font-size:22px;margin:4px 0}small{color:#6b675f}.g{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:22px 0}.k{background:#f6f5f3;border-radius:10px;padding:12px}.k b{display:block;font-size:20px;margin:4px 0}.k i{font-size:11px;color:#b8530f;font-style:normal}table{width:100%;border-collapse:collapse}td{padding:9px 0;border-top:1px solid #e7e2db}.n{background:#fcebdf;border-radius:10px;padding:12px;margin-top:20px}@media print{body{margin:0}}</style>
<small>LAPORAN PERFORMA CTWA</small><h1>${esc(title)}</h1><small>${esc(range)}</small>
<div class="g">${kpis.map((k) => `<div class="k"><small>${esc(k.label)}</small><b>${esc(k.value)}</b><i>${esc(k.delta)}</i></div>`).join('')}</div>
<small>3 IKLAN TERBAIK</small><table>${top.map((a) => `<tr><td>${a.n}. <b>${esc(a.name)}</b></td><td>${esc(a.purch)}</td><td style="text-align:right"><b>${esc(a.roas)}</b></td></tr>`).join('')}</table>
${note ? `<div class="n">${esc(note)}</div>` : ''}<script>onload=()=>setTimeout(()=>print(),300)<\/script>`);
  w.document.close(); return true;
}

export function printInvoice({ number, date, plan, amount, workspace }) {
  const w = window.open('', '_blank'); if (!w) return false;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(number)}</title><style>body{font:14px system-ui,sans-serif;color:#1d1c1a;max-width:680px;margin:40px auto;padding:0 24px}header{display:flex;justify-content:space-between;border-bottom:2px solid #1d1c1a;padding-bottom:18px}h1{font-size:24px;margin:0 0 6px}small{color:#6b675f}.row{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e7e2db}.total{font-size:18px;font-weight:800;border-bottom:0}@media print{body{margin:0}}</style><header><div><h1>Convera</h1><small>Invoice pembayaran</small></div><div style="text-align:right"><b>${esc(number)}</b><br><small>${esc(date)}</small></div></header><p>${esc(workspace)}</p><div class="row"><span>Paket</span><b>${esc(plan)}</b></div><div class="row total"><span>Total dibayar</span><b>${esc(amount)}</b></div><p><small>Invoice ini dibuat dari data lokal workspace. Simpan sebagai PDF melalui dialog cetak browser.</small></p><script>onload=()=>setTimeout(()=>print(),300)<\/script>`);
  w.document.close(); return true;
}
