// TrAIder sunucu tarafı PDF raporu (tarayıcı olmadan) — n8n'in sabah raporu bunu Telegram'a gönderir.
// pdfkit ile çizilir; Türkçe karakterler için DejaVu fontu kullanılır (fonts/ klasörü).

const path = require('path');
let PDFDocument = null;
try { PDFDocument = require('pdfkit'); } catch { /* npm install yapılmamış */ }

const FONT = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');

const C = {
    text: '#0f172a', muted: '#64748b', light: '#94a3b8', border: '#e2e8f0', blue: '#2563eb', blueDark: '#1e3a8a',
    blueBg: '#eff6ff', green: '#059669', red: '#dc2626', amberBg: '#fefce8', amberBorder: '#fde68a', amberText: '#854d0e', stripe: '#f8fafc'
};

const fmt = (v, unit = '') => v === null || v === undefined || isNaN(v) ? '—'
    : unit + Number(v).toLocaleString('tr-TR', Math.abs(v) < 1 ? { maximumSignificantDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAxis = v => Number(v).toLocaleString('tr-TR', { maximumFractionDigits: Math.abs(v) < 10 ? 3 : Math.abs(v) < 1000 ? 2 : 0 });
const pctTxt = v => typeof v === 'number' && !isNaN(v) ? `${v >= 0 ? '▲ +' : '▼ '}${v.toFixed(2)}%` : '—';

const isAvailable = () => !!PDFDocument;

/**
 * @param {object} o
 *  date: Date, snap, history: [{title, unit, color, data:[{t,v}]}],
 *  summary: string, outlook: string, news: [{baslik, ozet, etki, kaynak}], sources: [{title, uri}],
 *  portfolio: { total, pnl, items:[{label, amount, value, pnl}] } | null, username
 * @returns {Promise<Buffer>}
 */
function buildReportPdf(o) {
    return new Promise((resolve, reject) => {
        if (!PDFDocument) return reject(new Error('"pdfkit" paketi kurulu değil (npm install).'));
        const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 }, info: { Title: 'TrAIder Günlük Piyasa Raporu' } });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.registerFont('R', FONT);
        doc.registerFont('B', FONT_BOLD);

        const L = 40, W = doc.page.width - 80;          // sol kenar, içerik genişliği
        const bottom = () => doc.page.height - 50;
        const ensure = h => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = 40; } };
        const title = t => { ensure(30); doc.moveDown(0.6); doc.font('B').fontSize(12).fillColor(C.blueDark).text(t, L, doc.y); doc.moveDown(0.3); };

        // ---- Başlık ----
        doc.font('B').fontSize(20).fillColor(C.text).text('Tr', L, 40, { continued: true }).fillColor(C.blue).text('AI', { continued: true })
            .fillColor(C.text).text('der Günlük Piyasa Raporu');
        const dateStr = o.date.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' })
            + ' • Saat ' + o.date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
        doc.font('R').fontSize(9).fillColor(C.muted).text(dateStr + (o.username ? `  •  ${o.username}` : ''), L, doc.y + 2);
        doc.moveTo(L, doc.y + 6).lineTo(L + W, doc.y + 6).lineWidth(2.5).strokeColor(C.blue).stroke();
        doc.y += 16;

        // ---- Özet kutusu ----
        const box = (heading, body, bg, border, headColor, textColor) => {
            doc.font('R').fontSize(9.5);
            const h = doc.heightOfString(body, { width: W - 24, lineGap: 2 }) + 34;
            ensure(h + 8);
            const y = doc.y;
            doc.roundedRect(L, y, W, h, 6).fillAndStroke(bg, border || bg);
            doc.font('B').fontSize(11).fillColor(headColor).text(heading, L + 12, y + 9);
            doc.font('R').fontSize(9.5).fillColor(textColor).text(body, L + 12, y + 26, { width: W - 24, lineGap: 2 });
            doc.y = y + h + 10;
        };
        box('Günün Özeti', o.summary || '—', C.blueBg, null, C.blueDark, '#1e293b');

        // ---- Portföy ----
        if (o.portfolio && o.portfolio.items.length) {
            const p = o.portfolio;
            const pnl = p.pnl === null || p.pnl === undefined ? '' : `   Kâr/Zarar: ${p.pnl >= 0 ? '+' : ''}${fmt(p.pnl, '₺')}`;
            box('Portföyün', `Toplam değer: ${fmt(p.total, '₺')}${pnl}\n` + p.items.map(i => `• ${i.label}: ${Number(i.amount).toLocaleString('tr-TR', { maximumFractionDigits: 8 })} → ${fmt(i.value, '₺')}`).join('\n'),
                '#f0fdf4', '#bbf7d0', '#166534', '#14532d');
        }

        // ---- 30 günlük çizgi grafikler (2x2) ----
        const hist = (o.history || []).filter(h => h.data && h.data.length > 1);
        if (hist.length) {
            title('Son 30 Gün');
            const cw = (W - 12) / 2, ch = 125;
            for (let i = 0; i < hist.length; i += 2) {
                ensure(ch + 10);
                const rowY = doc.y;
                [hist[i], hist[i + 1]].forEach((h, k) => { if (h) lineChart(doc, h, L + k * (cw + 12), rowY, cw, ch); });
                doc.y = rowY + ch + 10;
            }
        }

        // ---- 24 saat değişim çubukları ----
        const changes = [];
        const gold = o.snap.metals.find(m => m.name === 'Ons Altın');
        if (gold && typeof gold.change === 'number') changes.push({ name: 'Altın', change: gold.change });
        for (const c of o.snap.crypto) if (typeof c.change === 'number' && !isNaN(c.change)) changes.push({ name: c.name, change: c.change });
        if (changes.length) {
            title('Son 24 Saat Değişim');
            const rowH = 16, h = changes.length * rowH + 8;
            ensure(h + 6);
            const y0 = doc.y, labelW = 60, mid = L + labelW + (W - labelW - 50) / 2, half = (W - labelW - 50) / 2;
            const maxAbs = Math.max(1, ...changes.map(c => Math.abs(c.change)));
            doc.moveTo(mid, y0).lineTo(mid, y0 + h - 4).lineWidth(0.7).strokeColor('#cbd5e1').stroke();
            changes.forEach((c, i) => {
                const y = y0 + i * rowH + 3, len = Math.max(1.5, (Math.abs(c.change) / maxAbs) * half), up = c.change >= 0;
                doc.font('R').fontSize(8.5).fillColor('#334155').text(c.name, L, y + 1, { width: labelW });
                doc.rect(up ? mid : mid - len, y, len, rowH - 6).fill(up ? '#10b981' : '#ef4444');
                const label = `${up ? '+' : ''}${c.change.toFixed(2)}%`;
                doc.font('B').fontSize(8).fillColor(up ? C.green : C.red);
                if (up) doc.text(label, mid + len + 4, y + 1, { lineBreak: false });
                else doc.text(label, mid - len - 4 - doc.widthOfString(label), y + 1, { lineBreak: false });
            });
            doc.y = y0 + h + 4;
        }

        // ---- Fiyat tabloları ----
        const table = (heading, rows) => {
            if (!rows.length) return;
            const cols = [W * 0.46, W * 0.30, W * 0.24], rowH = 17;
            ensure(rowH * (rows.length + 1) + 40);   // başlık + tablo aynı sayfada kalsın
            title(heading);
            const top = doc.y;
            let y = top;
            doc.rect(L, y, W, rowH).fill(C.blueBg);
            doc.font('B').fontSize(8.5).fillColor('#334155');
            doc.text('Varlık', L + 6, y + 4.5); doc.text('Fiyat', L + cols[0], y + 4.5, { width: cols[1] - 6, align: 'right' }); doc.text('24 Saat', L + cols[0] + cols[1], y + 4.5, { width: cols[2] - 6, align: 'right' });
            y += rowH;
            rows.forEach((r, i) => {
                if (i % 2) doc.rect(L, y, W, rowH).fill(C.stripe);
                doc.font('R').fontSize(8.5).fillColor(C.text).text(r.name, L + 6, y + 4.5, { width: cols[0] - 10, lineBreak: false });
                doc.font('B').text(fmt(r.value, r.unit), L + cols[0], y + 4.5, { width: cols[1] - 6, align: 'right' });
                const hasCh = typeof r.change === 'number' && !isNaN(r.change);
                doc.font('B').fillColor(hasCh ? (r.change >= 0 ? C.green : C.red) : C.light).text(pctTxt(r.change), L + cols[0] + cols[1], y + 4.5, { width: cols[2] - 6, align: 'right' });
                y += rowH;
            });
            doc.rect(L, top, W, y - top).lineWidth(0.6).strokeColor(C.border).stroke();
            doc.y = y + 4;
        };
        table('Döviz Kurları', o.snap.fx.map(x => ({ ...x, unit: '₺' })));
        table('Altın & Gümüş', o.snap.metals);
        table('Kripto Paralar', o.snap.crypto);

        // ---- Haberler ----
        if (o.news && o.news.length) {
            ensure(110);
            title('Piyasayı Etkileyen Haberler');
            o.news.forEach((n, i) => {
                doc.font('R').fontSize(8.5);
                const body = [n.ozet, n.etki ? `Piyasa etkisi: ${n.etki}` : '', n.kaynak ? `Kaynak: ${n.kaynak}` : ''].filter(Boolean).join('\n');
                const h = doc.heightOfString(body, { width: W - 20, lineGap: 1.5 }) + 26;
                ensure(h + 6);
                const y = doc.y;
                doc.roundedRect(L, y, W, h, 4).lineWidth(0.6).strokeColor(C.border).stroke();
                doc.rect(L, y, 3, h).fill(C.blue);
                doc.font('B').fontSize(9.5).fillColor(C.text).text(`${i + 1}. ${n.baslik || ''}`, L + 10, y + 7, { width: W - 20 });
                doc.font('R').fontSize(8.5).fillColor('#334155').text(body, L + 10, y + 21, { width: W - 20, lineGap: 1.5 });
                doc.y = y + h + 5;
            });
        }

        // ---- Dikkat edilecekler ----
        if (o.outlook) box('Dikkat Edilecekler', o.outlook, C.amberBg, C.amberBorder, C.amberText, '#422006');

        // ---- Kaynaklar ----
        if (o.sources && o.sources.length) {
            title('Kaynaklar');
            o.sources.slice(0, 12).forEach(s => {
                ensure(12);
                doc.font('R').fontSize(8).fillColor(C.blue).text('• ' + s.title, L, doc.y, { link: s.uri, width: W, underline: false });
            });
        }

        // ---- Alt bilgi ----
        ensure(30);
        doc.moveDown(1);
        doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(C.border).stroke();
        doc.moveDown(0.4);
        doc.font('R').fontSize(7.5).fillColor(C.light).text('Bu rapor yapay zeka tarafından otomatik hazırlanmıştır ve yatırım tavsiyesi değildir. Döviz: open.er-api.com, Frankfurter • Kripto/Altın: Binance', L, doc.y, { width: W });

        doc.end();
    });
}

