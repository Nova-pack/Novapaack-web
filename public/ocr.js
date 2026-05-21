/**
 * NOVAPACK REPARTIDOR — OCR de etiquetas (idea 7)
 *
 * Cuando el QR de un bulto está dañado o ilegible, el chófer puede tomar
 * una foto del albarán y OCRearla para extraer el ID. Tesseract.js se
 * carga bajo demanda desde CDN para no añadir ~2MB al bundle del cold-start.
 *
 * Heurística: tras OCR, busca tokens que casen con un patrón típico de
 * albarán (NP-XXXX, FAC-..., o secuencias de 4-12 dígitos). Por cada
 * candidato intenta encontrar el ticket en deliveries[] (cache local del
 * chófer); si hay un único match exacto, abre la confirmación de entrega
 * directamente. Si hay varios o ninguno, propone la lista al chófer.
 */
(function() {
    'use strict';

    var TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    var _tessLoading = null;

    function _status(msg, color) {
        var el = document.getElementById('ocr-status');
        if (!el) return;
        el.textContent = msg || '';
        el.style.color = color || 'var(--text-dim)';
    }

    function _loadTesseract() {
        if (window.Tesseract) return Promise.resolve();
        if (_tessLoading) return _tessLoading;
        _tessLoading = new Promise(function(resolve, reject) {
            var s = document.createElement('script');
            s.src = TESSERACT_CDN;
            s.onload = function() { resolve(); };
            s.onerror = function() {
                _tessLoading = null;
                reject(new Error('No se pudo descargar Tesseract.js'));
            };
            document.head.appendChild(s);
        });
        return _tessLoading;
    }

    function _candidateIds(text) {
        if (!text) return [];
        var ids = new Set();
        // NP-XXXX style
        var re1 = /\bN[Pp][\s\-_]?(\d{3,8})\b/g;
        var m;
        while ((m = re1.exec(text)) !== null) ids.add('NP-' + m[1]);
        // FAC-YY-N
        var re2 = /\bF[Aa][Cc][\s\-_]?(\d{2})[\s\-_]?(\d{1,6})\b/g;
        while ((m = re2.exec(text)) !== null) ids.add('FAC-' + m[1] + '-' + m[2]);
        // YY-NNN style (year-number business id like 26-001)
        var re3 = /\b(\d{2})[\-_](\d{2,5})\b/g;
        while ((m = re3.exec(text)) !== null) ids.add(m[1] + '-' + m[2]);
        // Pure numeric runs ≥4 digits — fallback last
        var re4 = /\b(\d{4,12})\b/g;
        while ((m = re4.exec(text)) !== null) ids.add(m[1]);
        return Array.from(ids);
    }

    function _matchInDeliveries(candidates) {
        if (typeof deliveries === 'undefined') return [];
        var matches = [];
        var seen = new Set();
        candidates.forEach(function(cid) {
            var lc = cid.toUpperCase();
            deliveries.forEach(function(d) {
                var did = (d.id || d._id || '').toString().toUpperCase();
                if (did === lc || did.indexOf(lc) !== -1 || lc.indexOf(did) !== -1) {
                    if (!seen.has(d._id)) {
                        seen.add(d._id);
                        matches.push(d);
                    }
                }
            });
        });
        return matches;
    }

    async function _runOcr(file) {
        _status('Cargando OCR…', '#5DADE2');
        try {
            await _loadTesseract();
        } catch(e) {
            _status('No se pudo cargar el OCR. Comprueba la conexión.', '#FF3B30');
            return;
        }
        _status('Analizando imagen… (puede tardar 5-15s)', '#5DADE2');
        try {
            var result = await window.Tesseract.recognize(file, 'spa+eng', {
                logger: function(m) {
                    if (m && m.status === 'recognizing text' && typeof m.progress === 'number') {
                        _status('Analizando… ' + Math.round(m.progress * 100) + '%', '#5DADE2');
                    }
                }
            });
            var text = (result && result.data && result.data.text) || '';
            var candidates = _candidateIds(text);
            if (candidates.length === 0) {
                _status('No se detectó ningún número de albarán. Prueba con otra foto.', '#FF9F0A');
                return;
            }
            var matches = _matchInDeliveries(candidates);
            if (matches.length === 1) {
                _status('✅ Detectado ' + (matches[0].id || matches[0]._id) + ' — abriendo…', '#34C759');
                if (typeof loadTicketForConfirmation === 'function') {
                    loadTicketForConfirmation(matches[0]);
                }
                return;
            }
            if (matches.length > 1) {
                _showCandidatesList(matches);
                _status('Varios albaranes posibles — elige uno.', '#FF9F0A');
                return;
            }
            // No match in current driver's list — fall back to setting the
            // strongest candidate in the manual input so the driver can hit
            // search.
            var input = document.getElementById('manual-id-input');
            if (input) input.value = candidates[0];
            _status('Detectado: ' + candidates.join(', ') + ' — pulsa buscar.', '#FF9F0A');
        } catch(e) {
            console.error('[OCR] error:', e);
            _status('Error OCR: ' + (e.message || e), '#FF3B30');
        }
    }

    function _showCandidatesList(matches) {
        var existing = document.getElementById('ocr-candidates');
        if (existing) existing.remove();
        var box = document.createElement('div');
        box.id = 'ocr-candidates';
        box.style.cssText = 'background:#161616; border:1px solid rgba(93,173,226,0.25); border-radius:8px; padding:8px; margin-top:8px; display:flex; flex-direction:column; gap:6px;';
        matches.slice(0, 6).forEach(function(d) {
            var btn = document.createElement('button');
            btn.style.cssText = 'background:#1a1a1a; border:1px solid #333; color:#ddd; padding:8px 10px; border-radius:6px; text-align:left; cursor:pointer; font-size:0.82rem;';
            btn.innerHTML = '<strong>' + (d.id || d._id) + '</strong> · ' + (d.receiver || 'sin nombre') + ' (' + (d.localidad || '') + ')';
            btn.addEventListener('click', function() {
                box.remove();
                if (typeof loadTicketForConfirmation === 'function') loadTicketForConfirmation(d);
                _status('', '');
            });
            box.appendChild(btn);
        });
        var status = document.getElementById('ocr-status');
        if (status && status.parentElement) status.parentElement.appendChild(box);
    }

    function _wire() {
        var btn = document.getElementById('btn-ocr-scan');
        var input = document.getElementById('ocr-photo-input');
        if (!btn || !input) return;
        btn.addEventListener('click', function() { input.click(); });
        input.addEventListener('change', function(e) {
            var f = e.target.files && e.target.files[0];
            if (!f) return;
            _runOcr(f);
            input.value = '';
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _wire);
    } else {
        _wire();
    }
})();
