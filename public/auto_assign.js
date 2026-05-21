/**
 * NOVAPACK CLOUD — Auto-asignación de paradas
 *
 * Encuentra los albaranes pendientes sin ruta (driverPhone vacío o ausente) y
 * propone una asignación basada en:
 *   1. CP exacto en coverageZones de la ruta
 *   2. Localidad exacta en coverageZones
 *   3. Provincia coincide con label de la ruta
 *   4. Coincidencia por substring CP/localidad en label
 *   5. Si sólo hay una ruta configurada → esa
 *   6. Si no, fallback a último GPS conocido del chófer (si está dentro de
 *      un radio razonable del CP del ticket — heurístico)
 *
 * El admin revisa la tabla, puede sobreescribir cada fila a mano y
 * confirma en lote. La escritura usa el helper centralizado
 * window.normalizePhone para mantener consistencia con el listener del
 * repartidor.
 */
(function() {
    'use strict';

    if (typeof db === 'undefined') return;

    var _container = null;
    var _initialized = false;
    var _routes = [];          // [{docId, label, number(normalized), zones: ['29700', 'velez-malaga'], province?}]
    var _proposals = [];       // [{ticket, suggestedPhone, suggestedLabel, reason, override?}]
    var _loading = false;

    function _esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function _normPhone(p) {
        return (typeof window.normalizePhone === 'function')
            ? window.normalizePhone(p)
            : (p || '').toString().replace(/\D/g, '').replace(/^34/, '').slice(-9);
    }

    async function _loadRoutes() {
        var snap = await db.collection('config').doc('phones').collection('list').get();
        _routes = [];
        snap.forEach(function(doc) {
            var d = doc.data();
            var zonesRaw = (d.coverageZones || '').toString();
            var zones = zonesRaw.split(',').map(function(z) { return z.trim().toLowerCase(); }).filter(Boolean);
            _routes.push({
                docId: doc.id,
                label: d.label || '— sin nombre —',
                labelLower: (d.label || '').toLowerCase(),
                number: _normPhone(d.number),
                zones: zones,
                driverNames: [d.driverName, d.driverName2, d.driverName3, d.driverName4].filter(function(n) { return n && n.trim(); })
            });
        });
    }

    async function _loadUnassigned(limit) {
        // Tickets pendientes sin chófer asignado.
        // Firestore no permite "campo ausente", así que buscamos por status y
        // filtramos en cliente cualquiera con driverPhone vacío.
        var snap = await db.collection('tickets')
            .where('status', '==', 'Pendiente')
            .orderBy('createdAt', 'desc')
            .limit(limit || 500)
            .get();
        var out = [];
        snap.forEach(function(doc) {
            var d = doc.data();
            d._id = doc.id;
            var dp = (d.driverPhone || '').toString().trim();
            if (!dp || dp === '' || dp === '0' || dp === 'null') {
                out.push(d);
            }
        });
        return out;
    }

    function _matchRoute(ticket) {
        var cp = (ticket.cp || '').toString().trim().toLowerCase();
        var loc = (ticket.localidad || '').toString().trim().toLowerCase();
        var prov = (ticket.province || '').toString().trim().toLowerCase();

        // Priority 1: CP exacto en zonas de cobertura
        for (var i = 0; i < _routes.length; i++) {
            if (cp && _routes[i].zones.indexOf(cp) !== -1) {
                return { route: _routes[i], reason: 'CP en zona de cobertura' };
            }
        }
        // Priority 2: localidad exacta en zonas
        for (var j = 0; j < _routes.length; j++) {
            if (loc && _routes[j].zones.indexOf(loc) !== -1) {
                return { route: _routes[j], reason: 'Localidad en zona de cobertura' };
            }
        }
        // Priority 3: CP en label
        for (var k = 0; k < _routes.length; k++) {
            if (cp && _routes[k].labelLower.indexOf(cp) !== -1) {
                return { route: _routes[k], reason: 'CP en nombre de ruta' };
            }
        }
        // Priority 4: localidad ≥ 4 chars en label
        for (var m = 0; m < _routes.length; m++) {
            if (loc && loc.length >= 4 && _routes[m].labelLower.indexOf(loc) !== -1) {
                return { route: _routes[m], reason: 'Localidad en nombre de ruta' };
            }
        }
        // Priority 5: provincia ≥ 4 chars en label
        for (var n = 0; n < _routes.length; n++) {
            if (prov && prov.length >= 4 && _routes[n].labelLower.indexOf(prov) !== -1) {
                return { route: _routes[n], reason: 'Provincia en nombre de ruta' };
            }
        }
        // Priority 6: única ruta configurada
        var routesWithPhone = _routes.filter(function(r) { return r.number; });
        if (routesWithPhone.length === 1) {
            return { route: routesWithPhone[0], reason: 'Única ruta configurada' };
        }
        return null;
    }

    function _layout() {
        return ''
            + '<div style="max-width:1200px; margin:0 auto;">'
            + '  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:18px;">'
            + '    <div>'
            + '      <h2 style="margin:0; color:#FF4D00; font-size:1.2rem; letter-spacing:1px;">⚡ Auto-asignación de paradas</h2>'
            + '      <p style="margin:6px 0 0; font-size:0.82rem; color:#999;">Asigna ruta automáticamente a los albaranes pendientes sin chófer. Revisa las propuestas y confirma en lote.</p>'
            + '    </div>'
            + '    <div style="display:flex; gap:8px;">'
            + '      <button id="aa-scan-btn" class="aa-btn aa-btn-primary"><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">search</span> Buscar pendientes</button>'
            + '      <button id="aa-confirm-btn" class="aa-btn aa-btn-success" disabled><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">check_circle</span> Confirmar selección</button>'
            + '    </div>'
            + '  </div>'
            + '  <div id="aa-summary" style="font-size:0.82rem; color:#888; margin-bottom:14px;">Pulsa "Buscar pendientes" para empezar.</div>'
            + '  <div id="aa-table-wrap"></div>'
            + '</div>'
            + '<style>'
            + '.aa-btn{background:#1a1a1a;border:1px solid #444;color:#ddd;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:0.82rem;font-weight:600;}'
            + '.aa-btn-primary{background:#FF4D00;color:#000;border-color:#FF4D00;}'
            + '.aa-btn-success{background:#34C759;color:#000;border-color:#34C759;}'
            + '.aa-btn:disabled{background:#222;color:#666;border-color:#333;cursor:not-allowed;}'
            + '.aa-table{width:100%;border-collapse:collapse;font-size:0.85rem;background:#161616;border:1px solid rgba(255,255,255,0.08);border-radius:10px;overflow:hidden;}'
            + '.aa-table th{background:#1a1a2e;color:#FF8A50;text-align:left;padding:10px 12px;font-size:0.72rem;text-transform:uppercase;letter-spacing:1px;font-weight:700;border-bottom:1px solid rgba(255,255,255,0.08);}'
            + '.aa-table td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.05);color:#ddd;vertical-align:top;}'
            + '.aa-table tr:hover{background:rgba(255,77,0,0.04);}'
            + '.aa-table select{background:#0a0a0a;border:1px solid #333;color:#ddd;padding:4px 6px;border-radius:4px;font-size:0.78rem;width:100%;}'
            + '.aa-reason{display:inline-block;background:rgba(255,77,0,0.10);color:#FF8A50;padding:2px 8px;border-radius:8px;font-size:0.7rem;}'
            + '.aa-no-match{display:inline-block;background:rgba(255,59,48,0.12);color:#FF3B30;padding:2px 8px;border-radius:8px;font-size:0.7rem;}'
            + '.aa-pill{display:inline-block;padding:2px 8px;border-radius:8px;font-size:0.72rem;background:rgba(120,120,120,0.18);color:#aaa;font-family:monospace;}'
            + '</style>';
    }

    function _renderTable() {
        var wrap = document.getElementById('aa-table-wrap');
        if (!wrap) return;
        if (_proposals.length === 0) {
            wrap.innerHTML = '<div style="text-align:center; color:#666; padding:40px 20px;">No hay albaranes pendientes sin asignar 🎉</div>';
            return;
        }
        var routeOpts = '<option value="">— sin asignar —</option>'
            + _routes.filter(function(r){ return r.number; })
                     .map(function(r) { return '<option value="' + _esc(r.number) + '">' + _esc(r.label) + ' · ' + _esc(r.number) + '</option>'; })
                     .join('');
        var rows = _proposals.map(function(p, idx) {
            var t = p.ticket;
            var route = p.suggestedRoute;
            var override = p.override == null
                ? (route ? route.number : '')
                : p.override;
            var ageDays = (function() {
                var c = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate() : null;
                if (!c) return '';
                var days = Math.floor((Date.now() - c.getTime()) / 86400000);
                return days <= 0 ? 'hoy' : days + 'd';
            })();
            return '<tr data-idx="' + idx + '">'
                + '<td><input type="checkbox" class="aa-chk" data-idx="' + idx + '" ' + (route ? 'checked' : '') + '></td>'
                + '<td><strong>' + _esc(t.id || t._id) + '</strong>'
                +     (ageDays ? ' <span class="aa-pill">' + _esc(ageDays) + '</span>' : '')
                + '</td>'
                + '<td>' + _esc((t.receiver || '').toUpperCase()) + '</td>'
                + '<td>' + _esc(t.localidad || '') + (t.cp ? ' <span class="aa-pill">' + _esc(t.cp) + '</span>' : '') + '<div style="font-size:0.7rem; color:#888;">' + _esc(t.province || '') + '</div></td>'
                + '<td>' + (route
                    ? '<span class="aa-reason">✓ ' + _esc(p.reason) + '</span>'
                    : '<span class="aa-no-match">✗ Sin coincidencia</span>')
                + '</td>'
                + '<td><select class="aa-route-select" data-idx="' + idx + '">' + routeOpts.replace('value="' + _esc(override) + '"', 'value="' + _esc(override) + '" selected') + '</select></td>'
                + '</tr>';
        }).join('');
        wrap.innerHTML = '<table class="aa-table">'
            + '<thead><tr>'
            + '<th><input type="checkbox" id="aa-chk-all" checked></th>'
            + '<th>Albarán</th><th>Destinatario</th><th>Destino</th><th>Sugerencia</th><th style="min-width:240px;">Asignar a</th>'
            + '</tr></thead>'
            + '<tbody>' + rows + '</tbody></table>';

        var chkAll = document.getElementById('aa-chk-all');
        if (chkAll) chkAll.addEventListener('change', function() {
            wrap.querySelectorAll('.aa-chk').forEach(function(c) { c.checked = chkAll.checked; });
            _refreshConfirmBtn();
        });
        wrap.querySelectorAll('.aa-chk').forEach(function(c) {
            c.addEventListener('change', _refreshConfirmBtn);
        });
        wrap.querySelectorAll('.aa-route-select').forEach(function(s) {
            s.addEventListener('change', function() {
                var idx = parseInt(s.getAttribute('data-idx'), 10);
                _proposals[idx].override = s.value;
                // Auto-tick row when admin picks a route, untick when set blank
                var chk = wrap.querySelector('.aa-chk[data-idx="' + idx + '"]');
                if (chk) chk.checked = !!s.value;
                _refreshConfirmBtn();
            });
        });
        _refreshConfirmBtn();
    }

    function _refreshConfirmBtn() {
        var btn = document.getElementById('aa-confirm-btn');
        if (!btn) return;
        var anySelected = false;
        document.querySelectorAll('.aa-chk').forEach(function(c) {
            if (c.checked) {
                var idx = parseInt(c.getAttribute('data-idx'), 10);
                var sel = document.querySelector('.aa-route-select[data-idx="' + idx + '"]');
                if (sel && sel.value) anySelected = true;
            }
        });
        btn.disabled = !anySelected;
    }

    async function _scan() {
        if (_loading) return;
        _loading = true;
        var sumEl = document.getElementById('aa-summary');
        if (sumEl) { sumEl.textContent = 'Cargando rutas y albaranes…'; sumEl.style.color = '#888'; }
        try {
            await _loadRoutes();
            var unassigned = await _loadUnassigned();
            _proposals = unassigned.map(function(t) {
                var match = _matchRoute(t);
                return {
                    ticket: t,
                    suggestedRoute: match ? match.route : null,
                    reason: match ? match.reason : null,
                    override: null
                };
            });
            // Sort: matched first, then unmatched. Within matched, group by route.
            _proposals.sort(function(a, b) {
                if (a.suggestedRoute && !b.suggestedRoute) return -1;
                if (!a.suggestedRoute && b.suggestedRoute) return 1;
                if (a.suggestedRoute && b.suggestedRoute) {
                    return a.suggestedRoute.label.localeCompare(b.suggestedRoute.label);
                }
                return 0;
            });
            var matched = _proposals.filter(function(p) { return p.suggestedRoute; }).length;
            if (sumEl) {
                sumEl.style.color = '#34C759';
                sumEl.textContent = '✅ ' + _proposals.length + ' albaranes pendientes sin asignar · ' + matched + ' con coincidencia automática · ' + (_proposals.length - matched) + ' sin coincidencia';
            }
            _renderTable();
        } catch(e) {
            console.error('[AUTO-ASSIGN] scan error:', e);
            if (sumEl) {
                sumEl.style.color = '#FF3B30';
                sumEl.textContent = '⚠️ Error: ' + e.message;
            }
        } finally {
            _loading = false;
        }
    }

    async function _confirm() {
        var btn = document.getElementById('aa-confirm-btn');
        var sumEl = document.getElementById('aa-summary');
        if (!btn || btn.disabled) return;
        var picks = [];
        document.querySelectorAll('.aa-chk').forEach(function(c) {
            if (!c.checked) return;
            var idx = parseInt(c.getAttribute('data-idx'), 10);
            var sel = document.querySelector('.aa-route-select[data-idx="' + idx + '"]');
            var phone = sel ? sel.value : '';
            if (phone) picks.push({ idx: idx, phone: _normPhone(phone) });
        });
        if (picks.length === 0) return;
        if (!confirm('¿Confirmar asignación de ' + picks.length + ' albaranes?')) return;

        btn.disabled = true;
        btn.textContent = 'Aplicando…';
        try {
            // Find each route's label so we can also stamp routeLabel
            var routesByPhone = {};
            _routes.forEach(function(r) { if (r.number) routesByPhone[r.number] = r; });

            // Process in batches of up to 450 ops
            var done = 0;
            for (var i = 0; i < picks.length; i += 450) {
                var batch = db.batch();
                var slice = picks.slice(i, i + 450);
                slice.forEach(function(pick) {
                    var p = _proposals[pick.idx];
                    var ref = db.collection('tickets').doc(p.ticket._id);
                    var route = routesByPhone[pick.phone];
                    var update = {
                        driverPhone: pick.phone,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                        autoAssignedAt: firebase.firestore.FieldValue.serverTimestamp(),
                        autoAssignedReason: p.reason || 'manual'
                    };
                    if (route && route.label) update.routeLabel = route.label;
                    batch.update(ref, update);
                });
                await batch.commit();
                done += slice.length;
                if (sumEl) sumEl.textContent = 'Aplicado ' + done + ' / ' + picks.length + '…';
            }
            if (sumEl) {
                sumEl.style.color = '#34C759';
                sumEl.textContent = '✅ ' + done + ' albaranes asignados.';
            }
            // Re-scan to refresh the table (show only those still unassigned)
            await _scan();
        } catch(e) {
            console.error('[AUTO-ASSIGN] confirm error:', e);
            if (sumEl) {
                sumEl.style.color = '#FF3B30';
                sumEl.textContent = '⚠️ Error: ' + e.message;
            }
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">check_circle</span> Confirmar selección';
        }
    }

    function _ensureMounted() {
        _container = document.getElementById('erp-tab-auto-assign');
        if (!_container) return false;
        if (!_initialized) {
            _container.innerHTML = _layout();
            _initialized = true;
            document.getElementById('aa-scan-btn').addEventListener('click', _scan);
            document.getElementById('aa-confirm-btn').addEventListener('click', _confirm);
        }
        return true;
    }

    function _watchVisibility() {
        var target = document.getElementById('erp-tab-auto-assign');
        if (!target) { setTimeout(_watchVisibility, 500); return; }
        new MutationObserver(function() {
            if (target.style.display !== 'none') {
                if (_ensureMounted() && _proposals.length === 0 && !_loading) {
                    _scan();
                }
            }
        }).observe(target, { attributes: true, attributeFilter: ['style'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _watchVisibility);
    } else {
        _watchVisibility();
    }

    window.autoAssignRescan = _scan;
})();
