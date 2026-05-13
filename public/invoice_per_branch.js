/**
 * NOVAPACK CLOUD — Facturas independientes por sucursal (Formato 2)
 *
 * Para clientes con sucursales (parentClientId), permite generar
 * facturas separadas, una por sede con actividad en el periodo, usando
 * los precios REALES de cada albarán (Σ price). Todas las facturas
 * comparten el NIF del cliente padre.
 *
 * Diferencia con Formato 1:
 *   • Formato 1: una sola factura, importe = cuota plana del padre,
 *     bloque informativo de % volumen.
 *   • Formato 2: N facturas (una por sede), importe = suma precios
 *     reales, sin tarifa plana, mismo NIF.
 *
 * Uso:
 *   generateBranchInvoicesPreview(parentId, year, month)
 *      → devuelve array de borradores sin tocar Firestore
 *   generateBranchInvoicesAndSave(parentId, year, month)
 *      → crea las facturas en Firestore + genera asientos contables
 *   downloadAllBranchInvoicesPDF(parentId, year, month)
 *      → descarga todas como ZIP (o PDFs separados)
 */
(function() {
    'use strict';

    if (typeof db === 'undefined') return;

    function _money(n) { return (Number(n) || 0).toFixed(2).replace('.', ',') + ' €'; }
    function _esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }
    function _formatDate(d) {
        if (!d) return '';
        const dt = (d.toDate ? d.toDate() : (d._seconds ? new Date(d._seconds * 1000) : new Date(d)));
        if (isNaN(dt.getTime())) return '';
        return dt.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    function _monthLabel(y, m) {
        const dt = new Date(y, m - 1, 1);
        return dt.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }).replace(/^./, c => c.toUpperCase());
    }

    /**
     * Carga padre + sucursales + albaranes pendientes del periodo.
     * Devuelve estructura con cada sede + sus tickets agrupados.
     */
    async function _loadBranchInvoiceData(parentId, year, month) {
        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 1);

        // 1. Padre + sus datos fiscales
        const parentDoc = await db.collection('users').doc(parentId).get();
        if (!parentDoc.exists) throw new Error('Cliente padre no encontrado: ' + parentId);
        const parent = { id: parentDoc.id, ...parentDoc.data() };

        // 2. Sucursales
        const childSnap = await db.collection('users')
            .where('parentClientId', '==', parentId).get();
        const sedes = [parent];
        childSnap.forEach(doc => sedes.push({ id: doc.id, ...doc.data() }));

        // 3. Por cada sede, cargar comp_main (prefix, address) y sus tickets del periodo no facturados
        for (const sede of sedes) {
            const compDoc = await db.collection('users').doc(sede.id).collection('companies').doc('comp_main').get();
            sede.comp_main = compDoc.exists ? compDoc.data() : {};

            // Identidades para query de tickets
            const ids = [sede.id, sede.authUid, sede.idNum, sede.idNum ? sede.idNum.toString() : null].filter(Boolean);
            const tickets = [];
            const seen = new Set();
            // Firestore 'in' limit 10. ids debería ser pocos.
            const slice = ids.slice(0, 10).map(v => v.toString());
            if (slice.length > 0) {
                // Query por uid
                try {
                    const tSnap = await db.collection('tickets')
                        .where('uid', 'in', slice)
                        .where('createdAt', '>=', firebase.firestore.Timestamp.fromDate(monthStart))
                        .where('createdAt', '<', firebase.firestore.Timestamp.fromDate(monthEnd))
                        .get();
                    tSnap.forEach(d => {
                        if (seen.has(d.id)) return;
                        const td = d.data();
                        if (td.invoiceId) return; // ya facturado
                        if (td.deleted) return;
                        seen.add(d.id);
                        tickets.push({ id: d.id, ...td });
                    });
                } catch(e) { console.warn('Tickets uid query:', e.message); }
                // Query por clientIdNum como fallback (legacy)
                try {
                    const tSnap2 = await db.collection('tickets')
                        .where('clientIdNum', 'in', slice)
                        .where('createdAt', '>=', firebase.firestore.Timestamp.fromDate(monthStart))
                        .where('createdAt', '<', firebase.firestore.Timestamp.fromDate(monthEnd))
                        .get();
                    tSnap2.forEach(d => {
                        if (seen.has(d.id)) return;
                        const td = d.data();
                        if (td.invoiceId) return;
                        if (td.deleted) return;
                        seen.add(d.id);
                        tickets.push({ id: d.id, ...td });
                    });
                } catch(e) { console.warn('Tickets clientIdNum query:', e.message); }
            }
            sede.tickets = tickets;
            // Calcular subtotal de la sede
            sede.subtotal = tickets.reduce((s, t) => s + (Number(t.price) || 0), 0);
        }

        // Filtrar sedes sin actividad (no se factura sede vacía)
        const sedesConActividad = sedes.filter(s => s.tickets.length > 0);

        return { parent, sedes: sedesConActividad, allSedes: sedes, monthStart, monthEnd };
    }

    /**
     * Construye HTML de UNA factura sucursal con precios reales.
     */
    function _buildBranchInvoiceHTML(invoice, sede, parent, fiscalSender) {
        const sf = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif";
        const periodLabel = invoice._period || '';
        const isParent = sede.id === parent.id;

        // Líneas de albaranes con precio real
        let rowsHTML = '';
        invoice.tickets.forEach(t => {
            const desc = 'Albarán ' + (t.id || t.docId || '?') + ' — ' + (t.receiver || 'Destinatario s/n')
                + (t.localidad ? ' (' + t.localidad + ')' : '');
            const qty = (t.packagesList && t.packagesList.length) || parseInt(t.packages, 10) || 1;
            const price = Number(t.price) || 0;
            const lineTotal = price; // ya viene calculado total
            rowsHTML += ''
                + '<tr>'
                + '<td style="padding:8px 0; border-bottom:0.5px solid #f0f0f0; font-size:0.78rem; color:#444;">' + _esc(desc) + '</td>'
                + '<td style="padding:8px 0; border-bottom:0.5px solid #f0f0f0; text-align:center; font-size:0.78rem; color:#666;">' + qty + '</td>'
                + '<td style="padding:8px 0; border-bottom:0.5px solid #f0f0f0; text-align:right; font-size:0.78rem; color:#666;">' + _money(price) + '</td>'
                + '<td style="padding:8px 0; border-bottom:0.5px solid #f0f0f0; text-align:right; font-size:0.78rem; color:#222; font-weight:500;">' + _money(lineTotal) + '</td>'
                + '</tr>';
        });

        const ivaRate = invoice.ivaRate || 21;
        const irpfRate = invoice.irpfRate || 0;
        const subtotal = invoice.subtotal;
        const iva = invoice.iva;
        const irpf = invoice.irpf || 0;
        const total = invoice.total;

        return ''
            + '<div style="font-family:' + sf + '; padding:40px 50px; color:#444; line-height:1.5; background:white; max-width:800px; margin:0 auto; box-sizing:border-box; font-weight:300;">'

            // HEADER
            + '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:30px;">'
            + '  <div>'
            + '    <div style="font-family:Xenotron, sans-serif; color:#FF6600; font-size:1.6rem; letter-spacing:3px;">' + _esc(fiscalSender.name || 'NOVAPACK S.L.') + '</div>'
            + '    <div style="font-size:0.65rem; color:#999; letter-spacing:1.5px; text-transform:uppercase; border-top:0.5px solid #ddd; margin-top:5px; padding-top:5px;">Servicio Inmediato de Paquetería</div>'
            + '    <div style="margin-top:12px; font-size:0.72rem; color:#888; line-height:1.6;">'
            + '      CIF: ' + _esc(fiscalSender.cif || '—') + '<br>'
            + (fiscalSender.address ? _esc(fiscalSender.address).replace(/,/g, '<br>') : '')
            + '    </div>'
            + '  </div>'
            + '  <div style="text-align:right;">'
            + '    <div style="font-size:0.62rem; color:#bbb; letter-spacing:2px; text-transform:uppercase;">Factura</div>'
            + '    <div style="font-size:1.4rem; color:#222; margin:4px 0 10px;">' + _esc(invoice.invoiceId) + '</div>'
            + '    <div style="font-size:0.62rem; color:#bbb; letter-spacing:1px; text-transform:uppercase;">Fecha emisión</div>'
            + '    <div style="font-size:0.85rem; color:#555; margin-bottom:6px;">' + _esc(_formatDate(invoice.date)) + '</div>'
            + '    <div style="font-size:0.62rem; color:#bbb; letter-spacing:1px; text-transform:uppercase;">Periodo</div>'
            + '    <div style="font-size:0.85rem; color:#FF6600; font-weight:500;">' + _esc(periodLabel) + '</div>'
            + '  </div>'
            + '</div>'
            + '<div style="border-top:0.5px solid #e0e0e0; margin-bottom:24px;"></div>'

            // CLIENT — siempre se factura al PADRE (NIF + razón social) pero
            // con nota de la SEDE específica
            + '<div style="margin-bottom:24px;">'
            + '  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">'
            + '    <div>'
            + '      <div style="font-size:0.62rem; color:#bbb; letter-spacing:2px; text-transform:uppercase; margin-bottom:6px;">Facturar a</div>'
            + '      <div style="font-size:0.95rem; color:#222; font-weight:500;">' + _esc(parent.name) + '</div>'
            + '      <div style="font-size:0.75rem; color:#888; line-height:1.6;">CIF/NIF: ' + _esc(parent.nif || '—') + '<br>' + _esc([parent.street, parent.number, parent.localidad, parent.cp ? 'CP ' + parent.cp : '', parent.province].filter(Boolean).join(', ')) + '</div>'
            + '    </div>'
            + '    <div style="background:rgba(93,173,226,0.05); border:1px solid rgba(93,173,226,0.2); border-radius:6px; padding:10px 12px;">'
            + '      <div style="font-size:0.62rem; color:#5DADE2; letter-spacing:2px; text-transform:uppercase; margin-bottom:4px;">' + (isParent ? 'Sede principal' : 'Sucursal') + '</div>'
            + '      <div style="font-size:0.85rem; color:#222; font-weight:500;">' + _esc(sede.name || '') + '</div>'
            + '      <div style="font-size:0.7rem; color:#888;">#' + _esc(sede.idNum || '?') + (sede.localidad ? ' · ' + _esc(sede.localidad) : '') + '</div>'
            + '    </div>'
            + '  </div>'
            + '</div>'

            // TICKETS TABLE
            + '<table style="width:100%; border-collapse:collapse; margin-bottom:20px;">'
            + '  <thead>'
            + '    <tr style="border-bottom:0.5px solid #ccc;">'
            + '      <th style="padding:8px 0; text-align:left; font-size:0.6rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase;">Concepto</th>'
            + '      <th style="padding:8px 0; text-align:center; font-size:0.6rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase; width:45px;">Cant.</th>'
            + '      <th style="padding:8px 0; text-align:right; font-size:0.6rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase; width:80px;">Precio</th>'
            + '      <th style="padding:8px 0; text-align:right; font-size:0.6rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase; width:90px;">Importe</th>'
            + '    </tr>'
            + '  </thead>'
            + '  <tbody>' + rowsHTML + '</tbody>'
            + '</table>'

            // TOTALS
            + '<div style="display:flex; justify-content:flex-end; margin-bottom:20px;">'
            + '  <div style="width:280px;">'
            + '    <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:0.8rem; color:#888;"><span>Base Imponible</span><span>' + _money(subtotal) + '</span></div>'
            + '    <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:0.8rem; color:#888;"><span>IVA (' + ivaRate + ' %)</span><span>' + _money(iva) + '</span></div>'
            + (irpf > 0 ? '<div style="display:flex; justify-content:space-between; padding:4px 0; font-size:0.8rem; color:#888;"><span>IRPF (−' + irpfRate + ' %)</span><span>−' + _money(irpf) + '</span></div>' : '')
            + '    <div style="border-top:1px solid #333; margin-top:6px; padding-top:8px; display:flex; justify-content:space-between; font-size:1.15rem; color:#111; font-weight:700;"><span>Total</span><span>' + _money(total) + '</span></div>'
            + '  </div>'
            + '</div>'

            // PAYMENT
            + '<div style="background:#f8f8f8; border-radius:6px; padding:10px 14px; font-size:0.72rem; color:#666; line-height:1.6; margin-bottom:14px;">'
            + '  <strong style="color:#333;">Forma de pago:</strong> ' + _esc(invoice.paymentTermsLabel || 'Transferencia bancaria') + (parent.iban ? '<br><strong style="color:#333;">IBAN cliente:</strong> <span style="font-family:monospace;">' + _esc(parent.iban) + '</span>' : '') + (fiscalSender.bank ? '<br><strong style="color:#333;">IBAN emisor:</strong> <span style="font-family:monospace;">' + _esc(fiscalSender.bank) + '</span>' : '')
            + '</div>'

            // FOOTER
            + '<div style="font-size:0.6rem; color:#aaa; line-height:1.5; border-top:0.5px solid #e0e0e0; padding-top:10px; text-align:center;">'
            + 'Factura emitida por consumo real de servicios de transporte. ' + _esc(fiscalSender.legal || 'Documento de validez fiscal conforme a la normativa vigente.')
            + '</div>'

            + '</div>';
    }

    // ============ PUBLIC API ============

    /**
     * Vista previa SIN guardar. Devuelve array de borradores
     * (uno por sucursal con actividad) + HTML de cada uno.
     */
    window.generateBranchInvoicesPreview = async function generateBranchInvoicesPreview(parentId, year, month) {
        const data = await _loadBranchInvoiceData(parentId, year, month);
        const { parent, sedes } = data;
        const fiscalSender = (typeof window.invCompanyData === 'object' && window.invCompanyData) ? window.invCompanyData : {};

        // Numeración SIMULADA en preview (en guardar real se asigna por allocSequentialNumber)
        const yearShort = String(year).slice(-2);
        const previews = [];
        sedes.forEach((sede, idx) => {
            const subtotal = sede.subtotal;
            const ivaRate = fiscalSender.iva || 21;
            const irpfRate = parent.irpfRate || 0;
            const iva = subtotal * (ivaRate / 100);
            const irpf = subtotal * (irpfRate / 100);
            const total = subtotal + iva - irpf;
            const invoice = {
                invoiceId: '(preview · FAC-' + yearShort + '-XXX' + (idx + 1) + ')',
                date: new Date(year, month - 1, 28),
                _period: _monthLabel(year, month),
                clientId: parent.id,
                clientName: parent.name,
                clientCIF: parent.nif || '',
                sedeId: sede.id,
                sedeName: sede.name,
                sedeIdNum: sede.idNum,
                tickets: sede.tickets.map(t => t.id),
                ticketsDetail: sede.tickets,
                subtotal: subtotal, iva: iva, ivaRate: ivaRate, irpf: irpf, irpfRate: irpfRate,
                total: total,
                paymentTermsLabel: 'Pendiente al guardar'
            };
            previews.push({
                sede: sede,
                invoice: invoice,
                html: _buildBranchInvoiceHTML(invoice, sede, parent, fiscalSender)
            });
        });
        return { parent, previews, allSedes: data.allSedes };
    };

    /**
     * Genera las facturas reales y las guarda en Firestore.
     * Marca cada ticket con invoiceId. Cada factura usa allocSequentialNumber.
     */
    window.generateBranchInvoicesAndSave = async function generateBranchInvoicesAndSave(parentId, year, month) {
        const data = await _loadBranchInvoiceData(parentId, year, month);
        const { parent, sedes } = data;
        if (sedes.length === 0) {
            alert('No hay sedes con actividad en este periodo. Nada que facturar.');
            return [];
        }
        const fiscalSender = (typeof window.invCompanyData === 'object' && window.invCompanyData) ? window.invCompanyData : {};
        const yearShort = String(year).slice(-2);
        const generated = [];

        for (const sede of sedes) {
            // Reservar nº atómico
            let nextNum;
            if (typeof window.allocSequentialNumber === 'function') {
                nextNum = await window.allocSequentialNumber('sequence_counters/invoices_' + year, async () => {
                    // Seed: max existente
                    const seedSnap = await db.collection('invoices')
                        .where('date', '>=', new Date(year, 0, 1))
                        .where('date', '<', new Date(year + 1, 0, 1))
                        .orderBy('date', 'desc').limit(10000).get();
                    let max = 0;
                    seedSnap.forEach(doc => {
                        const m = (doc.data().invoiceId || '').match(/^FAC-\d{2}-(\d+)$/);
                        if (m) { const s = parseInt(m[1], 10); if (s > max) max = s; }
                        const n = doc.data().number || 0;
                        if (n > max) max = n;
                    });
                    return max;
                });
            } else {
                nextNum = Date.now() % 100000;
            }
            const invoiceId = 'FAC-' + yearShort + '-' + nextNum;
            const subtotal = sede.subtotal;
            const ivaRate = fiscalSender.iva || 21;
            const irpfRate = parent.irpfRate || 0;
            const iva = subtotal * (ivaRate / 100);
            const irpf = subtotal * (irpfRate / 100);
            const total = subtotal + iva - irpf;

            const invoiceData = {
                number: nextNum,
                invoiceId: invoiceId,
                date: new Date(year, month - 1, new Date().getDate()),
                clientId: parent.id,
                clientName: parent.name,
                clientCIF: parent.nif || '',
                sedeId: sede.id,
                sedeName: sede.name,
                sedeIdNum: sede.idNum || '',
                subtotal: subtotal,
                iva: iva,
                ivaRate: ivaRate,
                irpf: irpf,
                irpfRate: irpfRate,
                total: total,
                tickets: sede.tickets.map(t => t.id),
                ticketsDetail: sede.tickets.map(t => ({
                    id: t.id, compName: sede.name, price: t.price || 0
                })),
                senderData: fiscalSender,
                emittedBy: 'branch_invoice_v1',
                periodMonth: month,
                periodYear: year
            };
            if (typeof getOperatorStamp === 'function') Object.assign(invoiceData, getOperatorStamp());

            // Guardar
            const invRef = await db.collection('invoices').add(invoiceData);
            // Marcar tickets
            let batch = db.batch();
            let opCount = 0;
            for (const t of sede.tickets) {
                batch.update(db.collection('tickets').doc(t.id), {
                    invoiceId: invRef.id,
                    invoiceNum: invoiceId
                });
                if (++opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
            }
            if (opCount > 0) await batch.commit();

            generated.push({ docId: invRef.id, ...invoiceData });
        }
        return generated;
    };

    /**
     * Descarga todas las facturas como PDFs separados (uno por sede).
     */
    window.downloadAllBranchInvoicesPDF = async function downloadAllBranchInvoicesPDF(parentId, year, month) {
        if (typeof html2pdf !== 'function') { alert('html2pdf no cargado.'); return; }
        const { parent, previews } = await window.generateBranchInvoicesPreview(parentId, year, month);
        if (previews.length === 0) { alert('No hay facturas que generar.'); return; }
        if (typeof showLoading === 'function') showLoading();
        try {
            for (const p of previews) {
                const el = document.createElement('div');
                el.innerHTML = p.html;
                el.style.position = 'fixed';
                el.style.left = '-9999px';
                document.body.appendChild(el);
                try {
                    await html2pdf().from(el).set({
                        margin: 0,
                        filename: 'Factura_' + (parent.name || parent.idNum || 'cliente').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + (p.sede.name || p.sede.idNum || 'sede').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + year + '-' + String(month).padStart(2, '0') + '.pdf',
                        image: { type: 'jpeg', quality: 0.95 },
                        html2canvas: { scale: 2, useCORS: true, allowTaint: true },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                    }).save();
                    // Pequeña pausa entre PDFs para que el navegador no agrupe descargas
                    await new Promise(r => setTimeout(r, 800));
                } finally {
                    document.body.removeChild(el);
                }
            }
        } finally {
            if (typeof hideLoading === 'function') hideLoading();
        }
    };

    /**
     * Modal de previsualización con todas las facturas y botones para
     * guardar / descargar.
     */
    // ============ FORMAT SELECTOR ============
    // Modal único que pregunta: mes + Formato 1 (consolidada) o Formato 2
    // (por sucursal). Dispatcher hacia el generador adecuado.
    window.openInvoiceFormatModal = function openInvoiceFormatModal(parentId) {
        const old = document.getElementById('mb-format-select');
        if (old) old.remove();
        const parent = (window.userMap && window.userMap[parentId])
                    || (window._advClientsCache && window._advClientsCache.find(c => c.id === parentId))
                    || {};
        const now = new Date();
        const defaultMonth = now.getMonth() + 1;
        const defaultYear = now.getFullYear();

        const modal = document.createElement('div');
        modal.id = 'mb-format-select';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100001; display:flex; align-items:center; justify-content:center; padding:20px;';
        modal.innerHTML = ''
            + '<div style="background:#1e1e1e; border:1px solid #444; border-radius:12px; padding:24px; max-width:640px; width:100%; color:#d4d4d4;">'
            + '<h3 style="margin:0 0 6px; color:#FF6600; font-size:1.05rem;">📊 Facturar mes — ' + _esc(parent.name || parentId) + '</h3>'
            + '<p style="margin:0 0 18px; font-size:0.8rem; color:#888;">NIF compartido: ' + _esc(parent.nif || '—') + '. Elige periodo y formato.</p>'

            + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:18px;">'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">Mes</label><select id="fs-month" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;">'
            + ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
                .map((m, i) => '<option value="' + (i+1) + '"' + ((i+1) === defaultMonth ? ' selected' : '') + '>' + m + '</option>').join('')
            + '  </select></div>'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">Año</label><input type="number" id="fs-year" value="' + defaultYear + '" min="2020" max="2099" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px; font-family:monospace;"></div>'
            + '</div>'

            + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">'
            + '  <div onclick="document.getElementById(\'fs-f1\').click();" style="background:rgba(255,102,0,0.05); border:2px solid rgba(255,102,0,0.3); border-radius:10px; padding:16px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor=\'#FF6600\'" onmouseout="this.style.borderColor=\'rgba(255,102,0,0.3)\'">'
            + '    <div style="font-size:1.1rem; margin-bottom:6px;">📄</div>'
            + '    <div style="font-weight:700; color:#FF6600; font-size:0.92rem; margin-bottom:4px;">Formato 1 — Consolidada</div>'
            + '    <div style="font-size:0.72rem; color:#aaa; line-height:1.4;">Una sola factura. Tarifa plana del padre. Bloque informativo con % volumen por sucursal.</div>'
            + '    <button id="fs-f1" type="button" style="margin-top:10px; background:#FF6600; border:0; color:#fff; padding:6px 14px; border-radius:5px; font-weight:700; cursor:pointer; font-size:0.78rem; width:100%;">Vista previa</button>'
            + '  </div>'
            + '  <div onclick="document.getElementById(\'fs-f2\').click();" style="background:rgba(93,173,226,0.05); border:2px solid rgba(93,173,226,0.3); border-radius:10px; padding:16px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor=\'#5DADE2\'" onmouseout="this.style.borderColor=\'rgba(93,173,226,0.3)\'">'
            + '    <div style="font-size:1.1rem; margin-bottom:6px;">📑</div>'
            + '    <div style="font-weight:700; color:#5DADE2; font-size:0.92rem; margin-bottom:4px;">Formato 2 — Por sucursal</div>'
            + '    <div style="font-size:0.72rem; color:#aaa; line-height:1.4;">Una factura por sede con actividad. Mismo NIF en todas. Importes según consumo real (no tarifa plana).</div>'
            + '    <button id="fs-f2" type="button" style="margin-top:10px; background:#5DADE2; border:0; color:#000; padding:6px 14px; border-radius:5px; font-weight:700; cursor:pointer; font-size:0.78rem; width:100%;">Vista previa</button>'
            + '  </div>'
            + '</div>'

            + '<div style="margin-top:18px; text-align:right;">'
            + '  <button type="button" id="fs-cancel" style="background:#333; border:1px solid #555; color:#fff; padding:7px 16px; border-radius:5px; cursor:pointer;">Cancelar</button>'
            + '</div>'
            + '</div>';
        document.body.appendChild(modal);
        document.getElementById('fs-cancel').onclick = () => modal.remove();
        document.getElementById('fs-f1').onclick = (e) => {
            e.stopPropagation();
            const m = parseInt(document.getElementById('fs-month').value, 10);
            const y = parseInt(document.getElementById('fs-year').value, 10);
            modal.remove();
            window.previewFlatRateConsolidatedModal(parentId, y, m);
        };
        document.getElementById('fs-f2').onclick = (e) => {
            e.stopPropagation();
            const m = parseInt(document.getElementById('fs-month').value, 10);
            const y = parseInt(document.getElementById('fs-year').value, 10);
            modal.remove();
            window.previewBranchInvoicesModal(parentId, y, m);
        };
    };

    // ============ FORMATO 1 — Vista previa consolidada (in-memory) ============
    // Genera factura tarifa plana sin guardar, agrupando los albaranes del
    // padre y todos sus hijos en el periodo. Muestra preview con botón
    // "Guardar y emitir" que la persiste.
    window.previewFlatRateConsolidatedModal = async function previewFlatRateConsolidatedModal(parentId, year, month) {
        if (typeof showLoading === 'function') showLoading();
        let data;
        try {
            data = await _loadBranchInvoiceData(parentId, year, month);
        } catch(e) {
            if (typeof hideLoading === 'function') hideLoading();
            alert('Error: ' + e.message);
            return;
        }
        if (typeof hideLoading === 'function') hideLoading();
        const { parent, sedes } = data;
        if (sedes.length === 0) {
            alert('No hay actividad de ' + parent.name + ' en ' + _monthLabel(year, month) + '. Nada que facturar.');
            return;
        }

        // Construir ticketsDetail combinando todas las sedes
        const allTicketsDetail = [];
        sedes.forEach(s => {
            s.tickets.forEach(t => {
                allTicketsDetail.push({
                    id: t.id,
                    clientIdNum: (s.idNum || '').toString(),
                    uid: s.id,
                    compName: s.name,
                    price: t.price || 0
                });
            });
        });

        // Calcular importe de la cuota plana del padre
        // Soporta legacy (flatRateAmount) y v2 (items flat_monthly de la tarifa)
        // vía el helper unificado window.getMonthlyFlatAmount.
        const flatAmount = (typeof window.getMonthlyFlatAmount === 'function')
            ? window.getMonthlyFlatAmount(parent.id)
            : (Number(parent.flatRateAmount) || 0);
        if (flatAmount <= 0) {
            if (!confirm('⚠️ El cliente padre NO tiene cuota plana configurada (ni en flatRateAmount legacy ni en items flat_monthly v2).\n\nEdita su ficha o su tarifa antes de emitir.\n\n¿Continuar con preview a 0 € de todos modos?')) return;
        }
        const fiscalSender = (typeof window.invCompanyData === 'object' && window.invCompanyData) ? window.invCompanyData : {};
        const ivaRate = fiscalSender.iva || 21;
        const irpfRate = parent.irpfRate || 0;
        const iva = flatAmount * (ivaRate / 100);
        const irpf = flatAmount * (irpfRate / 100);
        const total = flatAmount + iva - irpf;
        const yearShort = String(year).slice(-2);

        const draft = {
            invoiceId: '(preview · FAC-' + yearShort + '-XXX)',
            date: new Date(year, month - 1, new Date().getDate()),
            dueDate: null,
            clientId: parent.id,
            clientName: parent.name,
            clientCIF: parent.nif || '',
            subtotal: flatAmount, iva: iva, ivaRate: ivaRate, irpf: irpf, irpfRate: irpfRate,
            total: total,
            tickets: allTicketsDetail.map(t => t.id),
            ticketsDetail: allTicketsDetail,
            senderData: fiscalSender,
            periodMonth: month, periodYear: year,
            isFlatRateConsolidated: true
        };

        // Cargar branchesMap para que el builder agrupe correctamente
        const branchesMap = {};
        data.allSedes.forEach(s => {
            const idn = (s.idNum || '').toString();
            if (idn) branchesMap[idn] = s;
            branchesMap[s.id] = s;
        });

        const html = typeof window.buildMultiBranchInvoiceHTML === 'function'
            ? window.buildMultiBranchInvoiceHTML(draft, parent, branchesMap)
            : '<p>Error: builder no disponible</p>';

        // Modal preview
        const old = document.getElementById('mb-f1-preview');
        if (old) old.remove();
        const modal = document.createElement('div');
        modal.id = 'mb-f1-preview';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:99999; display:flex; flex-direction:column; padding:20px; overflow-y:auto;';
        modal.innerHTML = ''
            + '<div style="max-width:880px; width:100%; margin:0 auto 14px; display:flex; justify-content:space-between; align-items:center; color:#fff;">'
            + '  <div>'
            + '    <h3 style="margin:0; color:#FF6600; font-size:1.05rem;">📄 Formato 1 — Factura consolidada · ' + _esc(_monthLabel(year, month)) + '</h3>'
            + '    <div style="font-size:0.78rem; color:#aaa; margin-top:3px;">' + _esc(parent.name) + ' · cuota plana ' + _money(flatAmount) + '</div>'
            + '  </div>'
            + '  <div style="display:flex; gap:8px;">'
            + '    <button id="f1-save" style="background:#FF6600; border:0; color:#fff; padding:8px 16px; border-radius:6px; font-weight:700; cursor:pointer;">💾 Guardar y facturar</button>'
            + '    <button id="f1-close" style="background:#333; border:1px solid #555; color:#fff; padding:8px 16px; border-radius:6px; cursor:pointer;">Cerrar</button>'
            + '  </div>'
            + '</div>'
            + '<div style="max-width:880px; width:100%; margin:0 auto; background:white; border-radius:8px;">' + html + '</div>';
        document.body.appendChild(modal);
        document.getElementById('f1-close').onclick = () => modal.remove();
        document.getElementById('f1-save').onclick = async () => {
            if (!confirm('Vas a EMITIR la factura consolidada de ' + parent.name + ' por ' + _money(flatAmount) + ' base.\n\nMarcará los ' + allTicketsDetail.length + ' albaranes implicados como facturados. ¿Continuar?')) return;
            const btn = document.getElementById('f1-save');
            btn.disabled = true; btn.textContent = 'Guardando…';
            try {
                // Reservar nº atómico
                let nextNum;
                if (typeof window.allocSequentialNumber === 'function') {
                    nextNum = await window.allocSequentialNumber('sequence_counters/invoices_' + year, async () => {
                        const seedSnap = await db.collection('invoices')
                            .where('date', '>=', new Date(year, 0, 1))
                            .where('date', '<', new Date(year + 1, 0, 1))
                            .orderBy('date', 'desc').limit(10000).get();
                        let max = 0;
                        seedSnap.forEach(doc => {
                            const m = (doc.data().invoiceId || '').match(/^FAC-\d{2}-(\d+)$/);
                            if (m) { const s = parseInt(m[1], 10); if (s > max) max = s; }
                            const n = doc.data().number || 0;
                            if (n > max) max = n;
                        });
                        return max;
                    });
                } else {
                    nextNum = Date.now() % 100000;
                }
                const invoiceId = 'FAC-' + yearShort + '-' + nextNum;
                draft.invoiceId = invoiceId;
                draft.number = nextNum;
                if (typeof getOperatorStamp === 'function') Object.assign(draft, getOperatorStamp());
                const invRef = await db.collection('invoices').add(draft);
                // Marcar tickets
                let batch = db.batch();
                let opCount = 0;
                for (const t of allTicketsDetail) {
                    batch.update(db.collection('tickets').doc(t.id), {
                        invoiceId: invRef.id, invoiceNum: invoiceId
                    });
                    if (++opCount >= 450) { await batch.commit(); batch = db.batch(); opCount = 0; }
                }
                if (opCount > 0) await batch.commit();
                alert('✅ Factura consolidada emitida: ' + invoiceId);
                modal.remove();
            } catch(e) {
                alert('Error: ' + e.message);
                btn.disabled = false; btn.textContent = '💾 Guardar y facturar';
            }
        };
    };

    window.previewBranchInvoicesModal = async function previewBranchInvoicesModal(parentId, year, month) {
        if (typeof showLoading === 'function') showLoading();
        let result;
        try {
            result = await window.generateBranchInvoicesPreview(parentId, year, month);
        } catch(e) {
            if (typeof hideLoading === 'function') hideLoading();
            alert('Error preparando facturas: ' + e.message);
            return;
        }
        if (typeof hideLoading === 'function') hideLoading();
        const { parent, previews } = result;
        if (previews.length === 0) {
            alert('No hay sedes con actividad en ' + _monthLabel(year, month) + '. Nada que facturar.');
            return;
        }

        const old = document.getElementById('mb-branch-preview');
        if (old) old.remove();
        const modal = document.createElement('div');
        modal.id = 'mb-branch-preview';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:99999; display:flex; flex-direction:column; padding:20px; overflow-y:auto;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; max-width:880px; width:100%; margin:0 auto 16px; color:#fff;';
        header.innerHTML = ''
            + '<div>'
            + '  <h3 style="margin:0; color:#5DADE2; font-size:1.1rem;">📑 Formato 2 — ' + previews.length + ' facturas separadas · ' + _esc(_monthLabel(year, month)) + '</h3>'
            + '  <div style="font-size:0.78rem; color:#aaa; margin-top:4px;">Cliente padre: ' + _esc(parent.name) + ' · NIF ' + _esc(parent.nif || '—') + '</div>'
            + '</div>'
            + '<div style="display:flex; gap:8px;">'
            + '  <button id="mbb-download" style="background:#5DADE2; border:0; color:#000; padding:8px 16px; border-radius:6px; font-weight:700; cursor:pointer;">📥 Descargar todas (PDF)</button>'
            + '  <button id="mbb-save" style="background:#FF6600; border:0; color:#fff; padding:8px 16px; border-radius:6px; font-weight:700; cursor:pointer;">💾 Guardar y facturar</button>'
            + '  <button id="mbb-close" style="background:#333; border:1px solid #555; color:#fff; padding:8px 16px; border-radius:6px; cursor:pointer;">Cerrar</button>'
            + '</div>';
        modal.appendChild(header);
        const grid = document.createElement('div');
        grid.style.cssText = 'max-width:880px; width:100%; margin:0 auto; display:flex; flex-direction:column; gap:14px;';
        previews.forEach(p => {
            const card = document.createElement('div');
            card.style.cssText = 'background:white; border-radius:8px; overflow:hidden;';
            card.innerHTML = p.html;
            grid.appendChild(card);
        });
        modal.appendChild(grid);
        document.body.appendChild(modal);

        document.getElementById('mbb-close').onclick = () => modal.remove();
        document.getElementById('mbb-download').onclick = () => window.downloadAllBranchInvoicesPDF(parentId, year, month);
        document.getElementById('mbb-save').onclick = async () => {
            if (!confirm('Vas a EMITIR ' + previews.length + ' facturas en Firestore para ' + parent.name + '.\n\nCada albarán incluido quedará marcado como facturado. ¿Continuar?')) return;
            const btn = document.getElementById('mbb-save');
            btn.disabled = true; btn.textContent = 'Guardando…';
            try {
                const gen = await window.generateBranchInvoicesAndSave(parentId, year, month);
                alert('✅ ' + gen.length + ' facturas emitidas.\n\nIDs:\n  ' + gen.map(g => g.invoiceId).join('\n  '));
                modal.remove();
            } catch(e) {
                alert('Error: ' + e.message);
                btn.disabled = false; btn.textContent = '💾 Guardar y facturar';
            }
        };
    };
})();
