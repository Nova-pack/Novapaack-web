/**
 * NOVAPACK REPARTIDOR — Co-piloto de voz (v2)
 *
 * Asistente manos libres para conducción en la furgo.
 *
 * Capacidades:
 *  - 🔊 TTS automático de la siguiente parada cuando la lista cambia.
 *  - 🎤 Comandos por voz (push-to-talk):
 *       "siguiente" / "próxima"       → anuncia próxima parada
 *       "repite"                      → repite la última frase
 *       "ruta" / "ruta completa"      → lee TODAS las pendientes en orden
 *       "estado" / "cuántas"          → "X pendientes, Y entregadas"
 *       "hora" / "fecha"              → dice fecha y hora
 *       "para" / "calla" / "stop"     → cancela TTS
 *       "ayuda"                       → lista de comandos
 *  - 📋 Action-sheet por tarjeta (botón verde de la card):
 *       🔊 Leer · 🗺️ Navegar · 📞 Llamar · 📋 Detalles
 *  - ✨ Resaltado visual de la tarjeta mientras se lee.
 *  - 👋 Saludo al iniciar (opcional, por config).
 *  - ⚙️ Ajustes (pulsación larga en el botón copiloto): velocidad, voz,
 *       activar saludo, activar voz por orden.
 *  - Persistencia de estado + ajustes en localStorage.
 *
 * Sin dependencias. Web Speech API (SpeechSynthesis + SpeechRecognition).
 */
