/**
 * NOVAPACK REPARTIDOR — Co-piloto de voz
 *
 * Modo manos libres para conducción:
 *  - Botón en la cabecera que activa/desactiva el modo.
 *  - Cuando está activo: anuncia automáticamente la siguiente entrega
 *    pendiente cuando la lista cambia (nueva entrega asignada o tras
 *    completar una). Para evitar spam, mantiene memoria del último
 *    anuncio.
 *  - Botón de "leer ahora" en cada delivery-card (TTS de nombre + dirección).
 *  - Repite la última frase si el chófer pulsa el icono.
 *
 * Usa SpeechSynthesis nativa — sin dependencias.
 */
(function() {
    'use strict';

    var _enabled = false;
    var _lastAnnouncedId = null;
    var _voiceEs = null;
    var _lastUtterance = '';
    var _badge = null;

    function _supports() {
        return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
    }

    function _pickVoice() {
        if (!_supports()) return null;
        if (_voiceEs) return _voiceEs;
        var voices = window.speechSynthesis.getVoices();
        // Prefer a Spanish female voice; fall back to any es-* voice; else null (browser default).
        _voiceEs = voices.find(function(v) { return /es-(ES|US)/i.test(v.lang) && /female|mujer|monica|paulina|marisol|elena/i.test(v.name); })
                || voices.find(function(v) { return /^es/i.test(v.lang); })
                || null;
        return _voiceEs;
    }

    function _speak(text) {
        if (!_supports()) return;
        if (!text) return;
        try {
            window.speechSynthesis.cancel();
            var u = new SpeechSynthesisUtterance(text);
            u.lang = 'es-ES';
            u.rate = 1.0;
            u.pitch = 1.0;
            u.volume = 1.0;
            var v = _pickVoice();
            if (v) u.voice = v;
            window.speechSynthesis.speak(u);
            _lastUtterance = text;
        } catch(e) {
            console.warn('[COPILOTO] speak error:', e.message);
        }
    }

    function _formatStop(d, indexHint) {
        if (!d) return '';
        var name = d.receiver || d.clientName || 'Sin nombre';
        var bits = [];
        if (indexHint != null) bits.push('Parada ' + indexHint);
        bits.push(name);
        var loc = [d.localidad, d.cp].filter(Boolean).join(' ');
        if (loc) bits.push('en ' + loc);
        if (d.address) bits.push(d.address);
        if (d.timeSlot) bits.push(d.timeSlot === 'MAÑANA' ? 'horario de mañana' : 'horario de tarde');
        var pkgs = (d.packagesList && d.packagesList.length) || parseInt(d.packages || 0, 10);
        if (pkgs > 0) bits.push(pkgs + (pkgs === 1 ? ' bulto' : ' bultos'));
        return bits.join('. ');
    }

    function _findNextPending() {
        if (typeof deliveries === 'undefined') return null;
        for (var i = 0; i < deliveries.length; i++) {
            var d = deliveries[i];
            if (d.status === 'Entregado' || d.delivered) continue;
            if (d.status === 'Anulado' || d.status === 'Devuelto') continue;
            return { d: d, idx: i + 1 };
        }
        return null;
    }

    function _announceNextIfChanged() {
        if (!_enabled) return;
        var nxt = _findNextPending();
        if (!nxt) return;
        var id = nxt.d._id || nxt.d.id;
        if (id === _lastAnnouncedId) return;
        _lastAnnouncedId = id;
        _speak('Siguiente. ' + _formatStop(nxt.d, nxt.idx));
    }

    function _setEnabled(on) {
        _enabled = !!on;
        try { localStorage.setItem('copilotoEnabled', _enabled ? '1' : '0'); } catch(e) {}
        if (_badge) {
            _badge.classList.toggle('active', _enabled);
            _badge.title = _enabled ? 'Co-piloto activo (toca para desactivar)' : 'Activar co-piloto de voz';
        }
        if (_enabled) {
            // Try to wake the engine on a user gesture (some browsers throttle TTS otherwise).
            _speak('Co-piloto activado.');
            _lastAnnouncedId = null;
            _announceNextIfChanged();
        } else {
            try { window.speechSynthesis.cancel(); } catch(e) {}
        }
    }

    function _injectHeaderButton() {
        var actions = document.querySelector('.header-actions');
        if (!actions) return;
        if (document.getElementById('btn-copiloto')) return;
        var btn = document.createElement('button');
        btn.id = 'btn-copiloto';
        btn.className = 'header-btn';
        btn.title = 'Activar co-piloto de voz';
        btn.innerHTML = '<span class="material-symbols-outlined">record_voice_over</span>';
        btn.addEventListener('click', function() { _setEnabled(!_enabled); });
        // Slot before logout
        var logout = document.getElementById('btn-logout');
        if (logout && logout.parentElement) {
            logout.parentElement.insertBefore(btn, logout);
        } else {
            actions.appendChild(btn);
        }
        _badge = btn;
    }

    function _injectStyle() {
        if (document.getElementById('copiloto-style')) return;
        var s = document.createElement('style');
        s.id = 'copiloto-style';
        s.textContent = ''
            + '#btn-copiloto.active{background:#34C759;color:#000;}'
            + '#btn-copiloto.active .material-symbols-outlined{color:#000;}'
            + '.dc-speak{position:absolute; top:8px; right:8px; background:rgba(52,199,89,0.12); border:1px solid rgba(52,199,89,0.35); color:#34C759; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer;}'
            + '.dc-speak:active{transform:scale(0.92);}'
            + '.delivery-card{position:relative;}';
        document.head.appendChild(s);
    }

    // After every render, attach a per-card speak button. Hooks via observer to
    // avoid touching reparto.js's render loop directly.
    function _attachSpeakButtons() {
        var list = document.getElementById('delivery-list');
        if (!list) return;
        list.querySelectorAll('.delivery-card').forEach(function(card) {
            if (card.querySelector('.dc-speak')) return;
            var id = card.getAttribute('data-id');
            if (!id) return;
            var btn = document.createElement('button');
            btn.className = 'dc-speak';
            btn.title = 'Leer dirección';
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem;">campaign</span>';
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (typeof deliveries === 'undefined') return;
                var d = deliveries.find(function(x) { return x._id === id; });
                if (d) _speak(_formatStop(d));
            });
            card.appendChild(btn);
        });
    }

    function _watchList() {
        var list = document.getElementById('delivery-list');
        if (!list) { setTimeout(_watchList, 500); return; }
        new MutationObserver(function() {
            _attachSpeakButtons();
            // Auto-announce if enabled and the head of the queue moved
            _announceNextIfChanged();
        }).observe(list, { childList: true, subtree: false });
    }

    function _boot() {
        if (!_supports()) return; // No TTS engine — skip silently
        _injectStyle();
        _injectHeaderButton();
        _attachSpeakButtons();
        _watchList();

        // Restore previous state
        try {
            if (localStorage.getItem('copilotoEnabled') === '1') {
                // Don't auto-speak on cold load — wait for first user interaction
                // to comply with autoplay policies. Just paint the badge.
                _enabled = true;
                if (_badge) {
                    _badge.classList.add('active');
                    _badge.title = 'Co-piloto activo (toca para desactivar)';
                }
            }
        } catch(e) {}

        // Voices may load asynchronously
        if (window.speechSynthesis && typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
            window.speechSynthesis.onvoiceschanged = function() { _voiceEs = null; _pickVoice(); };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _boot);
    } else {
        _boot();
    }

    // Manual API
    window.copiloto = {
        enable: function() { _setEnabled(true); },
        disable: function() { _setEnabled(false); },
        speak: _speak,
        repeat: function() { if (_lastUtterance) _speak(_lastUtterance); },
        announceNext: function() { _lastAnnouncedId = null; _announceNextIfChanged(); }
    };
})();
