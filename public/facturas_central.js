// =============================================
// NOVAPACK ERP — Centro de Facturación v1.0
// =============================================
// Full-screen tab with sub-filters, KPIs, and invoice/credit note management.
// Sub-tabs: TODAS | PENDIENTES | VENCIDAS | COBRADAS | ABONOS

(function() {
    'use strict';

    let _facCache = [];
    let _facFiltered = [];
    let _facSubTab = 'todas';
    let _facPage = 0;
    const PAGE_SIZE = 50;
    let _facDateFrom = '';
    let _facDateTo = '';
    let _facTextFilter = '';
    let _facCompanyFilter = ''; // Filter by billing company
    let _facLoading = false;
    let _facCompanies = {}; // billing_companies map

    // ============================================================
    //  INIT — called by erp_tabs onLoad
    // ============================================================
    window.facCentralInit = function() {
        _facLoadCompanies().then(() => {
            _facRender();
            _facLoadData();
        });
    };

    async function _facLoadCompanies() {
        try {
            const snap = await db.collection('billing_companies').get();
            _facCompanies = {};
            snap.forEach(doc => { _facCompanies[doc.id] = doc.data(); });
        } catch(e) { console.error('[FAC] Error loading companies:', e); }
    }

    // ============================================================
    //  MAIN LAYOUT
    // ============================================================
    function _facRender() {
        const container = document.getElementById('erp-tab-facturas-central');
        if (!container) return;

        const today = new Date();
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        if (!_facDateFrom) _facDateFrom = monthAgo.toISOString().split('T')[0];
        if (!_facDateTo) _facDateTo = today.toISOString().split('T')[0];

        const subTabStyle = (id, color) => {
            const active = _facSubTab === id;
            return `padding:10px 20px; cursor:pointer; font-size:0.85rem; font-weight:600; color:${active ? '#fff' : '#888'}; border-bottom:${active ? '3px solid ' + color : '3px solid transparent'}; display:flex; align-items:center; gap:5px; transition:all 0.2s; user-select:none;`;
        };

        // Company options
        let companyOpts = '<option value="">Todas las Empresas</option>';
        Object.entries(_facCompanies).forEach(([id, c]) => {
            const sel = _facCompanyFilter === id ? 'selected' : '';
            companyOpts += `<option value="${id}" ${sel}>${c.name || 'Sin Nombre'}</option>`;
        });

        container.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; background:#1e1e1e; color:#d4d4d4; font-family:'Segoe UI',sans-serif;">
            <!-- HEADER -->
            <div style="background:linear-gradient(135deg, #1b5e20, #2e7d32); padding:14px 24px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span class="material-symbols-outlined" style="font-size:1.5rem; color:#fff;">receipt_long</span>
                    <span style="font-size:1.3rem; font-weight:bold; color:#fff;">CENTRO DE FACTURACIÓN</span>
                    <span id="fac-total-badge" style="background:rgba(255,255,255,0.2); color:#fff; padding:3px 10px; border-radius:12px; font-size:0.75rem; font-weight:bold;"></span>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button type="button" onclick="window._facNewInvoice()" style="background:linear-gradient(135deg,#e65100,#ff6d00); border:none; color:#fff; padding:8px 18px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.85rem; display:flex; align-items:center; gap:5px; box-shadow:0 2px 8px rgba(255,109,0,0.4);" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform=''">
                        <span class="material-symbols-outlined" style="font-size:1rem;">add_circle</span> + Nueva Factura
                    </button>
                    <button type="button" onclick="window.monthlyBillingInit()" style="background:linear-gradient(135deg,#4527A0,#7B1FA2); border:none; color:#fff; padding:8px 18px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.85rem; display:flex; align-items:center; gap:5px; box-shadow:0 2px 8px rgba(123,31,162,0.4);" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform=''">
                        <span class="material-symbols-outlined" style="font-size:1rem;">event_repeat</span> Facturación Mensual
                    </button>
                    <button type="button" onclick="window.facCentralSEPA()" style="background:linear-gradient(135deg,#1565C0,#1E88E5); border:none; color:#fff; padding:8px 18px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.85rem; display:flex; align-items:center; gap:5px; box-shadow:0 2px 8px rgba(21,101,192,0.4);" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform=''">
                        <span class="material-symbols-outlined" style="font-size:1rem;">account_balance</span> Remesa SEPA
                    </button>
                    <button type="button" onclick="window._facExportCSV()" style="background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.3); color:#fff; padding:7px 14px; border-radius:5px; cursor:pointer; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                        <span class="material-symbols-outlined" style="font-size:0.9rem;">download</span> Exportar
                    </button>
                    <button type="button" onclick="window._facRefresh()" style="background:#4CAF50; border:none; color:#fff; padding:7px 14px; border-radius:5px; cursor:pointer; font-weight:bold; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                        <span class="material-symbols-outlined" style="font-size:0.9rem;">refresh</span> Actualizar
                    </button>
                </div>
            </div>

            <!-- KPI SUMMARY -->
            <div id="fac-kpi-bar" style="background:#252526; padding:12px 24px; display:flex; gap:16px; flex-shrink:0; border-bottom:1px solid #3c3c3c; flex-wrap:wrap;">
                <div style="flex:1; min-width:160px; background:rgba(33,150,243,0.1); border:1px solid rgba(33,150,243,0.3); border-radius:10px; padding:12px 16px;">
                    <div style="font-size:0.65rem; color:#64B5F6; text-transform:uppercase; font-weight:600;">Facturado</div>
                    <div id="fac-kpi-total" style="font-size:1.3rem; font-weight:800; color:#fff; margin-top:2px;">0,00€</div>
                    <div id="fac-kpi-total-count" style="font-size:0.7rem; color:#888;">0 facturas</div>
                </div>
                <div style="flex:1; min-width:160px; background:rgba(76,175,80,0.1); border:1px solid rgba(76,175,80,0.3); border-radius:10px; padding:12px 16px;">
                    <div style="font-size:0.65rem; color:#81C784; text-transform:uppercase; font-weight:600;">Cobrado</div>
                    <div id="fac-kpi-paid" style="font-size:1.3rem; font-weight:800; color:#4CAF50; margin-top:2px;">0,00€</div>
                    <div id="fac-kpi-paid-count" style="font-size:0.7rem; color:#888;">0 facturas</div>
                </div>
                <div style="flex:1; min-width:160px; background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.3); border-radius:10px; padding:12px 16px;">
                    <div style="font-size:0.65rem; color:#FFB74D; text-transform:uppercase; font-weight:600;">Pendiente</div>
                    <div id="fac-kpi-pending" style="font-size:1.3rem; font-weight:800; color:#FF9800; margin-top:2px;">0,00€</div>
                    <div id="fac-kpi-pending-count" style="font-size:0.7rem; color:#888;">0 facturas</div>
                </div>
                <div style="flex:1; min-width:160px; background:rgba(244,67,54,0.1); border:1px solid rgba(244,67,54,0.3); border-radius:10px; padding:12px 16px;">
                    <div style="font-size:0.65rem; color:#E57373; text-transform:uppercase; font-weight:600;">Vencido</div>
                    <div id="fac-kpi-overdue" style="font-size:1.3rem; font-weight:800; color:#f44336; margin-top:2px;">0,00€</div>
                    <div id="fac-kpi-overdue-count" style="font-size:0.7rem; color:#888;">0 facturas</div>
                </div>
                <div style="flex:1; min-width:160px; background:rgba(156,39,176,0.1); border:1px solid rgba(156,39,176,0.3); border-radius:10px; padding:12px 16px;">
                    <div style="font-size:0.65rem; color:#CE93D8; text-transform:uppercase; font-weight:600;">Abonos</div>
                    <div id="fac-kpi-abonos" style="font-size:1.3rem; font-weight:800; color:#9C27B0; margin-top:2px;">0,00€</div>
                    <div id="fac-kpi-abonos-count" style="font-size:0.7rem; color:#888;">0 abonos</div>
                </div>
            </div>

            <!-- FILTER BAR -->
            <div style="background:#1e1e1e; padding:10px 24px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; flex-shrink:0; border-bottom:1px solid #3c3c3c;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <label style="color:#888; font-size:0.7rem; text-transform:uppercase;">Desde</label>
                    <input type="date" id="fac-date-from" value="${_facDateFrom}" onchange="window._facApplyFilters()" style="background:#2d2d30; border:1px solid #3c3c3c; color:#fff; padding:5px 8px; border-radius:4px; font-size:0.8rem;">
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <label style="color:#888; font-size:0.7rem; text-transform:uppercase;">Hasta</label>
                    <input type="date" id="fac-date-to" value="${_facDateTo}" onchange="window._facApplyFilters()" style="background:#2d2d30; border:1px solid #3c3c3c; color:#fff; padding:5px 8px; border-radius:4px; font-size:0.8rem;">
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <label style="color:#888; font-size:0.7rem; text-transform:uppercase;">Empresa</label>
                    <select id="fac-company-filter" onchange="window._facApplyFilters()" style="background:#2d2d30; border:1px solid #3c3c3c; color:#fff; padding:5px 8px; border-radius:4px; font-size:0.8rem; min-width:180px;">
                        ${companyOpts}
                    </select>
                </div>
                <div style="flex:1; min-width:200px;">
                    <input type="text" id="fac-text-filter" value="${_facTextFilter}" placeholder="🔍 Buscar por nº factura, cliente, NIF, importe..." oninput="window._facApplyFilters()"
                        style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; padding:7px 12px; border-radius:4px; font-size:0.8rem; box-sizing:border-box;">
                </div>
            </div>

            <!-- SUB-TAB BAR -->
            <div style="display:flex; background:#1e1e1e; border-bottom:2px solid #333; flex-shrink:0;">
                <div onclick="window._facSetSubTab('todas')" style="${subTabStyle('todas', '#2196F3')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">list</span> TODAS
                    <span id="fac-count-todas" style="background:rgba(33,150,243,0.2); color:#64B5F6; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._facSetSubTab('pendientes')" style="${subTabStyle('pendientes', '#FF9800')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">pending_actions</span> PENDIENTES
                    <span id="fac-count-pendientes" style="background:rgba(255,152,0,0.2); color:#FFB74D; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._facSetSubTab('vencidas')" style="${subTabStyle('vencidas', '#f44336')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">warning</span> VENCIDAS
                    <span id="fac-count-vencidas" style="background:rgba(244,67,54,0.2); color:#E57373; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._facSetSubTab('cobradas')" style="${subTabStyle('cobradas', '#4CAF50')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">check_circle</span> COBRADAS
                    <span id="fac-count-cobradas" style="background:rgba(76,175,80,0.2); color:#81C784; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._facSetSubTab('abonos')" style="${subTabStyle('abonos', '#9C27B0')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">money_off</span> ABONOS
                    <span id="fac-count-abonos" style="background:rgba(156,39,176,0.2); color:#CE93D8; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
            </div>

            <!-- TABLE AREA -->
            <div id="fac-table-area" style="flex:1; overflow-y:auto; padding:0;">
                <div style="text-align:center; padding:60px; color:#888;">
                    <span class="material-symbols-outlined" style="font-size:3rem; display:block; margin-bottom:10px;">hourglass_empty</span>
                    Cargando facturas...
                </div>
            </div>

            <!-- PAGINATION -->
            <div id="fac-pagination" style="background:#252526; padding:8px 24px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0; border-top:1px solid #3c3c3c;">
                <span id="fac-page-info" style="color:#888; font-size:0.75rem;"></span>
                <div style="display:flex; gap:6px;">
                    <button type="button" onclick="window._facPrevPage()" id="fac-btn-prev" style="background:#2d2d30; border:1px solid #3c3c3c; color:#ccc; padding:4px 12px; border-radius:3px; cursor:pointer; font-size:0.8rem;">← Anterior</button>
                    <button type="button" onclick="window._facNextPage()" id="fac-btn-next" style="background:#2d2d30; border:1px solid #3c3c3c; color:#ccc; padding:4px 12px; border-radius:3px; cursor:pointer; font-size:0.8rem;">Siguiente →</button>
                </div>
            </div>
        </div>

        <!-- ABONO PARCIAL MODAL -->
        <div id="fac-abono-modal" style="display:none; position:fixed; z-index:99000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); align-items:center; justify-content:center;">
            <div style="background:#1a1a1a; border:1px solid #333; border-radius:12px; width:90%; max-width:850px; max-height:85vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.8); padding:25px;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; padding-bottom:15px; margin-bottom:15px;">
                    <h2 style="margin:0; color:#fff; font-size:1.2rem;"><span class="material-symbols-outlined" style="vertical-align:middle; color:#9C27B0;">money_off</span> Generar Abono Parcial</h2>
                    <span onclick="document.getElementById('fac-abono-modal').style.display='none'" style="color:#aaa; font-size:28px; cursor:pointer; font-weight:bold;">&times;</span>
                </div>
                <div id="fac-abono-info" style="color:#aaa; font-size:0.85rem; margin-bottom:15px;"></div>
                <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
                    <thead>
                        <tr style="background:#252526; color:#9cdcfe; font-size:0.7rem;">
                            <th style="padding:8px; text-align:center; width:30px;">☐</th>
                            <th style="padding:8px; text-align:left;">Descripción</th>
                            <th style="padding:8px; text-align:center; width:80px;">Qty Orig.</th>
                            <th style="padding:8px; text-align:center; width:100px;">Qty Abonar</th>
                            <th style="padding:8px; text-align:right; width:90px;">Precio Ud.</th>
                            <th style="padding:8px; text-align:right; width:100px;">Total Abono</th>
                        </tr>
                    </thead>
                    <tbody id="fac-abono-lines"></tbody>
                </table>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:20px; padding-top:15px; border-top:1px solid #333;">
                    <div>
                        <span style="color:#888; font-size:0.85rem;">Total Abono: </span>
                        <span id="fac-abono-total" style="color:#f44336; font-size:1.2rem; font-weight:900;">0,00€</span>
                    </div>
                    <button type="button" onclick="window._facConfirmAbono()" style="background:linear-gradient(135deg,#9C27B0,#7B1FA2); border:none; color:#fff; padding:10px 24px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.9rem;">
                        ✅ Confirmar Abono
                    </button>
                </div>
            </div>
        </div>`;
    }

    // ============================================================
    //  DATA LOADING
    // ============================================================
    async function _facLoadData() {
        if (_facLoading) return;
        _facLoading = true;

        try {
            const fromEl = document.getElementById('fac-date-from');
            const toEl = document.getElementById('fac-date-to');
            if (fromEl) _facDateFrom = fromEl.value;
            if (toEl) _facDateTo = toEl.value;

            let query = db.collection('invoices');

            if (_facDateFrom) {
                query = query.where('date', '>=', new Date(_facDateFrom + 'T00:00:00'));
            }
            if (_facDateTo) {
                const endD = new Date(_facDateTo + 'T23:59:59');
                query = query.where('date', '<=', endD);
            }

            query = query.orderBy('date', 'desc').limit(5000);
            const snap = await query.get();

            _facCache = [];
            snap.forEach(doc => _facCache.push({ docId: doc.id, ...doc.data() }));

            _facApplyFiltersInternal();
        } catch (e) {
            const area = document.getElementById('fac-table-area');
            if (area) area.innerHTML = `<div style="color:#f44; padding:30px; text-align:center;">Error cargando facturas: ${e.message}</div>`;
        } finally {
            _facLoading = false;
        }
    }

    // ============================================================
    //  FILTERS & SUB-TABS
    // ============================================================
    window._facSetSubTab = function(tab) {
        _facSubTab = tab;
        _facPage = 0;
        _facApplyFiltersInternal();
        _facRender();
        _facApplyFiltersInternal();
    };

    var _facApplyFiltersTimer;
    window._facApplyFilters = function() {
        clearTimeout(_facApplyFiltersTimer);
        _facApplyFiltersTimer = setTimeout(function() {
            const fromEl = document.getElementById('fac-date-from');
            const toEl = document.getElementById('fac-date-to');
            const textEl = document.getElementById('fac-text-filter');
            const compEl = document.getElementById('fac-company-filter');
            if (fromEl) _facDateFrom = fromEl.value;
            if (toEl) _facDateTo = toEl.value;
            if (textEl) _facTextFilter = textEl.value;
            if (compEl) _facCompanyFilter = compEl.value;

            _facPage = 0;
            _facLoadData();
        }, 500);
    };

    window._facRefresh = function() {
        _facCache = [];
        _facLoadCompanies().then(() => _facLoadData());
    };

    function _facApplyFiltersInternal() {
        const now = new Date();
        let data = _facCache.slice();

        // Company filter
        if (_facCompanyFilter) {
            data = data.filter(inv => {
                const sd = inv.senderData || {};
                const compName = _facCompanies[_facCompanyFilter] ? _facCompanies[_facCompanyFilter].name : '';
                return sd.name === compName || sd.cif === (_facCompanies[_facCompanyFilter] || {}).nif;
            });
        }

        // Text filter
        const q = _facTextFilter.toLowerCase().trim();
        if (q) {
            data = data.filter(inv => {
                const fields = [
                    inv.invoiceId, inv.clientName, inv.clientCIF,
                    String(inv.total || ''), String(inv.number || ''),
                    (inv.senderData || {}).name || ''
                ].join(' ').toLowerCase();
                return fields.includes(q);
            });
        }

        // Helpers
        const isAbono = (inv) => inv.isAbono === true;
        const isPaid = (inv) => inv.paid === true && !isAbono(inv);
        const isOverdue = (inv) => {
            if (inv.paid || isAbono(inv)) return false;
            const due = inv.dueDate ? (inv.dueDate.toDate ? inv.dueDate.toDate() : new Date(inv.dueDate)) : null;
            return due && due < now;
        };
        const isPending = (inv) => !inv.paid && !isAbono(inv) && !isOverdue(inv);

        // Counts
        let countAll = data.length;
        let countPending = data.filter(isPending).length;
        let countOverdue = data.filter(isOverdue).length;
        let countPaid = data.filter(isPaid).length;
        let countAbonos = data.filter(isAbono).length;

        // Sub-tab filter
        switch (_facSubTab) {
            case 'pendientes': data = data.filter(isPending); break;
            case 'vencidas': data = data.filter(isOverdue); break;
            case 'cobradas': data = data.filter(isPaid); break;
            case 'abonos': data = data.filter(isAbono); break;
        }

        _facFiltered = data;

        // Update counters
        _updateFacBadge('fac-count-todas', countAll);
        _updateFacBadge('fac-count-pendientes', countPending);
        _updateFacBadge('fac-count-vencidas', countOverdue);
        _updateFacBadge('fac-count-cobradas', countPaid);
        _updateFacBadge('fac-count-abonos', countAbonos);
        _updateFacBadge('fac-total-badge', countAll + ' facturas');

        // KPIs
        _facRenderKPIs(isPaid, isPending, isOverdue, isAbono);

        _facRenderTable();
    }

    function _updateFacBadge(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function _facRenderKPIs(isPaidFn, isPendingFn, isOverdueFn, isAbonoFn) {
        // Use full cache (pre-subtab filter) for KPIs, but respect company and text filters
        let data = _facCache.slice();

        if (_facCompanyFilter) {
            data = data.filter(inv => {
                const sd = inv.senderData || {};
                const compName = _facCompanies[_facCompanyFilter] ? _facCompanies[_facCompanyFilter].name : '';
                return sd.name === compName || sd.cif === (_facCompanies[_facCompanyFilter] || {}).nif;
            });
        }

        const fmt = (n) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '€';

        const allNonAbono = data.filter(i => !i.isAbono);
        const paid = data.filter(isPaidFn);
        const pending = data.filter(isPendingFn);
        const overdue = data.filter(isOverdueFn);
        const abonos = data.filter(isAbonoFn);

        const totalSum = allNonAbono.reduce((s, i) => s + (i.total || 0), 0);
        const paidSum = paid.reduce((s, i) => s + (i.total || 0), 0);
        const pendingSum = pending.reduce((s, i) => s + (i.total || 0), 0);
        const overdueSum = overdue.reduce((s, i) => s + (i.total || 0), 0);
        const abonosSum = abonos.reduce((s, i) => s + (i.total || 0), 0);

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('fac-kpi-total', fmt(totalSum));
        set('fac-kpi-total-count', allNonAbono.length + ' facturas');
        set('fac-kpi-paid', fmt(paidSum));
        set('fac-kpi-paid-count', paid.length + ' facturas');
        set('fac-kpi-pending', fmt(pendingSum));
        set('fac-kpi-pending-count', pending.length + ' facturas');
        set('fac-kpi-overdue', fmt(overdueSum));
        set('fac-kpi-overdue-count', overdue.length + ' facturas');
        set('fac-kpi-abonos', fmt(abonosSum));
        set('fac-kpi-abonos-count', abonos.length + ' abonos');
    }

    // ============================================================
    //  TABLE RENDER
    // ============================================================
    function _facRenderTable() {
        const area = document.getElementById('fac-table-area');
        if (!area) return;

        const start = _facPage * PAGE_SIZE;
        const pageData = _facFiltered.slice(start, start + PAGE_SIZE);
        const totalPages = Math.ceil(_facFiltered.length / PAGE_SIZE) || 1;

        const pageInfo = document.getElementById('fac-page-info');
        if (pageInfo) pageInfo.textContent = `Mostrando ${start + 1}-${Math.min(start + PAGE_SIZE, _facFiltered.length)} de ${_facFiltered.length} · Página ${_facPage + 1}/${totalPages}`;

        const prevBtn = document.getElementById('fac-btn-prev');
        const nextBtn = document.getElementById('fac-btn-next');
        if (prevBtn) prevBtn.disabled = _facPage === 0;
        if (nextBtn) nextBtn.disabled = start + PAGE_SIZE >= _facFiltered.length;

        if (pageData.length === 0) {
            area.innerHTML = `<div style="text-align:center; padding:60px; color:#888;">
                <span class="material-symbols-outlined" style="font-size:2.5rem; display:block; margin-bottom:10px;">search_off</span>
                No hay facturas con estos filtros.
            </div>`;
            return;
        }

        const now = new Date();
        let html = `
        <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
            <thead style="position:sticky; top:0; z-index:2;">
                <tr style="background:#252526; color:#9cdcfe; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:left;">Fecha</th>
                    <th style="padding:8px 6px; text-align:left;">Nº Factura</th>
                    <th style="padding:8px 6px; text-align:left;">Cliente</th>
                    <th style="padding:8px 6px; text-align:left;">Empresa Emisora</th>
                    <th style="padding:8px 6px; text-align:right;">Base Imp.</th>
                    <th style="padding:8px 6px; text-align:right;">IVA</th>
                    <th style="padding:8px 6px; text-align:right; font-weight:900;">Total</th>
                    <th style="padding:8px 6px; text-align:center;">Estado</th>
                    <th style="padding:8px 6px; text-align:center;">Acciones</th>
                </tr>
            </thead>
            <tbody>`;

        pageData.forEach(inv => {
            const dateObj = inv.date ? (inv.date.toDate ? inv.date.toDate() : new Date(inv.date)) : null;
            const dateStr = dateObj ? dateObj.toLocaleDateString('es-ES') : 'N/A';
            const isAb = inv.isAbono === true;
            const total = inv.total || 0;
            const fmt = (n) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            // Status
            let statusHtml = '';
            if (isAb) {
                statusHtml = `<span style="color:#CE93D8; font-size:0.7rem; font-weight:bold;">🟣 Abono</span>`;
            } else if (inv.paid) {
                statusHtml = `<span style="color:#4CAF50; font-size:0.7rem;">✅ Cobrada</span>`;
            } else {
                const due = inv.dueDate ? (inv.dueDate.toDate ? inv.dueDate.toDate() : new Date(inv.dueDate)) : null;
                if (due && due < now) {
                    const daysLate = Math.floor((now - due) / 86400000);
                    statusHtml = `<span style="color:#f44336; font-size:0.7rem; font-weight:bold;">🔴 Vencida (${daysLate}d)</span>`;
                } else {
                    statusHtml = `<span style="color:#FF9800; font-size:0.7rem;">🟠 Pendiente</span>`;
                }
            }

            // Invoice number color
            const numColor = isAb ? '#CE93D8' : '#FFD700';
            const totalColor = total < 0 ? '#f44336' : '#4CAF50';

            // Sender company
            const senderName = (inv.senderData || {}).name || '-';

            // Rectifica reference
            const rectRef = inv.rectificaA ? `<div style="font-size:0.65rem; color:#888;">Rectifica: ${inv.rectificaA}</div>` : '';

            // Chip status email (Sprint email-automation)
            let emailChip = '';
            if (inv.emailSentAt) {
                const sentDt = inv.emailSentAt.toDate ? inv.emailSentAt.toDate() : new Date(inv.emailSentAt);
                emailChip = `<span style="background:rgba(76,175,80,0.2); color:#4CAF50; padding:1px 6px; border-radius:3px; font-size:0.62rem; font-weight:700; margin-left:4px;" title="Enviada el ${sentDt.toLocaleString('es-ES')} a ${inv.emailSentTo || ''}">📧✓</span>`;
            } else if (inv.emailQueuedAt) {
                emailChip = `<span style="background:rgba(255,152,0,0.2); color:#FFB74D; padding:1px 6px; border-radius:3px; font-size:0.62rem; font-weight:700; margin-left:4px;" title="En cola para envío automático">📧⏳</span>`;
            }

            html += `
            <tr style="border-bottom:1px solid #2d2d30;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                <td style="padding:6px; color:#ccc;">${dateStr}</td>
                <td style="padding:6px; color:${numColor}; font-weight:bold;">${inv.invoiceId || 'N/A'}${rectRef}</td>
                <td style="padding:6px; color:#64B5F6;">[#${inv.clientCIF || '?'}] ${(inv.clientName || '-').substring(0, 30)}${emailChip}</td>
                <td style="padding:6px; color:#aaa; font-size:0.75rem;">${senderName}</td>
                <td style="padding:6px; text-align:right; color:#ccc;">${fmt(inv.subtotal || 0)}€</td>
                <td style="padding:6px; text-align:right; color:#ccc;">${fmt(inv.iva || 0)}€</td>
                <td style="padding:6px; text-align:right; color:${totalColor}; font-weight:900;">${fmt(total)}€</td>
                <td style="padding:6px; text-align:center;">${statusHtml}</td>
                <td style="padding:6px; text-align:center; white-space:nowrap;">
                    <button type="button" onclick="window._facViewInvoice('${inv.docId}')" style="background:#333; border:1px solid #555; color:#ccc; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Ver / Editar">👁</button>
                    <button type="button" onclick="window._facPrintInvoice('${inv.docId}')" style="background:#333; border:1px solid #555; color:#ccc; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Imprimir">🖨</button>
                    ${!inv.paid && !isAb ? `<button type="button" onclick="window._facMarkPaid('${inv.docId}')" style="background:#1b5e20; border:1px solid #4CAF50; color:#4CAF50; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px; font-weight:bold;" title="Marcar Cobrada">💳</button>` : ''}
                    ${!isAb ? `<button type="button" onclick="window._facOpenAbonoModal('${inv.docId}')" style="background:#4a148c; border:1px solid #9C27B0; color:#CE93D8; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Generar Abono">↩</button>` : ''}
                    ${!isAb && !inv.paid && !inv.isIncobrableMarcadaPor ? `<button type="button" onclick="window.contaMarkAsIncobrable('${inv.docId}')" style="background:#3e1a1a; border:1px solid #F44336; color:#FF6E6E; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Marcar incobrable (art. 80.4 LIVA — genera rectificativa)">⚠</button>` : ''}
                </td>
            </tr>`;
        });

        html += '</tbody></table>';
        area.innerHTML = html;
    }

    // ============================================================
    //  PAGINATION
    // ============================================================
    window._facPrevPage = function() { if (_facPage > 0) { _facPage--; _facRenderTable(); } };
    window._facNextPage = function() { if ((_facPage + 1) * PAGE_SIZE < _facFiltered.length) { _facPage++; _facRenderTable(); } };

    // ============================================================
    //  ACTIONS
    // ============================================================
    window._facNewInvoice = function() {
        // Trigger the exact same toolbar button that users normally click
        var btn = document.getElementById('btn-adv-new');
        if (btn) {
            btn.click();
        } else {
            // Fallback
            window.erpOpenTab('factura');
            if (typeof window.advResetForm === 'function') window.advResetForm();
        }
    };
    window._facViewInvoice = function(docId) {
        // Load invoice into the advanced billing editor
        if (typeof window.erpOpenTab === 'function') window.erpOpenTab('factura');
        setTimeout(() => {
            if (typeof window.advLoadInvoice === 'function') window.advLoadInvoice(docId);
        }, 400);
    };

    window._facPrintInvoice = function(docId) {
        if (typeof window.printInvoice === 'function') window.printInvoice(docId);
        else alert('Función de impresión no disponible.');
    };

    window._facMarkPaid = async function(docId) {
        if (!confirm('¿Marcar esta factura como COBRADA?')) return;
        try {
            await db.collection('invoices').doc(docId).update({ paid: true, paidDate: new Date() });
            alert('✅ Factura marcada como cobrada.');
            _facLoadData();
        } catch(e) {
            alert('Error: ' + e.message);
        }
    };

    // ============================================================
    //  ABONO PARCIAL
    // ============================================================
    let _facAbonoInvoiceId = null;
    let _facAbonoOriginal = null;

    window._facOpenAbonoModal = async function(docId) {
        try {
            const doc = await db.collection('invoices').doc(docId).get();
            if (!doc.exists) { alert('Factura no encontrada.'); return; }
            const inv = doc.data();
            _facAbonoInvoiceId = docId;
            _facAbonoOriginal = inv;

            const info = document.getElementById('fac-abono-info');
            info.innerHTML = `Factura: <strong style="color:#FFD700;">${escapeHtml(inv.invoiceId)}</strong> · Cliente: <strong>${escapeHtml(inv.clientName || '-')}</strong> · Total original: <strong style="color:#4CAF50;">${(inv.total || 0).toFixed(2)}€</strong>`;

            const tbody = document.getElementById('fac-abono-lines');
            tbody.innerHTML = '';

            const grid = inv.advancedGrid || [];
            if (grid.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#888;">Esta factura no tiene líneas detalladas (advancedGrid).</td></tr>';
            } else {
                grid.forEach((line, i) => {
                    const maxQty = Math.abs(line.qty || 1);
                    const unitPrice = Math.abs(line.price || 0);
                    const tr = document.createElement('tr');
                    tr.style.borderBottom = '1px solid #2d2d30';
                    tr.innerHTML = `
                        <td style="padding:6px; text-align:center;"><input type="checkbox" class="fac-abono-chk" data-idx="${i}" onchange="window._facRecalcAbono()" style="scale:1.2;"></td>
                        <td style="padding:6px; color:#ccc;">${line.description || '-'}</td>
                        <td style="padding:6px; text-align:center; color:#888;">${maxQty}</td>
                        <td style="padding:6px; text-align:center;"><input type="number" class="fac-abono-qty" data-idx="${i}" value="${maxQty}" min="0" max="${maxQty}" step="1" onchange="window._facRecalcAbono()" oninput="window._facRecalcAbono()" style="width:60px; background:#2d2d30; border:1px solid #555; color:#fff; padding:4px; text-align:center; border-radius:4px;"></td>
                        <td style="padding:6px; text-align:right; color:#ccc;">${unitPrice.toFixed(2)}€</td>
                        <td style="padding:6px; text-align:right; color:#f44336; font-weight:bold;" id="fac-abono-line-total-${i}">0,00€</td>
                    `;
                    tbody.appendChild(tr);
                });
            }

            document.getElementById('fac-abono-modal').style.display = 'flex';
            _facRecalcAbono();
        } catch(e) {
            alert('Error cargando factura: ' + e.message);
        }
    };

    window._facRecalcAbono = function() {
        const grid = (_facAbonoOriginal || {}).advancedGrid || [];
        let total = 0;

        grid.forEach((line, i) => {
            const chk = document.querySelector(`.fac-abono-chk[data-idx="${i}"]`);
            const qtyInput = document.querySelector(`.fac-abono-qty[data-idx="${i}"]`);
            const totalEl = document.getElementById(`fac-abono-line-total-${i}`);

            if (chk && chk.checked && qtyInput) {
                const qty = parseInt(qtyInput.value) || 0;
                const price = Math.abs(line.price || 0);
                const discount = line.discount || 0;
                const gross = qty * price;
                const lineTotal = gross - (gross * discount / 100);
                total += lineTotal;
                if (totalEl) totalEl.textContent = '-' + lineTotal.toFixed(2) + '€';
                if (totalEl) totalEl.style.color = '#f44336';
            } else {
                if (totalEl) { totalEl.textContent = '0,00€'; totalEl.style.color = '#888'; }
            }
        });

        const totalEl = document.getElementById('fac-abono-total');
        if (totalEl) totalEl.textContent = '-' + total.toFixed(2) + '€';
    };

    window._facConfirmAbono = async function() {
        if (!_facAbonoOriginal || !_facAbonoInvoiceId) return;

        const grid = _facAbonoOriginal.advancedGrid || [];
        const selectedLines = [];

        grid.forEach((line, i) => {
            const chk = document.querySelector(`.fac-abono-chk[data-idx="${i}"]`);
            const qtyInput = document.querySelector(`.fac-abono-qty[data-idx="${i}"]`);
            if (chk && chk.checked && qtyInput) {
                const qty = parseInt(qtyInput.value) || 0;
                if (qty > 0) {
                    selectedLines.push({
                        ...line,
                        qty: -qty,
                        total: -(qty * Math.abs(line.price || 0) * (1 - (line.discount || 0) / 100))
                    });
                }
            }
        });

        if (selectedLines.length === 0) { alert('Selecciona al menos una línea para abonar.'); return; }

        if (!confirm(`¿Confirmas generar un abono parcial con ${selectedLines.length} línea(s)?`)) return;

        // LEGAL: capturar motivo de rectificación (RD 1619/2012 art. 15)
        const motivo = await _facPedirMotivoRectificacion();
        if (motivo === null) return; // cancelado

        try {
            // Numeración atómica con serie R independiente (Fix legal-sprint1 #2)
            // Counter: sequence_counters/credits_YYYY
            // Serie:   R-YY-N  (rectificativa, conforme RD 1619/2012 art. 6.1.a)
            const aboYear = new Date().getFullYear();
            const aboYY = String(aboYear).slice(-2);
            const counterPath = 'sequence_counters/credits_' + aboYear;

            const nextNum = await window.allocSequentialNumber(counterPath, async () => {
                // Seed inicial: máximo R-{aboYY}-N + máximo ABO-{aboYY}-N legacy + máximo FAC-{aboYY}-N
                // Aseguramos no chocar con ningún número existente (transición)
                const yrStart = new Date(aboYear, 0, 1);
                const yrEnd = new Date(aboYear + 1, 0, 1);
                const snap = await db.collection('invoices')
                    .where('date', '>=', yrStart).where('date', '<', yrEnd)
                    .limit(20000).get();
                let max = 0;
                snap.forEach(d => {
                    const iid = d.data().invoiceId || '';
                    const m = iid.match(/^R-\d{2}-(\d+)$/);
                    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
                });
                return max;
            });

            const subtotal = selectedLines.reduce((s, l) => s + l.total, 0);
            const ivaRate = _facAbonoOriginal.ivaRate || 21;
            const ivaAmount = Math.round(subtotal * (ivaRate / 100) * 100) / 100;
            const irpfRate = _facAbonoOriginal.irpfRate || 0;
            const irpfAmount = Math.round(subtotal * (irpfRate / 100) * 100) / 100;
            const total = Math.round((subtotal + ivaAmount - irpfAmount) * 100) / 100;

            const abonoData = {
                number: nextNum,
                invoiceId: `R-${aboYY}-${nextNum}`,
                serie: 'R',
                date: new Date(),
                clientId: _facAbonoOriginal.clientId,
                clientName: _facAbonoOriginal.clientName,
                clientCIF: _facAbonoOriginal.clientCIF,
                subtotal: subtotal,
                iva: ivaAmount,
                ivaRate: ivaRate,
                irpf: irpfAmount,
                irpfRate: irpfRate,
                total: total,
                paid: false,  // pendiente devolver/compensar
                isAbono: true,
                isPartialAbono: true,
                rectificaA: _facAbonoOriginal.invoiceId,
                rectificaDocId: _facAbonoInvoiceId,
                rectificaDate: _facAbonoOriginal.date || null,
                motivoRectificacion: motivo.codigo,
                motivoRectificacionTexto: motivo.texto,
                senderData: _facAbonoOriginal.senderData || {},
                advancedGrid: selectedLines,
                paymentTerms: _facAbonoOriginal.paymentTerms || 'contado',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            await db.collection('invoices').add(abonoData);
            alert(`✅ Factura rectificativa ${abonoData.invoiceId} generada (${total.toFixed(2)}€)\n\nMotivo: ${motivo.texto}`);

            document.getElementById('fac-abono-modal').style.display = 'none';
            _facLoadData();
        } catch(e) {
            console.error('[abono parcial]', e);
            alert('Error generando abono: ' + e.message);
        }
    };

    // ============================================================
    //  Captura motivo rectificación (RD 1619/2012 art. 15)
    //  Causas tipificadas — devuelve {codigo, texto} o null si cancelado
    // ============================================================
    async function _facPedirMotivoRectificacion() {
        const causas = [
            { codigo: 'R1', texto: 'Error fundado en derecho (datos identificativos, importes, tipo IVA, etc.)' },
            { codigo: 'R2', texto: 'Modificación BI: descuento/bonificación posterior a la emisión' },
            { codigo: 'R3', texto: 'Anulación total de la operación' },
            { codigo: 'R4', texto: 'Devolución de mercancías o envases' },
            { codigo: 'R5', texto: 'Impago judicialmente declarado (concurso, art. 80.3 LIVA)' },
            { codigo: 'R6', texto: 'Modificación BI por sentencia firme o resolución administrativa' },
            { codigo: 'R7', texto: 'Otro motivo legal (especificar)' }
        ];
        const list = causas.map((c, i) => `  ${i+1}. ${c.codigo} — ${c.texto}`).join('\n');
        const sel = prompt('MOTIVO DE LA RECTIFICACIÓN (obligatorio - RD 1619/2012 art. 15)\n\n' + list + '\n\nEscribe el número (1-7):');
        if (sel === null) return null;
        const idx = parseInt(sel, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= causas.length) { alert('Causa no válida.'); return null; }
        let causa = causas[idx];
        if (causa.codigo === 'R7') {
            const txt = prompt('Especifica el motivo:');
            if (!txt || !txt.trim()) return null;
            causa = { codigo: 'R7', texto: txt.trim() };
        }
        return causa;
    }

    // ============================================================
    //  EXPORT CSV
    // ============================================================
    window._facExportCSV = function() {
        if (_facFiltered.length === 0) { alert('No hay datos para exportar.'); return; }

        const headers = ['Fecha', 'Nº Factura', 'Cliente Nº', 'Cliente', 'Empresa Emisora', 'Base Imp.', 'IVA', 'Total', 'Estado', 'Tipo'];
        let csv = headers.join(';') + '\n';

        const now = new Date();
        _facFiltered.forEach(inv => {
            const dateObj = inv.date ? (inv.date.toDate ? inv.date.toDate() : new Date(inv.date)) : null;
            const dateStr = dateObj ? dateObj.toLocaleDateString('es-ES') : '';
            const isAb = inv.isAbono === true;
            let estado = 'Pendiente';
            if (isAb) estado = 'Abono';
            else if (inv.paid) estado = 'Cobrada';
            else {
                const due = inv.dueDate ? (inv.dueDate.toDate ? inv.dueDate.toDate() : new Date(inv.dueDate)) : null;
                if (due && due < now) estado = 'Vencida';
            }

            const row = [
                dateStr,
                inv.invoiceId || '',
                inv.clientCIF || '',
                (inv.clientName || '').replace(/;/g, ','),
                ((inv.senderData || {}).name || '').replace(/;/g, ','),
                (inv.subtotal || 0).toFixed(2),
                (inv.iva || 0).toFixed(2),
                (inv.total || 0).toFixed(2),
                estado,
                isAb ? 'Abono' : 'Factura'
            ];
            csv += row.join(';') + '\n';
        });

        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `facturas_${_facDateFrom}_${_facDateTo}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

})();
