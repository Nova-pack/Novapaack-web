/**
 * NOVAPACK CLOUD — Public tracking page
 * Reads a single doc from `public_tickets` (publicly readable, no PII).
 * Live-updates via onSnapshot so the recipient sees status change in real time.
 */
(function() {
    'use strict';

    var unsub = null;

    function $(id) { return document.getElementById(id); }

    function showOnly(panelId) {
        ['panel-loading', 'panel-not-found', 'panel-error', 'panel-ticket'].forEach(function(p) {
            $(p).classList.add('hidden');
        });
        $(panelId).classList.remove('hidden');
    }

    function fmtDate(ts) {
        if (!ts) return '';
        try {
            var d = ts.toDate ? ts.toDate()
                : ts._seconds ? new Date(ts._seconds * 1000)
                : ts.seconds ? new Date(ts.seconds * 1000)
                : new Date(ts);
            if (isNaN(d.getTime())) return '';
            var sameDay = d.toDateString() === new Date().toDateString();
            if (sameDay) return 'Hoy ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        } catch(e) { return ''; }
    }

    function statusLabel(key) {
        switch (key) {
            case 'delivered':  return '✅ Entregado';
            case 'in_transit': return '🚚 En reparto';
            case 'pending':    return '⏳ Pendiente';
            case 'cancelled':  return '⛔ Cancelado';
            case 'returned':   return '↩️ Devuelto';
            case 'incident':   return '⚠️ Incidencia';
            default:           return '⏳ ' + (key || 'En proceso');
        }
    }

    function buildTimeline(t) {
        // Steps the package is expected to go through, in order. Each step
        // has done/active/future based on the current status.
        var key = t.statusKey || 'pending';
        var isFinal = key === 'delivered' || key === 'cancelled' || key === 'returned';

        var steps = [
            {
                id: 'created',
                label: 'Albarán registrado',
                meta: t.createdAt ? fmtDate(t.createdAt) : '',
                done: true,
                active: key === 'pending' && !t.distributedAt
            },
            {
                id: 'in_transit',
                label: 'En reparto',
                meta: t.distributedAt
                    ? fmtDate(t.distributedAt)
                    : (key === 'in_transit' ? 'En curso ahora' : ''),
                done: key === 'in_transit' || key === 'delivered',
                active: key === 'in_transit'
            },
            {
                id: 'delivered',
                label: t.signatureRefused ? 'Entregado (sin firma)' : 'Entregado',
                meta: t.deliveredAt
                    ? (fmtDate(t.deliveredAt) + (t.deliveredTo ? ' · a ' + t.deliveredTo : ''))
                    : '',
                done: key === 'delivered',
                active: key === 'delivered'
            }
        ];

        // Override timeline for non-happy-path final states.
        if (key === 'cancelled') {
            steps[2] = { id: 'cancelled', label: 'Cancelado', meta: '', done: true, active: true };
        } else if (key === 'returned') {
            steps[2] = { id: 'returned', label: 'Devuelto al remitente', meta: '', done: true, active: true };
        } else if (key === 'incident') {
            steps.push({ id: 'incident', label: 'Incidencia abierta', meta: 'El equipo está revisándola', done: false, active: true });
        }

        return steps.map(function(s) {
            var cls = s.done ? 'step done' : (s.active ? 'step active' : 'step future');
            var label = '<div class="label">' + escapeHtml(s.label) + '</div>';
            var meta = s.meta ? '<div class="meta">' + escapeHtml(s.meta) + '</div>' : '';
            return '<div class="' + cls + '">' + label + meta + '</div>';
        }).join('');
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function renderTicket(id, t) {
        $('t-id').textContent = t.id || id;
        $('t-receiver').textContent = t.receiver || '—';
        var routeBits = [];
        if (t.routeLabel) routeBits.push('Ruta: ' + t.routeLabel);
        if (t.shippingType) routeBits.push(t.shippingType);
        $('t-route').textContent = routeBits.join(' · ');

        var statusEl = $('t-status');
        statusEl.className = 'status-badge status-' + (t.statusKey || 'pending');
        statusEl.textContent = statusLabel(t.statusKey);

        $('t-timeline').innerHTML = buildTimeline(t);

        var dest = [];
        if (t.destinationCity) dest.push(t.destinationCity);
        if (t.destinationCp) dest.push('CP ' + t.destinationCp);
        if (t.destinationProvince) dest.push(t.destinationProvince);
        var destText = dest.length ? dest.join(' · ') : 'Destino sin especificar';
        $('t-destination').innerHTML = '<span>' + escapeHtml(destText) + '</span>';
    }

    function lookup(rawId) {
        var id = (rawId || '').trim();
        if (!id) return;

        // Update URL so the link is shareable
        if (location.search.indexOf('id=') === -1 || decodeURIComponent(location.search).indexOf(id) === -1) {
            history.replaceState(null, '', '?id=' + encodeURIComponent(id));
        }

        if (unsub) { unsub(); unsub = null; }
        showOnly('panel-loading');

        // The mirror is keyed by the business id (NP-…), so a single doc get
        // is all we need. Live updates flow via onSnapshot.
        var ref = firebase.firestore().collection('public_tickets').doc(id);
        unsub = ref.onSnapshot(function(doc) {
            if (doc.exists) {
                showOnly('panel-ticket');
                renderTicket(id, doc.data());
            } else {
                showOnly('panel-not-found');
            }
        }, function(err) { showError(err); });
    }

    function showError(err) {
        $('error-msg').textContent = 'Error: ' + (err && err.message ? err.message : 'No se pudo consultar el envío.');
        showOnly('panel-error');
    }

    document.getElementById('lookup-form').addEventListener('submit', function(e) {
        e.preventDefault();
        lookup($('lookup-input').value);
    });

    // Auto-lookup if id is in the URL
    var params = new URLSearchParams(location.search);
    var initialId = params.get('id');
    if (initialId) {
        $('lookup-input').value = initialId;
        lookup(initialId);
    }
})();
