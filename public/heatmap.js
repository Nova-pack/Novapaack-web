/**
 * NOVAPACK CLOUD — Heatmap de retrasos
 *
 * Mapa de calor sobre Google Maps que muestra dónde se concentran los
 * retrasos de entrega. La intensidad de cada punto se pondera por el
 * tiempo de entrega (createdAt → deliveredAt) en horas.
 *
 * Coordenadas: usa `signatureMeta.lat/lng` cuando está disponible (firma
 * digital del POD, idea 2). Para tickets sin signatureMeta cae a
 * geocodificar la dirección con caché en localStorage para no quemar
 * cuota de Maps.
 *
 * Hotspots: aparte del heatmap, panel lateral con top localidades / CPs
 * por retraso medio y conteo.
 */
(function() {
    'use strict';

    if (typeof db === 'undefined') return;

    var _container = null;
    var _initialized = false;
    var _map = null;
    var _heatmap = null;
    var _markers = [];
    var _currentRange = '30d';
    var _delayThresholdH = 24;
    var _data = [];
    var _loading = false;
    var _geocoder = null;
    var _geocodeCache = _loadGeocodeCache();

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
        var to = Date.now();
        var from;
        switch (key) {
            case '7d':  from = to - 7 * 86400000; break;
            case '90d': from = to - 90 * 86400000; break;
            case 'all': from = 0; break;
            case '30d':
            default:    from = to - 30 * 86400000; break;
        }
        return { from: from, to: to };
    }

    function _loadGeocodeCache() {
        try { return JSON.parse(localStorage.getItem('hm_geocode_cache') || '{}'); }
        catch(e) { return {}; }
    }
    function _saveGeocodeCache() {
        try { localStorage.setItem('hm_geocode_cache', JSON.stringify(_geocodeCache)); } catch(e) {}
    }

    function _geocodeKey(t) {
        var bits = [t.address, t.localidad, t.cp, t.province, 'España'].filter(Boolean);
        return bits.join(', ').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function _geocode(t) {
        return new Promise(function(resolve) {
            var key = _geocodeKey(t);
            if (!key) return resolve(null);
            if (_geocodeCache[key]) return resolve(_geocodeCache[key]);
            if (!window.google || !google.maps || !google.maps.Geocoder) return resolve(null);
            if (!_geocoder) _geocoder = new google.maps.Geocoder();
            _geocoder.geocode({ address: key }, function(results, status) {
                if (status === 'OK' && results && results[0]) {
                    var loc = results[0].geometry.location;
                    var coord = { lat: loc.lat(), lng: loc.lng() };
                    _geocodeCache[key] = coord;
                    _saveGeocodeCache();
                    resolve(coord);
                } else {
                    _geocodeCache[key] = null; // negative cache to avoid retrying
                    _saveGeocodeCache();
                    resolve(null);
                }
            });
        });
    }

    function _delayHours(t) {
        var c = _toMillis(t.createdAt);
        var d = _toMillis(t.deliveredAt);
        if (!c || !d || d < c) return null;
        return (d - c) / 3600000;
    }

    function _layout() {
        return ''
            + '<div style="background:linear-gradient(90deg, #001f3f, #003366); padding:6px 15px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">'
            + '  <span class="material-symbols-outlined" style="color:white; font-size:1.3rem;">whatshot</span>'
            + '  <span style="color:white; font-weight:700; font-size:0.9rem; letter-spacing:0.5px;">HEATMAP DE RETRASOS</span>'
            + '  <div style="flex:1;"></div>'
            + '  <div id="hm-range-bar" style="display:flex; gap:6px; flex-wrap:wrap;"></div>'
            + '  <span style="color:rgba(255,255,255,0.6); font-size:0.78rem; margin-left:10px;">Umbral retraso (h):</span>'
            + '  <input id="hm-threshold" type="number" min="1" max="168" step="1" value="' + _delayThresholdH + '" style="width:70px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:white; padding:3px 6px; border-radius:3px; font-size:0.8rem;">'
            + '  <button id="hm-refresh-btn" style="background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.2); color:white; padding:4px 12px; font-size:0.78rem; cursor:pointer; border-radius:3px;">Actualizar</button>'
            + '</div>'
            + '<div style="display:grid; grid-template-columns:1fr 320px; gap:0; height:calc(100vh - 130px); min-height:500px;">'
            + '  <div id="hm-map" style="background:#1a1a2e;"></div>'
            + '  <div style="background:#0a0a0a; border-left:1px solid rgba(255,255,255,0.08); padding:16px; overflow-y:auto;">'
            + '    <div id="hm-summary" style="font-size:0.78rem; color:#888; margin-bottom:12px;">Cargando…</div>'
            + '    <div style="margin-bottom:18px;">'
            + '      <h3 style="font-size:0.78rem; color:#FF8A50; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">KPIs de retraso</h3>'
            + '      <div id="hm-kpis" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;"></div>'
            + '    </div>'
            + '    <div style="margin-bottom:18px;">'
            + '      <h3 style="font-size:0.78rem; color:#FF8A50; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Top localidades retrasadas</h3>'
            + '      <div id="hm-top-localities"></div>'
            + '    </div>'
            + '    <div>'
            + '      <h3 style="font-size:0.78rem; color:#FF8A50; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Top CP retrasados</h3>'
            + '      <div id="hm-top-cps"></div>'
            + '    </div>'
            + '  </div>'
            + '</div>'
            + '<style>'
            + '.hm-range-btn{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.85);padding:3px 12px;border-radius:100px;cursor:pointer;font-size:0.75rem;font-weight:600;}'
            + '.hm-range-btn.active{background:#FF4D00;color:#000;border-color:#FF4D00;}'
            + '.hm-kpi{background:#161616;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;}'
            + '.hm-kpi .v{font-size:1.2rem;font-weight:800;color:#fff;line-height:1.1;}'
            + '.hm-kpi .l{font-size:0.65rem;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:3px;}'
            + '.hm-row{display:flex;align-items:center;gap:8px;font-size:0.78rem;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);}'
            + '.hm-row .name{flex:1;color:#ddd;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;}'
            + '.hm-row .badge{background:rgba(255,77,0,0.18);color:#FF8A50;padding:2px 8px;border-radius:8px;font-size:0.7rem;font-weight:700;}'
            + '.hm-row .count{color:#888;font-size:0.7rem;}'
            + '</style>';
    }

    function _renderRangeBar() {
        var el = document.getElementById('hm-range-bar');
        if (!el) return;
        var ranges = [['7d','7d'],['30d','30d'],['90d','90d'],['all','Todo']];
        el.innerHTML = ranges.map(function(r) {
            var cls = (r[0] === _currentRange) ? 'hm-range-btn active' : 'hm-range-btn';
            return '<button class="' + cls + '" data-range="' + r[0] + '">' + _esc(r[1]) + '</button>';
        }).join('');
        el.querySelectorAll('button').forEach(function(b) {
            b.addEventListener('click', function() {
                _currentRange = b.getAttribute('data-range');
                _renderRangeBar();
                _loadAndRender();
            });
        });
    }

    async function _loadDelivered() {
        var bounds = _rangeBounds(_currentRange);
        var query = db.collection('tickets').where('status', '==', 'Entregado').orderBy('createdAt', 'desc').limit(2000);
        if (bounds.from > 0) {
            query = db.collection('tickets')
                .where('status', '==', 'Entregado')
                .where('createdAt', '>=', firebase.firestore.Timestamp.fromMillis(bounds.from))
                .orderBy('createdAt', 'desc')
                .limit(2000);
        }
        var snap = await query.get();
        var out = [];
        snap.forEach(function(doc) {
            var d = doc.data();
            d._id = doc.id;
            out.push(d);
        });
        return out;
    }

    function _waitForGoogleMaps() {
        return new Promise(function(resolve, reject) {
            var tries = 0;
            (function check() {
                if (window.google && google.maps && google.maps.visualization) return resolve();
                if (++tries > 60) return reject(new Error('Google Maps no se cargó (visualization library).'));
                setTimeout(check, 200);
            })();
        });
    }

    function _ensureMap() {
        if (_map) return _map;
        _map = new google.maps.Map(document.getElementById('hm-map'), {
            center: { lat: 40.4168, lng: -3.7038 }, // Madrid as fallback
            zoom: 6,
            mapTypeId: 'roadmap',
            styles: [
                { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
                { elementType: 'labels.text.fill', stylers: [{ color: '#aaa' }] },
                { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0a0a' }] },
                { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a3e' }] },
                { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0a0a' }] },
                { featureType: 'poi', stylers: [{ visibility: 'off' }] }
            ]
        });
        return _map;
    }

    async function _enrichWithCoords(tickets) {
        var enriched = [];
        // First pass: tickets with explicit signatureMeta GPS
        var pending = [];
        tickets.forEach(function(t) {
            if (t.signatureMeta && typeof t.signatureMeta.lat === 'number' && typeof t.signatureMeta.lng === 'number') {
                enriched.push({ t: t, lat: t.signatureMeta.lat, lng: t.signatureMeta.lng });
            } else {
                pending.push(t);
            }
        });
        // Second pass: geocode the rest. Use cache. Hard cap on actual API calls
        // per session to avoid burning quota.
        var apiCallsRemaining = 80;
        for (var i = 0; i < pending.length; i++) {
            var t = pending[i];
            var key = _geocodeKey(t);
            if (!key) continue;
            if (_geocodeCache.hasOwnProperty(key)) {
                var cached = _geocodeCache[key];
                if (cached) enriched.push({ t: t, lat: cached.lat, lng: cached.lng });
                continue;
            }
            if (apiCallsRemaining <= 0) break;
            try {
                var coord = await _geocode(t);
                apiCallsRemaining--;
                if (coord) enriched.push({ t: t, lat: coord.lat, lng: coord.lng });
                // Soft throttle to avoid OVER_QUERY_LIMIT
                await new Promise(function(r) { setTimeout(r, 60); });
            } catch(e) { /* silent */ }
        }
        return enriched;
    }

    function _renderHeatmapPoints(points) {
        // Clear previous
        if (_heatmap) { _heatmap.setMap(null); _heatmap = null; }
        _markers.forEach(function(m) { m.setMap(null); });
        _markers = [];

        if (points.length === 0) return;

        var bounds = new google.maps.LatLngBounds();
        var data = points.map(function(p) {
            var ll = new google.maps.LatLng(p.lat, p.lng);
            bounds.extend(ll);
            // Weight = clamped delay above threshold (more delay → hotter spot)
            var w = Math.max(0.5, Math.min(p.delayH / _delayThresholdH, 8));
            return { location: ll, weight: w };
        });
        _heatmap = new google.maps.visualization.HeatmapLayer({
            data: data,
            map: _map,
            radius: 28,
            opacity: 0.75,
            gradient: [
                'rgba(0,255,200,0)',
                'rgba(0,255,200,0.5)',
                'rgba(255,235,59,0.7)',
                'rgba(255,152,0,0.85)',
                'rgba(255,77,0,1)',
                'rgba(255,59,48,1)',
                'rgba(180,30,30,1)'
            ]
        });
        // Mark slow points with subtle dots so they're clickable
        points.forEach(function(p) {
            if (p.delayH < _delayThresholdH) return;
            var marker = new google.maps.Marker({
                position: { lat: p.lat, lng: p.lng },
                map: _map,
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 4,
                    fillColor: '#FF3B30',
                    fillOpacity: 0.9,
                    strokeWeight: 0,
                },
                title: (p.t.id || '?') + ' · ' + p.delayH.toFixed(1) + 'h\n' + (p.t.localidad || '') + ' (' + (p.t.cp || '') + ')'
            });
            _markers.push(marker);
        });
        if (!bounds.isEmpty()) {
            _map.fitBounds(bounds);
            // Don't zoom in too tight when there's just one cluster
            var listener = google.maps.event.addListener(_map, 'idle', function() {
                if (_map.getZoom() > 14) _map.setZoom(14);
                google.maps.event.removeListener(listener);
            });
        }
    }

    function _renderSidebar(tickets, points) {
        var n = tickets.length;
        var withDelay = tickets.map(_delayHours).filter(function(d) { return d != null; });
        var avgH = withDelay.length ? withDelay.reduce(function(a, b) { return a + b; }, 0) / withDelay.length : 0;
        var p95 = (function() {
            if (withDelay.length === 0) return 0;
            var sorted = withDelay.slice().sort(function(a, b) { return a - b; });
            return sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
        })();
        var slowCount = withDelay.filter(function(h) { return h >= _delayThresholdH; }).length;

        function fmtH(h) {
            if (h < 1) return Math.round(h * 60) + 'm';
            if (h < 24) return h.toFixed(1) + 'h';
            return (h / 24).toFixed(1) + 'd';
        }

        var sumEl = document.getElementById('hm-summary');
        if (sumEl) {
            sumEl.innerHTML = ''
                + n + ' entregas en rango · '
                + points.length + ' con coordenadas · '
                + slowCount + ' por encima del umbral';
        }

        var kpisEl = document.getElementById('hm-kpis');
        if (kpisEl) {
            kpisEl.innerHTML = ''
                + '<div class="hm-kpi"><div class="v">' + fmtH(avgH) + '</div><div class="l">Tiempo medio</div></div>'
                + '<div class="hm-kpi"><div class="v">' + fmtH(p95) + '</div><div class="l">P95 (peor 5%)</div></div>'
                + '<div class="hm-kpi"><div class="v">' + slowCount + '</div><div class="l">Por encima umbral</div></div>'
                + '<div class="hm-kpi"><div class="v">' + (withDelay.length ? Math.round(slowCount / withDelay.length * 100) + '%' : '—') + '</div><div class="l">% retrasados</div></div>';
        }

        // Aggregate by locality and CP
        var byLoc = {};
        var byCp = {};
        tickets.forEach(function(t) {
            var h = _delayHours(t);
            if (h == null) return;
            var loc = (t.localidad || '').toUpperCase().trim();
            var cp = (t.cp || '').toString().trim();
            if (loc) {
                if (!byLoc[loc]) byLoc[loc] = { sum: 0, n: 0, slow: 0 };
                byLoc[loc].sum += h;
                byLoc[loc].n++;
                if (h >= _delayThresholdH) byLoc[loc].slow++;
            }
            if (cp) {
                if (!byCp[cp]) byCp[cp] = { sum: 0, n: 0, slow: 0 };
                byCp[cp].sum += h;
                byCp[cp].n++;
                if (h >= _delayThresholdH) byCp[cp].slow++;
            }
        });

        function topRows(map, label) {
            var rows = Object.keys(map).map(function(k) {
                var v = map[k];
                return { name: k, avg: v.sum / v.n, n: v.n, slow: v.slow };
            }).filter(function(r) { return r.n >= 2; })
              .sort(function(a, b) { return b.avg - a.avg; })
              .slice(0, 8);
            if (rows.length === 0) {
                return '<div style="color:#666; font-size:0.78rem;">Sin datos suficientes.</div>';
            }
            return rows.map(function(r) {
                return '<div class="hm-row">'
                    + '<span class="name" title="' + _esc(r.name) + '">' + _esc(r.name) + '</span>'
                    + '<span class="count">' + r.n + ' · ' + r.slow + ' lentos</span>'
                    + '<span class="badge">' + fmtH(r.avg) + '</span>'
                    + '</div>';
            }).join('');
        }
        var locEl = document.getElementById('hm-top-localities');
        var cpEl = document.getElementById('hm-top-cps');
        if (locEl) locEl.innerHTML = topRows(byLoc);
        if (cpEl) cpEl.innerHTML = topRows(byCp);
    }

    async function _loadAndRender() {
        if (_loading) return;
        _loading = true;
        var sumEl = document.getElementById('hm-summary');
        if (sumEl) { sumEl.style.color = '#888'; sumEl.textContent = 'Cargando entregas…'; }
        try {
            await _waitForGoogleMaps();
            _ensureMap();

            var tickets = await _loadDelivered();
            _data = tickets;
            if (sumEl) sumEl.textContent = 'Geocodificando ' + tickets.length + ' direcciones…';

            var enriched = await _enrichWithCoords(tickets);

            // Build heatmap points: each point gets weight from its delay (h)
            var points = enriched.map(function(e) {
                var h = _delayHours(e.t);
                if (h == null) return null;
                return { lat: e.lat, lng: e.lng, delayH: h, t: e.t };
            }).filter(Boolean);

            _renderHeatmapPoints(points);
            _renderSidebar(tickets, points);
        } catch(e) {
            console.error('[HEATMAP] error:', e);
            if (sumEl) {
                sumEl.style.color = '#FF3B30';
                sumEl.textContent = '⚠️ ' + e.message;
            }
        } finally {
            _loading = false;
        }
    }

    function _ensureMounted() {
        _container = document.getElementById('erp-tab-heatmap');
        if (!_container) return false;
        if (!_initialized) {
            _container.innerHTML = _layout();
            _renderRangeBar();
            document.getElementById('hm-refresh-btn').addEventListener('click', function() {
                var tEl = document.getElementById('hm-threshold');
                var v = parseInt(tEl.value, 10);
                if (v > 0) _delayThresholdH = v;
                _loadAndRender();
            });
            _initialized = true;
        }
        return true;
    }

    function _watchVisibility() {
        var target = document.getElementById('erp-tab-heatmap');
        if (!target) { setTimeout(_watchVisibility, 500); return; }
        new MutationObserver(function() {
            if (target.style.display !== 'none') {
                if (_ensureMounted() && _data.length === 0 && !_loading) {
                    _loadAndRender();
                } else if (_ensureMounted() && _map) {
                    // Force resize on re-show so the map renders correctly
                    google.maps.event.trigger(_map, 'resize');
                }
            }
        }).observe(target, { attributes: true, attributeFilter: ['style'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _watchVisibility);
    } else {
        _watchVisibility();
    }

    window.heatmapRefresh = _loadAndRender;
})();
