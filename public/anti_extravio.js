/**
 * NOVAPACK CLOUD — Anti-extravío
 *
 * Detecta tickets que llevan demasiado tiempo en estado "Pendiente" o
 * parcialmente escaneados sin completar entrega. Cuando un ticket cruza el
 * umbral, se crea automáticamente un driver_alerts para el repartidor de la
 * ruta (con read=false / completed=false) y se marca el ticket con
 * lostAlertSentAt para evitar re-disparar.
 *
 * Configuración en config/admin:
 *   lostAlertHoursPending   (default 24)  — horas que un ticket puede estar
 *                                            'Pendiente' antes de alertar
 *   lostAlertHoursPartial   (default 4)   — horas con scans parciales sin
 *                                            entrega antes de alertar
 *   lostAlertEnabled        (default true)
 *
 * Sólo se ejecuta en admin.html (donde isAdmin() es cierto y la regla
 * tickets/update permite tocar lostAlertSentAt).
 */
(function() {
    'use strict';

    if (typeof db === 'undefined') {
        console.warn('[ANTI-EXTRAVIO] firestore no inicializado, abortando');
        return;
    }

    var DEFAULT_HOURS_PENDING = 24;
    var DEFAULT_HOURS_PARTIAL = 4;
    var SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 min
    var REALERT_AFTER_HOURS = 24;          // re-alert max una vez por día por ticket

    var _config = {
        lostAlertHoursPending: DEFAULT_HOURS_PENDING,
        lostAlertHoursPartial: DEFAULT_HOURS_PARTIAL,
        lostAlertEnabled: true
    };

    var _ticketsListener = null;
    var _scanTimer = null;
    var _knownTickets = new Map();   // id -> ticket data
    var _lostNow = [];                // currently-suspicious tickets (sorted)
    var _running = false;

    function _esc(s) {
        return (typeof escapeHtml === 'function')
            ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function _toMillis(t) {
        if (!t) return 0;
        if (t.toMillis) return t.toMillis();
        if (t.toDate) return t.toDate().getTime();
        if (t._seconds) return t._seconds * 1000;
        if (t instanceof Date) return t.getTime();
        if (typeof t === 'string') { var d = new Date(t); return isNaN(d) ? 0 : d.getTime(); }
        if (typeof t === 'number') return t;
        return 0;
    }

    function _fmtAge(ms) {
        if (ms < 0) ms = 0;
        var h = Math.floor(ms / 3600000);
        var m = Math.floor((ms % 3600000) / 60000);
        if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
        if (h > 0) return h + 'h ' + m + 'm';
        return m + 'm';
    }

    async function _loadConfig() {
        try {
            var doc = await db.collection('config').doc('admin').get();
            if (doc.exists) {
                var d = doc.data();
                if (typeof d.lostAlertHoursPending === 'number') _config.lostAlertHoursPending = d.lostAlertHoursPending;
                if (typeof d.lostAlertHoursPartial === 'number') _config.lostAlertHoursPartial = d.lostAlertHoursPartial;
                if (typeof d.lostAlertEnabled === 'boolean') _config.lostAlertEnabled = d.lostAlertEnabled;
            }
        } catch(e) { console.warn('[ANTI-EXTRAVIO] loadConfig:', e.message); }
    }

    async function _saveConfig(patch) {
        try {
            await db.collection('config').doc('admin').set(Object.assign({}, patch, {
                lostAlertConfigUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }), { merge: true });
            Object.assign(_config, patch);
        } catch(e) {
            alert('Error guardando configuración: ' + e.message);
        }
    }

    /**
     * True if the ticket should appear in the "potentially lost" list right now.
     * Returns { reason: 'pending'|'partial', ageMs }
     */
    function _evaluateTicket(t) {
        if (!t) return null;
        if (t.delivered === true || t.status === 'Entregado') return null;
        if (t.status === 'Anulado' || t.status === 'Devuelto' || t.status === 'Incidencia') return null;

        var now = Date.now();
        var createdMs = _toMillis(t.createdAt);
        var lastScanMs = _toMillis(t.lastScan);
        var pendingMs = createdMs ? (now - createdMs) : 0;

        var partialThresholdMs = _config.lostAlertHoursPartial * 3600000;
        var pendingThresholdMs = _config.lostAlertHoursPending * 3600000;

        // Partial scan in transit
        var packagesScanned = parseInt(t.packagesScanned || 0, 10);
        var totalPackages = (t.packagesList && t.packagesList.length) || parseInt(t.packages || 0, 10) || 0;
        if (lastScanMs && packagesScanned > 0 && packagesScanned < totalPackages) {
            var ageSinceScan = now - lastScanMs;
            if (ageSinceScan >= partialThresholdMs) {
                return { reason: 'partial', ageMs: ageSinceScan };
            }
            return null;
        }

        // Pendiente without any scan, too old
        if (pendingMs >= pendingThresholdMs) {
            return { reason: 'pending', ageMs: pendingMs };
        }
        return null;
    }

    function _alreadyAlertedRecently(t) {
        var sentMs = _toMillis(t.lostAlertSentAt);
        if (!sentMs) return false;
        return (Date.now() - sentMs) < (REALERT_AFTER_HOURS * 3600000);
    }

    async function _fireAlertForTicket(t, reason, ageMs) {
        try {
            var routePhone = t.driverPhone || '';
            var titleMap = {
                pending: '🚨 Posible extravío — sin escanear',
                partial: '🚨 Albarán a medias sin entregar'
            };
            var bodyParts = [];
            bodyParts.push('Albarán ' + (t.id || t._id || ''));
            if (t.receiver) bodyParts.push('para ' + t.receiver);
            bodyParts.push('lleva ' + _fmtAge(ageMs));
            if (reason === 'partial') bodyParts.push('con escaneo parcial');
            else bodyParts.push('sin tocar');
            bodyParts.push('— revisa por favor.');

            var alertData = {
                title: titleMap[reason] || '🚨 Posible extravío',
                body: bodyParts.join(' '),
                ticketId: t._id || null,
                ticketBusinessId: t.id || '',
                routePhone: routePhone,
                kind: 'extravio',
                reason: reason,
                completed: false,
                read: false,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            if (typeof getOperatorStamp === 'function') Object.assign(alertData, getOperatorStamp());

            // Driver alert (only if we have a route)
            if (routePhone) {
                await db.collection('driver_alerts').add(alertData);
            }
            // Mark ticket so we don't re-alert for REALERT_AFTER_HOURS
            if (t._id) {
                await db.collection('tickets').doc(t._id).update({
                    lostAlertSentAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lostAlertReason: reason
                });
            }
            console.log('[ANTI-EXTRAVIO] Alerta disparada para', t.id, '(' + reason + ', ' + _fmtAge(ageMs) + ')');
        } catch(e) {
            console.warn('[ANTI-EXTRAVIO] No pude disparar alerta para', t.id || t._id, '-', e.message);
        }
    }

    async function _scanAndAlert() {
        if (_running) return;
        if (!_config.lostAlertEnabled) {
            _renderPanel([]);
            return;
        }
        _running = true;
        try {
            var lost = [];
            _knownTickets.forEach(function(t) {
                var ev = _evaluateTicket(t);
                if (ev) lost.push(Object.assign({}, t, { _lostReason: ev.reason, _lostAgeMs: ev.ageMs }));
            });

            // Sort: oldest first
            lost.sort(function(a, b) { return b._lostAgeMs - a._lostAgeMs; });
            _lostNow = lost;
            _renderPanel(lost);

            // Fire alerts for those not yet alerted
            for (var i = 0; i < lost.length; i++) {
                var t = lost[i];
                if (!_alreadyAlertedRecently(t)) {
                    await _fireAlertForTicket(t, t._lostReason, t._lostAgeMs);
                }
            }
        } finally {
            _running = false;
        }
    }

    function _renderPanel(lost) {
        var container = document.getElementById('briefing-lost');
        var counter = document.getElementById('briefing-lost-count');
        if (!container || !counter) return;
        counter.textContent = lost.length;
        if (lost.length === 0) {
            container.innerHTML = '<div style="padding:14px; text-align:center; color:#666; font-size:0.8rem;">Sin alertas — todo en marcha 🟢</div>';
            return;
        }
        var rows = lost.slice(0, 25).map(function(t) {
            var routeChip = t.driverPhone
                ? '<span style="background:rgba(255,77,0,0.18); color:#FF8A50; padding:1px 8px; border-radius:8px; font-size:0.7rem; margin-left:6px;">📞 ' + _esc(t.driverPhone) + '</span>'
                : '<span style="background:rgba(120,120,120,0.18); color:#aaa; padding:1px 8px; border-radius:8px; font-size:0.7rem; margin-left:6px;">sin ruta</span>';
            var reasonLabel = t._lostReason === 'partial' ? 'Escaneo parcial' : 'Sin escanear';
            var alertedDot = _toMillis(t.lostAlertSentAt) ? '<span title="Alerta enviada al repartidor" style="color:#4CAF50; margin-left:6px;">●</span>' : '';
            return '<div style="padding:8px 10px; border-bottom:1px solid #2a2a3e; cursor:pointer;" data-ticket-id="' + _esc(t._id || '') + '">'
                + '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">'
                + '<div style="font-weight:700; color:#fff; font-size:0.85rem;">' + _esc(t.id || t._id || '?') + ' · ' + _esc(t.receiver || 'sin destinatario') + alertedDot + '</div>'
                + '<div style="color:#FF3B30; font-size:0.75rem; font-weight:800; white-space:nowrap;">' + _fmtAge(t._lostAgeMs) + '</div>'
                + '</div>'
                + '<div style="font-size:0.7rem; color:#aaa; margin-top:3px; display:flex; align-items:center; flex-wrap:wrap;">'
                + '<span>' + _esc(reasonLabel) + ' · ' + _esc((t.localidad || '') + (t.cp ? ' (' + t.cp + ')' : '')) + '</span>'
                + routeChip
                + '</div>'
                + '</div>';
        }).join('');
        container.innerHTML = rows;
        // Click row → open the search tab with the business id pre-loaded.
        container.querySelectorAll('[data-ticket-id]').forEach(function(el) {
            el.addEventListener('click', function() {
                var tid = el.getAttribute('data-ticket-id');
                var ticket = _knownTickets.get(tid);
                if (typeof erpOpenTab === 'function') erpOpenTab('ticket-search');
                setTimeout(function() {
                    var inp = document.getElementById('ts-filter-text');
                    if (inp) {
                        inp.value = (ticket && ticket.id) ? ticket.id : (tid || '');
                        if (typeof advPerformTicketSearch === 'function') advPerformTicketSearch();
                    }
                }, 80);
            });
        });
    }

    // Live cache of all non-delivered tickets so the scanner is fast.
    function _startTicketsListener() {
        if (_ticketsListener) return;
        try {
            // Hard cap to avoid massive listeners. 500 simultaneous Pendientes is
            // plenty; if a setup ever exceeds this, the oldest are still scanned
            // because they're the ones we care about.
            _ticketsListener = db.collection('tickets')
                .where('status', '==', 'Pendiente')
                .limit(500)
                .onSnapshot(function(snap) {
                    snap.docChanges().forEach(function(ch) {
                        if (ch.type === 'removed') _knownTickets.delete(ch.doc.id);
                        else {
                            var d = ch.doc.data();
                            d._id = ch.doc.id;
                            _knownTickets.set(ch.doc.id, d);
                        }
                    });
                    // After every snapshot, re-render the panel without firing duplicate alerts.
                    var lost = [];
                    _knownTickets.forEach(function(t) {
                        var ev = _evaluateTicket(t);
                        if (ev) lost.push(Object.assign({}, t, { _lostReason: ev.reason, _lostAgeMs: ev.ageMs }));
                    });
                    lost.sort(function(a, b) { return b._lostAgeMs - a._lostAgeMs; });
                    _lostNow = lost;
                    _renderPanel(lost);
                }, function(err) {
                    console.warn('[ANTI-EXTRAVIO] tickets listener error:', err.message);
                });
        } catch(e) {
            console.warn('[ANTI-EXTRAVIO] no pude iniciar listener:', e.message);
        }
    }

    function _stopTicketsListener() {
        if (_ticketsListener) { _ticketsListener(); _ticketsListener = null; }
        if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
    }

    // ============ CONFIG MODAL ============
    function _openConfigModal() {
        var existing = document.getElementById('modal-anti-extravio');
        if (existing) existing.remove();
        var modal = document.createElement('div');
        modal.id = 'modal-anti-extravio';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:60000; display:flex; align-items:center; justify-content:center; padding:20px;';
        modal.innerHTML = ''
            + '<div style="background:#1e1e2e; border:1px solid #333; border-radius:12px; max-width:460px; width:100%; padding:22px; color:#d4d4d4;">'
            + '  <h3 style="margin:0 0 10px; color:#FF3B30; font-size:1.05rem;">⚙️ Configurar Anti-extravío</h3>'
            + '  <p style="font-size:0.8rem; color:#888; margin:0 0 16px;">Tiempo en horas tras el cual un albarán se considera potencialmente extraviado.</p>'
            + '  <label style="display:block; font-size:0.8rem; margin-bottom:6px;">Pendiente sin escanear (h)</label>'
            + '  <input id="ax-h-pending" type="number" min="1" max="240" step="1" value="' + _config.lostAlertHoursPending + '" style="width:100%; background:#2d2d30; border:1px solid #555; color:#fff; padding:8px; border-radius:4px; margin-bottom:14px;">'
            + '  <label style="display:block; font-size:0.8rem; margin-bottom:6px;">Escaneo parcial sin entregar (h)</label>'
            + '  <input id="ax-h-partial" type="number" min="1" max="48" step="1" value="' + _config.lostAlertHoursPartial + '" style="width:100%; background:#2d2d30; border:1px solid #555; color:#fff; padding:8px; border-radius:4px; margin-bottom:14px;">'
            + '  <label style="display:flex; align-items:center; gap:8px; font-size:0.85rem; margin-bottom:18px;">'
            + '    <input id="ax-enabled" type="checkbox" ' + (_config.lostAlertEnabled ? 'checked' : '') + '> Disparar alertas automáticas al repartidor'
            + '  </label>'
            + '  <div style="display:flex; gap:10px; justify-content:flex-end;">'
            + '    <button id="ax-cancel" style="background:#333; border:1px solid #555; color:#fff; padding:8px 16px; border-radius:4px; cursor:pointer;">Cancelar</button>'
            + '    <button id="ax-save" style="background:#FF3B30; border:0; color:#fff; padding:8px 16px; border-radius:4px; cursor:pointer; font-weight:700;">Guardar</button>'
            + '  </div>'
            + '</div>';
        document.body.appendChild(modal);
        document.getElementById('ax-cancel').onclick = function() { modal.remove(); };
        document.getElementById('ax-save').onclick = async function() {
            var hp = Math.max(1, Math.min(240, parseInt(document.getElementById('ax-h-pending').value, 10) || DEFAULT_HOURS_PENDING));
            var hpa = Math.max(1, Math.min(48, parseInt(document.getElementById('ax-h-partial').value, 10) || DEFAULT_HOURS_PARTIAL));
            var en = !!document.getElementById('ax-enabled').checked;
            await _saveConfig({
                lostAlertHoursPending: hp,
                lostAlertHoursPartial: hpa,
                lostAlertEnabled: en
            });
            modal.remove();
            _scanAndAlert();
        };
    }

    // ============ PUBLIC API ============
    window.antiExtravio = {
        list: function() { return _lostNow.slice(); },
        scanNow: _scanAndAlert,
        config: function() { return Object.assign({}, _config); },
        setConfig: _saveConfig,
        stop: _stopTicketsListener
    };

    // ============ BOOT ============
    async function _boot() {
        await _loadConfig();
        _startTicketsListener();
        _scanTimer = setInterval(_scanAndAlert, SCAN_INTERVAL_MS);
        // Wire config button
        var btn = document.getElementById('briefing-lost-config');
        if (btn) btn.addEventListener('click', _openConfigModal);
    }

    // Boot when DOM + auth ready. We wait for the admin auth state since we
    // need isAdmin for ticket updates and config writes.
    function _waitForAuthAndBoot() {
        if (typeof firebase === 'undefined' || !firebase.auth) {
            setTimeout(_waitForAuthAndBoot, 500);
            return;
        }
        firebase.auth().onAuthStateChanged(function(user) {
            if (user) _boot();
            else _stopTicketsListener();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _waitForAuthAndBoot);
    } else {
        _waitForAuthAndBoot();
    }
})();
