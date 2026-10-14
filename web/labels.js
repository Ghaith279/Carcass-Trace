// Label printing. Builds one page per label at the label size set in Settings and opens the
// browser's print dialog. Set the label printer as the default printer with the same paper size.
// To skip the dialog entirely, start Chrome with --kiosk-printing (see README).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dm = d => { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}`; };
const dmy = d => { const x = new Date(d); return `${dm(x)}/${x.getFullYear()}`; };
const kg3 = v => Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
// use_by is a plain date (YYYY-MM-DD); read it without timezone shifts
const ymdToDm = s => { const [, m, d] = String(s).split('-'); return `${d}/${m}`; };

function barcodeSvg(value) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  window.JsBarcode(svg, value, { format: 'CODE128', displayValue: true, fontSize: 14, textMargin: 1, height: 40, margin: 0, width: 2 });
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.setAttribute('class', 'bc');
  return svg.outerHTML;
}

function trayLabel(t) {
  const cs = (t.carcasses || []).map(c => c.no);
  const src = cs.length <= 1 ? `Carcass ${esc(cs[0] || '')}` : `Batch ${esc(cs[0])} +${cs.length - 1}`;
  return `<div class="label">
    <div class="name">${esc(t.product_name)}</div>
    <div class="row"><span>${kg3(t.weight_kg)} kg</span><span class="strong">Use by ${ymdToDm(t.use_by)}</span></div>
    <div class="row small"><span>${src}</span><span>Packed ${dm(t.packed_at)}</span></div>
    ${barcodeSvg(t.code)}
  </div>`;
}

function carcassLabel(c) {
  return `<div class="label">
    <div class="row"><span class="name">${esc(c.species)} ${esc(c.no)}</span><span>${Number(c.weight_kg).toFixed(1)} kg</span></div>
    <div class="row small"><span>Tag ${esc(c.ear_tag || '-')}</span><span>${dmy(c.received_at)}</span></div>
    ${barcodeSvg(c.no)}
  </div>`;
}

export function printLabels(items, settings) {
  if (!window.JsBarcode) throw new Error('The barcode library did not load. Check the internet connection and reload.');
  const w = settings?.label_width_mm || 50, h = settings?.label_height_mm || 30;
  const body = items.map(it => it.kind === 'carcass' ? carcassLabel(it.data) : trayLabel(it.data)).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}mm ${h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; }
    .label { width: ${w}mm; height: ${h}mm; padding: 1.5mm 2mm; overflow: hidden; display: flex; flex-direction: column; gap: 0.4mm; page-break-after: always; break-after: page; }
    .label:last-child { page-break-after: auto; break-after: auto; }
    .name { font-weight: 700; font-size: ${Math.max(8, Math.round(h / 3.2))}pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row { display: flex; justify-content: space-between; gap: 2mm; font-size: ${Math.max(6.5, Math.round(h / 4.2))}pt; white-space: nowrap; }
    .row.small { font-size: ${Math.max(6, Math.round(h / 4.8))}pt; }
    .strong { font-weight: 700; }
    .bc { flex: 1 1 auto; width: 100%; min-height: 8mm; }
  </style></head><body>${body}</body></html>`;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  }, 150);
  return html;
}
