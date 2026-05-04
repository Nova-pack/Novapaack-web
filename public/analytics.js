/**
 * NOVAPACK CLOUD — Analytics dashboard
 *
 * Lee `tickets` filtrados por rango temporal y renderiza KPIs + gráficos
 * sencillos (sin dependencias externas — todo CSS/SVG).
 *
 * Métricas:
 *   - Total albaranes en rango
 *   - % entregados / pendientes / incidencias
 *   - Tiempo medio de entrega (createdAt → deliveredAt)
 *   - Top 10 rutas por volumen + % éxito
 *   - Top 10 localidades por volumen
 *   - Albaranes por día (barras)
 *
 * Uso: pestaña "Analítica" del menú Informes.
 */
(function() {
    'use strict';

    if (typeof db === 'undefined') return;

    var _container = null;
    var _currentRange = '30d';
    var _loading = false;
    var _cache = null;
    var _initialized = false;

    function _esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    function _toMillis(t) {
        if (!t) return 0;
        if (t.toMillis) return t.toMillis();
        if (t.toDate) return t.toDate().getTime();
        if (t._seconds) return t._seconds * 1000;
        if (t.seconds) return t.seconds * 1000;
        if (t instanceof Date) return t.getTime();
        if (typeof t === 'string') { var d = new Date(t); return isNaN(d) ? 0 : d.getTime(); }
        if (typeof t === 'number') return t;
        return 0;
    }

    function _rangeBounds(key) {
        var now = new Date();
        var to = now.getTime();
        var from;
        switch (key) {
            case '7d':  from = to - 7 * 86400000; break;
            case '90d': from = to - 90 * 86400000; break;
            case 'mtd': from = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); break;
            case 'ytd': from = new Date(now.getFullYear(), 0, 1).getTime(); break;
            case '30d':
            default:    from = to - 30 * 86400000; break;
        }
        return { from: from, to: to, fromDate: new Date(from), toDate: new Date(to) };
    }

    function _rangeLabel(key) {
        switch (key) {
            case '7d':  return 'Últimos 7 días';
            case '30d': return 'Últimos 30 días';
            case '90d': return 'Últimos 90 días';
            case 'mtd': return 'Mes en curso';
            case 'ytd': return 'Año en curso';
            default:    return key;
        }
    }

    function _layout() {
        return ''
            + '<div style="max-width:1200px; margin:0 auto;">'
            + '  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:18px;">'
            + '    <h2 style="margin:0; color:#FF4D00; font-size:1.2rem; letter-spacing:1px;">📊 Analítica de operaciones</h2>'
            + '    <div id="ax-range-bar" style="display:flex; gap:6px; flex-wrap:wrap;"></div>'
            + '  </div>'
            + '  <div id="ax-summary" style="font-size:0.78rem; color:#888; margin-bottom:14px;"></div>'
            + '  <div id="ax-kpis" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:12px; margin-bottom:18px;"></div>'
            + '  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px,1fr)); gap:14px; margin-bottom:18px;">'
            + '    <div class="ax-card"><h3>Albaranes por día</h3><div id="ax-bars-daily"></div></div>'
            + '    <div class="ax-card"><h3>Distribución por estado</h3><div id="ax-status-mix"></div></div>'
            + '  </div>'
            + '  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px,1fr)); gap:14px; margin-bottom:18px;">'
            + '    <div class="ax-card"><h3>Top rutas por volumen</h3><div id="ax-top-routes"></div></div>'
            + '    <div class="ax-card"><h3>Top localidades</h3><div id="ax-top-localities"></div></div>'
            + '  </div>'
            + '  <div id="ax-loading" style="display:none; text-align:center; padding:40px; color:#999;">Cargando datos…</div>'
            + '  <div id="ax-empty" style="display:none; text-align:center; padding:40px; color:#666;">Sin datos en este rango.</div>'
            + '</div>'
            + '<style>'
            + '.ax-range-btn{background:#1a1a1a;border:1px solid #333;color:#aaa;padding:6px 14px;border-radius:100px;cursor:pointer;font-size:0.78rem;font-weight:600;}'
            + '.ax-range-btn.active{background:#FF4D00;color:#000;border-color:#FF4D00;}'
            + '.ax-card{background:#161616;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;}'
            + '.ax-card h3{color:#FF8A50;font-size:0.85rem;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px;}'
            + '.ax-kpi{background:#161616;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;}'
            + '.ax-kpi .v{font-size:1.7rem;font-weight:800;color:#fff;line-height:1.1;}'
            + '.ax-kpi .l{font-size:0.7rem;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:4px;}'
            + '.ax-kpi .d{font-size:0.7rem;color:#aaa;margin-top:6px;}'
            + '.ax-bar-row{display:flex;align-items:center;gap:8px;font-size:0.78rem;margin-bottom:6px;}'
            + '.ax-bar-row .name{flex:0 0 auto;min-width:100px;color:#ccc;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;}'
            + '.ax-bar-row .bar{flex:1;height:10px;background:rgba(255,255,255,0.06);border-radius:6px;overflow:hidden;}'
            + '.ax-bar-row .bar > div{height:100%;background:linear-gradient(90deg,#FF4D00,#FFB74D);}'
            + '.ax-bar-row .v{flex:0 0 auto;color:#fff;font-weight:600;min-width:48px;text-align:right;}'
            + '.ax-mix-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:0.85rem;}'
            + '.ax-mix-dot{width:10px;height:10px;border-radius:50%;}'
            + '.ax-day-bar{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;flex:1;min-width:8px;}'
            + '.ax-day-bar .b{width:75%;background:linear-gradient(180deg,#FF4D00,#FF8A50);border-radius:3px 3px 0 0;}'
            + '.ax-day-bar .l{font-size:0.6rem;color:#666;margin-top:4px;writing-mode:vertical-rl;transform:rotate(180deg);}'
            + '</style>';
    }

    function _renderRangeBar() {
        var bar = document.getElementById('ax-range-bar');
        if (!bar) return;
        var ranges = [['7d','7d'],['30d','30d'],['90d','90d'],['mtd','Mes'],['ytd','Año']];
        bar.innerHTML = ranges.map(function(r) {
            var cls = (r[0] === _currentRange) ? 'ax-range-btn active' : 'ax-range-btn';
            return '<button class="' + cls + '" data-range="' + r[0] + '">' + _esc(r[1]) + '</button>';
        }).join('');
        bar.querySelectorAll('button').forEach(function(b) {
            b.addEventListener('click', function() {
                _currentRange = b.getAttribute('data-range');
                _renderRangeBar();
                _loadAndRender();
            });
        });
    }

    async function _fetchTickets(range) {
        // We pull in pages by createdAt to keep the query small. limit 5000 is
        // a hard ceiling — beyond that the dashboard would need server-side
        // aggregation anyway.
        var bounds = _rangeBounds(range);
        var fromTs = firebase.firestore.Timestamp.fromMillis(bounds.from);
        var snap = await db.collection('tickets')
            .where('createdAt', '>=', fromTs)
            .orderBy('createdAt', 'desc')
            .limit(5000)
            .get();
        var out = [];
        snap.forEach(function(doc) {
            var d = doc.data();
            d._id = doc.id;
            out.push(d);
        });
        return { tickets: out, bounds: bounds };
    }

    function _aggregate(data) {
        var tickets = data.tickets;
        var totalDelivered = 0, totalPending = 0, totalIncident = 0, totalCancel = 0, totalReturn = 0;
        var totalDeliveredHours = 0, deliveredCount = 0;
        var byDay = {};   // 'YYYY-MM-DD' -> count
        var byRoute = {}; // routeLabel -> { total, delivered }
        var byLoc = {};   // 'localidad' -> count
        var statusCounts = {};

        tickets.forEach(function(t) {
            var status = t.status || (t.delivered ? 'Entregado' : 'Pendiente');
            statusCounts[status] = (statusCounts[status] || 0) + 1;

            if (status === 'Entregado' || t.delivered) totalDelivered++;
            else if (status === 'Pendiente') totalPending++;
            else if (status === 'Incidencia') totalIncident++;
            else if (status === 'Anulado') totalCancel++;
            else if (status === 'Devuelto') totalReturn++;

            // Time to delivery
            var createdMs = _toMillis(t.createdAt);
            var deliveredMs = _toMillis(t.deliveredAt);
            if (createdMs && deliveredMs && deliveredMs > createdMs) {
                totalDeliveredHours += (deliveredMs - createdMs) / 3600000;
                deliveredCount++;
            }

            // Daily volume
            if (createdMs) {
                var d = new Date(createdMs);
                var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
                byDay[key] = (byDay[key] || 0) + 1;
            }

            // Routes (use routeLabel if available; fall back to driverPhone hint)
            var routeKey = (t.routeLabel || '').toUpperCase().trim() || (t.driverPhone ? '#' + t.driverPhone : '— sin ruta —');
            if (!byRoute[routeKey]) byRoute[routeKey] = { total: 0, delivered: 0 };
            byRoute[routeKey].total++;
            if (status === 'Entregado' || t.delivered) byRoute[routeKey].delivered++;

            // Localities
            var loc = (t.localidad || '').toUpperCase().trim();
            if (loc) byLoc[loc] = (byLoc[loc] || 0) + 1;
        });

        return {
            total: tickets.length,
            totalDelivered: totalDelivered,
            totalPending: totalPending,
            totalIncident: totalIncident,
            totalCancel: totalCancel,
            totalReturn: totalReturn,
            avgDeliveryHours: deliveredCount > 0 ? (totalDeliveredHours / deliveredCount) : null,
            successRate: tickets.length > 0
                ? ((totalDelivered / tickets.length) * 100)
                : 0,
            byDay: byDay,
            byRoute: byRoute,
            byLoc: byLoc,
            statusCounts: statusCounts
        };
    }

    function _renderKpis(agg, bounds) {
        var el = document.getElementById('ax-kpis');
        if (!el) return;
        var avg = agg.avgDeliveryHours;
        var avgTxt = (avg == null) ? '—'
            : avg < 1 ? Math.round(avg * 60) + ' min'
            : avg < 24 ? avg.toFixed(1) + ' h'
            : (avg / 24).toFixed(1) + ' d';
        var kpis = [
            { v: agg.total, l: 'Albaranes', d: '' },
            { v: agg.totalDelivered, l: 'Entregados', d: agg.successRate.toFixed(1) + ' % éxito' },
            { v: agg.totalPending, l: 'Pendientes', d: '' },
            { v: agg.totalIncident, l: 'Incidencias', d: '' },
            { v: avgTxt, l: 'Tiempo medio entrega', d: '' }
        ];
        el.innerHTML = kpis.map(function(k) {
            return '<div class="ax-kpi"><div class="v">' + _esc(k.v) + '</div><div class="l">' + _esc(k.l) + '</div>' + (k.d ? '<div class="d">' + _esc(k.d) + '</div>' : '') + '</div>';
        }).join('');
    }

    function _renderDailyBars(agg, bounds) {
        var el = document.getElementById('ax-bars-daily');
        if (!el) return;
        // Build full daily series (zero-fill missing days)
        var days = [];
        var cursor = new Date(bounds.fromDate.getFullYear(), bounds.fromDate.getMonth(), bounds.fromDate.getDate());
        var end = new Date(bounds.toDate.getFullYear(), bounds.toDate.getMonth(), bounds.toDate.getDate());
        while (cursor <= end) {
            var key = cursor.getFullYear() + '-' + String(cursor.getMonth()+1).padStart(2,'0') + '-' + String(cursor.getDate()).padStart(2,'0');
            days.push({ key: key, count: agg.byDay[key] || 0, date: new Date(cursor) });
            cursor.setDate(cursor.getDate() + 1);
        }
        // Cap to last 60 to stay readable
        if (days.length > 60) days = days.slice(days.length - 60);
        var max = Math.max.apply(null, days.map(function(d) { return d.count; }).concat(1));
        var html = '<div style="display:flex; align-items:flex-end; gap:2px; height:160px;">';
        days.forEach(function(d) {
            var pct = max > 0 ? (d.count / max * 100) : 0;
            var label = d.date.getDate() + '/' + (d.date.getMonth() + 1);
            html += '<div class="ax-day-bar" title="' + _esc(label) + ': ' + d.count + ' albaranes">'
                  + '<div class="b" style="height:' + Math.max(2, pct) + '%;"></div>'
                  + '<div class="l">' + _esc(label) + '</div>'
                  + '</div>';
        });
        html += '</div>';
        el.innerHTML = html;
    }

    function _renderStatusMix(agg) {
        var el = document.getElementById('ax-status-mix');
        if (!el) return;
        var palette = {
            'Entregado': '#34C759',
            'Pendiente': '#FF9F0A',
            'Incidencia': '#FF3B30',
            'Anulado': '#888',
            'Devuelto': '#5AC8FA'
        };
        var total = agg.total || 1;
        var ordered = Object.keys(agg.statusCounts).map(function(k) {
            return { k: k, n: agg.statusCounts[k] };
        }).sort(function(a, b) { return b.n - a.n; });
        var rows = ordered.map(function(r) {
            var pct = (r.n / total * 100).toFixed(1);
            var c = palette[r.k] || '#666';
            return '<div class="ax-mix-row">'
                + '<span class="ax-mix-dot" style="background:' + c + ';"></span>'
                + '<span style="flex:1;color:#ddd;">' + _esc(r.k) + '</span>'
                + '<span style="color:#aaa; font-size:0.78rem;">' + r.n + ' · ' + pct + '%</span>'
                + '</div>'
                + '<div class="bar" style="height:6px; background:rgba(255,255,255,0.05); border-radius:3px; overflow:hidden; margin-bottom:8px;">'
                + '<div style="height:100%; width:' + pct + '%; background:' + c + ';"></div>'
                + '</div>';
        }).join('');
        el.innerHTML = rows || '<div style="color:#666; font-size:0.85rem;">Sin datos.</div>';
    }

    function _renderTopRoutes(agg) {
        var el = document.getElementById('ax-top-routes');
        if (!el) return;
        var rows = Object.keys(agg.byRoute).map(function(k) {
            var r = agg.byRoute[k];
            return { name: k, total: r.total, delivered: r.delivered, success: r.total > 0 ? (r.delivered / r.total * 100) : 0 };
        }).sort(function(a, b) { return b.total - a.total; }).slice(0, 10);
        var max = rows.length > 0 ? rows[0].total : 1;
        if (rows.length === 0) {
            el.innerHTML = '<div style="color:#666; font-size:0.85rem;">Sin rutas en este rango.</div>';
            return;
        }
        el.innerHTML = '<table style="width:100%; font-size:0.78rem; border-collapse:collapse;">'
            + '<thead><tr style="color:#888; text-align:left;"><th style="padding:4px 0;">Ruta</th><th style="text-align:right;">Vol.</th><th style="text-align:right;">Éxito</th></tr></thead>'
            + '<tbody>'
            + rows.map(function(r) {
                var pct = r.total / max * 100;
                var ok = r.success.toFixed(0);
                var color = r.success >= 90 ? '#34C759' : r.success >= 70 ? '#FF9F0A' : '#FF3B30';
                return '<tr style="border-top:1px solid rgba(255,255,255,0.04);">'
                    + '<td style="padding:6px 0; color:#ddd;">'
                    + '<div>' + _esc(r.name) + '</div>'
                    + '<div class="bar" style="height:4px; background:rgba(255,255,255,0.05); border-radius:2px; margin-top:3px;"><div style="height:100%; width:' + pct + '%; background:linear-gradient(90deg,#FF4D00,#FFB74D);"></div></div>'
                    + '</td>'
                    + '<td style="text-align:right; color:#fff; font-weight:600;">' + r.total + '</td>'
                    + '<td style="text-align:right; color:' + color + '; font-weight:700;">' + ok + '%</td>'
                    + '</tr>';
            }).join('')
            + '</tbody></table>';
    }

    function _renderTopLocalities(agg) {
        var el = document.getElementById('ax-top-localities');
        if (!el) return;
        var rows = Object.keys(agg.byLoc).map(function(k) { return { name: k, n: agg.byLoc[k] }; })
            .sort(function(a, b) { return b.n - a.n; })
            .slice(0, 10);
        if (rows.length === 0) {
            el.innerHTML = '<div style="color:#666; font-size:0.85rem;">Sin localidades en este rango.</div>';
            return;
        }
        var max = rows[0].n;
        el.innerHTML = rows.map(function(r) {
            return '<div class="ax-bar-row">'
                + '<span class="name" title="' + _esc(r.name) + '">' + _esc(r.name) + '</span>'
                + '<div class="bar"><div style="width:' + (r.n / max * 100) + '%;"></div></div>'
                + '<span class="v">' + r.n + '</span>'
                + '</div>';
        }).join('');
    }

    async function _loadAndRender() {
        if (_loading) return;
        _loading = true;
        var loading = document.getElementById('ax-loading');
        var empty = document.getElementById('ax-empty');
        if (loading) loading.style.display = 'block';
        if (empty) empty.style.display = 'none';
        try {
            var data = await _fetchTickets(_currentRange);
            _cache = data;
            var agg = _aggregate(data);
            var bounds = data.bounds;
            var sumEl = document.getElementById('ax-summary');
            if (sumEl) {
                sumEl.textContent = _rangeLabel(_currentRange) + ' · '
                    + bounds.fromDate.toLocaleDateString('es-ES') + ' → ' + bounds.toDate.toLocaleDateString('es-ES')
                    + ' · ' + agg.total + ' albaranes en muestra';
            }
            if (agg.total === 0) {
                if (empty) empty.style.display = 'block';
            } else {
                _renderKpis(agg, bounds);
                _renderDailyBars(agg, bounds);
                _renderStatusMix(agg);
                _renderTopRoutes(agg);
                _renderTopLocalities(agg);
            }
        } catch(e) {
            console.error('[ANALYTICS] error:', e);
            var sumEl2 = document.getElementById('ax-summary');
            if (sumEl2) {
                sumEl2.textContent = '⚠️ Error: ' + e.message;
                sumEl2.style.color = '#FF3B30';
            }
        } finally {
            if (loading) loading.style.display = 'none';
            _loading = false;
        }
    }

    function _ensureMounted() {
        _container = document.getElementById('erp-tab-analytics');
        if (!_container) return false;
        if (!_initialized) {
            _container.innerHTML = _layout();
            _renderRangeBar();
            _initialized = true;
        }
        return true;
    }

    // Hook: when the analytics tab becomes visible, load data.
    function _watchVisibility() {
        if (typeof MutationObserver === 'undefined') return;
        var target = document.getElementById('erp-tab-analytics');
        if (!target) {
            // Tab wrapper might mount after this script. Retry.
            setTimeout(_watchVisibility, 500);
            return;
        }
        new MutationObserver(function() {
            if (target.style.display !== 'none') {
                if (_ensureMounted()) {
                    if (!_cache) _loadAndRender();
                }
            }
        }).observe(target, { attributes: true, attributeFilter: ['style'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _watchVisibility);
    } else {
        _watchVisibility();
    }

    // Expose for manual refresh from console
    window.analyticsRefresh = function() { _cache = null; _loadAndRender(); };
})();
