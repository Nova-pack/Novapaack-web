/**
 * NOVAPACK CLOUD — Importador FIJOS-2026
 * ============================================================
 * Lee public/fijos_2026.json y aplica las tarifas especiales del
 * documento manual FIJOS-2026.docx a los clientes del sistema.
 *
 * Estrategia de aplicación:
 *   - Flat rate (PTE)            → users/{uid}.isFlatRate = true
 *                                  users/{uid}.flatRateAmount = N
 *   - Per-package custom rates   → users/{uid}.customRates = { paquete, bulto, bateria, ... }
 *   - Notes humanas              → users/{uid}.tariffNote = "..." (visible en ficha)
 *   - Auditoría                  → users/{uid}.tariffImportedFrom = 'FIJOS-2026'
 *                                  users/{uid}.tariffImportedAt   = serverTimestamp
 *
 * UI: modal en admin con tabla previa, indicador de match, log final.
 *
 * Activación: window.openFijos2026Importer()
 */
(function() {
    'use strict';
    if (typeof db === 'undefined') {
        console.warn('[FIJOS-2026] db not ready, deferring');
        return;
    }

    let _fijosData = null;
    let _matchCache = null;

    async function _loadJson() {
        if (_fijosData) return _fijosData;
        const resp = await fetch('fijos_2026.json?v=' + Date.now());
        if (!resp.ok) throw new Error('No se pudo cargar fijos_2026.json');
        _fijosData = await resp.json();
        return _fijosData;
    }

    function _esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _money(n) {
        return (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
    }

    /** Normaliza un nombre para comparar: quita tildes, paréntesis, sufijos S.L./S.A. */
    function _normName(s) {
        return String(s || '')
            .normalize('NFD').replace(/[̀-ͯ]/g, '')      // quita tildes
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')                              // quita paréntesis
            .replace(/-+/g, ' ')                                     // guiones a espacios
            .replace(/\b(s\.?l\.?u?\.?|s\.?a\.?|sl|sa|slu|c\.?b\.?)\b/g, ' ') // sufijos jurídicos
            .replace(/[^a-z0-9 ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** Busca cliente por idNum dentro de userMap (in-memory) */
    function _findClient(idNum) {
        if (!window.userMap) return null;
        const target = String(idNum).trim();
        for (const [uid, u] of Object.entries(window.userMap)) {
            const candidate = String(u.idNum || '').trim();
            if (candidate === target || candidate === String(parseInt(target))) {
                return { uid, data: u, matchedBy: 'idNum' };
            }
        }
        return null;
    }

    /** Fallback: busca cliente por nombre normalizado (substring tras normalizar) */
    function _findClientByName(searchName) {
        if (!window.userMap || !searchName) return null;
        const target = _normName(searchName);
        if (!target) return null;
        const targetTokens = target.split(' ').filter(t => t.length >= 3);
        const candidates = [];
        for (const [uid, u] of Object.entries(window.userMap)) {
            const candidate = _normName(u.name);
            if (!candidate) continue;
            if (candidate === target) {
                candidates.push({ uid, data: u, score: 100 });
                continue;
            }
            if (candidate.includes(target) || target.includes(candidate)) {
                candidates.push({ uid, data: u, score: 80 });
                continue;
            }
            // Match por tokens significativos
            const hits = targetTokens.filter(t => candidate.includes(t)).length;
            if (hits >= 2 || (hits === 1 && targetTokens.length === 1)) {
                candidates.push({ uid, data: u, score: 30 + 10 * hits });
            }
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        return { uid: best.uid, data: best.data, matchedBy: 'name', score: best.score };
    }

    /** Resuelve cada entry → lista de matches { entry, idNum, match: {uid,data,matchedBy} | null } */
    function _matchAll(entries) {
        const rows = [];
        entries.forEach(entry => {
            entry.idNums.forEach(idNum => {
                // 1) Match por idNum
                let m = _findClient(idNum);
                // 2) Fallback: por nombre
                if (!m && entry.name) {
                    m = _findClientByName(entry.name);
                }
                rows.push({ entry, idNum, match: m });
            });
        });
        return rows;
    }

    /** Re-vincula manualmente una fila a un cliente por uid */
    window._fijosManualLink = function(rowIdx, uid) {
        if (!_matchCache || !window.userMap || !window.userMap[uid]) return;
        _matchCache[rowIdx].match = { uid, data: window.userMap[uid], matchedBy: 'manual' };
        _renderPreview();
    };

    /** Busca clientes por texto libre (para el dropdown de vinculación manual) */
    window._fijosSearchClients = function(rowIdx, query) {
        const out = document.getElementById('fijos-search-results-' + rowIdx);
        if (!out) return;
        const q = _normName(query);
        if (!q || q.length < 2) { out.innerHTML = ''; return; }
        const results = [];
        for (const [uid, u] of Object.entries(window.userMap || {})) {
            const candidate = _normName(u.name);
            if (candidate.includes(q) || q.includes(candidate)) {
                results.push({ uid, data: u });
                if (results.length >= 10) break;
            }
        }
        if (!results.length) {
            out.innerHTML = '<div style="padding:6px; color:#888; font-size:0.7rem;">Sin resultados</div>';
            return;
        }
        out.innerHTML = results.map(r =>
            '<div onclick="window._fijosManualLink(' + rowIdx + ', \'' + _esc(r.uid) + '\')" style="padding:5px 8px; cursor:pointer; border-bottom:1px solid #2a2a2a; font-size:0.72rem;" onmouseover="this.style.background=\'#1e3a5f\'" onmouseout="this.style.background=\'transparent\'">' +
                '<b style="color:#FFD700;">#' + _esc(r.data.idNum || '?') + '</b> · ' + _esc(r.data.name || '—') +
                '<div style="color:#888; font-size:0.65rem;">NIF ' + _esc(r.data.nif || '—') + ' · ' + _esc(r.data.localidad || '—') + '</div>' +
            '</div>'
        ).join('');
    };

    /** Texto humano corto de qué se aplicará */
    function _describeApply(entry) {
        const parts = [];
        if (entry.kind === 'flat' || entry.kind === 'flat_plus_extras' || entry.kind === 'flat_plus_routes') {
            if (entry.flatAmount) parts.push('Tarifa plana: <b>' + _money(entry.flatAmount) + '/mes</b>');
        }
        if (entry.rates) {
            const r = entry.rates;
            const cells = [];
            Object.entries(r).forEach(([k, v]) => {
                if (typeof v === 'number') cells.push(k + ': ' + _money(v));
                else cells.push(k + ': ' + _esc(String(v)));
            });
            if (cells.length) parts.push('Por bulto: ' + cells.join(' · '));
        }
        if (entry.extras) {
            const ex = Object.entries(entry.extras).map(([k, v]) => k + ': ' + (typeof v === 'number' ? _money(v) : v)).join(' · ');
            parts.push('Extras: ' + ex);
        }
        if (entry.kind === 'normal') parts.push('Tarifa normal');
        if (entry.kind === 'normal_with_suffix') parts.push('Tarifa normal + sufijo albarán: ' + entry.albaranSuffix.join(', '));
        if (entry.kind === 'normal_plus_special') {
            const ex = Object.entries(entry.specials).map(([k, v]) => k + ': ' + _money(v)).join(' · ');
            parts.push('Tarifa normal + especiales: ' + ex);
        }
        if (entry.preferredInvoiceFormat === 'per_branch') {
            parts.push('<span style="color:#5DADE2; font-weight:700;">⭐ Facturar SIEMPRE POR SUCURSAL (F2)</span>');
        } else if (entry.preferredInvoiceFormat === 'consolidated') {
            parts.push('<span style="color:#FF6600; font-weight:700;">⭐ Facturar SIEMPRE CONSOLIDADO (F1)</span>');
        }
        return parts.join(' · ') || '—';
    }

    /** Construye el update payload para Firestore según el tipo de entry */
    function _buildPayload(entry) {
        const p = {
            tariffNote: entry.note || '',
            tariffImportedFrom: 'FIJOS-2026',
            tariffImportedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        // Flat rate
        if (entry.flatAmount && (entry.kind === 'flat' || entry.kind === 'flat_plus_extras' || entry.kind === 'flat_plus_routes')) {
            p.isFlatRate = true;
            p.flatRateAmount = Number(entry.flatAmount);
        }
        // Custom rates (per-package)
        if (entry.rates && Object.keys(entry.rates).length) {
            p.customRates = entry.rates;
        }
        // Extras (si los hay, se guardan también)
        if (entry.extras) {
            p.customExtras = entry.extras;
        }
        // Routes
        if (entry.routes) {
            p.customRoutes = entry.routes;
        }
        // Specials
        if (entry.specials) {
            p.customSpecials = entry.specials;
        }
        // No PA
        if (entry.noPaymentDue) {
            p.noPaymentDue = true;
        }
        // Sufijo albaranes
        if (entry.albaranSuffix) {
            p.albaranSuffix = entry.albaranSuffix;
        }
        // Validez temporal
        if (entry.validUntil) {
            p.tariffValidUntil = entry.validUntil;
        }
        // Estados manuales
        if (entry.status) {
            p.tariffStatus = entry.status;
        }
        // Formato preferido de factura (consolidated | per_branch)
        if (entry.preferredInvoiceFormat) {
            p.preferredInvoiceFormat = entry.preferredInvoiceFormat;
        }
        return p;
    }

    /** Render preview en el modal */
    function _renderPreview() {
        const matches = _matchCache;
        const container = document.getElementById('fijos-preview');
        if (!container) return;

        const total = matches.length;
        const byId = matches.filter(r => r.match && r.match.matchedBy === 'idNum').length;
        const byName = matches.filter(r => r.match && r.match.matchedBy === 'name').length;
        const byManual = matches.filter(r => r.match && r.match.matchedBy === 'manual').length;
        const found = byId + byName + byManual;
        const missing = total - found;

        let html = '<div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:8px; margin-bottom:12px;">';
        html += '<div style="background:rgba(255,255,255,0.04); padding:8px; border-radius:6px; text-align:center;"><div style="font-size:1.4rem; font-weight:900; color:#5DADE2;">' + total + '</div><div style="font-size:0.7rem; color:#888;">Entradas</div></div>';
        html += '<div style="background:rgba(76,175,80,0.1); padding:8px; border-radius:6px; text-align:center;"><div style="font-size:1.4rem; font-weight:900; color:#4CAF50;">' + byId + '</div><div style="font-size:0.7rem; color:#888;">Match por #ID</div></div>';
        html += '<div style="background:rgba(255,152,0,0.1); padding:8px; border-radius:6px; text-align:center;"><div style="font-size:1.4rem; font-weight:900; color:#FF9800;">' + byName + '</div><div style="font-size:0.7rem; color:#888;">Match por nombre</div></div>';
        html += '<div style="background:rgba(156,39,176,0.1); padding:8px; border-radius:6px; text-align:center;"><div style="font-size:1.4rem; font-weight:900; color:#9C27B0;">' + byManual + '</div><div style="font-size:0.7rem; color:#888;">Vinculados manual</div></div>';
        html += '<div style="background:rgba(229,57,53,0.1); padding:8px; border-radius:6px; text-align:center;"><div style="font-size:1.4rem; font-weight:900; color:#E53935;">' + missing + '</div><div style="font-size:0.7rem; color:#888;">Sin match</div></div>';
        html += '</div>';

        html += '<table style="width:100%; border-collapse:collapse; font-size:0.78rem;">';
        html += '<thead><tr style="background:#1e1e26;">' +
                '<th style="padding:8px; text-align:left; border:1px solid #333;">idNum</th>' +
                '<th style="padding:8px; text-align:left; border:1px solid #333;">FIJOS dice</th>' +
                '<th style="padding:8px; text-align:left; border:1px solid #333;">Cliente en sistema</th>' +
                '<th style="padding:8px; text-align:left; border:1px solid #333;">A aplicar</th>' +
                '<th style="padding:8px; text-align:left; border:1px solid #333;">Estado</th>' +
                '</tr></thead><tbody>';

        matches.forEach((row, idx) => {
            const e = row.entry;
            const m = row.match;

            let statusCell, clientCell;
            if (m) {
                const matchBadge = m.matchedBy === 'idNum'
                    ? '<span style="color:#4CAF50; font-weight:700;">✓ MATCH</span>'
                    : (m.matchedBy === 'name'
                        ? '<span style="background:#FF9800; color:#000; padding:1px 6px; border-radius:8px; font-size:0.65rem; font-weight:900;">✓ por nombre</span>'
                        : '<span style="background:#9C27B0; color:#fff; padding:1px 6px; border-radius:8px; font-size:0.65rem; font-weight:900;">✓ manual</span>');
                statusCell = matchBadge;
                clientCell = '<b>' + _esc(m.data.name || '—') + '</b>'
                    + ' <span style="color:#888; font-size:0.65rem;">[#' + _esc(m.data.idNum || '?') + ']</span>'
                    + '<br><span style="color:#888; font-size:0.7rem;">NIF: ' + _esc(m.data.nif || '—') + '</span>';
            } else {
                statusCell = '<span style="color:#E53935; font-weight:700;">✗ NO EXISTE</span>';
                clientCell = '<span style="color:#FF8A80; display:block; margin-bottom:4px;">— sin match en /users —</span>'
                    + '<input type="text" placeholder="🔍 Buscar por nombre..." oninput="window._fijosSearchClients(' + idx + ', this.value)" style="width:100%; padding:4px 6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:4px; font-size:0.7rem;">'
                    + '<div id="fijos-search-results-' + idx + '" style="margin-top:2px; max-height:140px; overflow-y:auto; background:#111; border-radius:4px;"></div>';
            }

            html += '<tr ' + (m ? '' : 'style="background:rgba(229,57,53,0.04);"') + '>';
            html += '<td style="padding:6px; border:1px solid #2a2a2a; font-weight:700; color:#FFD700;">#' + _esc(row.idNum) + '</td>';
            html += '<td style="padding:6px; border:1px solid #2a2a2a;"><b>' + _esc(e.name) + '</b><br><span style="font-size:0.72rem; color:#aaa;">' + _esc(e.note || '') + '</span></td>';
            html += '<td style="padding:6px; border:1px solid #2a2a2a; min-width:240px;">' + clientCell + '</td>';
            html += '<td style="padding:6px; border:1px solid #2a2a2a; font-size:0.72rem;">' + _describeApply(e) + '</td>';
            html += '<td style="padding:6px; border:1px solid #2a2a2a;">' + statusCell + '</td>';
            html += '</tr>';
        });
        html += '</tbody></table>';

        if (missing > 0) {
            html += '<div style="margin-top:12px; padding:10px; background:rgba(229,57,53,0.1); border:1px solid #E53935; border-radius:6px; font-size:0.78rem; color:#FF8A80;">';
            html += '⚠️ <b>' + missing + ' entradas sin match en /users.</b> Esos clientes pueden estar en /contacts pero no en /users (no son clientes activos de NOVAPACK). Se ignorarán durante el import.';
            html += '</div>';
        }

        container.innerHTML = html;
    }

    /** Aplica los cambios en Firestore */
    async function _applyAll() {
        // Aplica si: tiene match + (no es kind=normal OR tiene preferredInvoiceFormat OR tiene albaranSuffix)
        const matches = _matchCache.filter(r => {
            if (!r.match) return false;
            if (r.entry.kind !== 'normal') return true;
            if (r.entry.preferredInvoiceFormat) return true;
            if (r.entry.albaranSuffix) return true;
            return false;
        });
        if (matches.length === 0) {
            alert('No hay nada que aplicar (todas las entradas son "normal" o no tienen match).');
            return;
        }
        const ok = confirm(
            'CONFIRMAR aplicación FIJOS-2026\n\n' +
            'Se actualizarán ' + matches.length + ' clientes con sus tarifas especiales.\n\n' +
            'Cambios:\n' +
            '  • isFlatRate + flatRateAmount (clientes PTE)\n' +
            '  • customRates (clientes con tarifa por bulto)\n' +
            '  • tariffNote (visible en ficha)\n' +
            '  • Auditoría: tariffImportedFrom + tariffImportedAt\n\n' +
            'Los datos NO se borran, solo se añaden/sobreescriben campos concretos.\n\n' +
            '¿Continuar?'
        );
        if (!ok) return;

        const logEl = document.getElementById('fijos-apply-log');
        logEl.style.display = 'block';
        logEl.innerHTML = '<div style="color:#5DADE2;">⏳ Aplicando...</div>';

        let success = 0, fail = 0;
        const errors = [];

        // Procesar en lotes secuenciales (no paralelo para evitar saturar)
        for (const row of matches) {
            try {
                const payload = _buildPayload(row.entry);
                await db.collection('users').doc(row.match.uid).set(payload, { merge: true });
                // Update in-memory userMap también
                if (window.userMap && window.userMap[row.match.uid]) {
                    Object.assign(window.userMap[row.match.uid], payload);
                    delete window.userMap[row.match.uid].tariffImportedAt; // server timestamp no útil local
                }
                success++;
            } catch (e) {
                fail++;
                errors.push('#' + row.idNum + ' ' + row.entry.name + ': ' + e.message);
                console.error('[FIJOS-2026] fail', row, e);
            }
        }

        let logHtml = '<div style="padding:8px; border-radius:6px; background:rgba(76,175,80,0.1); border:1px solid #4CAF50; margin-bottom:8px;"><b style="color:#4CAF50;">✅ ' + success + ' clientes actualizados correctamente.</b></div>';
        if (fail > 0) {
            logHtml += '<div style="padding:8px; border-radius:6px; background:rgba(229,57,53,0.1); border:1px solid #E53935;"><b style="color:#E53935;">❌ ' + fail + ' fallos:</b><br>' + errors.map(_esc).join('<br>') + '</div>';
        }
        logHtml += '<div style="margin-top:8px; font-size:0.75rem; color:#aaa;">Auditoría guardada en cada user: tariffImportedFrom=FIJOS-2026 · tariffImportedAt=' + new Date().toLocaleString('es-ES') + '</div>';
        logEl.innerHTML = logHtml;

        const btnApply = document.getElementById('fijos-btn-apply');
        if (btnApply) {
            btnApply.disabled = true;
            btnApply.textContent = '✓ Aplicado';
            btnApply.style.background = '#4CAF50';
        }
    }

    /** Construye y abre el modal */
    window.openFijos2026Importer = async function() {
        let modal = document.getElementById('fijos-2026-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'fijos-2026-modal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:99999; padding:20px; overflow-y:auto;';
            modal.innerHTML =
                '<div style="max-width:1200px; margin:0 auto; background:#0d0d15; border:2px solid #FF9800; border-radius:12px; padding:20px; color:#eee;">' +
                    '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">' +
                        '<div>' +
                            '<h2 style="margin:0; color:#FF9800; font-size:1.3rem; display:flex; align-items:center; gap:8px;">📋 Importador FIJOS-2026</h2>' +
                            '<p style="margin:4px 0 0; color:#888; font-size:0.78rem;">Tarifas especiales manuales del documento <b>FIJOS-2026.docx</b>. Revisa la tabla y aplica.</p>' +
                        '</div>' +
                        '<button onclick="document.getElementById(\'fijos-2026-modal\').style.display=\'none\';" style="background:transparent; color:#aaa; border:1px solid #444; padding:8px 14px; border-radius:6px; cursor:pointer; font-weight:700;">✕ Cerrar</button>' +
                    '</div>' +
                    '<div id="fijos-preview" style="margin-bottom:16px;"><div style="color:#888; padding:30px; text-align:center;">⏳ Cargando datos FIJOS-2026...</div></div>' +
                    '<div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap;">' +
                        '<button id="fijos-btn-refresh" onclick="window._fijosRefresh()" style="background:#1e3a5f; color:#5DADE2; border:1px solid #2d5a8e; padding:10px 18px; border-radius:6px; cursor:pointer; font-weight:700;">🔄 Recargar matches</button>' +
                        '<button id="fijos-btn-apply" onclick="window._fijosApply()" style="background:#FF9800; color:#000; border:0; padding:10px 22px; border-radius:6px; cursor:pointer; font-weight:900;">✓ APLICAR a Firestore</button>' +
                    '</div>' +
                    '<div id="fijos-apply-log" style="margin-top:14px; display:none;"></div>' +
                '</div>';
            document.body.appendChild(modal);
        } else {
            modal.style.display = 'block';
        }

        try {
            await _loadJson();
            _matchCache = _matchAll(_fijosData.entries);
            _renderPreview();
        } catch (e) {
            document.getElementById('fijos-preview').innerHTML =
                '<div style="color:#E53935; padding:20px;">❌ Error: ' + _esc(e.message) + '</div>';
        }
    };

    window._fijosRefresh = function() {
        if (!_fijosData) return;
        _matchCache = _matchAll(_fijosData.entries);
        _renderPreview();
    };
    window._fijosApply = _applyAll;

    console.log('[FIJOS-2026] importer ready · use window.openFijos2026Importer()');
})();
