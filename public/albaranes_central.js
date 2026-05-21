// =============================================
// NOVAPACK ERP — Albaranes Centralizado v1.0
// =============================================
// Full-screen tab with sub-filters, toolbar, and batch operations.
// Sub-tabs: TODOS | PENDIENTES | FACTURADOS | DEBIDOS

(function() {
    'use strict';

    let _albCache = [];
    let _albFiltered = [];
    let _albSubTab = 'todos';
    let _albPage = 0;
    const PAGE_SIZE = 100;
    let _albDateFrom = '';
    let _albDateTo = '';
    let _albTextFilter = '';
    let _albLoading = false;

    // ============================================================
    //  INIT — called by erp_tabs onLoad
    // ============================================================
    window.albCentralInit = function() {
        _albRender();
        _albLoadData();
        // Close "Más" dropdown on outside click
        document.addEventListener('click', function(e) {
            const wrapper = document.getElementById('alb-more-dropdown-wrapper');
            const dd = document.getElementById('alb-more-dropdown');
            if (wrapper && dd && !wrapper.contains(e.target)) {
                dd.style.display = 'none';
            }
        });
    };

    // ============================================================
    //  MAIN LAYOUT
    // ============================================================
    function _albRender() {
        const container = document.getElementById('erp-tab-albaranes-central');
        if (!container) return;

        const today = new Date();
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        if (!_albDateFrom) _albDateFrom = monthAgo.toISOString().split('T')[0];
        if (!_albDateTo) _albDateTo = today.toISOString().split('T')[0];

        const subTabStyle = (id, color) => {
            const active = _albSubTab === id;
            return `padding:10px 20px; cursor:pointer; font-size:0.85rem; font-weight:600; color:${active ? '#fff' : '#888'}; border-bottom:${active ? '3px solid ' + color : '3px solid transparent'}; display:flex; align-items:center; gap:5px; transition:all 0.2s; user-select:none;`;
        };

        container.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; background:#1e1e1e; color:#d4d4d4; font-family:'Segoe UI',sans-serif;">
            <!-- HEADER -->
            <div style="background:linear-gradient(135deg, #0d47a1, #1565c0); padding:14px 24px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span class="material-symbols-outlined" style="font-size:1.5rem; color:#fff;">inventory_2</span>
                    <span style="font-size:1.3rem; font-weight:bold; color:#fff;">ALBARANES CENTRALIZADO</span>
                    <span id="alb-total-badge" style="background:rgba(255,255,255,0.2); color:#fff; padding:3px 10px; border-radius:12px; font-size:0.75rem; font-weight:bold;"></span>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <!-- PRIMARY: + Nuevo Albarán (always visible, prominent) -->
                    <button type="button" onclick="if(typeof window.erpOpenTab==='function') window.erpOpenTab('manual-tickets');" style="background:linear-gradient(135deg,#e65100,#ff6d00); border:none; color:#fff; padding:8px 18px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.85rem; display:flex; align-items:center; gap:5px; box-shadow:0 2px 8px rgba(255,109,0,0.4); transition:all 0.2s;" onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 12px rgba(255,109,0,0.5)'" onmouseout="this.style.transform='';this.style.boxShadow='0 2px 8px rgba(255,109,0,0.4)'">
                        <span class="material-symbols-outlined" style="font-size:1rem;">add_circle</span> + Nuevo Albar\u00e1n
                    </button>
                    <!-- SECONDARY: More dropdown -->
                    <div style="position:relative;" id="alb-more-dropdown-wrapper">
                        <button type="button" onclick="var dd=document.getElementById('alb-more-dropdown'); dd.style.display=dd.style.display==='block'?'none':'block';" style="background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.3); color:#fff; padding:7px 14px; border-radius:5px; cursor:pointer; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                            <span class="material-symbols-outlined" style="font-size:0.9rem;">menu</span> M\u00e1s \u25BE
                        </button>
                        <div id="alb-more-dropdown" style="display:none; position:absolute; top:100%; right:0; margin-top:4px; background:#2d2d30; border:1px solid #555; border-radius:8px; min-width:240px; box-shadow:0 8px 24px rgba(0,0,0,0.5); z-index:9999; overflow:hidden;">
                            <div style="padding:6px 14px; color:#888; font-size:0.65rem; text-transform:uppercase; font-weight:600; border-bottom:1px solid #3c3c3c;">Importar al Grid</div>
                            <button type="button" onclick="if(typeof advOpenTicketImportModal==='function') advOpenTicketImportModal(); document.getElementById('alb-more-dropdown').style.display='none';" style="display:flex; align-items:center; gap:8px; width:100%; padding:10px 14px; background:none; border:none; color:#d4d4d4; cursor:pointer; font-size:0.82rem; text-align:left;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='none'">
                                <span class="material-symbols-outlined" style="font-size:1rem; color:#64B5F6;">download</span> Importar Todos
                            </button>
                            <button type="button" onclick="if(typeof advImportByFilter==='function') advImportByFilter('date'); document.getElementById('alb-more-dropdown').style.display='none';" style="display:flex; align-items:center; gap:8px; width:100%; padding:10px 14px; background:none; border:none; color:#d4d4d4; cursor:pointer; font-size:0.82rem; text-align:left;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='none'">
                                <span class="material-symbols-outlined" style="font-size:1rem; color:#FFB74D;">calendar_today</span> Importar por Fecha
                            </button>
                            <button type="button" onclick="if(typeof advImportByFilter==='function') advImportByFilter('name'); document.getElementById('alb-more-dropdown').style.display='none';" style="display:flex; align-items:center; gap:8px; width:100%; padding:10px 14px; background:none; border:none; color:#d4d4d4; cursor:pointer; font-size:0.82rem; text-align:left;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='none'">
                                <span class="material-symbols-outlined" style="font-size:1rem; color:#81C784;">person</span> Importar por Nombre
                            </button>
                            <button type="button" onclick="if(typeof advImportByFilter==='function') advImportByFilter('number'); document.getElementById('alb-more-dropdown').style.display='none';" style="display:flex; align-items:center; gap:8px; width:100%; padding:10px 14px; background:none; border:none; color:#d4d4d4; cursor:pointer; font-size:0.82rem; text-align:left;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='none'">
                                <span class="material-symbols-outlined" style="font-size:1rem; color:#CE93D8;">tag</span> Importar por N\u00famero
                            </button>
                            <div style="border-top:1px solid #3c3c3c; margin:2px 0;"></div>
                            <div style="padding:6px 14px; color:#888; font-size:0.65rem; text-transform:uppercase; font-weight:600;">Herramientas</div>
                            <button type="button" onclick="if(typeof window.erpOpenTab==='function') window.erpOpenTab('scanner'); document.getElementById('alb-more-dropdown').style.display='none';" style="display:flex; align-items:center; gap:8px; width:100%; padding:10px 14px; background:none; border:none; color:#d4d4d4; cursor:pointer; font-size:0.82rem; text-align:left;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='none'">
                                <span class="material-symbols-outlined" style="font-size:1rem; color:#4FC3F7;">qr_code_scanner</span> Esc\u00e1ner QR
                            </button>
                            <button type="button" onclick="if(typeof openBulkDeleteModal==='function') openBulkDeleteModal(); document.getElementById('alb-more-dropdown').style.display='none';" style="display:flex; align-items:center; gap:8px; width:100%; padding:10px 14px; background:none; border:none; color:#FF5252; cursor:pointer; font-size:0.82rem; text-align:left;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='none'">
                                <span class="material-symbols-outlined" style="font-size:1rem;">delete_sweep</span> Eliminar por Lote
                            </button>
                        </div>
                    </div>
                    <!-- Exportar -->
                    <button type="button" onclick="window._albExportCSV()" style="background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.3); color:#fff; padding:7px 14px; border-radius:5px; cursor:pointer; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                        <span class="material-symbols-outlined" style="font-size:0.9rem;">download</span> Exportar
                    </button>
                    <!-- Actualizar -->
                    <button type="button" onclick="window._albRefresh()" style="background:#4CAF50; border:none; color:#fff; padding:7px 14px; border-radius:5px; cursor:pointer; font-weight:bold; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                        <span class="material-symbols-outlined" style="font-size:0.9rem;">refresh</span> Actualizar
                    </button>
                </div>
            </div>

            <!-- FILTER BAR -->
            <div style="background:#252526; padding:10px 24px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; flex-shrink:0; border-bottom:1px solid #3c3c3c;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <label style="color:#888; font-size:0.7rem; text-transform:uppercase;">Desde</label>
                    <input type="date" id="alb-date-from" value="${_albDateFrom}" onchange="window._albApplyFilters()" style="background:#2d2d30; border:1px solid #3c3c3c; color:#fff; padding:5px 8px; border-radius:4px; font-size:0.8rem;">
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <label style="color:#888; font-size:0.7rem; text-transform:uppercase;">Hasta</label>
                    <input type="date" id="alb-date-to" value="${_albDateTo}" onchange="window._albApplyFilters()" style="background:#2d2d30; border:1px solid #3c3c3c; color:#fff; padding:5px 8px; border-radius:4px; font-size:0.8rem;">
                </div>
                <div style="flex:1; min-width:200px;">
                    <input type="text" id="alb-text-filter" value="${_albTextFilter}" placeholder="🔍 Buscar por nº, cliente, destino, ciudad..." oninput="window._albApplyFilters()"
                        style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; padding:7px 12px; border-radius:4px; font-size:0.8rem; box-sizing:border-box;">
                </div>
                <button type="button" onclick="window._albFacturarSeleccionados()" style="background:linear-gradient(135deg,#1b5e20,#2e7d32); border:none; color:#fff; padding:7px 16px; border-radius:5px; cursor:pointer; font-weight:bold; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                    <span class="material-symbols-outlined" style="font-size:0.9rem;">receipt</span> Facturar Seleccionados
                </button>
            </div>

            <!-- SUB-TAB BAR -->
            <div style="display:flex; background:#1e1e1e; border-bottom:2px solid #333; flex-shrink:0;">
                <div onclick="window._albSetSubTab('todos')" style="${subTabStyle('todos', '#2196F3')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">list</span> TODOS
                    <span id="alb-count-todos" style="background:rgba(33,150,243,0.2); color:#64B5F6; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._albSetSubTab('pendientes')" style="${subTabStyle('pendientes', '#FF9800')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">pending_actions</span> PENDIENTES
                    <span id="alb-count-pendientes" style="background:rgba(255,152,0,0.2); color:#FFB74D; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._albSetSubTab('facturados')" style="${subTabStyle('facturados', '#4CAF50')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">check_circle</span> FACTURADOS
                    <span id="alb-count-facturados" style="background:rgba(76,175,80,0.2); color:#81C784; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._albSetSubTab('debidos')" style="${subTabStyle('debidos', '#E040FB')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">swap_horiz</span> DEBIDOS
                    <span id="alb-count-debidos" style="background:rgba(224,64,251,0.2); color:#EA80FC; padding:1px 7px; border-radius:8px; font-size:0.65rem;"></span>
                </div>
                <div onclick="window._albSetSubTab('pod')" style="${subTabStyle('pod', '#4CAF50')}">
                    <span class="material-symbols-outlined" style="font-size:1rem;">task</span> POD
                </div>
            </div>

            <!-- TABLE AREA -->
            <div id="alb-table-area" style="flex:1; overflow-y:auto; padding:0;">
                <div style="text-align:center; padding:60px; color:#888;">
                    <span class="material-symbols-outlined" style="font-size:3rem; display:block; margin-bottom:10px;">hourglass_empty</span>
                    Cargando albaranes...
                </div>
            </div>

            <!-- PAGINATION -->
            <div id="alb-pagination" style="background:#252526; padding:8px 24px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0; border-top:1px solid #3c3c3c;">
                <span id="alb-page-info" style="color:#888; font-size:0.75rem;"></span>
                <div style="display:flex; gap:6px;">
                    <button type="button" onclick="window._albPrevPage()" id="alb-btn-prev" style="background:#2d2d30; border:1px solid #3c3c3c; color:#ccc; padding:4px 12px; border-radius:3px; cursor:pointer; font-size:0.8rem;">← Anterior</button>
                    <button type="button" onclick="window._albNextPage()" id="alb-btn-next" style="background:#2d2d30; border:1px solid #3c3c3c; color:#ccc; padding:4px 12px; border-radius:3px; cursor:pointer; font-size:0.8rem;">Siguiente →</button>
                </div>
            </div>
        </div>`;
    }

    // ============================================================
    //  DATA LOADING
    // ============================================================
    async function _albLoadData() {
        if (_albLoading) return;
        _albLoading = true;

        try {
            const fromEl = document.getElementById('alb-date-from');
            const toEl = document.getElementById('alb-date-to');
            if (fromEl) _albDateFrom = fromEl.value;
            if (toEl) _albDateTo = toEl.value;

            let query = db.collection('tickets');

            if (_albDateFrom) {
                query = query.where('createdAt', '>=', new Date(_albDateFrom + 'T00:00:00'));
            }
            if (_albDateTo) {
                const endD = new Date(_albDateTo + 'T23:59:59');
                query = query.where('createdAt', '<=', endD);
            }

            query = query.orderBy('createdAt', 'desc').limit(5000);
            const snap = await query.get();

            _albCache = [];
            snap.forEach(doc => _albCache.push({ docId: doc.id, ...doc.data() }));

            _albApplyFiltersInternal();
        } catch (e) {
            const area = document.getElementById('alb-table-area');
            if (area) area.innerHTML = `<div style="color:#f44; padding:30px; text-align:center;">Error cargando: ${e.message}</div>`;
        } finally {
            _albLoading = false;
        }
    }

    // ============================================================
    //  FILTERS & SUB-TABS
    // ============================================================
    window._albSetSubTab = function(tab) {
        _albSubTab = tab;
        _albPage = 0;
        // Re-render sub-tab bar styles
        _albRender();
        if (tab === 'pod') {
            _albRenderPOD();
        } else {
            _albApplyFiltersInternal();
        }
    };

    var _albApplyFiltersTimer;
    window._albApplyFilters = function() {
        clearTimeout(_albApplyFiltersTimer);
        _albApplyFiltersTimer = setTimeout(function() {
            const fromEl = document.getElementById('alb-date-from');
            const toEl = document.getElementById('alb-date-to');
            const textEl = document.getElementById('alb-text-filter');
            if (fromEl) _albDateFrom = fromEl.value;
            if (toEl) _albDateTo = toEl.value;
            if (textEl) _albTextFilter = textEl.value;

            // If dates changed, reload from Firestore
            _albPage = 0;
            _albLoadData();
        }, 500);
    };

    window._albRefresh = function() {
        _albCache = [];
        _albLoadData();
    };

    function _albApplyFiltersInternal() {
        // Restore pagination when not on POD tab
        var pagination = document.getElementById('alb-pagination');
        if (pagination) pagination.style.display = '';
        let data = _albCache.slice();
        const q = _albTextFilter.toLowerCase().trim();

        // Text filter
        if (q) {
            data = data.filter(t => {
                const fields = [
                    t.id, t.receiver, t.receiverName, t.receiverAddress,
                    t.city, t.receiverCity, t.senderName, t.sender,
                    t.observations, t.shippingType, String(t.clientIdNum || ''),
                    t.billToClientName || ''
                ].join(' ').toLowerCase();
                return fields.includes(q);
            });
        }

        // Sub-tab filter
        const isPending = (t) => !t.invoiceId || t.invoiceId === '' || t.invoiceId === 'null';
        const isBilled = (t) => t.invoiceId && t.invoiceId !== '' && t.invoiceId !== 'null';
        const isDebido = (t) => t.shippingType === 'Debidos';

        let countAll = data.length;
        let countPend = data.filter(isPending).length;
        let countBill = data.filter(isBilled).length;
        let countDeb = data.filter(isDebido).length;

        switch (_albSubTab) {
            case 'pendientes': data = data.filter(isPending); break;
            case 'facturados': data = data.filter(isBilled); break;
            case 'debidos': data = data.filter(isDebido); break;
        }

        _albFiltered = data;

        // Update counters
        _updateBadge('alb-count-todos', countAll);
        _updateBadge('alb-count-pendientes', countPend);
        _updateBadge('alb-count-facturados', countBill);
        _updateBadge('alb-count-debidos', countDeb);
        _updateBadge('alb-total-badge', countAll + ' albaranes');

        _albRenderTable();
    }

    function _updateBadge(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    // ============================================================
    //  TABLE RENDER
    // ============================================================
    function _albRenderTable() {
        const area = document.getElementById('alb-table-area');
        if (!area) return;

        const start = _albPage * PAGE_SIZE;
        const pageData = _albFiltered.slice(start, start + PAGE_SIZE);
        const totalPages = Math.ceil(_albFiltered.length / PAGE_SIZE) || 1;

        // Pagination info
        const pageInfo = document.getElementById('alb-page-info');
        if (pageInfo) pageInfo.textContent = `Mostrando ${start + 1}-${Math.min(start + PAGE_SIZE, _albFiltered.length)} de ${_albFiltered.length} · Página ${_albPage + 1}/${totalPages}`;

        const prevBtn = document.getElementById('alb-btn-prev');
        const nextBtn = document.getElementById('alb-btn-next');
        if (prevBtn) prevBtn.disabled = _albPage === 0;
        if (nextBtn) nextBtn.disabled = start + PAGE_SIZE >= _albFiltered.length;

        if (pageData.length === 0) {
            area.innerHTML = `<div style="text-align:center; padding:60px; color:#888;">
                <span class="material-symbols-outlined" style="font-size:2.5rem; display:block; margin-bottom:10px;">search_off</span>
                No hay albaranes con estos filtros.
            </div>`;
            return;
        }

        // Build userMap lookup
        const umap = window.userMap || {};

        let html = `
        <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
            <thead style="position:sticky; top:0; z-index:2;">
                <tr style="background:#252526; color:#9cdcfe; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:center; width:30px;">
                        <input type="checkbox" id="alb-select-all" onchange="document.querySelectorAll('.alb-chk').forEach(c=>c.checked=this.checked)" style="scale:1.2;">
                    </th>
                    <th style="padding:8px 6px; text-align:left;">Fecha</th>
                    <th style="padding:8px 6px; text-align:left;">Nº Albarán</th>
                    <th style="padding:8px 6px; text-align:left;">Cliente</th>
                    <th style="padding:8px 6px; text-align:left;">Destinatario</th>
                    <th style="padding:8px 6px; text-align:left;">Ciudad</th>
                    <th style="padding:8px 6px; text-align:center;">Bultos</th>
                    <th style="padding:8px 6px; text-align:center;">Kg</th>
                    <th style="padding:8px 6px; text-align:center;">Tipo</th>
                    <th style="padding:8px 6px; text-align:center;">Estado</th>
                    <th style="padding:8px 6px; text-align:center;">Acciones</th>
                </tr>
            </thead>
            <tbody>`;

        pageData.forEach(t => {
            const date = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleDateString('es-ES') : 'N/A';
            const billed = t.invoiceId && t.invoiceId !== '' && t.invoiceId !== 'null';
            const statusHtml = billed
                ? `<span style="color:#4CAF50; font-size:0.7rem;">✅ Facturado</span>`
                : `<span style="color:#FF9800; font-size:0.7rem;">⏳ Pendiente</span>`;
            const typeColor = t.shippingType === 'Debidos' ? '#E040FB' : '#2196F3';
            const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages || 1);

            // Find client name
            const clientName = t.senderName || t.sender || '';
            const clientId = t.uid || '';

            html += `
            <tr style="border-bottom:1px solid #2d2d30;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                <td style="padding:6px; text-align:center;">${!billed ? `<input type="checkbox" class="alb-chk" data-docid="${t.docId}" data-clientid="${clientId}" style="scale:1.1;">` : ''}</td>
                <td style="padding:6px; color:#ccc;">${date}</td>
                <td style="padding:6px; color:#FFD700; font-weight:bold;">${t.id || t.docId || '-'}</td>
                <td style="padding:6px; color:#64B5F6; cursor:pointer;" onclick="if(typeof openFichaCliente==='function' && '${clientId}') openFichaCliente('${clientId}')" title="Abrir ficha">
                    <span style="border-bottom:1px dotted #64B5F6;">[#${t.clientIdNum || '?'}] ${clientName.substring(0, 30)}</span>
                </td>
                <td style="padding:6px; color:#fff;">${(t.receiver || t.receiverName || '-').substring(0, 35)}</td>
                <td style="padding:6px; color:#888;">${t.city || t.receiverCity || '-'}</td>
                <td style="padding:6px; text-align:center; color:#ccc;">${pkgs}</td>
                <td style="padding:6px; text-align:center; color:#ccc;">${t.weight || t.kilos || '-'}</td>
                <td style="padding:6px; text-align:center; color:${typeColor}; font-size:0.7rem; font-weight:bold;">${t.shippingType || 'Pagados'}</td>
                <td style="padding:6px; text-align:center;">${statusHtml}</td>
                <td style="padding:6px; text-align:center; white-space:nowrap;">
                    <button type="button" onclick="window._albViewTicket('${t.docId}')" style="background:#333; border:1px solid #555; color:#ccc; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Ver detalle">👁️</button>
                    <button type="button" onclick="window._albEditTicket('${t.docId}', '${clientId}')" style="background:#333; border:1px solid #FF9800; color:#FF9800; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Editar">✏️</button>
                    <button type="button" onclick="if(typeof printTicketFromAdmin==='function') printTicketFromAdmin('${clientId}','${t.compId || 'comp_main'}','${t.docId}')" style="background:#333; border:1px solid #4CAF50; color:#4CAF50; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Imprimir albaran">🖨️</button>
                    <button type="button" onclick="window._albReassignTicket('${t.docId}')" style="background:#333; border:1px solid #2196F3; color:#2196F3; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Reasignar cliente">🔄</button>
                    ${!billed ? `<button type="button" onclick="window._albDeleteTicket('${t.docId}','${(t.id || t.docId || '').replace(/'/g, '')}')" style="background:#333; border:1px solid #FF3B30; color:#FF3B30; padding:2px 6px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Eliminar albaran">🗑️</button>` : ''}
                </td>
            </tr>`;
        });

        html += '</tbody></table>';
        area.innerHTML = html;
    }

    // ============================================================
    //  PAGINATION
    // ============================================================
    window._albPrevPage = function() {
        if (_albPage > 0) { _albPage--; _albRenderTable(); }
    };
    window._albNextPage = function() {
        if ((_albPage + 1) * PAGE_SIZE < _albFiltered.length) { _albPage++; _albRenderTable(); }
    };

    // ============================================================
    //  BATCH INVOICE
    // ============================================================
    window._albFacturarSeleccionados = function() {
        const checks = document.querySelectorAll('.alb-chk:checked');
        if (checks.length === 0) {
            alert('Selecciona al menos un albarán pendiente.');
            return;
        }

        // Group by client
        const byClient = {};
        checks.forEach(chk => {
            const cid = chk.getAttribute('data-clientid');
            if (!byClient[cid]) byClient[cid] = [];
            byClient[cid].push(chk.getAttribute('data-docid'));
        });

        const clientCount = Object.keys(byClient).length;
        if (clientCount > 1) {
            alert(`Has seleccionado albaranes de ${clientCount} clientes distintos.\nPara facturar en lote, selecciona albaranes de un solo cliente.`);
            return;
        }

        const clientId = Object.keys(byClient)[0];
        if (!clientId) { alert('No se pudo identificar el cliente.'); return; }

        // Open billing tab
        if (typeof window.erpOpenTab === 'function') window.erpOpenTab('factura');

        setTimeout(() => {
            if (typeof window.advLoadClientDetails === 'function') {
                window.advLoadClientDetails(clientId);
            }
        }, 500);

        alert(`Se han seleccionado ${checks.length} albaranes. Se abre Facturación con el cliente.`);
    };

    // ============================================================
    //  VIEW TICKET DETAIL
    // ============================================================
    window._albViewTicket = function(docId) {
        if (typeof window.openTicketPreviewModal === 'function') {
            window.openTicketPreviewModal(docId, 'view');
        } else if (typeof window.openTicketEditModal === 'function') {
            window.openTicketEditModal(docId);
        } else {
            alert('Función de detalle no disponible.');
        }
    };

    // ============================================================
    //  EDIT TICKET
    // ============================================================
    window._albEditTicket = function(docId, clientId) {
        if (typeof window.openTicketEditModal === 'function') {
            window.openTicketEditModal(docId);
        } else {
            alert('Función de edición no disponible.');
        }
    };

    // ============================================================
    //  EXPORT CSV
    // ============================================================
    window._albExportCSV = function() {
        if (_albFiltered.length === 0) { alert('No hay datos para exportar.'); return; }

        const headers = ['Fecha', 'Nº Albarán', 'Cliente Nº', 'Cliente', 'Destinatario', 'Ciudad', 'Bultos', 'Kg', 'Tipo', 'Estado'];
        let csv = headers.join(';') + '\n';

        _albFiltered.forEach(t => {
            const date = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleDateString('es-ES') : '';
            const billed = t.invoiceId && t.invoiceId !== '' ? 'Facturado' : 'Pendiente';
            const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages || 1);
            const row = [
                date,
                t.id || t.docId || '',
                t.clientIdNum || '',
                (t.senderName || t.sender || '').replace(/;/g, ','),
                (t.receiver || t.receiverName || '').replace(/;/g, ','),
                (t.city || t.receiverCity || '').replace(/;/g, ','),
                pkgs,
                t.weight || t.kilos || '',
                t.shippingType || 'Pagados',
                billed
            ];
            csv += row.join(';') + '\n';
        });

        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `albaranes_${_albDateFrom}_${_albDateTo}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // ============================================================
    //  POD — Justificantes de Entrega (integrated sub-tab)
    // ============================================================
    let _podData = null;

    function _albRenderPOD() {
        const area = document.getElementById('alb-table-area');
        const pagination = document.getElementById('alb-pagination');
        if (!area) return;
        if (pagination) pagination.style.display = 'none';

        area.innerHTML = `
        <div style="padding:24px; max-width:900px; margin:0 auto;">
            <div style="background:#252526; border:1px solid #3c3c3c; border-radius:8px; padding:20px; margin-bottom:20px;">
                <h3 style="color:#4CAF50; margin:0 0 12px 0; font-size:0.95rem; display:flex; align-items:center; gap:6px;">
                    <span class="material-symbols-outlined" style="font-size:1.1rem;">task</span> Buscador de Justificantes POD
                </h3>
                <div style="display:flex; gap:10px; align-items:flex-end;">
                    <div style="flex:1;">
                        <label style="font-size:0.7rem; color:#888; display:block; margin-bottom:4px;">ID de Albarán / Ticket</label>
                        <input type="text" id="pod-search-input-alb" placeholder="Ej: NP12345" autocomplete="off"
                            onkeypress="if(event.key==='Enter') window._albSearchPOD()"
                            style="width:100%; background:#1e1e1e; border:1px solid #555; color:#fff; padding:8px 12px; border-radius:5px; font-size:0.85rem; box-sizing:border-box;">
                    </div>
                    <button type="button" onclick="window._albSearchPOD()" style="background:#4CAF50; border:none; color:#fff; padding:8px 20px; border-radius:5px; cursor:pointer; font-weight:bold; font-size:0.85rem; display:flex; align-items:center; gap:5px; height:38px;">
                        <span class="material-symbols-outlined" style="font-size:1rem;">search</span> BUSCAR
                    </button>
                </div>
            </div>

            <div id="pod-alb-loading" style="display:none; text-align:center; padding:40px; color:#4CAF50;">
                <span class="material-symbols-outlined" style="font-size:2.5rem; animation:spin 1.5s linear infinite;">autorenew</span>
                <div style="margin-top:8px; font-weight:bold; font-size:0.85rem;">Buscando en servidor...</div>
            </div>

            <div id="pod-alb-not-found" style="display:none; text-align:center; padding:40px; color:#FF5252; font-weight:bold; font-size:0.9rem;">
                <span class="material-symbols-outlined" style="font-size:2.5rem; display:block; margin-bottom:8px;">search_off</span>
                No se ha encontrado el albarán o no tiene justificante de entrega.
            </div>

            <div id="pod-alb-result" style="display:none;">
                <div style="background:#111; border:1px solid #333; border-radius:8px; padding:20px; box-shadow:0 4px 16px rgba(0,0,0,0.5);">
                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px dashed #333; padding-bottom:12px; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
                        <h3 style="margin:0; font-size:1.1rem; font-weight:bold; color:#fff;">JUSTIFICANTE <span id="pod-alb-id" style="color:#4CAF50;"></span></h3>
                        <span id="pod-alb-status" style="font-size:0.75rem; padding:3px 10px; border-radius:10px;"></span>
                    </div>

                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:20px;">
                        <!-- Datos del envío -->
                        <div style="background:rgba(255,255,255,0.02); padding:16px; border-radius:8px; border:1px solid #2d2d30;">
                            <h4 style="color:#888; font-size:0.7rem; text-transform:uppercase; margin:0 0 12px 0; letter-spacing:1px;">
                                <span class="material-symbols-outlined" style="font-size:0.9rem; vertical-align:middle;">local_shipping</span> Detalles del Envío
                            </h4>
                            <div style="display:flex; flex-direction:column; gap:8px; font-size:0.85rem;">
                                <div><strong style="color:#4CAF50;">Destinatario:</strong> <span id="pod-alb-receiver" style="color:#fff; font-weight:bold;"></span></div>
                                <div><strong style="color:#888;">Dirección:</strong> <span id="pod-alb-address" style="color:#ccc;"></span></div>
                                <div><strong style="color:#888;">Fecha Emisión:</strong> <span id="pod-alb-date" style="color:#ccc;"></span></div>
                                <div><strong style="color:#888;">Bultos:</strong> <span id="pod-alb-pkgs" style="color:#ccc;"></span></div>
                                <div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.05);">
                                    <strong style="color:#4CAF50; display:block; margin-bottom:4px; font-size:0.75rem;">INFORMACIÓN DE ENTREGA:</strong>
                                    <div style="color:#fff;"><strong style="color:#888;">Entregado a:</strong> <span id="pod-alb-delivery-name" style="font-weight:bold;"></span></div>
                                    <div style="color:#fff;"><strong style="color:#888;">Fecha/Hora:</strong> <span id="pod-alb-delivery-time"></span></div>
                                    <div style="color:#888; font-size:0.75rem; margin-top:4px; display:flex; gap:4px; align-items:center;">
                                        <span class="material-symbols-outlined" style="font-size:0.9rem;">location_on</span>
                                        <span id="pod-alb-gps"></span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Evidencias -->
                        <div style="display:flex; flex-direction:column; gap:12px;">
                            <div style="background:rgba(255,255,255,0.02); border:1px solid #2d2d30; border-radius:8px; padding:14px; text-align:center;">
                                <h4 style="color:#888; font-size:0.7rem; text-transform:uppercase; margin:0 0 8px 0; letter-spacing:1px; text-align:left;">
                                    <span class="material-symbols-outlined" style="font-size:0.9rem; vertical-align:middle;">draw</span> Firma
                                </h4>
                                <div id="pod-alb-sig-box" style="height:120px; display:flex; align-items:center; justify-content:center; background:#fff; border-radius:6px;">
                                    <img id="pod-alb-sig-img" src="" style="max-width:100%; max-height:100%; display:none;">
                                    <span id="pod-alb-sig-empty" style="color:#888; font-style:italic; font-size:0.8rem;">No se adjuntó firma</span>
                                </div>
                            </div>
                            <div style="background:rgba(255,255,255,0.02); border:1px solid #2d2d30; border-radius:8px; padding:14px; text-align:center;">
                                <h4 style="color:#888; font-size:0.7rem; text-transform:uppercase; margin:0 0 8px 0; letter-spacing:1px; text-align:left;">
                                    <span class="material-symbols-outlined" style="font-size:0.9rem; vertical-align:middle;">photo_camera</span> Fotografía
                                </h4>
                                <div id="pod-alb-photo-box" style="height:160px; display:flex; align-items:center; justify-content:center; background:#000; border-radius:6px; overflow:hidden;">
                                    <img id="pod-alb-photo-img" src="" style="max-width:100%; max-height:100%; display:none; object-fit:contain; cursor:pointer;" onclick="window.open(this.src)">
                                    <span id="pod-alb-photo-empty" style="color:#555; font-style:italic; font-size:0.8rem;">No se adjuntó fotografía</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Botones -->
                    <div style="margin-top:16px; display:flex; justify-content:flex-end; gap:10px; border-top:1px solid #333; padding-top:14px; flex-wrap:wrap;">
                        <button type="button" onclick="window._albEmailPOD()" style="background:transparent; border:1px solid #2196F3; color:#2196F3; padding:6px 16px; border-radius:5px; cursor:pointer; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                            <span class="material-symbols-outlined" style="font-size:0.9rem;">mail</span> ENVIAR POR EMAIL
                        </button>
                        <button type="button" onclick="window._albPrintPOD()" style="background:transparent; border:1px solid #ccc; color:#ccc; padding:6px 16px; border-radius:5px; cursor:pointer; font-size:0.8rem; display:flex; align-items:center; gap:4px;">
                            <span class="material-symbols-outlined" style="font-size:0.9rem;">print</span> IMPRIMIR
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
    }

    // --- POD Search ---
    window._albSearchPOD = async function() {
        var input = document.getElementById('pod-search-input-alb');
        if (!input) return;
        var val = input.value.trim();
        if (!val) { alert('Introduce un ID de albarán para buscar.'); return; }

        document.getElementById('pod-alb-result').style.display = 'none';
        document.getElementById('pod-alb-not-found').style.display = 'none';
        document.getElementById('pod-alb-loading').style.display = 'block';

        try {
            var querySnap = await db.collection('tickets').where('id', '==', val).get();
            var targetDoc = null;
            if (!querySnap.empty) {
                targetDoc = querySnap.docs[0];
            } else {
                var docGet = await db.collection('tickets').doc(val).get();
                if (docGet.exists) targetDoc = docGet;
            }

            if (!targetDoc) {
                document.getElementById('pod-alb-loading').style.display = 'none';
                document.getElementById('pod-alb-not-found').style.display = 'block';
                return;
            }

            var data = targetDoc.data();
            _podData = data;

            document.getElementById('pod-alb-id').textContent = data.id || targetDoc.id;

            var statusEl = document.getElementById('pod-alb-status');
            if (data.status === 'Entregado' || data.delivered) {
                statusEl.style.background = 'rgba(76,175,80,0.2)';
                statusEl.style.color = '#4CAF50';
                statusEl.textContent = '✅ ENTREGADO';
            } else {
                statusEl.style.background = 'rgba(255,152,0,0.2)';
                statusEl.style.color = '#FF9800';
                statusEl.textContent = '⚠️ ' + (data.status ? data.status.toUpperCase() : 'PENDIENTE');
            }

            document.getElementById('pod-alb-receiver').textContent = (data.receiver || 'S/N').toUpperCase();
            document.getElementById('pod-alb-address').textContent = data.address || '';

            var dDate = data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toLocaleDateString() : new Date(data.createdAt).toLocaleDateString()) : 'N/A';
            document.getElementById('pod-alb-date').textContent = dDate;

            var pkgs = data.packagesList ? data.packagesList.reduce(function(acc, p) { return acc + (parseInt(p.qty) || 1); }, 0) : (data.packages || 1);
            document.getElementById('pod-alb-pkgs').textContent = pkgs + ' Bulto(s)';

            document.getElementById('pod-alb-delivery-name').textContent = (data.deliveryReceiverName || 'Información no disponible').toUpperCase();

            var dTime = data.deliveredAt ? (data.deliveredAt.toDate ? data.deliveredAt.toDate().toLocaleString() : new Date(data.deliveredAt).toLocaleString()) : 'N/A';
            document.getElementById('pod-alb-delivery-time').textContent = dTime;

            if (data.deliveryGPS) {
                document.getElementById('pod-alb-gps').textContent = data.deliveryGPS.latitude + ', ' + data.deliveryGPS.longitude;
            } else {
                document.getElementById('pod-alb-gps').textContent = 'GPS no registrado';
            }

            var sigImg = document.getElementById('pod-alb-sig-img');
            var sigEmpty = document.getElementById('pod-alb-sig-empty');
            if (data.signatureURL) {
                if (data.podCleaned) {
                    sigEmpty.style.display = 'block';
                    sigEmpty.innerHTML = '<span style="color:#FF9800;">Firma eliminada (Política > 6 meses)</span>';
                    sigImg.style.display = 'none';
                } else {
                    sigImg.src = data.signatureURL;
                    sigImg.style.display = 'block';
                    sigEmpty.style.display = 'none';
                }
            } else {
                sigImg.style.display = 'none';
                sigEmpty.style.display = 'block';
            }

            var photoImg = document.getElementById('pod-alb-photo-img');
            var photoEmpty = document.getElementById('pod-alb-photo-empty');
            if (data.photoURL) {
                if (data.podCleaned) {
                    photoEmpty.style.display = 'block';
                    photoEmpty.innerHTML = '<span style="color:#FF9800;">Foto eliminada (Política > 6 meses)</span>';
                    photoImg.style.display = 'none';
                } else {
                    photoImg.src = data.photoURL;
                    photoImg.style.display = 'block';
                    photoEmpty.style.display = 'none';
                }
            } else {
                photoImg.style.display = 'none';
                photoEmpty.style.display = 'block';
            }

            document.getElementById('pod-alb-loading').style.display = 'none';
            document.getElementById('pod-alb-result').style.display = 'block';
        } catch (err) {
            console.error('Error buscando POD:', err);
            document.getElementById('pod-alb-loading').style.display = 'none';
            alert('Error técnico al buscar: ' + err.message);
        }
    };

    // --- POD Print ---
    window._albPrintPOD = function() {
        var _eh = (typeof escapeHtml === 'function')
            ? escapeHtml
            : function(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); };
        var _safeUrl = function(u) { return (typeof u === 'string' && /^(https?:|data:|blob:)/i.test(u)) ? u : ''; };
        var _txt = function(elId) { var el = document.getElementById(elId); return _eh(el ? el.textContent : ''); };

        var id = _txt('pod-alb-id');
        var w = window.open('', 'PRINT', 'height=800,width=600');
        w.document.write('<html><head><title>Justificante POD - ' + id + '</title>');
        w.document.write('<style>body{font-family:sans-serif;color:#333;} .box{border:1px solid #ddd;padding:15px;margin-bottom:15px;border-radius:5px;} img{max-width:100%;}</style>');
        w.document.write('</head><body>');
        w.document.write('<h2 style="text-align:center;border-bottom:2px solid;padding-bottom:10px;">CERTIFICADO DE ENTREGA</h2>');
        w.document.write('<h3>ALBARÁN: ' + id + '</h3>');
        w.document.write('<div class="box">');
        w.document.write('<p><strong>Destinatario:</strong> ' + _txt('pod-alb-receiver') + '</p>');
        w.document.write('<p><strong>Dirección:</strong> ' + _txt('pod-alb-address') + '</p>');
        w.document.write('<p><strong>Bultos:</strong> ' + _txt('pod-alb-pkgs') + '</p>');
        w.document.write('</div>');
        w.document.write('<div class="box" style="background:#f9f9f9;">');
        w.document.write('<h4>DATOS DE LA RECEPCIÓN</h4>');
        w.document.write('<p><strong>Entregado a:</strong> ' + _txt('pod-alb-delivery-name') + '</p>');
        w.document.write('<p><strong>Fecha/Hora:</strong> ' + _txt('pod-alb-delivery-time') + '</p>');
        w.document.write('<p><strong>GPS:</strong> ' + _txt('pod-alb-gps') + '</p>');
        w.document.write('</div>');
        var sigImg = document.getElementById('pod-alb-sig-img');
        if (sigImg && sigImg.style.display !== 'none') {
            var sigUrl = _safeUrl(sigImg.src);
            if (sigUrl) w.document.write('<div class="box"><h4>FIRMA:</h4><img src="' + _eh(sigUrl) + '" style="max-height:150px;background:#fff;"></div>');
        }
        var photoImg = document.getElementById('pod-alb-photo-img');
        if (photoImg && photoImg.style.display !== 'none') {
            var photUrl = _safeUrl(photoImg.src);
            if (photUrl) w.document.write('<div class="box"><h4>FOTOGRAFÍA:</h4><img src="' + _eh(photUrl) + '" style="max-height:300px;"></div>');
        }
        w.document.write('<script>window.onload=function(){setTimeout(function(){window.print();},200);}<\/script>');
        w.document.write('</body></html>');
        w.document.close();
        w.focus();
    };

    // --- POD Email ---
    window._albEmailPOD = function() {
        var id = document.getElementById('pod-alb-id').textContent;
        var data = _podData || {};
        var defaultEmail = '';
        if (data.sender) {
            var c = Object.values(window.userMap || {}).find(function(u) {
                return u.name === data.sender || u.id === data.sender || String(u.idNum) === String(data.sender);
            });
            if (c && c.email) defaultEmail = c.email;
        }
        if (!defaultEmail && data.receiverEmail) defaultEmail = data.receiverEmail;

        var email = prompt('Email del destinatario para enviar el POD:', defaultEmail);
        if (!email || !email.trim()) return;

        var subject = encodeURIComponent('Justificante de Entrega (POD) — Albarán ' + id + ' — NOVAPACK');
        var body = '══════════════════════════════════════\n';
        body += '   CERTIFICADO DE ENTREGA — NOVAPACK\n';
        body += '══════════════════════════════════════\n\n';
        body += 'ALBARÁN: ' + id + '\n\n';
        body += '── DATOS DEL ENVÍO ──\n';
        body += 'Destinatario: ' + document.getElementById('pod-alb-receiver').textContent + '\n';
        body += 'Dirección: ' + document.getElementById('pod-alb-address').textContent + '\n';
        body += 'Bultos: ' + document.getElementById('pod-alb-pkgs').textContent + '\n\n';
        body += '── DATOS DE LA RECEPCIÓN ──\n';
        body += 'Entregado a: ' + document.getElementById('pod-alb-delivery-name').textContent + '\n';
        if (data.deliveryReceiverDNI) body += 'DNI Receptor: ' + data.deliveryReceiverDNI + '\n';
        body += 'Fecha/Hora: ' + document.getElementById('pod-alb-delivery-time').textContent + '\n';
        body += 'GPS: ' + document.getElementById('pod-alb-gps').textContent + '\n\n';
        body += '── EVIDENCIAS ──\n';
        if (data.signatureURL && !data.podCleaned) {
            body += 'Firma digital: ' + data.signatureURL + '\n';
        } else {
            body += 'Firma digital: No disponible\n';
        }
        if (data.photoURL && !data.podCleaned) {
            body += 'Fotografía: ' + data.photoURL + '\n';
        } else {
            body += 'Fotografía: No disponible\n';
        }
        body += '\n══════════════════════════════════════\n';
        body += 'Generado por NOVAPACK CLOUD — ' + new Date().toLocaleString() + '\n';

        window.open('mailto:' + encodeURIComponent(email.trim()) + '?subject=' + subject + '&body=' + encodeURIComponent(body));
    };

    // ============================================================
    //  DELETE TICKET (move to trash)
    // ============================================================
    window._albDeleteTicket = async function(docId, ticketId) {
        if (!confirm('Eliminar albaran ' + (ticketId || docId) + '?\n\nSe movera a la papelera y podra restaurarse.')) return;
        try {
            if (typeof window.moveTicketToTrash === 'function') {
                await window.moveTicketToTrash(docId, 'Eliminado desde albaranes centralizados', 'albaranes_central');
            } else {
                await db.collection('tickets').doc(docId).delete();
            }
            // Remove from local arrays and re-render
            _albCache = _albCache.filter(t => t.docId !== docId);
            _albApplyFiltersInternal();
            alert('Albaran eliminado correctamente.');
        } catch(err) {
            alert('Error al eliminar: ' + err.message);
        }
    };

    // ============================================================
    //  REASSIGN TICKET (change billing client)
    // ============================================================
    window._albReassignTicket = async function(docId) {
        // Load ticket data
        var ticketSnap;
        try {
            ticketSnap = await db.collection('tickets').doc(docId).get();
        } catch(err) {
            alert('Error cargando albaran: ' + err.message);
            return;
        }
        if (!ticketSnap.exists) { alert('Albaran no encontrado.'); return; }
        var ticketData = ticketSnap.data();

        // Check if billed
        if (ticketData.invoiceId) {
            alert('Este albaran ya esta facturado. No se puede reasignar.');
            return;
        }

        // Build client list from userMap
        var umap = window.userMap || {};
        var clients = [];
        Object.keys(umap).forEach(function(uid) {
            var u = umap[uid];
            if (u && u.role === 'client') {
                clients.push({ uid: uid, name: u.name || u.company || u.email || uid, idNum: u.idNum || '' });
            }
        });
        clients.sort(function(a, b) { return a.name.localeCompare(b.name); });

        if (clients.length === 0) {
            alert('No se encontraron clientes en el sistema.');
            return;
        }

        // Show reassign modal
        var existing = document.getElementById('alb-reassign-modal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'alb-reassign-modal';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:99998; display:flex; align-items:center; justify-content:center;';

        var currentClient = ticketData.senderName || ticketData.sender || 'Desconocido';
        var ticketLabel = ticketData.id || docId;

        var optionsHtml = '<option value="">-- Seleccionar cliente --</option>';
        clients.forEach(function(c) {
            optionsHtml += '<option value="' + c.uid + '">[' + (c.idNum || '?') + '] ' + c.name.substring(0, 50) + '</option>';
        });

        modal.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #3c3c3c; border-radius:12px; padding:30px; max-width:500px; width:90%; box-shadow:0 15px 50px rgba(0,0,0,0.8);">
            <h3 style="color:#2196F3; margin:0 0 6px; font-size:1.1rem; display:flex; align-items:center; gap:8px;">
                <span class="material-symbols-outlined">swap_horiz</span> Reasignar Albaran
            </h3>
            <p style="color:#888; margin:0 0 20px; font-size:0.82rem;">Albaran <strong style="color:#FFD700;">${ticketLabel}</strong></p>
            <div style="margin-bottom:16px;">
                <label style="color:#aaa; font-size:0.78rem; display:block; margin-bottom:4px;">Cliente actual:</label>
                <div style="background:#2a2a2d; border:1px solid #444; border-radius:6px; padding:8px 12px; color:#FF9800; font-weight:bold; font-size:0.85rem;">${currentClient}</div>
            </div>
            <div style="margin-bottom:20px;">
                <label style="color:#aaa; font-size:0.78rem; display:block; margin-bottom:4px;">Nuevo cliente:</label>
                <input type="text" id="alb-reassign-search" placeholder="Buscar cliente..." style="width:100%; background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:8px 12px; border-radius:6px; font-size:0.85rem; margin-bottom:6px; box-sizing:border-box;">
                <select id="alb-reassign-select" size="6" style="width:100%; background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:4px; border-radius:6px; font-size:0.82rem; box-sizing:border-box;">
                    ${optionsHtml}
                </select>
            </div>
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button id="alb-reassign-cancel" style="background:transparent; border:1px solid #555; color:#888; padding:8px 20px; font-size:0.82rem; cursor:pointer; border-radius:6px;">Cancelar</button>
                <button id="alb-reassign-confirm" style="background:linear-gradient(135deg,#2196F3,#1565C0); border:none; color:white; padding:8px 20px; font-size:0.82rem; cursor:pointer; border-radius:6px; font-weight:bold;">Reasignar</button>
            </div>
        </div>`;

        document.body.appendChild(modal);

        // Search filter
        var searchInput = document.getElementById('alb-reassign-search');
        var selectEl = document.getElementById('alb-reassign-select');
        var _albReassignTimer;
        searchInput.addEventListener('input', function() {
            var self = this;
            clearTimeout(_albReassignTimer);
            _albReassignTimer = setTimeout(function() {
                var q = self.value.trim().toLowerCase();
                var opts = selectEl.options;
                for (var i = 0; i < opts.length; i++) {
                    if (i === 0) continue; // skip placeholder
                    opts[i].style.display = opts[i].textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
                }
            }, 300);
        });
        searchInput.focus();

        // Cancel
        document.getElementById('alb-reassign-cancel').addEventListener('click', function() {
            modal.remove();
        });
        modal.addEventListener('click', function(e) {
            if (e.target === modal) modal.remove();
        });

        // Confirm
        document.getElementById('alb-reassign-confirm').addEventListener('click', async function() {
            var newUid = selectEl.value;
            if (!newUid) { alert('Selecciona un cliente.'); return; }

            var newClient = clients.find(function(c) { return c.uid === newUid; });
            if (!newClient) { alert('Cliente no encontrado.'); return; }

            if (!confirm('Reasignar albaran ' + ticketLabel + ' de "' + currentClient + '" a "' + newClient.name + '"?')) return;

            try {
                await db.collection('tickets').doc(docId).update({
                    uid: newUid,
                    sender: newClient.name,
                    senderName: newClient.name,
                    clientIdNum: newClient.idNum || '',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                // Update local data
                var local = _albCache.find(function(t) { return t.docId === docId; });
                if (local) {
                    local.uid = newUid;
                    local.sender = newClient.name;
                    local.senderName = newClient.name;
                    local.clientIdNum = newClient.idNum || '';
                }

                modal.remove();
                _albApplyFiltersInternal();
                alert('Albaran reasignado a ' + newClient.name + '.');
            } catch(err) {
                alert('Error al reasignar: ' + err.message);
            }
        });
    };

})();
