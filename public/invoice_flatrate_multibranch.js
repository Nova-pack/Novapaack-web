/**
 * NOVAPACK CLOUD — Factura tarifa plana multi-sucursal
 *
 * Plantilla extendida que sustituye al generateInvoiceHTML estándar cuando
 * el cliente tiene `isFlatRate: true` y/o sub-clientes con `parentClientId`
 * apuntando a él (sucursales con mismo NIF).
 *
 * Diferencias clave vs. la plantilla estándar:
 *   • Cabecera con periodo de facturación explícito ("Mayo 2026")
 *   • Concepto único con cuota fija
 *   • Desglose visual de albaranes AGRUPADOS POR SUCURSAL:
 *       Sede principal — ACME LOGISTICS (Málaga)
 *           NP-1042, NP-1043…
 *       Sucursal — ACME LOGISTICS (Vélez-Málaga) #100A
 *           NP-1044, NP-1052…
 *   • Bloque SEPA explícito (IBAN, ref. mandato, fecha)
 *   • Asiento contable referenciado en pie
 *   • Listo para PDF — usa html2pdf (ya cargado en admin.html)
 *
 * Uso desde admin:
 *   downloadMultiBranchInvoicePDF('FAC-26-001')   → descarga PDF
 *   previewMultiBranchInvoiceHTML('FAC-26-001')   → abre vista previa en modal
 */