// Tek bir çizgi grafik kutusu
function lineChart(doc, h, x, y, w, ht) {
    const vals = h.data.map(d => d.v);
    const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1;
    const first = vals[0], last = vals[vals.length - 1], pct = ((last - first) / first) * 100;
    const padL = 8, padR = 52, padT = 24, padB = 16;
    const px = i => x + padL + (i / (vals.length - 1)) * (w - padL - padR);
    const py = v => y + padT + (1 - (v - min) / range) * (ht - padT - padB);

    doc.roundedRect(x, y, w, ht, 5).lineWidth(0.6).strokeColor(C.border).stroke();
    doc.font('B').fontSize(9).fillColor(C.text).text(h.title, x + padL, y + 7, { lineBreak: false });
    const p = `30g: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    doc.font('B').fontSize(8.5).fillColor(pct >= 0 ? C.green : C.red).text(p, x + w - 8 - doc.widthOfString(p), y + 7, { lineBreak: false });

    for (let i = 0; i <= 3; i++) {
        const v = min + range * i / 3, yy = py(v);
        doc.moveTo(x + padL, yy).lineTo(x + w - padR, yy).lineWidth(0.4).strokeColor('#e5e7eb').stroke();
        doc.font('R').fontSize(6.5).fillColor(C.muted).text(h.unit + fmtAxis(v), x + w - padR + 3, yy - 3.5, { lineBreak: false });
    }
    // dolgu
    doc.save();
    doc.moveTo(px(0), y + ht - padB);
    vals.forEach((v, i) => doc.lineTo(px(i), py(v)));
    doc.lineTo(px(vals.length - 1), y + ht - padB).closePath().fillOpacity(0.12).fill(h.color);
    doc.restore();
    // çizgi
    vals.forEach((v, i) => i ? doc.lineTo(px(i), py(v)) : doc.moveTo(px(i), py(v)));
    doc.lineWidth(1.4).strokeColor(h.color).stroke();
    doc.circle(px(vals.length - 1), py(last), 2.2).fill(h.color);

    const d = t => new Date(t).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
    doc.font('R').fontSize(6.5).fillColor(C.light);
    doc.text(d(h.data[0].t), x + padL, y + ht - 11, { lineBreak: false });
    const end = d(h.data[h.data.length - 1].t);
    doc.text(end, x + w - padR - doc.widthOfString(end), y + ht - 11, { lineBreak: false });
}

module.exports = { buildReportPdf, isAvailable };