(function() {
    'use strict';

    // ──────────────────────────────────────────────────
    // Estado
    // ──────────────────────────────────────────────────
    var DEFAULT_SETTINGS = {
        rate: 1.0,
        pitch: 1.0,
        voiceUri: null,
        greetOnLoad: true,
        announceList: true,
        voiceCommandsEnabled: false
    };
    var _settings = Object.assign({}, DEFAULT_SETTINGS);
    var _enabled = false;
    var _lastAnnouncedId = null;
    var _voiceCache = null;
    var _lastUtterance = '';
    var _currentlySpeakingCardId = null;
    var _rec = null;            // SpeechRecognition instance (push-to-talk)
    var _recListening = false;
    var _badge = null;          // header copiloto button
    var _micBtn = null;         // header mic button
    var _greetingDone = false;

    // ──────────────────────────────────────────────────
    // Persistencia
    // ──────────────────────────────────────────────────
    function _saveSettings() {
        try { localStorage.setItem('copilotoSettings', JSON.stringify(_settings)); } catch(e) {}
    }
    function _loadSettings() {
        try {
            var raw = localStorage.getItem('copilotoSettings');
            if (raw) _settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
        } catch(e) {}
    }

    // ──────────────────────────────────────────────────
    // TTS — núcleo
    // ──────────────────────────────────────────────────
    function _supports() {
        return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
    }
    function _supportsRecognition() {
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    function _allVoices() {
        return _supports() ? (window.speechSynthesis.getVoices() || []) : [];
    }

    function _pickVoice() {
        if (!_supports()) return null;
        if (_voiceCache) return _voiceCache;
        var voices = _allVoices();
        if (_settings.voiceUri) {
            var pref = voices.find(function(v) { return v.voiceURI === _settings.voiceUri; });
            if (pref) { _voiceCache = pref; return pref; }
        }
        _voiceCache = voices.find(function(v) { return /es-(ES|US)/i.test(v.lang) && /female|mujer|monica|paulina|marisol|elena|lupe/i.test(v.name); })
                   || voices.find(function(v) { return /^es/i.test(v.lang); })
                   || null;
        return _voiceCache;
    }

    function _speak(text, opts) {
        if (!_supports() || !text) return;
        try {
            window.speechSynthesis.cancel();
            var u = new SpeechSynthesisUtterance(text);
            u.lang = 'es-ES';
            u.rate = (opts && opts.rate) || _settings.rate || 1.0;
            u.pitch = (opts && opts.pitch) || _settings.pitch || 1.0;
            u.volume = 1.0;
            var v = _pickVoice();
            if (v) u.voice = v;
            if (opts && opts.onEnd) u.onend = opts.onEnd;
            window.speechSynthesis.speak(u);
            _lastUtterance = text;
        } catch(e) {
            console.warn('[COPILOTO] speak error:', e.message);
        }
    }

    function _cancelSpeech() {
        try { window.speechSynthesis.cancel(); } catch(e) {}
        _setSpeakingCard(null);
    }

    // ──────────────────────────────────────────────────
    // Helpers de datos
    // ──────────────────────────────────────────────────
    function _getDeliveries() {
        // Reparto.js expone window.deliveries tras cada render
        if (Array.isArray(window.deliveries)) return window.deliveries;
        return [];
    }

    function _isPending(d) {
        if (!d) return false;
        if (d.status === 'Entregado' || d.delivered) return false;
        if (d.status === 'Anulado' || d.status === 'Devuelto') return false;
        return true;
    }

    function _findById(id) {
        return _getDeliveries().find(function(x) { return x._id === id || x.id === id; });
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
        if (d.notes) bits.push('Observaciones: ' + d.notes);
        return bits.join('. ');
    }

    function _pendingList() {
        return _getDeliveries().filter(_isPending);
    }
    function _deliveredList() {
        return _getDeliveries().filter(function(d) { return d.status === 'Entregado' || d.delivered; });
    }

    function _findNextPending() {
        var arr = _getDeliveries();
        for (var i = 0; i < arr.length; i++) {
            if (_isPending(arr[i])) return { d: arr[i], idx: i + 1 };
        }
        return null;
    }

    // ──────────────────────────────────────────────────
    // Highlight de tarjeta mientras se lee
    // ──────────────────────────────────────────────────
    function _setSpeakingCard(id) {
        if (_currentlySpeakingCardId === id) return;
        var prev = _currentlySpeakingCardId;
        _currentlySpeakingCardId = id;
        if (prev) {
            var pc = document.querySelector('.delivery-card[data-id="' + CSS.escape(prev) + '"]');
            if (pc) pc.classList.remove('copiloto-speaking');
        }
        if (id) {
            var cc = document.querySelector('.delivery-card[data-id="' + CSS.escape(id) + '"]');
            if (cc) {
                cc.classList.add('copiloto-speaking');
                try { cc.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_) {}
            }
        }
    }

    function _speakStopHighlighted(d, indexHint) {
        if (!d) return;
        var id = d._id || d.id;
        _setSpeakingCard(id);
        _speak(_formatStop(d, indexHint), {
            onEnd: function() { _setSpeakingCard(null); }
        });
    }

    // ──────────────────────────────────────────────────
    // Lecturas globales
    // ──────────────────────────────────────────────────
    function _announceNextIfChanged() {
        if (!_enabled) return;
        var nxt = _findNextPending();
        if (!nxt) return;
        var id = nxt.d._id || nxt.d.id;
        if (id === _lastAnnouncedId) return;
        _lastAnnouncedId = id;
        _speakStopHighlighted(nxt.d, nxt.idx);
    }

    function _readFullRoute() {
        var arr = _pendingList();
        if (!arr.length) { _speak('No tienes paradas pendientes.'); return; }
        _speak('Tienes ' + arr.length + ' paradas pendientes. Voy a leerlas.');
        var i = 0;
        function next() {
            if (i >= arr.length) { _speak('Fin de la ruta.'); _setSpeakingCard(null); return; }
            var d = arr[i];
            _setSpeakingCard(d._id || d.id);
            var u = new SpeechSynthesisUtterance(_formatStop(d, i + 1));
            u.lang = 'es-ES';
            u.rate = _settings.rate; u.pitch = _settings.pitch;
            var v = _pickVoice(); if (v) u.voice = v;
            u.onend = function() { i++; next(); };
            window.speechSynthesis.speak(u);
            _lastUtterance = _formatStop(d, i + 1);
        }
        // Pequeño hueco para que termine el "voy a leerlas"
        setTimeout(next, 1800);
    }

    function _speakStatus() {
        var pend = _pendingList().length;
        var done = _deliveredList().length;
        _speak('Tienes ' + pend + (pend === 1 ? ' parada pendiente' : ' paradas pendientes') +
               ' y ' + done + (done === 1 ? ' entrega completada.' : ' entregas completadas.'));
    }

    function _speakDateTime() {
        var d = new Date();
        var h = d.getHours(), m = d.getMinutes();
        var dia = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
        _speak('Hoy es ' + dia + '. Son las ' + h + ' y ' + (m < 10 ? '0' + m : m) + '.');
    }

    function _speakGreeting() {
        if (_greetingDone) return;
        _greetingDone = true;
        var pend = _pendingList().length;
        if (!pend) { _speak('Co-piloto listo. No tienes paradas pendientes.'); return; }
        var morning = _pendingList().filter(function(d){ return d.timeSlot === 'MAÑANA'; }).length;
        var afternoon = pend - morning;
        var parts = ['Co-piloto listo.', 'Tienes ' + pend + (pend === 1 ? ' parada' : ' paradas') + ' por hacer.'];
        if (morning && afternoon) parts.push(morning + ' de mañana y ' + afternoon + ' de tarde.');
        var nxt = _findNextPending();
        if (nxt) parts.push('Primera parada: ' + (nxt.d.receiver || 'sin nombre') + ' en ' + (nxt.d.localidad || 'destino').toString() + '.');
        _speak(parts.join(' '));
    }

    function _speakHelp() {
        _speak('Comandos disponibles: siguiente, repite, ruta completa, estado, hora, para, ayuda.');
    }

    // ──────────────────────────────────────────────────
    // Reconocimiento de voz — push-to-talk
    // ──────────────────────────────────────────────────
    function _initRecognition() {
        if (!_supportsRecognition()) return null;
        if (_rec) return _rec;
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        _rec = new SR();
        _rec.lang = 'es-ES';
        _rec.continuous = false;
        _rec.interimResults = false;
        _rec.maxAlternatives = 3;
        _rec.onresult = function(ev) {
            try {
                var transcripts = [];
                for (var i = 0; i < ev.results[0].length; i++) transcripts.push(ev.results[0][i].transcript);
                console.log('[COPILOTO] heard:', transcripts);
                _handleVoiceCommand(transcripts);
            } catch(e) { console.warn('[COPILOTO] result err:', e); }
        };
        _rec.onend = function() {
            _recListening = false;
            if (_micBtn) _micBtn.classList.remove('listening');
        };
        _rec.onerror = function(e) {
            console.warn('[COPILOTO] rec error:', e.error);
            _recListening = false;
            if (_micBtn) _micBtn.classList.remove('listening');
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                _speak('Activa el permiso de micrófono para usar la voz.');
            }
        };
        return _rec;
    }

    function _startListening() {
        if (!_supportsRecognition()) { _speak('Tu navegador no soporta órdenes de voz.'); return; }
        _initRecognition();
        if (!_rec || _recListening) return;
        try {
            _cancelSpeech();
            _rec.start();
            _recListening = true;
            if (_micBtn) _micBtn.classList.add('listening');
            try { navigator.vibrate && navigator.vibrate(30); } catch(_) {}
        } catch(e) {
            console.warn('[COPILOTO] start err:', e);
        }
    }

    function _stopListening() {
        if (!_rec || !_recListening) return;
        try { _rec.stop(); } catch(e) {}
    }

    function _handleVoiceCommand(transcripts) {
        var match = function(re) {
            return transcripts.some(function(t) { return re.test(t); });
        };
        if (match(/\b(siguiente|próxima|proxima|next)\b/i)) {
            _lastAnnouncedId = null;
            _announceNextIfChanged();
            if (!_findNextPending()) _speak('No hay paradas pendientes.');
            return;
        }
        if (match(/\b(repite|repeat|otra vez)\b/i)) {
            if (_lastUtterance) _speak(_lastUtterance);
            else _speak('No hay nada que repetir.');
            return;
        }
        if (match(/\b(ruta\s+completa|leer\s+ruta|toda\s+la\s+ruta|lista\s+ruta)\b/i)) {
            _readFullRoute();
            return;
        }
        if (match(/\b(estado|cuántas|cuantas|cuántos|cuantos|resumen)\b/i)) {
            _speakStatus();
            return;
        }
        if (match(/\b(hora|fecha|qué\s+hora|que\s+hora|qué\s+día|que\s+dia)\b/i)) {
            _speakDateTime();
            return;
        }
        if (match(/\b(para|calla|stop|silencio|cancela)\b/i)) {
            _cancelSpeech();
            return;
        }
        if (match(/\b(ayuda|help|qué\s+puedo\s+decir)\b/i)) {
            _speakHelp();
            return;
        }
        _speak('No te he entendido. Di ayuda para ver opciones.');
    }

    // ──────────────────────────────────────────────────
    // Action-sheet por tarjeta
    // ──────────────────────────────────────────────────
    function _openActionSheet(d) {
        var existing = document.getElementById('copiloto-action-sheet');
        if (existing) existing.remove();

        var receiver = d.receiver || d.clientName || 'Sin nombre';
        var addrFull = [d.address, d.localidad, d.cp, d.province].filter(Boolean).join(', ');
        var phone = d.phone || d.receiverPhone || d.contactPhone || d.tel || d.telefono || '';

        var sheet = document.createElement('div');
        sheet.id = 'copiloto-action-sheet';
        sheet.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.78); z-index:100002; display:flex; align-items:flex-end; justify-content:center;';
        sheet.innerHTML =
            '<div style="background:#1a1a1a; border:1px solid rgba(255,255,255,0.12); border-radius:16px 16px 0 0; width:100%; max-width:560px; padding:14px 16px 22px; color:#fff; box-shadow:0 -8px 24px rgba(0,0,0,0.6);">' +
                '<div style="width:42px; height:4px; background:#444; border-radius:2px; margin:0 auto 10px;"></div>' +
                '<div style="font-size:0.95rem; font-weight:800; margin-bottom:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + _esc(receiver) + '</div>' +
                '<div style="font-size:0.78rem; color:#aaa; margin-bottom:14px;">' + _esc(addrFull || 'Sin dirección') + '</div>' +
                '<div class="cp-as-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' +
                    '<button class="cp-as-btn" data-act="read" style="background:rgba(76,175,80,0.18); border:1px solid #4CAF50; color:#fff; padding:14px; border-radius:10px; font-weight:800; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:4px;">' +
                        '<span style="font-size:1.3rem;">🔊</span><span>Leer</span></button>' +
                    '<button class="cp-as-btn" data-act="nav" style="background:rgba(33,150,243,0.18); border:1px solid #2196F3; color:#fff; padding:14px; border-radius:10px; font-weight:800; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:4px;' + (addrFull ? '' : 'opacity:0.4; pointer-events:none;') + '">' +
                        '<span style="font-size:1.3rem;">🗺️</span><span>Navegar</span></button>' +
                    '<button class="cp-as-btn" data-act="call" style="background:rgba(255,152,0,0.18); border:1px solid #FF9800; color:#fff; padding:14px; border-radius:10px; font-weight:800; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:4px;' + (phone ? '' : 'opacity:0.4; pointer-events:none;') + '">' +
                        '<span style="font-size:1.3rem;">📞</span><span>Llamar</span></button>' +
                    '<button class="cp-as-btn" data-act="detail" style="background:rgba(171,71,188,0.18); border:1px solid #AB47BC; color:#fff; padding:14px; border-radius:10px; font-weight:800; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:4px;">' +
                        '<span style="font-size:1.3rem;">📋</span><span>Detalles</span></button>' +
                '</div>' +
                '<button class="cp-as-cancel" style="width:100%; margin-top:12px; background:transparent; border:1px solid #555; color:#ddd; padding:10px; border-radius:8px; font-weight:700; cursor:pointer;">Cerrar</button>' +
            '</div>';
        document.body.appendChild(sheet);

        function close() { sheet.remove(); }
        sheet.addEventListener('click', function(e) {
            if (e.target === sheet) close();
        });
        sheet.querySelector('.cp-as-cancel').addEventListener('click', close);
        sheet.querySelectorAll('.cp-as-btn').forEach(function(b) {
            b.addEventListener('click', function() {
                var act = this.dataset.act;
                if (act === 'read') {
                    _speakStopHighlighted(d);
                    close();
                } else if (act === 'nav') {
                    if (addrFull) {
                        var url = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(addrFull) + '&travelmode=driving';
                        window.open(url, '_blank');
                    }
                    close();
                } else if (act === 'call') {
                    if (phone) window.location.href = 'tel:' + String(phone).replace(/[^+0-9]/g, '');
                    close();
                } else if (act === 'detail') {
                    close();
                    if (typeof window.showDetailModal === 'function') {
                        window.showDetailModal(d);
                    } else {
                        // Fallback: simular click sobre la card
                        var card = document.querySelector('.delivery-card[data-id="' + CSS.escape(d._id || d.id) + '"]');
                        if (card) card.click();
                    }
                }
            });
        });
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // ──────────────────────────────────────────────────
    // Panel de ajustes (long-press)
    // ──────────────────────────────────────────────────
    function _openSettingsPanel() {
        var existing = document.getElementById('copiloto-settings');
        if (existing) existing.remove();
        var voices = _allVoices().filter(function(v) { return /^es/i.test(v.lang); });

        var sheet = document.createElement('div');
        sheet.id = 'copiloto-settings';
        sheet.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.82); z-index:100003; display:flex; align-items:flex-end; justify-content:center;';

        var voiceOpts = voices.map(function(v) {
            var sel = (_settings.voiceUri === v.voiceURI) ? 'selected' : '';
            return '<option value="' + _esc(v.voiceURI) + '" ' + sel + '>' + _esc(v.name) + ' (' + _esc(v.lang) + ')</option>';
        }).join('');

        sheet.innerHTML =
            '<div style="background:#1a1a1a; border:1px solid rgba(255,255,255,0.12); border-radius:16px 16px 0 0; width:100%; max-width:560px; padding:18px; color:#fff; max-height:85vh; overflow-y:auto;">' +
                '<div style="width:42px; height:4px; background:#444; border-radius:2px; margin:0 auto 14px;"></div>' +
                '<h3 style="margin:0 0 14px; color:#34C759; font-size:1rem;">⚙️ Ajustes del copiloto</h3>' +

                '<label style="display:block; font-size:0.78rem; color:#bbb; margin-bottom:4px;">Velocidad: <span id="cp-rate-v">' + _settings.rate.toFixed(1) + '</span>x</label>' +
                '<input type="range" id="cp-rate" min="0.6" max="1.6" step="0.1" value="' + _settings.rate + '" style="width:100%; margin-bottom:14px;">' +

                '<label style="display:block; font-size:0.78rem; color:#bbb; margin-bottom:4px;">Tono: <span id="cp-pitch-v">' + _settings.pitch.toFixed(1) + '</span></label>' +
                '<input type="range" id="cp-pitch" min="0.6" max="1.6" step="0.1" value="' + _settings.pitch + '" style="width:100%; margin-bottom:14px;">' +

                '<label style="display:block; font-size:0.78rem; color:#bbb; margin-bottom:4px;">Voz</label>' +
                '<select id="cp-voice" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:6px; font-size:0.85rem; margin-bottom:14px;">' +
                    '<option value="">— Auto (sistema) —</option>' + voiceOpts +
                '</select>' +

                '<label style="display:flex; align-items:center; gap:8px; font-size:0.85rem; margin-bottom:10px;">' +
                    '<input type="checkbox" id="cp-greet" ' + (_settings.greetOnLoad ? 'checked' : '') + '> Saludar al iniciar la app' +
                '</label>' +
                '<label style="display:flex; align-items:center; gap:8px; font-size:0.85rem; margin-bottom:10px;">' +
                    '<input type="checkbox" id="cp-announce" ' + (_settings.announceList ? 'checked' : '') + '> Anunciar próxima parada automáticamente' +
                '</label>' +
                '<label style="display:flex; align-items:center; gap:8px; font-size:0.85rem; margin-bottom:14px;">' +
                    '<input type="checkbox" id="cp-voice-cmds" ' + (_settings.voiceCommandsEnabled ? 'checked' : '') + (_supportsRecognition() ? '' : ' disabled') + '> Activar botón de voz' + (_supportsRecognition() ? '' : ' (no soportado en este navegador)') +
                '</label>' +

                '<div style="display:flex; gap:8px; margin-top:10px;">' +
                    '<button id="cp-set-test" style="flex:1; background:rgba(33,150,243,0.18); border:1px solid #2196F3; color:#fff; padding:10px; border-radius:8px; font-weight:700; cursor:pointer;">▶ Probar voz</button>' +
                    '<button id="cp-set-reset" style="flex:1; background:transparent; border:1px solid #555; color:#ddd; padding:10px; border-radius:8px; font-weight:700; cursor:pointer;">Restablecer</button>' +
                '</div>' +
                '<button id="cp-set-close" style="width:100%; margin-top:10px; background:#34C759; border:0; color:#000; padding:12px; border-radius:8px; font-weight:800; cursor:pointer;">Guardar y cerrar</button>' +
            '</div>';

        document.body.appendChild(sheet);
        sheet.addEventListener('click', function(e) { if (e.target === sheet) sheet.remove(); });

        document.getElementById('cp-rate').addEventListener('input', function() {
            _settings.rate = parseFloat(this.value) || 1.0;
            document.getElementById('cp-rate-v').textContent = _settings.rate.toFixed(1);
        });
        document.getElementById('cp-pitch').addEventListener('input', function() {
            _settings.pitch = parseFloat(this.value) || 1.0;
            document.getElementById('cp-pitch-v').textContent = _settings.pitch.toFixed(1);
        });
        document.getElementById('cp-voice').addEventListener('change', function() {
            _settings.voiceUri = this.value || null;
            _voiceCache = null;
            _pickVoice();
        });
        document.getElementById('cp-greet').addEventListener('change', function() { _settings.greetOnLoad = this.checked; });
        document.getElementById('cp-announce').addEventListener('change', function() { _settings.announceList = this.checked; });
        document.getElementById('cp-voice-cmds').addEventListener('change', function() {
            _settings.voiceCommandsEnabled = this.checked;
            _refreshMicButton();
        });
        document.getElementById('cp-set-test').addEventListener('click', function() {
            _speak('Hola, soy tu copiloto. Esta es la voz seleccionada.');
        });
        document.getElementById('cp-set-reset').addEventListener('click', function() {
            _settings = Object.assign({}, DEFAULT_SETTINGS);
            _saveSettings();
            sheet.remove();
            _openSettingsPanel();
        });
        document.getElementById('cp-set-close').addEventListener('click', function() {
            _saveSettings();
            sheet.remove();
        });
    }

    // ──────────────────────────────────────────────────
    // Enable/Disable
    // ──────────────────────────────────────────────────
    function _setEnabled(on) {
        _enabled = !!on;
        try { localStorage.setItem('copilotoEnabled', _enabled ? '1' : '0'); } catch(e) {}
        if (_badge) {
            _badge.classList.toggle('active', _enabled);
            _badge.title = _enabled ? 'Co-piloto activo (toca para desactivar · pulsación larga = ajustes)' : 'Activar co-piloto de voz';
        }
        if (_enabled) {
            _speak('Co-piloto activado.');
            _lastAnnouncedId = null;
            if (_settings.greetOnLoad && !_greetingDone) {
                setTimeout(_speakGreeting, 1200);
            } else if (_settings.announceList) {
                setTimeout(_announceNextIfChanged, 800);
            }
        } else {
            _cancelSpeech();
        }
    }

    // ──────────────────────────────────────────────────
    // Inyectar UI
    // ──────────────────────────────────────────────────
    function _refreshMicButton() {
        if (!_micBtn) return;
        var should = _settings.voiceCommandsEnabled && _supportsRecognition();
        _micBtn.style.display = should ? '' : 'none';
    }

    function _injectHeaderButtons() {
        var actions = document.querySelector('.header-actions');
        if (!actions) return;

        // Botón copiloto principal
        if (!document.getElementById('btn-copiloto')) {
            var btn = document.createElement('button');
            btn.id = 'btn-copiloto';
            btn.className = 'header-btn';
            btn.title = 'Activar co-piloto de voz';
            btn.innerHTML = '<span class="material-symbols-outlined">record_voice_over</span>';
            // Tap = toggle. Long-press = settings.
            var pressTimer = null;
            var longPressed = false;
            btn.addEventListener('touchstart', function(e) {
                longPressed = false;
                pressTimer = setTimeout(function() {
                    longPressed = true;
                    try { navigator.vibrate && navigator.vibrate(50); } catch(_) {}
                    _openSettingsPanel();
                }, 600);
            });
            btn.addEventListener('touchend', function() {
                if (pressTimer) clearTimeout(pressTimer);
            });
            btn.addEventListener('touchmove', function() {
                if (pressTimer) clearTimeout(pressTimer);
            });
            btn.addEventListener('click', function(e) {
                if (longPressed) { longPressed = false; return; }
                _setEnabled(!_enabled);
            });
            // Long-press para escritorio (right-click)
            btn.addEventListener('contextmenu', function(e) { e.preventDefault(); _openSettingsPanel(); });

            var logout = document.getElementById('btn-logout');
            if (logout && logout.parentElement) {
                logout.parentElement.insertBefore(btn, logout);
            } else {
                actions.appendChild(btn);
            }
            _badge = btn;
        }

        // Botón micrófono (push-to-talk)
        if (!document.getElementById('btn-copiloto-mic')) {
            var mic = document.createElement('button');
            mic.id = 'btn-copiloto-mic';
            mic.className = 'header-btn';
            mic.title = 'Mantén pulsado para hablar';
            mic.innerHTML = '<span class="material-symbols-outlined">mic</span>';
            mic.addEventListener('mousedown', _startListening);
            mic.addEventListener('mouseup', _stopListening);
            mic.addEventListener('mouseleave', _stopListening);
            mic.addEventListener('touchstart', function(e) { e.preventDefault(); _startListening(); });
            mic.addEventListener('touchend', _stopListening);
            mic.addEventListener('touchcancel', _stopListening);
            if (_badge && _badge.parentElement) {
                _badge.parentElement.insertBefore(mic, _badge);
            } else {
                actions.appendChild(mic);
            }
            _micBtn = mic;
        }
        _refreshMicButton();
    }

    function _injectStyle() {
        if (document.getElementById('copiloto-style')) return;
        var s = document.createElement('style');
        s.id = 'copiloto-style';
        s.textContent = ''
            + '#btn-copiloto.active{background:#34C759;color:#000;}'
            + '#btn-copiloto.active .material-symbols-outlined{color:#000;}'
            + '#btn-copiloto-mic.listening{background:#FF3B30;color:#fff;animation:cpPulseMic 0.8s ease-in-out infinite;}'
            + '#btn-copiloto-mic.listening .material-symbols-outlined{color:#fff;}'
            + '@keyframes cpPulseMic { 0%, 100% { transform:scale(1); } 50% { transform:scale(1.08); box-shadow:0 0 0 6px rgba(255,59,48,0.25); } }'
            + '.dc-speak{position:absolute; top:8px; right:8px; background:rgba(52,199,89,0.12); border:1px solid rgba(52,199,89,0.35); color:#34C759; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:5;}'
            + '.dc-speak:active{transform:scale(0.92);}'
            + '.delivery-card{position:relative;}'
            + '.delivery-card.copiloto-speaking{outline:2px solid #34C759; outline-offset:-1px; box-shadow:0 0 0 4px rgba(52,199,89,0.12);}'
            + '.cp-as-btn:active{transform:scale(0.96);}';
        document.head.appendChild(s);
    }

    function _attachSpeakButtons() {
        var list = document.getElementById('delivery-list');
        if (!list) return;
        list.querySelectorAll('.delivery-card').forEach(function(card) {
            if (card.querySelector('.dc-speak')) return;
            var id = card.getAttribute('data-id');
            if (!id) return;
            var btn = document.createElement('button');
            btn.className = 'dc-speak';
            btn.title = 'Acciones rápidas';
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.1rem;">campaign</span>';
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var d = _findById(id);
                if (!d) {
                    console.warn('[COPILOTO] delivery no encontrada para id=' + id);
                    return;
                }
                _openActionSheet(d);
            });
            card.appendChild(btn);
        });
    }

    function _watchList() {
        var list = document.getElementById('delivery-list');
        if (!list) { setTimeout(_watchList, 500); return; }
        new MutationObserver(function() {
            _attachSpeakButtons();
            if (_settings.announceList) _announceNextIfChanged();
        }).observe(list, { childList: true, subtree: false });

        // También engancha al evento custom que dispara renderDeliveries()
        window.addEventListener('deliveries-rendered', function() {
            _attachSpeakButtons();
            if (_settings.announceList) _announceNextIfChanged();
            // Saludo inicial cuando hay datos cargados y el copiloto está activo
            if (_enabled && _settings.greetOnLoad && !_greetingDone) {
                setTimeout(_speakGreeting, 400);
            }
        });
    }

    function _boot() {
        if (!_supports()) {
            console.warn('[COPILOTO] TTS no soportado en este navegador');
            return;
        }
        _loadSettings();
        _injectStyle();
        _injectHeaderButtons();
        _attachSpeakButtons();
        _watchList();

        // Restaurar estado previo
        try {
            if (localStorage.getItem('copilotoEnabled') === '1') {
                _enabled = true;
                if (_badge) {
                    _badge.classList.add('active');
                    _badge.title = 'Co-piloto activo (toca para desactivar · pulsación larga = ajustes)';
                }
            }
        } catch(e) {}

        // Voces a veces se cargan asíncronamente
        if (window.speechSynthesis && typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
            window.speechSynthesis.onvoiceschanged = function() { _voiceCache = null; _pickVoice(); };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _boot);
    } else {
        _boot();
    }

    // API pública
    window.copiloto = {
        enable: function() { _setEnabled(true); },
        disable: function() { _setEnabled(false); },
        toggle: function() { _setEnabled(!_enabled); },
        speak: _speak,
        cancel: _cancelSpeech,
        repeat: function() { if (_lastUtterance) _speak(_lastUtterance); },
        announceNext: function() { _lastAnnouncedId = null; _announceNextIfChanged(); },
        readFullRoute: _readFullRoute,
        status: _speakStatus,
        greet: function() { _greetingDone = false; _speakGreeting(); },
        settings: _openSettingsPanel,
        listen: _startListening,
        stopListening: _stopListening
    };
})();