(function() {
    'use strict';

    if (typeof db === 'undefined') return;

    function _esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function _money(n) {
        return (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
    }

    function _formatDate(d) {
        if (!d) return '';
        const dt = (d.toDate ? d.toDate() : (d._seconds ? new Date(d._seconds * 1000) : new Date(d)));
        if (isNaN(dt.getTime())) return '';
        return dt.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function _monthLabel(d) {
        if (!d) return '';
        const dt = (d.toDate ? d.toDate() : new Date(d));
        if (isNaN(dt.getTime())) return '';
        return dt.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }).replace(/^./, c => c.toUpperCase());
    }

    function _addDaysToDate(d, days) {
        const dt = new Date(d);
        dt.setDate(dt.getDate() + days);
        return dt;
    }

    // Map paymentTerms → days for due-date calculation
    const PAYMENT_DAYS = {
        'contado': 0, 'giro_30': 30, 'giro_60': 60,
        'giro_90': 90, 'giro_120': 120, 'transferencia': 0,
        'recibo_sepa': 30
    };
    const PAYMENT_LABELS = {
        'contado': 'Contado',
        'giro_30': 'Giro SEPA 30 días', 'giro_60': 'Giro SEPA 60 días',
        'giro_90': 'Giro SEPA 90 días', 'giro_120': 'Giro SEPA 120 días',
        'transferencia': 'Transferencia bancaria',
        'recibo_sepa': 'Recibo SEPA'
    };

    /**
     * Agrupa los albaranes por sucursal (clientIdNum dentro de cada ticket).
     * Devuelve un objeto { sucursalNombre: { idNum, ids: [...], count } }.
     */
    function _groupTicketsByBranch(ticketsDetail, parentClient, branchesMap) {
        const groups = {};
        const parentId = (parentClient.idNum || parentClient.id || '').toString();
        const parentName = parentClient.name || 'Sede principal';

        ticketsDetail.forEach(t => {
            // Identificador de quién emitió el ticket: clientIdNum o compName
            const tIdNum = (t.clientIdNum || '').toString();
            const isParent = !tIdNum || tIdNum === parentId;
            let groupKey, groupLabel, groupSubLabel;
            if (isParent) {
                groupKey = '_parent';
                groupLabel = parentName;
                groupSubLabel = 'Sede principal · #' + parentId;
            } else {
                // Buscar nombre de la sucursal en el mapa
                const branch = branchesMap[tIdNum] || branchesMap[t.uid] || {};
                groupKey = tIdNum || ('_branch_' + (t.uid || 'x'));
                groupLabel = branch.name || t.compName || 'Sucursal sin nombre';
                groupSubLabel = 'Sucursal · #' + (tIdNum || branch.idNum || '?');
            }
            if (!groups[groupKey]) {
                groups[groupKey] = { label: groupLabel, sub: groupSubLabel, ids: [], count: 0 };
            }
            groups[groupKey].ids.push(t.id || t.docId || '?');
            groups[groupKey].count++;
        });

        // Ordenar: padre primero, luego sucursales por nombre
        const ordered = [];
        if (groups['_parent']) ordered.push(groups['_parent']);
        Object.keys(groups).filter(k => k !== '_parent').sort().forEach(k => ordered.push(groups[k]));
        return ordered;
    }

    /**
     * Construye el HTML completo de la factura. Devuelve un string listo
     * para inyectar en un contenedor + html2pdf.
     */
    function buildHTML(inv, client, branchesMap, opts) {
        opts = opts || {};
        const senderBranch = inv.senderData || {};
        const ticketsDetail = inv.ticketsDetail || (inv.tickets || []).map(id => ({ id: id }));
        const groups = _groupTicketsByBranch(ticketsDetail, client, branchesMap || {});
        const totalTickets = ticketsDetail.length;
        const periodLabel = _monthLabel(inv.date);
        const issueDate = _formatDate(inv.date);
        const dueDate = inv.dueDate
            ? _formatDate(inv.dueDate)
            : _formatDate(_addDaysToDate((inv.date && inv.date.toDate) ? inv.date.toDate() : new Date(inv.date), PAYMENT_DAYS[client.paymentTerms || 'contado'] || 30));
        const paymentLabel = PAYMENT_LABELS[client.paymentTerms || 'contado'] || 'Transferencia bancaria';
        const sf = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif";

        // Concept block — el desglose por sucursal
        let branchesHTML = '';
        groups.forEach((g, idx) => {
            const idsCsv = g.ids.join(', ');
            branchesHTML += ''
                + '<div style="margin-top:' + (idx === 0 ? '12px' : '14px') + '; padding-left:6px; border-left:2px solid ' + (idx === 0 ? '#FF6600' : '#bbb') + '; padding-top:2px; padding-bottom:2px;">'
                + '  <div style="font-size:0.78rem; color:#333; font-weight:600;">' + _esc(g.label) + '</div>'
                + '  <div style="font-size:0.65rem; color:#888; letter-spacing:0.5px; margin-bottom:5px;">' + _esc(g.sub) + ' · ' + g.count + ' albaranes</div>'
                + '  <div style="font-family:monospace; font-size:0.7rem; color:#666; line-height:1.6; word-break:break-word;">' + _esc(idsCsv) + '</div>'
                + '</div>';
        });

        return ''
            + '<div style="font-family:' + sf + '; padding:50px; color:#444; line-height:1.55; background:white; max-width:800px; margin:0 auto; min-height:1060px; position:relative; box-sizing:border-box; font-weight:300;">'

            // HEADER
            + '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:40px;">'
            + '  <div>'
            + '    <div style="font-family:Xenotron, sans-serif; color:#FF6600; font-size:1.8rem; letter-spacing:3px; font-weight:normal;">' + _esc(senderBranch.name || 'NOVAPACK S.L.') + '</div>'
            + '    <div style="border-top:0.5px solid #ddd; margin-top:5px; padding-top:5px; font-size:0.7rem; color:#999; letter-spacing:1.5px; text-transform:uppercase; font-weight:400;">Servicio Inmediato de Paquetería</div>'
            + '    <div style="margin-top:16px; font-size:0.78rem; color:#888; line-height:1.7;">'
            + '      CIF: ' + _esc(senderBranch.cif || '—') + '<br>'
            + (senderBranch.address ? _esc(senderBranch.address).replace(/,/g, '<br>') + '<br>' : '')
            + (senderBranch.email ? _esc(senderBranch.email) : '')
            + '    </div>'
            + '  </div>'
            + '  <div style="text-align:right;">'
            + '    <div style="font-size:0.65rem; color:#bbb; letter-spacing:2px; text-transform:uppercase;">Factura</div>'
            + '    <div style="font-size:1.5rem; color:#222; font-weight:300; margin:4px 0 10px;">' + _esc(inv.invoiceId) + '</div>'
            + '    <div style="font-size:0.65rem; color:#bbb; letter-spacing:1px; text-transform:uppercase;">Fecha emisión</div>'
            + '    <div style="font-size:0.9rem; color:#555; margin-bottom:8px;">' + _esc(issueDate) + '</div>'
            + '    <div style="font-size:0.65rem; color:#bbb; letter-spacing:1px; text-transform:uppercase;">Periodo</div>'
            + '    <div style="font-size:0.9rem; color:#FF6600; font-weight:500;">' + _esc(periodLabel) + '</div>'
            + (dueDate ? '<div style="font-size:0.65rem; color:#bbb; letter-spacing:1px; text-transform:uppercase; margin-top:8px;">Vencimiento</div><div style="font-size:0.9rem; color:#555;">' + _esc(dueDate) + '</div>' : '')
            + '  </div>'
            + '</div>'

            + '<div style="border-top:0.5px solid #e0e0e0; margin-bottom:30px;"></div>'

            // CLIENT BLOCK
            + '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:30px; margin-bottom:35px;">'
            + '  <div>'
            + '    <div style="font-size:0.65rem; color:#bbb; letter-spacing:2px; text-transform:uppercase; margin-bottom:8px;">Facturar a</div>'
            + '    <div style="font-size:1rem; color:#222; font-weight:500; margin-bottom:3px;">' + _esc(inv.clientName || client.name) + '</div>'
            + '    <div style="font-size:0.78rem; color:#888; line-height:1.7;">'
            + '      CIF/NIF: ' + _esc(client.nif || inv.clientCIF || '—') + ' · #' + _esc(client.idNum || '') + '<br>'
            + _esc([client.street, client.number, client.localidad, client.cp ? 'CP ' + client.cp : '', client.province].filter(Boolean).join(', ')) + '<br>'
            + (client.senderPhone || client.phone ? _esc(client.senderPhone || client.phone) + '<br>' : '')
            + (client.email ? _esc(client.email) : '')
            + '    </div>'
            + '  </div>'
            + '  <div>'
            + '    <div style="font-size:0.65rem; color:#bbb; letter-spacing:2px; text-transform:uppercase; margin-bottom:8px;">Resumen del periodo</div>'
            + '    <div style="font-size:0.85rem; color:#666; line-height:1.7;">'
            + '      Albaranes facturados: <strong style="color:#222;">' + totalTickets + '</strong><br>'
            + '      Sedes implicadas: <strong style="color:#222;">' + groups.length + '</strong><br>'
            + '      Modalidad: <strong style="color:#FF6600;">Tarifa plana mensual</strong>'
            + '    </div>'
            + '  </div>'
            + '</div>'

            // CONCEPT TABLE
            + '<table style="width:100%; border-collapse:collapse; margin-bottom:25px;">'
            + '  <thead>'
            + '    <tr style="border-bottom:0.5px solid #ccc;">'
            + '      <th style="padding:10px 0; text-align:left; font-size:0.62rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase;">Concepto</th>'
            + '      <th style="padding:10px 0; text-align:center; font-size:0.62rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase; width:50px;">Cant.</th>'
            + '      <th style="padding:10px 0; text-align:right; font-size:0.62rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase; width:100px;">Precio</th>'
            + '      <th style="padding:10px 0; text-align:right; font-size:0.62rem; color:#bbb; letter-spacing:1.5px; text-transform:uppercase; width:100px;">Importe</th>'
            + '    </tr>'
            + '  </thead>'
            + '  <tbody>'
            + '    <tr>'
            + '      <td style="padding:14px 0; border-bottom:0.5px solid #f0f0f0; color:#333; font-weight:400; vertical-align:top;">'
            + '        Cuota Fija — Servicio de Transporte<br>'
            + '        <span style="font-size:0.72rem; color:#888; font-weight:300;">Tarifa plana acordada para el periodo ' + _esc(periodLabel) + '. Incluye recogidas, entregas y operativa logística de todas las sedes vinculadas al cliente.</span>'
            + '      </td>'
            + '      <td style="padding:14px 0; border-bottom:0.5px solid #f0f0f0; text-align:center; color:#666;">1</td>'
            + '      <td style="padding:14px 0; border-bottom:0.5px solid #f0f0f0; text-align:right; color:#666;">' + _money(inv.subtotal) + '</td>'
            + '      <td style="padding:14px 0; border-bottom:0.5px solid #f0f0f0; text-align:right; color:#222; font-weight:500;">' + _money(inv.subtotal) + '</td>'
            + '    </tr>'
            + '  </tbody>'
            + '</table>'

            // BRANCH BREAKDOWN — bloque informativo con % por sucursal
            + (function() {
                if (totalTickets === 0 || groups.length === 0) return '';
                // Construir barras de % visualmente
                let pctRows = groups.map(g => {
                    const pct = (g.count / totalTickets) * 100;
                    const pctRound = pct.toFixed(1);
                    const barW = Math.max(2, Math.round(pct));
                    return ''
                        + '<div style="display:grid; grid-template-columns: 1fr 70px 60px 140px; gap:10px; align-items:center; padding:6px 0; border-bottom:0.5px dashed rgba(255,102,0,0.10);">'
                        + '  <div>'
                        + '    <div style="font-size:0.78rem; color:#333; font-weight:500;">' + _esc(g.label) + '</div>'
                        + '    <div style="font-size:0.62rem; color:#888; margin-top:1px;">' + _esc(g.sub) + '</div>'
                        + '  </div>'
                        + '  <div style="text-align:right; font-size:0.78rem; color:#444; font-weight:500;">' + g.count + ' alb.</div>'
                        + '  <div style="text-align:right; font-size:0.78rem; color:#FF6600; font-weight:600;">' + pctRound + ' %</div>'
                        + '  <div style="background:rgba(255,102,0,0.08); border-radius:3px; height:10px; overflow:hidden;">'
                        + '    <div style="height:100%; width:' + barW + '%; background:linear-gradient(90deg, #FF6600, #FFB366); border-radius:3px;"></div>'
                        + '  </div>'
                        + '</div>';
                }).join('');
                // Identificar sucursal más operativa
                const top = groups.slice().sort((a,b) => b.count - a.count)[0];
                // Listado de IDs (colapsado al final para no saturar)
                const allIdsHTML = groups.map(g =>
                    '<div style="margin-top:6px;">'
                    + '<span style="font-size:0.7rem; color:#666; font-weight:500;">' + _esc(g.label) + ':</span> '
                    + '<span style="font-family:monospace; font-size:0.65rem; color:#888;">' + _esc(g.ids.join(', ')) + '</span>'
                    + '</div>'
                ).join('');
                return ''
                    + '<div style="background:rgba(255,102,0,0.03); border:0.5px solid rgba(255,102,0,0.15); border-radius:6px; padding:14px 16px; margin-bottom:25px; page-break-inside:avoid;">'
                    + '  <div style="display:flex; align-items:center; gap:6px; margin-bottom:10px;">'
                    + '    <div style="font-size:0.65rem; color:#FF6600; letter-spacing:1.5px; text-transform:uppercase; font-weight:500;">ⓘ Distribución operativa por sucursal · ' + _esc(periodLabel) + '</div>'
                    + '  </div>'
                    + '  <div style="font-size:0.65rem; color:#999; font-style:italic; margin-bottom:10px; line-height:1.4;">Datos informativos. La cuota mensual contractual es única y no varía con el volumen.</div>'
                    + pctRows
                    + '  <div style="display:grid; grid-template-columns: 1fr 70px 60px 140px; gap:10px; padding:7px 0 3px; margin-top:3px; font-weight:700;">'
                    + '    <div style="font-size:0.78rem; color:#222;">TOTAL CONSOLIDADO</div>'
                    + '    <div style="text-align:right; font-size:0.78rem; color:#222;">' + totalTickets + ' alb.</div>'
                    + '    <div style="text-align:right; font-size:0.78rem; color:#222;">100 %</div>'
                    + '    <div></div>'
                    + '  </div>'
                    + (top ? '<div style="margin-top:8px; padding-top:8px; border-top:0.5px solid rgba(255,102,0,0.15); font-size:0.7rem; color:#555;">Sucursal más operativa este periodo: <strong style="color:#FF6600;">' + _esc(top.label) + '</strong> con ' + top.count + ' albaranes (' + ((top.count/totalTickets)*100).toFixed(1) + ' %).</div>' : '')
                    + '  <details style="margin-top:10px;"><summary style="cursor:pointer; font-size:0.65rem; color:#aaa; letter-spacing:1px; text-transform:uppercase;">Ver IDs de albaranes incluidos</summary>' + allIdsHTML + '</details>'
                    + '</div>'
            })()

            // TOTALS
            + '<div style="display:flex; justify-content:flex-end; margin-bottom:30px;">'
            + '  <div style="width:300px;">'
            + '    <div style="display:flex; justify-content:space-between; padding:5px 0; color:#888; font-size:0.85rem;"><span>Base Imponible</span><span>' + _money(inv.subtotal) + '</span></div>'
            + '    <div style="display:flex; justify-content:space-between; padding:5px 0; color:#888; font-size:0.85rem;"><span>IVA (' + (inv.ivaRate || 21) + ' %)</span><span>' + _money(inv.iva) + '</span></div>'
            + (inv.irpf && inv.irpf > 0 ? '<div style="display:flex; justify-content:space-between; padding:5px 0; color:#888; font-size:0.85rem;"><span>IRPF (−' + (inv.irpfRate || 0) + ' %)</span><span>−' + _money(inv.irpf) + '</span></div>' : '')
            + '    <div style="border-top:1px solid #333; margin-top:8px; padding-top:10px; display:flex; justify-content:space-between; font-size:1.25rem; color:#111; font-weight:700;"><span>Total</span><span>' + _money(inv.total) + '</span></div>'
            + '  </div>'
            + '</div>'

            // PAYMENT BLOCK
            + '<div style="background:#f8f8f8; border-radius:6px; padding:14px 16px; margin-bottom:25px; page-break-inside:avoid;">'
            + '  <div style="font-size:0.65rem; color:#999; letter-spacing:1.5px; text-transform:uppercase; font-weight:500; margin-bottom:8px;">Forma de pago</div>'
            + '  <div style="font-size:0.85rem; color:#333; font-weight:500; margin-bottom:6px;">' + _esc(paymentLabel) + '</div>'
            + (client.iban ? '<div style="font-size:0.72rem; color:#666; font-family:monospace; letter-spacing:0.5px;">IBAN cliente: ' + _esc(client.iban) + '</div>' : '')
            + (client.sepaRef ? '<div style="font-size:0.72rem; color:#666; margin-top:3px;">Ref. SEPA: ' + _esc(client.sepaRef) + (client.sepaDate ? ' · Mandato del ' + _esc(client.sepaDate) : '') + '</div>' : '')
            + (senderBranch.bank ? '<div style="font-size:0.72rem; color:#666; margin-top:6px;">IBAN emisor: <span style="font-family:monospace;">' + _esc(senderBranch.bank) + '</span></div>' : '')
            + '</div>'

            // FOOTER
            + '<div style="position:absolute; bottom:50px; left:50px; right:50px; border-top:0.5px solid #e0e0e0; padding-top:14px;">'
            + '  <div style="display:flex; justify-content:space-between; align-items:flex-end; font-size:0.65rem; color:#aaa; line-height:1.5;">'
            + '    <div>'
            + (inv.journalRef ? 'Asiento contable nº <strong style="color:#666;">' + _esc(inv.journalRef) + '</strong><br>' : '')
            + 'Documento contabilizado automáticamente. PGC: 430 / 700 / 477' + (inv.irpf > 0 ? ' / 473' : '') + '.'
            + '    </div>'
            + '    <div style="text-align:right; max-width:240px;">' + _esc(senderBranch.legal || 'Documento de validez fiscal conforme a la normativa vigente.') + '</div>'
            + '  </div>'
            + '</div>'

            + '</div>';
    }

    // ============ DATA LOADERS ============

    async function _loadInvoice(invoiceIdOrDocId) {
        // Try direct doc by id (invoiceId business id), then fall back to where()
        let snap = await db.collection('invoices').where('invoiceId', '==', invoiceIdOrDocId).limit(1).get();
        if (!snap.empty) {
            return { ...snap.docs[0].data(), _docId: snap.docs[0].id };
        }
        // Maybe the user passed a Firestore docId
        const direct = await db.collection('invoices').doc(invoiceIdOrDocId).get();
        if (direct.exists) return { ...direct.data(), _docId: direct.id };
        return null;
    }

    async function _loadClientAndBranches(inv) {
        // Parent client is inv.clientId — could be a uid or auto-id
        let parentDoc = null;
        if (inv.clientId) {
            const d = await db.collection('users').doc(inv.clientId).get();
            if (d.exists) parentDoc = { id: d.id, ...d.data() };
        }
        // Fallback: search by idNum (clientCIF stored as idNum sometimes)
        if (!parentDoc && inv.clientCIF) {
            const s = await db.collection('users').where('idNum', '==', inv.clientCIF).limit(1).get();
            if (!s.empty) parentDoc = { id: s.docs[0].id, ...s.docs[0].data() };
        }
        if (!parentDoc) parentDoc = { id: inv.clientId, name: inv.clientName, idNum: inv.clientCIF };

        // Load branches (users with parentClientId == parentDoc.id)
        const branchesMap = {};
        try {
            const bSnap = await db.collection('users').where('parentClientId', '==', parentDoc.id).get();
            bSnap.forEach(doc => {
                const d = doc.data();
                const idn = (d.idNum || '').toString();
                if (idn) branchesMap[idn] = { id: doc.id, ...d };
                branchesMap[doc.id] = { id: doc.id, ...d };
            });
        } catch(e) { console.warn('Branches load:', e); }

        return { client: parentDoc, branchesMap };
    }

    // ============ PUBLIC API ============

    window.previewMultiBranchInvoiceHTML = async function previewMultiBranchInvoiceHTML(invoiceId) {
        if (typeof showLoading === 'function') showLoading();
        try {
            const inv = await _loadInvoice(invoiceId);
            if (!inv) { alert('Factura no encontrada: ' + invoiceId); return; }
            const { client, branchesMap } = await _loadClientAndBranches(inv);
            const html = buildHTML(inv, client, branchesMap);

            // Modal preview
            let prev = document.getElementById('mb-invoice-preview');
            if (prev) prev.remove();
            const modal = document.createElement('div');
            modal.id = 'mb-invoice-preview';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:99999; display:flex; align-items:flex-start; justify-content:center; padding:24px; overflow-y:auto;';
            const inner = document.createElement('div');
            inner.style.cssText = 'background:#1e1e1e; border:1px solid #444; border-radius:12px; padding:16px; max-width:900px; width:100%;';
            inner.innerHTML = ''
                + '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">'
                + '  <h3 style="margin:0; color:#FF6600; font-size:1rem;">📄 Vista previa · ' + _esc(inv.invoiceId) + '</h3>'
                + '  <div style="display:flex; gap:8px;">'
                + '    <button id="mb-preview-download" style="background:#FF4D00; border:0; color:#000; padding:8px 16px; border-radius:6px; font-weight:700; cursor:pointer;">📥 Descargar PDF</button>'
                + '    <button id="mb-preview-close" style="background:#333; border:1px solid #555; color:#fff; padding:8px 16px; border-radius:6px; cursor:pointer;">Cerrar</button>'
                + '  </div>'
                + '</div>'
                + '<div id="mb-preview-content" style="background:white; border-radius:6px; max-height:80vh; overflow-y:auto;">' + html + '</div>';
            modal.appendChild(inner);
            document.body.appendChild(modal);
            document.getElementById('mb-preview-close').onclick = () => modal.remove();
            document.getElementById('mb-preview-download').onclick = () => {
                window.downloadMultiBranchInvoicePDF(invoiceId);
            };
        } catch(e) {
            alert('Error generando vista previa: ' + e.message);
        } finally {
            if (typeof hideLoading === 'function') hideLoading();
        }
    };

    window.downloadMultiBranchInvoicePDF = async function downloadMultiBranchInvoicePDF(invoiceId) {
        if (typeof html2pdf !== 'function') {
            alert('html2pdf no está cargado. Recarga el panel admin.');
            return;
        }
        if (typeof showLoading === 'function') showLoading();
        try {
            const inv = await _loadInvoice(invoiceId);
            if (!inv) { alert('Factura no encontrada: ' + invoiceId); return; }
            const { client, branchesMap } = await _loadClientAndBranches(inv);
            const html = buildHTML(inv, client, branchesMap);

            const el = document.createElement('div');
            el.innerHTML = html;
            el.style.position = 'fixed';
            el.style.left = '-9999px';
            document.body.appendChild(el);

            try {
                await html2pdf().from(el).set({
                    margin: 0,
                    filename: (inv.invoiceId || 'factura') + '_tarifa-plana.pdf',
                    image: { type: 'jpeg', quality: 0.95 },
                    html2canvas: { scale: 2, useCORS: true, allowTaint: true, letterRendering: true },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                }).save();
            } finally {
                document.body.removeChild(el);
            }
        } catch(e) {
            alert('Error generando PDF: ' + e.message);
        } finally {
            if (typeof hideLoading === 'function') hideLoading();
        }
    };

    // Expose builder too, in case some other panel wants the HTML directly
    window.buildMultiBranchInvoiceHTML = buildHTML;
})();
