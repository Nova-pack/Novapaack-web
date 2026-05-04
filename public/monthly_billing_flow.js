// =============================================
// NOVAPACK ERP — Flujo Facturación Mensual + SEPA v1.0
// =============================================
// Guided monthly billing workflow:
//   Step 1: Config (month + company)
//   Step 2: Pre-validation (IBAN/SEPA checks)
//   Step 3: Preview (invoice summary per client)
//   Step 4: Generating (progress)
//   Step 5: SEPA (review + download XML)

(function() {
    'use strict';

    const MODAL_ID = 'monthly-billing-modal';
    let _mbStep = 1;
    let _mbCompId = 'main';
    let _mbDateFrom = null;
    let _mbDateTo = null;
    let _mbGrouped = {}; // { clientId: { clientInfo, tickets, subtotal, iva, irpf, total } }
    let _mbValidation = { ok: [], warn: [], error: [] };
    let _mbGeneratedInvoices = []; // { invoiceId, invoiceDocId, clientId, clientName, total }
    let _mbCompanies = {};
    let _mbSenderData = {};

    // ============================================================
    //  ENTRY POINT — called from Centro de Facturación button
    // ============================================================
    window.monthlyBillingInit = async function() {
        _mbStep = 1;
        _mbGrouped = {};
        _mbValidation = { ok: [], warn: [], error: [] };
        _mbGeneratedInvoices = [];

        // Load billing companies
        try {
            const snap = await db.collection('billing_companies').get();
            _mbCompanies = {};
            snap.forEach(doc => { _mbCompanies[doc.id] = doc.data(); });
        } catch(e) { console.error('[MB] Error loading companies:', e); }

        _renderModal();
    };

    // Standalone SEPA from existing invoices
    window.facCentralSEPA = async function() {
        _mbStep = 5;
        _mbGeneratedInvoices = [];
        _mbCompanies = {};

        try {
            const snap = await db.collection('billing_companies').get();
            snap.forEach(doc => { _mbCompanies[doc.id] = doc.data(); });
        } catch(e) {}

        // Load unpaid invoices from current month
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        try {
            const invSnap = await db.collection('invoices')
                .where('date', '>=', monthStart)
                .orderBy('date', 'desc')
                .get();
            invSnap.forEach(doc => {
                const d = doc.data();
                if (!d.paid && !d.isAbono && !d.isCredit && d.total > 0) {
                    _mbGeneratedInvoices.push({
                        invoiceDocId: doc.id,
                        invoiceId: d.invoiceId,
                        clientId: d.clientId,
                        clientName: d.clientName || 'Sin nombre',
                        total: d.total || 0,
                        senderData: d.senderData || {}
                    });
                }
            });
        } catch(e) { console.error('[MB] SEPA load error:', e); }

        _renderModal();
    };

    // ============================================================
    //  MODAL CONTAINER
    // ============================================================
    function _renderModal() {
        let modal = document.getElementById(MODAL_ID);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = MODAL_ID;
            modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; z-index:99999; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; font-family:"Segoe UI",sans-serif;';
            document.body.appendChild(modal);
        }

        const steps = [
            { num: 1, label: 'Configuración' },
            { num: 2, label: 'Validación' },
            { num: 3, label: 'Preview' },
            { num: 4, label: 'Generando' },
            { num: 5, label: 'Remesa SEPA' }
        ];

        const stepIndicators = steps.map(s => {
            const active = s.num === _mbStep;
            const done = s.num < _mbStep;
            const bg = done ? '#4CAF50' : active ? '#FF6D00' : '#3c3c3c';
            const color = (done || active) ? '#fff' : '#888';
            return `<div style="display:flex; align-items:center; gap:6px;">
                <div style="width:28px; height:28px; border-radius:50%; background:${bg}; color:${color}; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:0.8rem;">${done ? '✓' : s.num}</div>
                <span style="font-size:0.75rem; color:${color}; font-weight:${active ? '700' : '400'};">${s.label}</span>
            </div>`;
        }).join('<div style="flex:1; height:2px; background:#3c3c3c; margin:0 4px;"></div>');

        let bodyHTML = '';
        switch(_mbStep) {
            case 1: bodyHTML = _renderStep1(); break;
            case 2: bodyHTML = _renderStep2(); break;
            case 3: bodyHTML = _renderStep3(); break;
            case 4: bodyHTML = _renderStep4(); break;
            case 5: bodyHTML = _renderStep5(); break;
        }

        modal.innerHTML = `
        <div style="background:#1e1e1e; border-radius:16px; width:95vw; max-width:900px; max-height:90vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.5); overflow:hidden;">
            <!-- Header -->
            <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32); padding:16px 24px; display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span class="material-symbols-outlined" style="color:#fff; font-size:1.4rem;">event_repeat</span>
                    <span style="color:#fff; font-weight:800; font-size:1.1rem;">FACTURACIÓN MENSUAL</span>
                </div>
                <button onclick="document.getElementById('${MODAL_ID}').remove()" style="background:none; border:none; color:rgba(255,255,255,0.7); cursor:pointer; font-size:1.3rem; line-height:1;">&times;</button>
            </div>
            <!-- Steps -->
            <div style="background:#252526; padding:12px 24px; display:flex; align-items:center; border-bottom:1px solid #3c3c3c;">
                ${stepIndicators}
            </div>
            <!-- Body -->
            <div style="flex:1; overflow-y:auto; padding:20px 24px; color:#d4d4d4;">
                ${bodyHTML}
            </div>
        </div>`;
    }

    // ============================================================
    //  STEP 1 — Configuration (Month + Company)
    // ============================================================
    function _renderStep1() {
        const now = new Date();
        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const defaultFrom = prevMonth.toISOString().split('T')[0];
        const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0);
        const defaultTo = lastDayPrev.toISOString().split('T')[0];

        let compOptions = '<option value="main" selected>Sede Principal (NOVAPACK)</option>';
        Object.entries(_mbCompanies).forEach(([id, c]) => {
            compOptions += `<option value="${id}">${c.name || id}</option>`;
        });

        return `
        <div style="max-width:500px; margin:0 auto;">
            <h3 style="color:#fff; margin-bottom:20px; font-size:1rem;">Selecciona el periodo y la empresa emisora</h3>

            <label style="font-size:0.8rem; color:#aaa; display:block; margin-bottom:4px;">Periodo de albaranes</label>
            <div style="display:flex; gap:10px; margin-bottom:20px;">
                <div style="flex:1;">
                    <label style="font-size:0.7rem; color:#888;">Desde</label>
                    <input type="date" id="mb-date-from" value="${defaultFrom}" style="width:100%; padding:10px; background:#2d2d2d; border:1px solid #555; border-radius:8px; color:#fff; font-size:0.9rem;">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.7rem; color:#888;">Hasta</label>
                    <input type="date" id="mb-date-to" value="${defaultTo}" style="width:100%; padding:10px; background:#2d2d2d; border:1px solid #555; border-radius:8px; color:#fff; font-size:0.9rem;">
                </div>
            </div>

            <label style="font-size:0.8rem; color:#aaa; display:block; margin-bottom:4px;">Empresa emisora</label>
            <select id="mb-company" style="width:100%; padding:10px; background:#2d2d2d; border:1px solid #555; border-radius:8px; color:#fff; font-size:0.9rem; margin-bottom:30px;">
                ${compOptions}
            </select>

            <div style="display:flex; justify-content:flex-end; gap:10px;">
                <button onclick="document.getElementById('${MODAL_ID}').remove()" style="padding:10px 24px; background:#3c3c3c; border:none; color:#ccc; border-radius:8px; cursor:pointer; font-size:0.85rem;">Cancelar</button>
                <button onclick="window._mbGoStep2()" style="padding:10px 24px; background:linear-gradient(135deg,#e65100,#ff6d00); border:none; color:#fff; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.85rem; box-shadow:0 2px 8px rgba(255,109,0,0.4);">Continuar →</button>
            </div>
        </div>`;
    }

    window._mbGoStep2 = async function() {
        _mbDateFrom = new Date(document.getElementById('mb-date-from').value + 'T00:00:00');
        _mbDateTo = new Date(document.getElementById('mb-date-to').value + 'T23:59:59');
        _mbCompId = document.getElementById('mb-company').value;

        if (isNaN(_mbDateFrom.getTime()) || isNaN(_mbDateTo.getTime())) {
            alert('Introduce fechas válidas.'); return;
        }

        // Prepare sender data
        _mbSenderData = Object.assign({}, window.invCompanyData || {});
        if (_mbCompId !== 'main' && window.advCompaniesMap && window.advCompaniesMap[_mbCompId]) {
            const filial = window.advCompaniesMap[_mbCompId];
            _mbSenderData.name = filial.name;
            _mbSenderData.cif = filial.nif || filial.cif;
            _mbSenderData.address = filial.address;
            if (filial.bank) _mbSenderData.bank = filial.bank;
            if (filial.email) _mbSenderData.email = filial.email;
            if (filial.legal) _mbSenderData.legal = filial.legal;
            if (filial.sepaId) _mbSenderData.sepaId = filial.sepaId;
        }

        // Show loading in modal body
        const modal = document.getElementById(MODAL_ID);
        const body = modal.querySelector('div > div:last-child');
        body.innerHTML = '<div style="text-align:center; padding:40px;"><div style="font-size:1.2rem; color:#FF6D00;">⏳ Analizando albaranes pendientes...</div></div>';

        try {
            // Load users
            if (!window.userMap || Object.keys(window.userMap).length < 2) {
                if (typeof window.loadUsers === 'function') await window.loadUsers('first');
            }

            // Query tickets in the date range
            const ticketsSnap = await db.collection('tickets')
                .where('createdAt', '>=', _mbDateFrom)
                .where('createdAt', '<=', _mbDateTo)
                .orderBy('createdAt', 'desc')
                .limit(10000)
                .get();

            _mbGrouped = {};
            ticketsSnap.forEach(doc => {
                const t = doc.data();
                if (t.invoiceId && String(t.invoiceId).trim() !== '' && String(t.invoiceId).toLowerCase() !== 'null') return;
                if (t.deleteRequested || t.status === 'Pendiente Anulación') return;

                let clientId;
                if (t.shippingType === 'Debidos') {
                    if (!t.billToUid) return;
                    clientId = t.billToUid;
                } else {
                    clientId = t.uid;
                }

                let userObj = window.userMap[clientId];
                if (!userObj && t.clientIdNum) {
                    userObj = Object.values(window.userMap).find(u => u.idNum == t.clientIdNum);
                }
                if (!userObj) return;

                const fid = userObj.id;
                if (!_mbGrouped[fid]) {
                    _mbGrouped[fid] = { clientInfo: userObj, tickets: [], subtotal: 0, iva: 0, irpf: 0, total: 0 };
                }
                _mbGrouped[fid].tickets.push({ ...t, docId: doc.id });
            });

            // Calculate totals per client
            const ivaRate = window.invCompanyData ? (window.invCompanyData.iva || 21) : 21;
            Object.values(_mbGrouped).forEach(g => {
                g.subtotal = 0;
                g.tickets.forEach(t => {
                    let price = 0;
                    if (typeof window.calculateTicketPriceSync === 'function') {
                        price = window.calculateTicketPriceSync(t, g.clientInfo.id, t.compId || 'comp_main');
                    }
                    t._price = price;
                    g.subtotal += price;
                });
                g.iva = g.subtotal * (ivaRate / 100);
                const irpfRate = parseFloat(g.clientInfo.irpf) || 0;
                g.irpf = g.subtotal * (irpfRate / 100);
                g.total = g.subtotal + g.iva - g.irpf;
            });

            // Remove zero-value clients
            Object.keys(_mbGrouped).forEach(k => {
                if (_mbGrouped[k].subtotal <= 0) delete _mbGrouped[k];
            });

            // Validate SEPA data
            _mbValidation = { ok: [], warn: [], error: [] };
            Object.entries(_mbGrouped).forEach(([id, g]) => {
                const c = g.clientInfo;
                const iban = (c.iban || '').replace(/\s/g, '');
                const hasIBAN = iban.length >= 20;
                const hasMandate = !!(c.sepaRef && c.sepaDate);
                if (hasIBAN && hasMandate) {
                    _mbValidation.ok.push(id);
                } else if (hasIBAN) {
                    _mbValidation.warn.push(id);
                } else {
                    _mbValidation.error.push(id);
                }
            });

            _mbStep = 2;
            _renderModal();

        } catch(e) {
            console.error('[MB] Error:', e);
            alert('Error al analizar albaranes: ' + e.message);
            document.getElementById(MODAL_ID).remove();
        }
    };

    // ============================================================
    //  STEP 2 — Pre-Validation
    // ============================================================
    function _renderStep2() {
        const totalClients = Object.keys(_mbGrouped).length;
        if (totalClients === 0) {
            return `
            <div style="text-align:center; padding:40px;">
                <div style="font-size:3rem; margin-bottom:10px;">📭</div>
                <h3 style="color:#fff;">No hay albaranes pendientes</h3>
                <p style="color:#888;">No se encontraron albaranes sin facturar en el periodo seleccionado.</p>
                <button onclick="document.getElementById('${MODAL_ID}').remove()" style="margin-top:20px; padding:10px 24px; background:#3c3c3c; border:none; color:#ccc; border-radius:8px; cursor:pointer;">Cerrar</button>
            </div>`;
        }

        const okCount = _mbValidation.ok.length;
        const warnCount = _mbValidation.warn.length;
        const errCount = _mbValidation.error.length;

        let clientRows = '';

        // Error clients (missing IBAN)
        _mbValidation.error.forEach(id => {
            const g = _mbGrouped[id];
            clientRows += _validationRow(g, '🔴', 'Sin IBAN', '#EF5350');
        });
        // Warn clients (missing mandate)
        _mbValidation.warn.forEach(id => {
            const g = _mbGrouped[id];
            clientRows += _validationRow(g, '🟡', 'Sin mandato SEPA', '#FFB74D');
        });
        // OK clients
        _mbValidation.ok.forEach(id => {
            const g = _mbGrouped[id];
            clientRows += _validationRow(g, '🟢', 'OK', '#66BB6A');
        });

        return `
        <div>
            <h3 style="color:#fff; margin-bottom:6px; font-size:1rem;">Validación de datos bancarios</h3>
            <p style="color:#888; font-size:0.8rem; margin-bottom:16px;">Las facturas se generarán para todos. Los avisos afectan solo a la remesa SEPA.</p>

            <div style="display:flex; gap:12px; margin-bottom:20px;">
                <div style="flex:1; background:rgba(76,175,80,0.15); border:1px solid rgba(76,175,80,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#4CAF50;">${okCount}</div>
                    <div style="font-size:0.7rem; color:#81C784;">IBAN + Mandato OK</div>
                </div>
                <div style="flex:1; background:rgba(255,152,0,0.15); border:1px solid rgba(255,152,0,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#FF9800;">${warnCount}</div>
                    <div style="font-size:0.7rem; color:#FFB74D;">Falta mandato</div>
                </div>
                <div style="flex:1; background:rgba(244,67,54,0.15); border:1px solid rgba(244,67,54,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#F44336;">${errCount}</div>
                    <div style="font-size:0.7rem; color:#EF5350;">Sin IBAN</div>
                </div>
            </div>

            <div style="max-height:300px; overflow-y:auto; border:1px solid #3c3c3c; border-radius:8px;">
                <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                    <thead>
                        <tr style="background:#2d2d2d; position:sticky; top:0;">
                            <th style="padding:8px 12px; text-align:left; color:#aaa;">Estado</th>
                            <th style="padding:8px 12px; text-align:left; color:#aaa;">Cliente</th>
                            <th style="padding:8px 12px; text-align:right; color:#aaa;">Albaranes</th>
                            <th style="padding:8px 12px; text-align:left; color:#aaa;">Problema</th>
                        </tr>
                    </thead>
                    <tbody>${clientRows}</tbody>
                </table>
            </div>

            <div style="display:flex; justify-content:space-between; margin-top:20px;">
                <button onclick="window._mbBack(1)" style="padding:10px 24px; background:#3c3c3c; border:none; color:#ccc; border-radius:8px; cursor:pointer; font-size:0.85rem;">← Atrás</button>
                <button onclick="window._mbGoStep3()" style="padding:10px 24px; background:linear-gradient(135deg,#e65100,#ff6d00); border:none; color:#fff; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.85rem; box-shadow:0 2px 8px rgba(255,109,0,0.4);">Continuar al Preview →</button>
            </div>
        </div>`;
    }

    function _validationRow(g, icon, issue, color) {
        return `<tr style="border-bottom:1px solid #333;">
            <td style="padding:8px 12px;">${icon}</td>
            <td style="padding:8px 12px; color:#fff;">${(g.clientInfo.name || 'Sin nombre').substring(0, 40)}</td>
            <td style="padding:8px 12px; text-align:right; color:#ccc;">${g.tickets.length}</td>
            <td style="padding:8px 12px; color:${color}; font-weight:600;">${issue}</td>
        </tr>`;
    }

    window._mbBack = function(step) {
        _mbStep = step;
        _renderModal();
    };

    window._mbGoStep3 = function() {
        _mbStep = 3;
        _renderModal();
    };

    // ============================================================
    //  STEP 3 — Preview (Invoice summary per client)
    // ============================================================
    function _renderStep3() {
        const groups = Object.values(_mbGrouped);
        const totalFacturas = groups.length;
        const totalImporte = groups.reduce((s, g) => s + g.total, 0);
        const totalAlbaranes = groups.reduce((s, g) => s + g.tickets.length, 0);

        let rows = '';
        groups.sort((a, b) => (b.total - a.total)); // Highest first
        groups.forEach(g => {
            const c = g.clientInfo;
            rows += `<tr style="border-bottom:1px solid #333;">
                <td style="padding:8px 12px; color:#fff;">${(c.name || 'Sin nombre').substring(0, 35)}</td>
                <td style="padding:8px 12px; color:#aaa;">${c.idNum || '-'}</td>
                <td style="padding:8px 12px; text-align:center; color:#ccc;">${g.tickets.length}</td>
                <td style="padding:8px 12px; text-align:right; color:#ccc;">${g.subtotal.toFixed(2)}€</td>
                <td style="padding:8px 12px; text-align:right; color:#ccc;">${g.iva.toFixed(2)}€</td>
                <td style="padding:8px 12px; text-align:right; color:#fff; font-weight:700;">${g.total.toFixed(2)}€</td>
            </tr>`;
        });

        const compName = _mbCompId === 'main' ? 'Sede Principal' : (_mbCompanies[_mbCompId] ? _mbCompanies[_mbCompId].name : _mbCompId);

        return `
        <div>
            <h3 style="color:#fff; margin-bottom:6px; font-size:1rem;">Resumen de facturación</h3>
            <p style="color:#888; font-size:0.8rem; margin-bottom:16px;">Emisor: <strong style="color:#FF6D00;">${compName}</strong> · Periodo: ${_mbDateFrom.toLocaleDateString('es-ES')} — ${_mbDateTo.toLocaleDateString('es-ES')}</p>

            <div style="display:flex; gap:12px; margin-bottom:20px;">
                <div style="flex:1; background:rgba(33,150,243,0.15); border:1px solid rgba(33,150,243,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#2196F3;">${totalFacturas}</div>
                    <div style="font-size:0.7rem; color:#64B5F6;">Facturas</div>
                </div>
                <div style="flex:1; background:rgba(255,109,0,0.15); border:1px solid rgba(255,109,0,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#FF6D00;">${totalAlbaranes}</div>
                    <div style="font-size:0.7rem; color:#FFB74D;">Albaranes</div>
                </div>
                <div style="flex:1; background:rgba(76,175,80,0.15); border:1px solid rgba(76,175,80,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#4CAF50;">${totalImporte.toFixed(2)}€</div>
                    <div style="font-size:0.7rem; color:#81C784;">Importe Total</div>
                </div>
            </div>

            <div style="max-height:320px; overflow-y:auto; border:1px solid #3c3c3c; border-radius:8px;">
                <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                    <thead>
                        <tr style="background:#2d2d2d; position:sticky; top:0;">
                            <th style="padding:8px 12px; text-align:left; color:#aaa;">Cliente</th>
                            <th style="padding:8px 12px; text-align:left; color:#aaa;">NIF</th>
                            <th style="padding:8px 12px; text-align:center; color:#aaa;">Alb.</th>
                            <th style="padding:8px 12px; text-align:right; color:#aaa;">Base</th>
                            <th style="padding:8px 12px; text-align:right; color:#aaa;">IVA</th>
                            <th style="padding:8px 12px; text-align:right; color:#aaa;">Total</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr style="background:#2d2d2d; border-top:2px solid #555;">
                            <td colspan="3" style="padding:10px 12px; color:#fff; font-weight:800;">TOTAL</td>
                            <td style="padding:10px 12px; text-align:right; color:#fff; font-weight:700;">${groups.reduce((s,g) => s + g.subtotal, 0).toFixed(2)}€</td>
                            <td style="padding:10px 12px; text-align:right; color:#fff; font-weight:700;">${groups.reduce((s,g) => s + g.iva, 0).toFixed(2)}€</td>
                            <td style="padding:10px 12px; text-align:right; color:#4CAF50; font-weight:900; font-size:1rem;">${totalImporte.toFixed(2)}€</td>
                        </tr>
                    </tfoot>
                </table>
            </div>

            <div style="display:flex; justify-content:space-between; margin-top:20px;">
                <button onclick="window._mbBack(2)" style="padding:10px 24px; background:#3c3c3c; border:none; color:#ccc; border-radius:8px; cursor:pointer; font-size:0.85rem;">← Atrás</button>
                <button onclick="window._mbExecute()" style="padding:12px 28px; background:linear-gradient(135deg,#c62828,#e53935); border:none; color:#fff; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.9rem; box-shadow:0 2px 12px rgba(229,57,53,0.5);">⚡ Generar ${totalFacturas} Facturas</button>
            </div>
        </div>`;
    }

    // ============================================================
    //  STEP 4 — Execute (Generate invoices with progress)
    // ============================================================
    window._mbExecute = async function() {
        _mbStep = 4;
        _renderModal();

        const modal = document.getElementById(MODAL_ID);
        const body = modal.querySelector('div > div:last-child');
        const clientIds = Object.keys(_mbGrouped);
        const total = clientIds.length;
        _mbGeneratedInvoices = [];

        const updateProgress = (current, message) => {
            const pct = Math.round((current / total) * 100);
            body.innerHTML = `
            <div style="text-align:center; padding:30px 0;">
                <div style="font-size:2.5rem; margin-bottom:12px;">⚙️</div>
                <h3 style="color:#fff; margin-bottom:8px;">Generando facturas...</h3>
                <p style="color:#888; font-size:0.85rem; margin-bottom:20px;">${message}</p>
                <div style="background:#333; border-radius:8px; height:20px; overflow:hidden; max-width:500px; margin:0 auto;">
                    <div style="background:linear-gradient(90deg,#e65100,#ff6d00); height:100%; width:${pct}%; transition:width 0.3s; border-radius:8px;"></div>
                </div>
                <p style="color:#FF6D00; font-weight:bold; font-size:1.1rem; margin-top:10px;">${current} / ${total}</p>
            </div>`;
        };

        try {
            // Get next invoice number
            const currentYear = new Date().getFullYear();
            const currentYY = String(currentYear).slice(-2);

            // Atomic per-year invoice counter. Seeds from highest existing FAC-YY-N
            // on first use, then increments transactionally for every invoice we add.
            const _invCounterPath = 'sequence_counters/invoices_' + currentYear;
            const _seedInvFromHistory = async () => {
                const yearStart = new Date(currentYear, 0, 1);
                const yearEnd = new Date(currentYear + 1, 0, 1);
                const snap = await db.collection('invoices')
                    .where('date', '>=', yearStart)
                    .where('date', '<', yearEnd)
                    .orderBy('date', 'desc')
                    .get();
                let max = 0;
                snap.forEach(doc => {
                    const iid = doc.data().invoiceId || '';
                    const m = iid.match(/^FAC-\d{2}-(\d+)$/);
                    if (m) {
                        const seq = parseInt(m[1], 10);
                        if (!isNaN(seq) && seq > max) max = seq;
                    }
                    const n = doc.data().number || 0;
                    if (n > max) max = n;
                });
                return max;
            };

            const ivaRate = window.invCompanyData ? (window.invCompanyData.iva || 21) : 21;
            const invoiceDate = new Date();

            for (let i = 0; i < clientIds.length; i++) {
                const cid = clientIds[i];
                const group = _mbGrouped[cid];
                const client = group.clientInfo;
                const tkts = group.tickets;

                updateProgress(i + 1, `${client.name || 'Cliente ' + (i+1)}...`);

                if (tkts.length === 0 || group.subtotal <= 0) continue;

                const ticketsIdArray = [];
                const ticketsDetailArray = [];
                const advancedGrid = [];

                tkts.forEach(t => {
                    ticketsIdArray.push(t.docId);
                    ticketsDetailArray.push({ id: t.id || t.docId, compName: t.compName || '', price: t._price || 0 });
                    advancedGrid.push({
                        description: `Albarán ${t.id || t.docId} - Destino: ${t.receiver}`,
                        qty: 1, price: t._price || 0, discount: 0, iva: ivaRate, total: t._price || 0, ticketId: t.docId
                    });
                });

                const irpfRate = parseFloat(client.irpf) || 0;
                // Reserve next number atomically for THIS invoice only.
                let nextInvNumber;
                if (typeof window.allocSequentialNumber === 'function') {
                    nextInvNumber = await window.allocSequentialNumber(_invCounterPath, _seedInvFromHistory);
                } else {
                    // Should not happen, but degrade gracefully.
                    nextInvNumber = (await _seedInvFromHistory()) + 1;
                }
                const invoiceIdStr = `FAC-${currentYY}-${nextInvNumber}`;

                const invoiceData = {
                    number: nextInvNumber,
                    invoiceId: invoiceIdStr,
                    date: invoiceDate,
                    clientId: client.id,
                    clientName: client.name || 'Sin nombre',
                    clientCIF: client.idNum || client.nif || 'N/A',
                    subtotal: group.subtotal,
                    iva: group.iva,
                    ivaRate: ivaRate,
                    irpf: group.irpf,
                    irpfRate: irpfRate,
                    total: group.total,
                    tickets: ticketsIdArray,
                    ticketsDetail: ticketsDetailArray,
                    senderData: _mbSenderData,
                    advancedGrid: advancedGrid
                };
                if (typeof getOperatorStamp === 'function') Object.assign(invoiceData, getOperatorStamp());

                const invDoc = await db.collection('invoices').add(invoiceData);

                // Batch update tickets
                let batch = db.batch();
                let opCount = 0;
                for (const t of tkts) {
                    batch.update(db.collection('tickets').doc(t.docId), { invoiceId: invDoc.id, invoiceNum: invoiceIdStr });
                    opCount++;
                    if (opCount === 490) { await batch.commit(); batch = db.batch(); opCount = 0; }
                }
                if (opCount > 0) await batch.commit();

                _mbGeneratedInvoices.push({
                    invoiceDocId: invDoc.id,
                    invoiceId: invoiceIdStr,
                    clientId: client.id,
                    clientName: client.name || 'Sin nombre',
                    total: group.total,
                    senderData: _mbSenderData
                });
                // (No manual increment: each iteration calls allocSequentialNumber.)
            }

            // Done — go to SEPA step
            _mbStep = 5;
            _renderModal();

        } catch(e) {
            console.error('[MB] Generation error:', e);
            body.innerHTML = `
            <div style="text-align:center; padding:40px;">
                <div style="font-size:3rem; margin-bottom:10px;">❌</div>
                <h3 style="color:#EF5350;">Error durante la generación</h3>
                <p style="color:#888; font-size:0.85rem;">${e.message}</p>
                <p style="color:#4CAF50; margin-top:10px; font-size:0.85rem;">Se generaron ${_mbGeneratedInvoices.length} facturas antes del error.</p>
                <button onclick="document.getElementById('${MODAL_ID}').remove()" style="margin-top:20px; padding:10px 24px; background:#3c3c3c; border:none; color:#ccc; border-radius:8px; cursor:pointer;">Cerrar</button>
            </div>`;
        }
    };

    function _renderStep4() {
        return `
        <div style="text-align:center; padding:40px;">
            <div style="font-size:2.5rem;">⏳</div>
            <p style="color:#fff; margin-top:10px;">Preparando...</p>
        </div>`;
    }

    // ============================================================
    //  STEP 5 — SEPA Review + Download XML
    // ============================================================
    function _renderStep5() {
        const invoices = _mbGeneratedInvoices;
        const totalGenerated = invoices.length;

        if (totalGenerated === 0) {
            return `
            <div style="text-align:center; padding:40px;">
                <div style="font-size:3rem; margin-bottom:10px;">📭</div>
                <h3 style="color:#fff;">No hay facturas para la remesa</h3>
                <button onclick="document.getElementById('${MODAL_ID}').remove()" style="margin-top:20px; padding:10px 24px; background:#3c3c3c; border:none; color:#ccc; border-radius:8px; cursor:pointer;">Cerrar</button>
            </div>`;
        }

        // Validate IBAN for SEPA
        let sepaReady = 0;
        let sepaTotal = 0;
        let rows = '';

        invoices.forEach((inv, idx) => {
            const client = window.userMap ? window.userMap[inv.clientId] : null;
            const iban = client ? (client.iban || '').replace(/\s/g, '') : '';
            const hasIBAN = iban.length >= 20;
            const hasMandate = client && client.sepaRef && client.sepaDate;
            const ok = hasIBAN;

            if (ok) { sepaReady++; sepaTotal += inv.total; }

            const statusIcon = ok ? '🟢' : '🔴';
            const statusText = !hasIBAN ? 'Sin IBAN' : !hasMandate ? 'Sin mandato' : 'OK';

            rows += `<tr style="border-bottom:1px solid #333;">
                <td style="padding:6px 10px;"><input type="checkbox" class="mb-sepa-check" data-idx="${idx}" ${ok ? 'checked' : 'disabled'} style="transform:scale(1.2);"></td>
                <td style="padding:6px 10px; color:#FF6D00; font-weight:600;">${inv.invoiceId}</td>
                <td style="padding:6px 10px; color:#fff;">${inv.clientName.substring(0, 30)}</td>
                <td style="padding:6px 10px; text-align:right; color:#fff; font-weight:600;">${inv.total.toFixed(2)}€</td>
                <td style="padding:6px 10px; color:${ok ? '#66BB6A' : '#EF5350'}; font-weight:600;">${statusIcon} ${statusText}</td>
            </tr>`;
        });

        const compName = _mbSenderData.name || 'Sede Principal';
        const hasBank = !!(_mbSenderData.bank || '').replace(/\s/g, '');

        return `
        <div>
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <h3 style="color:#fff; font-size:1rem; margin:0;">Remesa SEPA</h3>
                <span style="background:rgba(76,175,80,0.2); color:#4CAF50; padding:3px 10px; border-radius:12px; font-size:0.75rem; font-weight:bold;">${totalGenerated} facturas generadas</span>
            </div>
            <p style="color:#888; font-size:0.8rem; margin-bottom:16px;">Emisor: <strong style="color:#2196F3;">${compName}</strong>${hasBank ? '' : ' <span style="color:#EF5350; font-weight:600;">⚠️ Sin IBAN configurado</span>'}</p>

            <div style="display:flex; gap:12px; margin-bottom:16px;">
                <div style="flex:1; background:rgba(33,150,243,0.15); border:1px solid rgba(33,150,243,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#2196F3;">${sepaReady}</div>
                    <div style="font-size:0.7rem; color:#64B5F6;">Incluidas en remesa</div>
                </div>
                <div style="flex:1; background:rgba(244,67,54,0.15); border:1px solid rgba(244,67,54,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#F44336;">${totalGenerated - sepaReady}</div>
                    <div style="font-size:0.7rem; color:#EF5350;">Excluidas (sin IBAN)</div>
                </div>
                <div style="flex:1; background:rgba(76,175,80,0.15); border:1px solid rgba(76,175,80,0.3); border-radius:10px; padding:12px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:800; color:#4CAF50;">${sepaTotal.toFixed(2)}€</div>
                    <div style="font-size:0.7rem; color:#81C784;">Importe remesa</div>
                </div>
            </div>

            <div style="max-height:280px; overflow-y:auto; border:1px solid #3c3c3c; border-radius:8px;">
                <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                    <thead>
                        <tr style="background:#2d2d2d; position:sticky; top:0;">
                            <th style="padding:6px 10px; width:30px;"><input type="checkbox" id="mb-sepa-all" checked onchange="window._mbToggleSEPA(this.checked)" style="transform:scale(1.2);"></th>
                            <th style="padding:6px 10px; text-align:left; color:#aaa;">Factura</th>
                            <th style="padding:6px 10px; text-align:left; color:#aaa;">Cliente</th>
                            <th style="padding:6px 10px; text-align:right; color:#aaa;">Importe</th>
                            <th style="padding:6px 10px; text-align:left; color:#aaa;">Estado</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>

            <div style="display:flex; justify-content:space-between; margin-top:20px; flex-wrap:wrap; gap:8px;">
                <button onclick="document.getElementById('${MODAL_ID}').remove(); if(typeof window._facRefresh === 'function') window._facRefresh();" style="padding:10px 24px; background:#3c3c3c; border:none; color:#ccc; border-radius:8px; cursor:pointer; font-size:0.85rem;">Cerrar</button>
                <div style="display:flex; gap:8px;">
                    <button onclick="window._mbDownloadSEPA()" ${hasBank ? '' : 'disabled'} style="padding:10px 24px; background:${hasBank ? 'linear-gradient(135deg,#1565C0,#1E88E5)' : '#555'}; border:none; color:#fff; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.85rem; box-shadow:0 2px 8px rgba(21,101,192,0.4); display:flex; align-items:center; gap:6px;">
                        <span class="material-symbols-outlined" style="font-size:1rem;">account_balance</span> Descargar XML SEPA
                    </button>
                </div>
            </div>
        </div>`;
    }

    window._mbToggleSEPA = function(checked) {
        document.querySelectorAll('.mb-sepa-check:not(:disabled)').forEach(cb => { cb.checked = checked; });
    };

    // ============================================================
    //  SEPA XML Generation + Download
    // ============================================================
    window._mbDownloadSEPA = function() {
        const checkboxes = document.querySelectorAll('.mb-sepa-check:checked');
        const selectedInvoices = [];
        checkboxes.forEach(cb => {
            const idx = parseInt(cb.dataset.idx);
            if (!isNaN(idx) && _mbGeneratedInvoices[idx]) {
                selectedInvoices.push(_mbGeneratedInvoices[idx]);
            }
        });

        if (selectedInvoices.length === 0) {
            alert('No hay facturas seleccionadas para la remesa.'); return;
        }

        const company = _mbSenderData;
        if (!(company.bank || '').replace(/\s/g, '')) {
            alert('La empresa emisora no tiene IBAN configurado. Configúralo en Datos Fiscales.'); return;
        }

        // Build SEPA PAIN.008.001.02 XML
        const msgId = 'MSG' + Date.now();
        const creationDate = new Date().toISOString().split('.')[0];
        const totalAmount = selectedInvoices.reduce((sum, inv) => sum + inv.total, 0).toFixed(2);
        const numTrans = selectedInvoices.length;
        const creditorIBAN = company.bank.replace(/\s/g, '');
        const creditorCIF = (company.cif || '').replace(/[^A-Z0-9]/gi, '');
        const creditorName = (company.name || 'NOVAPACK').substring(0, 70).replace(/[&<>"]/g, '');
        const sepaId = company.sepaId || '000';
        const creditorId = `ES${creditorIBAN.substring(2, 4)}${sepaId}${creditorCIF}`;
        const collectionDate = new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0];

        let transactions = '';
        let skipped = 0;
        selectedInvoices.forEach(inv => {
            const client = window.userMap ? window.userMap[inv.clientId] : null;
            if (!client) { skipped++; return; }
            const clientIBAN = (client.iban || '').replace(/\s/g, '');
            if (clientIBAN.length < 20) { skipped++; return; }
            const clientName = (client.name || inv.clientName).substring(0, 70).replace(/[&<>"]/g, '');
            const mandateId = client.sepaRef || ('MANDATO-' + (inv.clientId || '').substring(0, 8));
            const mandateDate = client.sepaDate || new Date().toISOString().split('T')[0];

            transactions += `
        <DrctDbtTxInf>
            <PmtId><EndToEndId>${inv.invoiceId}</EndToEndId></PmtId>
            <InstdAmt Ccy="EUR">${inv.total.toFixed(2)}</InstdAmt>
            <DrctDbtTx>
                <MndtRltdInf>
                    <MndtId>${mandateId}</MndtId>
                    <DtOfSgntr>${mandateDate}</DtOfSgntr>
                </MndtRltdInf>
            </DrctDbtTx>
            <Dbtr><Nm>${clientName}</Nm></Dbtr>
            <DbtrAcct><Id><IBAN>${clientIBAN}</IBAN></Id></DbtrAcct>
            <RmtInf><Ustrd>Factura ${inv.invoiceId}</Ustrd></RmtInf>
        </DrctDbtTxInf>`;
        });

        const actualTrans = numTrans - skipped;
        if (actualTrans === 0) {
            alert('Ninguna factura seleccionada tiene IBAN válido.'); return;
        }

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">
    <CstmrDrctDbtInitn>
        <GrpHdr>
            <MsgId>${msgId}</MsgId>
            <CreDtTm>${creationDate}</CreDtTm>
            <NbOfTxs>${actualTrans}</NbOfTxs>
            <CtrlSum>${totalAmount}</CtrlSum>
            <InitgPty><Nm>${creditorName}</Nm></InitgPty>
        </GrpHdr>
        <PmtInf>
            <PmtInfId>${msgId}-INF</PmtInfId>
            <PmtMtd>DD</PmtMtd>
            <NbOfTxs>${actualTrans}</NbOfTxs>
            <CtrlSum>${totalAmount}</CtrlSum>
            <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>RCUR</SeqTp></PmtTpInf>
            <ReqdColltnDt>${collectionDate}</ReqdColltnDt>
            <Cdtr><Nm>${creditorName}</Nm></Cdtr>
            <CdtrAcct><Id><IBAN>${creditorIBAN}</IBAN></Id></CdtrAcct>
            <CdtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></CdtrAgt>
            <CdtrSchmeId><Id><PrvtId><Othr><Id>${creditorId}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>${transactions}
        </PmtInf>
    </CstmrDrctDbtInitn>
</Document>`;

        // Download
        const blob = new Blob([xml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
        a.href = url;
        a.download = `SEPA_Remesa_${dateStr}_${actualTrans}ops.xml`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (skipped > 0) {
            alert(`XML descargado con ${actualTrans} transacciones.\n⚠️ ${skipped} facturas excluidas por falta de IBAN.`);
        } else {
            alert(`✅ XML SEPA descargado correctamente.\n${actualTrans} transacciones por ${totalAmount}€.\n\nSúbelo al portal de tu banco para ejecutar los cobros.`);
        }
    };

})();
