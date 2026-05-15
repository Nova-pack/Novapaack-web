// =============================================
// NOVAPACK ERP — Ficha Maestra de Cliente v1.0
// =============================================
// Renders a full-screen, tabbed client card inside the ERP tab system.
// Sub-tabs: PRINCIPAL | DATOS ECONÓMICOS | ALBARANES | FACTURACIÓN

(function() {
    'use strict';

    let _fichaClientId = null;
    let _fichaClientData = null;
    let _fichaActiveSubTab = 'principal';
    let _fichaTicketsCache = [];
    let _fichaInvoicesCache = [];
    let _fichaTariffsCache = []; // {id, label}

    // ============================================================
    //  ENTRY POINT
    // ============================================================
    window.openFichaCliente = async function(clientId) {
        if (!clientId) return;
        _fichaClientId = clientId;

        // Try userMap first, then _advClientsCache, then Firestore
        _fichaClientData = (window.userMap && window.userMap[clientId]) ? { ...window.userMap[clientId], id: clientId } : null;

        if (!_fichaClientData && window._advClientsCache) {
            var cached = window._advClientsCache.find(function(c) { return c.id === clientId; });
            if (cached) _fichaClientData = { ...cached, id: clientId };
        }

        if (!_fichaClientData) {
            try {
                var doc = await db.collection('users').doc(clientId).get();
                if (doc.exists) {
                    _fichaClientData = { ...doc.data(), id: clientId };
                    if (window.userMap) window.userMap[clientId] = _fichaClientData;
                }
            } catch(e) { console.error('Error loading client:', e); }
        }

        if (!_fichaClientData) {
            alert('No se encontraron datos para este cliente.');
            return;
        }

        // Open a dynamic tab in the ERP tab system
        const tabTitle = `[#${_fichaClientData.idNum || '?'}] ${_fichaClientData.name || 'Cliente'}`;
        if (typeof window.erpOpenTab === 'function') {
            window.erpOpenTab('ficha-cliente', {
                title: tabTitle,
                icon: 'person',
                closeable: true,
                onLoad: () => _fichaRender()
            });
        }

        // If tab was already open, re-render with new client
        _fichaRender();
    };

    // ============================================================
    //  MAIN RENDER
    // ============================================================
    function _fichaRender() {
        const container = document.getElementById('erp-tab-ficha-cliente');
        if (!container || !_fichaClientData) return;
        const d = _fichaClientData;

        // Payment terms label map
        const paymentLabels = {
            'contado': 'Contado', 'giro_30': 'Giro 30 días', 'giro_60': 'Giro 60 días',
            'giro_90': 'Giro 90 días', 'giro_120': 'Giro 120 días',
            'transferencia': 'Transferencia', 'recibo_sepa': 'Recibo SEPA'
        };

        container.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; background:#1e1e1e; color:#d4d4d4; font-family:'Segoe UI',sans-serif;">
            <!-- HEADER BAR -->
            <div style="background:linear-gradient(135deg, #1a237e, #283593); padding:10px 16px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
                <div>
                    <div style="font-size:1rem; font-weight:bold; color:#fff; display:flex; align-items:center; gap:8px;">
                        <span class="material-symbols-outlined" style="font-size:1.1rem;">business</span>
                        ${d.name || 'Sin Nombre'}
                    </div>
                    <div style="font-size:0.72rem; color:#9fa8da; margin-top:2px;">
                        #${d.idNum || 'N/A'} · ${d.nif || 'N/A'} · ${d.email || ''} · <strong style="color:#FFD700;">${paymentLabels[d.paymentTerms] || 'Contado'}</strong>
                    </div>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button onclick="window._fichaSaveAll()" style="background:#4CAF50; border:none; color:#fff; padding:6px 14px; border-radius:5px; cursor:pointer; font-weight:bold; font-size:0.78rem; display:flex; align-items:center; gap:4px;" title="Guardar todos los cambios (atajo: Ctrl+S)">
                        <span class="material-symbols-outlined" style="font-size:0.95rem;">save</span> Guardar
                    </button>
                    <button onclick="window._fichaClose()" style="background:transparent; border:1px solid rgba(255,255,255,0.4); color:#fff; padding:6px 14px; border-radius:5px; cursor:pointer; font-weight:600; font-size:0.78rem; display:flex; align-items:center; gap:4px;" title="Cerrar la ficha sin guardar cambios">
                        <span class="material-symbols-outlined" style="font-size:0.95rem;">close</span> Salir
                    </button>
                </div>
            </div>

            <!-- SUB-TAB BAR -->
            <div id="ficha-subtab-bar" style="display:flex; background:#252526; border-bottom:2px solid #007acc; flex-shrink:0;">
                <div class="ficha-subtab ${_fichaActiveSubTab === 'principal' ? 'active' : ''}" onclick="window._fichaSetSubTab('principal')" style="padding:7px 14px; cursor:pointer; font-size:0.78rem; font-weight:600; color:${_fichaActiveSubTab === 'principal' ? '#fff' : '#888'}; border-bottom:${_fichaActiveSubTab === 'principal' ? '3px solid #007acc' : '3px solid transparent'}; display:flex; align-items:center; gap:5px; transition:all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size:1rem;">person</span> PRINCIPAL
                </div>
                <div class="ficha-subtab ${_fichaActiveSubTab === 'economico' ? 'active' : ''}" onclick="window._fichaSetSubTab('economico')" style="padding:7px 14px; cursor:pointer; font-size:0.78rem; font-weight:600; color:${_fichaActiveSubTab === 'economico' ? '#fff' : '#888'}; border-bottom:${_fichaActiveSubTab === 'economico' ? '3px solid #FF9800' : '3px solid transparent'}; display:flex; align-items:center; gap:5px; transition:all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size:1rem;">account_balance</span> DATOS ECONÓMICOS
                </div>
                <div class="ficha-subtab ${_fichaActiveSubTab === 'albaranes' ? 'active' : ''}" onclick="window._fichaSetSubTab('albaranes')" style="padding:7px 14px; cursor:pointer; font-size:0.78rem; font-weight:600; color:${_fichaActiveSubTab === 'albaranes' ? '#fff' : '#888'}; border-bottom:${_fichaActiveSubTab === 'albaranes' ? '3px solid #2196F3' : '3px solid transparent'}; display:flex; align-items:center; gap:5px; transition:all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size:1rem;">inventory_2</span> ALBARANES
                </div>
                <div class="ficha-subtab ${_fichaActiveSubTab === 'facturacion' ? 'active' : ''}" onclick="window._fichaSetSubTab('facturacion')" style="padding:7px 14px; cursor:pointer; font-size:0.78rem; font-weight:600; color:${_fichaActiveSubTab === 'facturacion' ? '#fff' : '#888'}; border-bottom:${_fichaActiveSubTab === 'facturacion' ? '3px solid #4CAF50' : '3px solid transparent'}; display:flex; align-items:center; gap:5px; transition:all 0.2s;">
                    <span class="material-symbols-outlined" style="font-size:1rem;">receipt</span> FACTURACIÓN
                </div>
            </div>

            <!-- SUB-TAB CONTENT -->
            <div id="ficha-subtab-content" style="flex:1; overflow-y:auto; padding:12px 16px;">
            </div>
        </div>`;

        // Render active sub-tab
        _fichaRenderSubTab();

        // Load tariffs asynchronously and populate selects
        _fichaLoadTariffs();
    }

    async function _fichaLoadTariffs(forceReload) {
        try {
            // IMPORTANTE: SIEMPRE recargar desde Firestore. Antes había una caché
            // en memoria que solo se llenaba la primera vez → cuando creabas una
            // tarifa nueva en otra pestaña y volvías a la ficha, no aparecía hasta
            // refrescar la página entera. Ahora cada apertura de ficha pide los
            // datos frescos. Es 1 lectura más, asumible.
            const snap = await db.collection('tariffs').get();
            _fichaTariffsCache = [];
            snap.forEach(doc => {
                if (!doc.id.startsWith('GLOBAL_')) return;
                const data = doc.data() || {};
                const shortId = doc.id.replace('GLOBAL_', '');
                const niceName = data.name || shortId;
                const versionTag = data.version === 2 ? ' [v2]' : ' [v1]';
                _fichaTariffsCache.push({
                    id: shortId,
                    label: niceName + versionTag,
                    sortKey: (niceName || shortId).toLowerCase()
                });
            });
            _fichaTariffsCache.sort((a, b) => a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true }));
            _fichaPopulateTariffSelects();
        } catch(e) {
            console.error('[Ficha] Error loading tariffs:', e);
        }
    }

    function _fichaPopulateTariffSelects() {
        const currentVal = _fichaClientData ? (_fichaClientData.tariffId || '') : '';
        // fc-tariff vive en pestaña Principal, fc-tariff-eco en Económico —
        // editan el mismo campo users/{id}.tariffId.
        ['fc-tariff', 'fc-tariff-eco'].forEach(selId => {
            const sel = document.getElementById(selId);
            if (!sel) return;
            sel.innerHTML = '<option value="">-- Sin Tarifa Global --</option>';
            if (currentVal && !_fichaTariffsCache.find(t => t.id === currentVal)) {
                const opt = document.createElement('option');
                opt.value = currentVal;
                opt.textContent = currentVal + ' (asignada — no listada)';
                opt.selected = true;
                sel.appendChild(opt);
            }
            _fichaTariffsCache.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.label;
                if (t.id === currentVal) opt.selected = true;
                sel.appendChild(opt);
            });
            // ─── AUTOGUARDADO al cambiar la tarifa ────────────────
            // Antes había que pulsar 💾 Guardar para persistir. Olvidarlo
            // perdía el cambio. Ahora el cambio se graba al instante en
            // Firestore + sincroniza el otro select + toast verde.
            sel.onchange = async function() {
                const newVal = this.value;
                const otherId = selId === 'fc-tariff' ? 'fc-tariff-eco' : 'fc-tariff';
                const other = document.getElementById(otherId);
                if (other && other.value !== newVal) other.value = newVal;
                await _fichaAutoSaveTariffId(newVal);
            };
        });
    }

    // ── RESOLUCIÓN ROBUSTA DEL DOCID REAL DEL CLIENTE ───────────
    // Problema: a veces la ficha se abre con un ID que NO es el docId
    // real de Firestore (es el authUid, o un alias cacheado). Al
    // intentar update() Firestore lanza "No document to update".
    // Esta función intenta:
    //   1. ¿El doc existe en users/{_fichaClientId}? → ese es el bueno.
    //   2. Si no → buscar users where authUid == _fichaClientId.
    //   3. Si no → buscar por idNum.
    // Si encuentra el real, ACTUALIZA _fichaClientId para futuros saves.
    async function _fichaResolveRealDocId() {
        if (!_fichaClientId) return null;
        // 1. ¿Existe directamente?
        try {
            const d = await db.collection('users').doc(_fichaClientId).get();
            if (d.exists) return _fichaClientId;
        } catch(_) {}
        // 2. Por authUid
        try {
            const snap = await db.collection('users').where('authUid', '==', _fichaClientId).limit(1).get();
            if (!snap.empty) {
                const realId = snap.docs[0].id;
                console.warn('[ficha] docId corregido por authUid:', _fichaClientId, '→', realId);
                _fichaClientId = realId;
                return realId;
            }
        } catch(_) {}
        // 3. Por idNum (si _fichaClientData lo tiene)
        try {
            const idNum = _fichaClientData && _fichaClientData.idNum;
            if (idNum) {
                const snap = await db.collection('users').where('idNum', '==', String(idNum)).limit(1).get();
                if (!snap.empty) {
                    const realId = snap.docs[0].id;
                    console.warn('[ficha] docId corregido por idNum:', _fichaClientId, '→', realId);
                    _fichaClientId = realId;
                    return realId;
                }
            }
        } catch(_) {}
        return null; // no se pudo resolver
    }

    // Update resiliente: si el doc no existe en _fichaClientId, resuelve
    // el real y reintenta. Lo usan autoSave y _fichaSaveAll.
    async function _fichaUpdateUserDoc(updates) {
        try {
            await db.collection('users').doc(_fichaClientId).update(updates);
            return _fichaClientId;
        } catch(e) {
            const notFound = (e && (e.code === 'not-found' || /No document to update/i.test(e.message || '')));
            if (!notFound) throw e;
            // Resolver el docId real y reintentar
            const realId = await _fichaResolveRealDocId();
            if (!realId) {
                throw new Error('No se encontró el documento del cliente (ni por id, ni authUid, ni idNum). Recarga la lista de clientes.');
            }
            await db.collection('users').doc(realId).update(updates);
            return realId;
        }
    }

    // ════════════════════════════════════════════════════════════
    //  AUTO-DETECCIÓN DE TELÉFONO DE RUTA POR CP
    // ════════════════════════════════════════════════════════════
    // Las rutas se configuran en Control de Rutas → config/phones/list.
    // Cada ruta tiene: number (tel repartidor), label, coverageZones
    // (CPs/localidades separados por comas).
    //
    // IMPORTANTE: cada cliente (PADRE o SUCURSAL) usa SU PROPIO CP.
    // Una sucursal de Sevilla en otro pueblo tiene su ruta propia,
    // no hereda la del padre.
    let _fichaRoutesCache = null;

    async function _fichaLoadRoutes(forceReload) {
        if (_fichaRoutesCache && !forceReload) return _fichaRoutesCache;
        const routes = [];
        try {
            const snap = await db.collection('config').doc('phones').collection('list').get();
            snap.forEach(doc => {
                const d = doc.data() || {};
                routes.push({
                    id: doc.id,
                    label: (d.label || '').toString().trim(),
                    number: (d.number || '').toString().trim(),
                    driverName: (d.driverName || '').toString().trim(),
                    coverageZones: (d.coverageZones || '').toString()
                });
            });
        } catch(e) { console.warn('[ficha] no pude cargar rutas:', e.message); }
        _fichaRoutesCache = routes;
        return routes;
    }

    function _normTxt(s) {
        return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    }

    // Devuelve { number, label, driverName } de la ruta que cubre ese CP/localidad, o null.
    function _fichaMatchRoute(routes, cp, localidad) {
        const cpStr = (cp || '').toString().trim().replace(/\s/g, '');
        const locNorm = _normTxt(localidad);
        if (!cpStr && !locNorm) return null;

        // Recorremos rutas; recogemos matches con prioridad.
        let exactCp = null, prefixCp = null, locMatch = null;
        for (const r of routes) {
            if (!r.number) continue;
            // Tokens: coverageZones + label
            const tokens = (r.coverageZones + ',' + r.label)
                .split(',').map(t => t.trim()).filter(Boolean);
            for (const tk of tokens) {
                const tkClean = tk.replace(/\s/g, '');
                // ¿es un CP (sólo dígitos)?
                if (/^\d+$/.test(tkClean)) {
                    if (cpStr) {
                        if (cpStr === tkClean) { exactCp = exactCp || r; }
                        else if (cpStr.startsWith(tkClean) && tkClean.length >= 2) { prefixCp = prefixCp || r; }
                    }
                } else {
                    // es una localidad / provincia
                    const tkNorm = _normTxt(tk);
                    if (locNorm && tkNorm && (locNorm === tkNorm || locNorm.includes(tkNorm) || tkNorm.includes(locNorm))) {
                        locMatch = locMatch || r;
                    }
                }
            }
        }
        const winner = exactCp || prefixCp || locMatch;
        return winner ? { number: winner.number, label: winner.label, driverName: winner.driverName } : null;
    }

    // Detecta y rellena el campo fc-default-route-phone de la ficha actual.
    window._fichaDetectRoutePhone = async function(silent) {
        const cpEl = document.getElementById('fc-cp');
        const locEl = document.getElementById('fc-city');
        const phoneEl = document.getElementById('fc-default-route-phone');
        if (!phoneEl) return;
        const cp = cpEl ? cpEl.value.trim() : (_fichaClientData && _fichaClientData.cp) || '';
        const loc = locEl ? locEl.value.trim() : (_fichaClientData && _fichaClientData.localidad) || '';
        if (!cp && !loc) {
            if (!silent) alert('Rellena primero el CP o la localidad del cliente para poder detectar su ruta.');
            return;
        }
        const routes = await _fichaLoadRoutes();
        if (!routes.length) {
            if (!silent) alert('No hay rutas configuradas en Control de Rutas todavía.');
            return;
        }
        const match = _fichaMatchRoute(routes, cp, loc);
        if (!match) {
            if (!silent) alert('Ningún recorrido cubre el CP ' + cp + (loc ? ' / ' + loc : '') + '.\n\nRevisa las zonas de cobertura en Control de Rutas o rellénalo a mano.');
            return;
        }
        phoneEl.value = match.number;
        if (!silent) {
            _fichaShowToast('✓ Ruta detectada: ' + (match.label || match.number) + (match.driverName ? ' (' + match.driverName + ')' : ''));
        }
        return match;
    };

    // ── BULK: auto-asignar teléfono de ruta a TODOS los clientes ──
    // Recorre users (padres Y sucursales), cada uno con SU CP.
    window._bulkAssignRoutePhones = async function() {
        const routes = await _fichaLoadRoutes(true);
        if (!routes.length) {
            alert('No hay rutas configuradas en Control de Rutas. Crea al menos una con sus zonas de cobertura primero.');
            return;
        }
        const mode = confirm(
            'AUTO-ASIGNAR TELÉFONO DE RUTA A TODOS LOS CLIENTES\n\n' +
            'Recorre todos los clientes (padres y sucursales) y, según el CP de cada uno, ' +
            'les asigna el teléfono de ruta de recogidas que le corresponde según Control de Rutas.\n\n' +
            '[Aceptar] = SOLO rellena los que están VACÍOS (no toca los ya configurados).\n' +
            '[Cancelar] = abortar.\n\n' +
            '¿Continuar (solo vacíos)?'
        );
        if (!mode) return;

        try {
            if (typeof showLoading === 'function') showLoading();
            const snap = await db.collection('users').get();
            let assigned = 0, skipped = 0, noMatch = 0, noCp = 0;
            let batch = db.batch();
            let ops = 0;
            const noMatchList = [];

            snap.forEach(doc => {
                const u = doc.data() || {};
                if (u.role === 'admin') return;
                // Solo vacíos
                if (u.defaultRoutePhone && u.defaultRoutePhone.toString().trim()) { skipped++; return; }
                const cp = (u.cp || '').toString().trim();
                const loc = (u.localidad || u.city || '').toString().trim();
                if (!cp && !loc) { noCp++; return; }
                const match = _fichaMatchRoute(routes, cp, loc);
                if (!match) {
                    noMatch++;
                    if (noMatchList.length < 10) noMatchList.push((u.name || u.idNum || doc.id) + ' (CP ' + (cp || '—') + ')');
                    return;
                }
                batch.update(db.collection('users').doc(doc.id), {
                    defaultRoutePhone: match.number,
                    defaultRoutePhoneAutoAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                ops++;
                assigned++;
                if (window.userMap && window.userMap[doc.id]) window.userMap[doc.id].defaultRoutePhone = match.number;
                if (ops >= 450) { batch.commit(); batch = db.batch(); ops = 0; }
            });
            if (ops > 0) await batch.commit();

            // Reconstruir directorio de rutas tras el bulk (no bloqueante)
            let dirInfo = '';
            try {
                if (typeof window._routeDirectoryRebuildCore === 'function') {
                    const r = await window._routeDirectoryRebuildCore();
                    dirInfo = '\n  📋 Directorio repartidores: ' + r.phones + ' rutas / ' + r.totalClients + ' clientes';
                }
            } catch(dErr) { console.warn('[bulk] rebuild dir fail:', dErr); }

            if (typeof hideLoading === 'function') hideLoading();
            let msg = 'AUTO-ASIGNACIÓN TERMINADA\n\n';
            msg += '  ✅ Asignados: ' + assigned + '\n';
            msg += '  ⏭️  Saltados (ya tenían): ' + skipped + '\n';
            msg += '  ⚠️  Sin ruta que cubra su CP: ' + noMatch + '\n';
            msg += '  ❔ Sin CP ni localidad: ' + noCp + '\n';
            msg += dirInfo;
            if (noMatchList.length) {
                msg += '\nSin cobertura (primeros 10):\n  ' + noMatchList.join('\n  ');
                msg += '\n\n→ Revisa las zonas de cobertura en Control de Rutas para estos CPs.';
            }
            alert(msg);
        } catch(e) {
            if (typeof hideLoading === 'function') hideLoading();
            console.error('[bulk route phones]', e);
            alert('Error en la asignación masiva: ' + e.message);
        }
    };

    // ====================================================
    // DIRECTORIO DE RUTAS — espejo /users → /config/route_directories/list/{phone}
    // Necesario porque las reglas Firestore no permiten al repartidor hacer
    // list() sobre /users (es solo admin). El espejo contiene solo los campos
    // públicos mínimos para que la app del repartidor pueda autocompletar
    // clientes de SU ruta sin filtrar datos sensibles (contraseñas, emails, etc.).
    // ====================================================

    function _routeDirNormPhone(p) {
        if (!p) return '';
        var s = String(p).replace(/[^0-9]/g, '');
        if (s.length === 11 && s.indexOf('34') === 0) s = s.slice(2);
        if (s.length === 12 && s.indexOf('034') === 0) s = s.slice(3);
        return s;
    }

    function _routeDirClientPayload(docId, u) {
        return {
            docId: docId,
            idNum: u.idNum || '',
            name: u.companyName || u.businessName || u.name || u.nombreFiscal || '(sin nombre)',
            nif: u.cif || u.nif || '',
            cp: u.cp || '',
            localidad: u.localidad || u.city || '',
            compId: u.compId || u.companyId || ''
        };
    }

    function _routeDirListRoot() {
        return db.collection('config').doc('route_directories').collection('list');
    }

    // Update transaccional para UN cliente que cambió su tel. de ruta.
    // oldPhone/newPhone pueden venir vacíos (entra o sale del directorio).
    window._routeDirectoryUpdateForClient = async function(oldPhone, newPhone, userDocId, userData) {
        try {
            var oldNorm = _routeDirNormPhone(oldPhone);
            var newNorm = _routeDirNormPhone(newPhone);
            if (oldNorm === newNorm && !newNorm) return;
            var payload = _routeDirClientPayload(userDocId, userData);
            var listRoot = _routeDirListRoot();

            // Quitar del antiguo si cambió
            if (oldNorm && oldNorm !== newNorm) {
                var oldRef = listRoot.doc(oldNorm);
                await db.runTransaction(async function(tx) {
                    var snap = await tx.get(oldRef);
                    if (!snap.exists) return;
                    var arr = (snap.data().clients || []).filter(function(c) {
                        return c.docId !== userDocId && (!payload.idNum || c.idNum !== payload.idNum);
                    });
                    tx.set(oldRef, {
                        phone: oldNorm,
                        clients: arr,
                        count: arr.length,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                });
            }

            // Añadir/actualizar en el nuevo
            if (newNorm) {
                var newRef = listRoot.doc(newNorm);
                await db.runTransaction(async function(tx) {
                    var snap = await tx.get(newRef);
                    var arr = snap.exists ? (snap.data().clients || []).filter(function(c) {
                        return c.docId !== userDocId && (!payload.idNum || c.idNum !== payload.idNum);
                    }) : [];
                    arr.push(payload);
                    arr.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
                    tx.set(newRef, {
                        phone: newNorm,
                        clients: arr,
                        count: arr.length,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                });
            }
        } catch(e) {
            console.warn('[routeDir] update single fail:', e);
        }
    };

    // Reconstruye TODO el directorio escaneando /users. Sin prompt.
    async function _routeDirectoryRebuildCore() {
        var snap = await db.collection('users').get();
        var byPhone = {};
        snap.forEach(function(doc) {
            var u = doc.data() || {};
            if (u.role === 'admin') return;
            var phoneNorm = _routeDirNormPhone(u.defaultRoutePhone);
            if (!phoneNorm) return;
            if (!byPhone[phoneNorm]) byPhone[phoneNorm] = [];
            byPhone[phoneNorm].push(_routeDirClientPayload(doc.id, u));
        });
        var phones = Object.keys(byPhone);
        var listRoot = _routeDirListRoot();
        var batch = db.batch();
        var ops = 0;
        var totalClients = 0;
        for (var i = 0; i < phones.length; i++) {
            var p = phones[i];
            var arr = byPhone[p];
            arr.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
            totalClients += arr.length;
            batch.set(listRoot.doc(p), {
                phone: p,
                clients: arr,
                count: arr.length,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            ops++;
            if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops > 0) await batch.commit();
        return { phones: phones.length, totalClients: totalClients };
    }

    // Versión pública con prompt + alert (botón admin)
    window._routeDirectoryRebuildAll = async function() {
        if (!confirm(
            'RECONSTRUIR DIRECTORIO DE RUTAS\n\n' +
            'Escanea todos los clientes y reescribe /config/route_directories/list/* ' +
            '(un documento por teléfono de ruta, con los clientes mínimos: NIF, nombre, CP, localidad).\n\n' +
            'Es necesario para que los repartidores puedan buscar clientes de SU ruta en la app sin permisos de admin.\n\n' +
            '¿Continuar?'
        )) return;
        try {
            if (typeof showLoading === 'function') showLoading();
            var res = await _routeDirectoryRebuildCore();
            if (typeof hideLoading === 'function') hideLoading();
            alert('DIRECTORIO RECONSTRUIDO ✅\n\nRutas escritas: ' + res.phones + '\nClientes totales: ' + res.totalClients);
        } catch(e) {
            if (typeof hideLoading === 'function') hideLoading();
            console.error('[routeDir rebuild]', e);
            alert('Error reconstruyendo: ' + e.message);
        }
    };

    // Exponer también para que el bulk de tel. de rutas lo dispare automáticamente
    window._routeDirectoryRebuildCore = _routeDirectoryRebuildCore;

    // Guarda inmediatamente el tariffId en Firestore + actualiza caches locales.
    async function _fichaAutoSaveTariffId(newTariffId) {
        if (!_fichaClientId) return;
        try {
            const savedId = await _fichaUpdateUserDoc({
                tariffId: newTariffId,
                tariffUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            // Update local cache (tanto en el id viejo como el resuelto)
            if (window.userMap) {
                if (window.userMap[savedId]) window.userMap[savedId].tariffId = newTariffId;
                if (window.userMap[_fichaClientId]) window.userMap[_fichaClientId].tariffId = newTariffId;
            }
            _fichaClientData = { ..._fichaClientData, tariffId: newTariffId };
            _fichaShowToast('✓ Tarifa actualizada: ' + (newTariffId || 'sin tarifa'));
            if (typeof _fichaWireFlatRateBlock === 'function') {
                try { _fichaWireFlatRateBlock(); } catch(_) {}
            }
        } catch(e) {
            console.error('[ficha] autoSave tariffId failed:', e);
            alert('❌ No se pudo guardar la tarifa: ' + e.message);
        }
    }

    // Toast no bloqueante de 2.5s — reemplaza al alert para autoguardados
    function _fichaShowToast(msg, color) {
        try {
            const t = document.createElement('div');
            t.style.cssText = 'position:fixed; bottom:20px; right:20px; background:' + (color || '#4CAF50') + '; color:#fff; padding:10px 18px; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.4); font-size:0.85rem; font-weight:600; z-index:100001; opacity:0; transition:opacity 0.2s;';
            t.textContent = msg;
            document.body.appendChild(t);
            requestAnimationFrame(() => { t.style.opacity = '1'; });
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 2500);
        } catch(_) {}
    }

    // Botón de refrescar manual por si el admin acaba de crear una tarifa
    window._fichaReloadTariffs = function() { _fichaLoadTariffs(true); };
    // Expuesto para que el constructor de tarifas pueda refrescar el bloque
    // de cuota mensual de la ficha tras editar/guardar una tarifa.
    // (función declarada más abajo — hoisted, así que la referencia es válida)
    window._fichaWireFlatRateBlock = function() {
        try { return _fichaWireFlatRateBlock(); } catch(e) { console.warn('[ficha] wireFlatRate:', e); }
    };

    // ============================================================
    //  SUB-TAB NAVIGATION
    // ============================================================
    window._fichaSetSubTab = function(tab) {
        _fichaActiveSubTab = tab;
        _fichaRender();
    };

    function _fichaRenderSubTab() {
        switch (_fichaActiveSubTab) {
            case 'principal': _fichaRenderPrincipal(); break;
            case 'economico': _fichaRenderEconomico(); break;
            case 'albaranes': _fichaRenderAlbaranes(); break;
            case 'facturacion': _fichaRenderFacturacion(); break;
        }
    }

    // ============================================================
    //  HELPER: Field row builder
    // ============================================================
    function _field(label, id, value, opts = {}) {
        const type = opts.type || 'text';
        const width = opts.width || '100%';
        const readonly = opts.readonly ? 'readonly style="opacity:0.6; cursor:not-allowed;"' : '';
        const placeholder = opts.placeholder || '';
        if (type === 'select' && opts.options) {
            let optsHtml = opts.options.map(o => `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}</option>`).join('');
            return `<div style="flex:${opts.flex || 1}; min-width:${opts.minWidth || '120px'};">
                <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">${label}</label>
                <select id="${id}" style="width:${width}; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem;">${optsHtml}</select>
            </div>`;
        }
        return `<div style="flex:${opts.flex || 1}; min-width:${opts.minWidth || '120px'};">
            <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">${label}</label>
            <input type="${type}" id="${id}" value="${(value || '').toString().replace(/"/g, '&quot;')}" placeholder="${placeholder}" ${readonly}
                style="width:${width}; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem; box-sizing:border-box;">
        </div>`;
    }

    function _sectionTitle(icon, text, color) {
        return `<div style="display:flex; align-items:center; gap:6px; margin:14px 0 6px; padding-bottom:5px; border-bottom:1px solid #3c3c3c;">
            <span class="material-symbols-outlined" style="color:${color}; font-size:0.95rem;">${icon}</span>
            <span style="color:${color}; font-size:0.8rem; font-weight:bold; text-transform:uppercase; letter-spacing:1px;">${text}</span>
        </div>`;
    }

    // ============================================================
    //  SUB-TAB: PRINCIPAL
    // ============================================================
    function _fichaRenderPrincipal() {
        const c = document.getElementById('ficha-subtab-content');
        const d = _fichaClientData;
        if (!c) return;

        c.innerHTML = `
        ${_sectionTitle('badge', 'Identificaci\u00f3n', '#007acc')}
        <div style="display:grid; grid-template-columns: 90px 1fr 150px; gap:6px; margin-bottom:6px;">
            ${_field('N\u00ba Cliente', 'fc-idnum', d.idNum, { minWidth: 'auto' })}
            ${_field('Raz\u00f3n Social / Empresa', 'fc-name', d.name, { minWidth: 'auto' })}
            ${_field('CIF / NIF', 'fc-nif', d.nif, { minWidth: 'auto' })}
        </div>

        ${_sectionTitle('mail', 'Contacto', '#4CAF50')}
        <div style="display:grid; grid-template-columns: 1fr 1fr 140px; gap:6px; margin-bottom:6px;">
            ${_field('Email principal', 'fc-email', d.email, { type: 'email', placeholder: 'donde llegan las comunicaciones', minWidth: 'auto' })}
            ${_field('Email Administraci\u00f3n', 'fc-admin-email', d.adminEmail, { type: 'email', placeholder: 'admin@empresa.com (opcional)', minWidth: 'auto' })}
            ${_field('Tel\u00e9fono', 'fc-phone', d.senderPhone || d.phone, { minWidth: 'auto' })}
        </div>

        ${_sectionTitle('location_on', 'Direcci\u00f3n Principal', '#FF9800')}
        <div style="display:grid; grid-template-columns: 1fr 70px 80px 1fr 1fr; gap:6px; margin-bottom:6px;">
            ${_field('Calle / V\u00eda', 'fc-street', d.street, { minWidth: 'auto' })}
            ${_field('N\u00famero', 'fc-number', d.number, { minWidth: 'auto' })}
            ${_field('C. Postal', 'fc-cp', d.cp, { minWidth: 'auto' })}
            ${_field('Localidad', 'fc-city', d.localidad, { minWidth: 'auto' })}
            ${_field('Provincia', 'fc-province', d.province, { minWidth: 'auto' })}
        </div>

        ${_sectionTitle('schedule', 'Configuraci\u00f3n de Recogidas', '#4CAF50')}
        <div style="display:grid; grid-template-columns: 120px 120px 1fr; gap:6px; margin-bottom:2px;">
            ${_field('Corte Ma\u00f1ana', 'fc-pickup-cutoff-am', d.pickupCutoffAM || '', { type: 'time', minWidth: 'auto' })}
            ${_field('Corte Tarde', 'fc-pickup-cutoff-pm', d.pickupCutoffPM || '', { type: 'time', minWidth: 'auto' })}
            <div style="min-width:auto;">
                <label style="display:flex; justify-content:space-between; align-items:center; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">
                    <span>Tlf. Ruta Recogidas</span>
                    <button type="button" onclick="window._fichaDetectRoutePhone()" title="Detectar autom\u00e1ticamente la ruta de recogidas seg\u00fan el CP de este cliente (Control de Rutas)" style="background:#4CAF50; border:0; color:#fff; padding:2px 8px; border-radius:3px; font-size:0.62rem; font-weight:700; cursor:pointer; letter-spacing:0;">\ud83d\udd0d Detectar por CP</button>
                </label>
                <input type="text" id="fc-default-route-phone" value="${d.defaultRoutePhone || ''}" placeholder="600123456 o pulsa Detectar" style="width:100%; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem; box-sizing:border-box;">
            </div>
        </div>
        <div style="font-size:0.65rem; color:#666; margin-bottom:6px;">\u2139\ufe0f El tel\u00e9fono de ruta sale de <strong>Control de Rutas</strong> seg\u00fan las zonas de cobertura (CP). Cada sucursal usa SU propio CP.</div>

        ${_sectionTitle('account_tree', 'Relaciones', '#2196F3')}
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; margin-bottom:6px;">
            ${_field('Filial Facturadora', 'fc-billing-company', d.billingCompanyId, {
                type: 'select', minWidth: 'auto',
                options: [{ value: '', label: '-- Central --' }].concat(
                    typeof billingCompaniesMap !== 'undefined' ? Object.entries(billingCompaniesMap).map(([id, bc]) => ({ value: id, label: bc.name })) : []
                )
            })}
            ${_field('Cliente Padre', 'fc-parent-client', d.parentClientId || '', { placeholder: 'Independiente', minWidth: 'auto' })}
            <div style="min-width:auto;">
                <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px; display:flex; justify-content:space-between; align-items:center;">
                    <span>Tarifa Global</span>
                    <button type="button" onclick="openTariffManager('${d.id}')" title="Gestionar la tarifa de este cliente: asignar tarifa global, personalizar precios o añadir cuota plana." style="background:#FF6600; border:0; color:#fff; padding:2px 8px; border-radius:3px; font-size:0.65rem; font-weight:700; cursor:pointer; letter-spacing:0;">💰 Tarifa y precios</button>
                </label>
                <div style="display:flex; gap:4px;">
                    <select id="fc-tariff" style="flex:1; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem;">
                        <option value="">-- Cargando... --</option>
                    </select>
                    <button type="button" onclick="window._fichaReloadTariffs()" title="Recargar listado de tarifas globales (si acabas de crear una nueva en otra pestaña)" style="background:#2d2d30; border:1px solid #3c3c3c; color:#aaa; padding:0 8px; border-radius:4px; cursor:pointer; font-size:0.75rem;">🔄</button>
                </div>
            </div>
        </div>

        ${d.parentClientId ? '' : `
        ${_sectionTitle('account_tree', 'Sucursales', '#5DADE2')}
        <div id="fc-sucursales-banner" style="background:rgba(93,173,226,0.05); border:1px solid rgba(93,173,226,0.2); border-radius:8px; padding:10px 12px; margin-bottom:8px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
            <div style="font-size:0.78rem; color:#aaa;">
                <span id="fc-sucursales-count" style="color:#5DADE2; font-weight:700;">—</span> sucursales vinculadas
                <span style="color:#666; margin-left:6px;">(comparten NIF, cada una con su propio login y prefijo)</span>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button type="button" onclick="window.composeConsolidatedWelcomeEmail('${d.id}')" style="background:#34C759; border:0; color:#fff; padding:6px 12px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer;" title="Envía UN email al correo de administración con los accesos (usuario+clave) de la central y TODAS las sucursales. El admin los reparte internamente.">✉️ Enviar accesos al admin</button>
                <button type="button" onclick="window.openParentDiagnostic('${d.id}')" style="background:transparent; border:1px solid #4CAF50; color:#4CAF50; padding:6px 12px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer;" title="Comprobar que padre y sucursales están bien configurados y que la facturación saldrá correcta">🩺 Verificar configuración</button>
                <button type="button" onclick="window.openInvoiceFormatModal('${d.id}')" style="background:#FF6600; border:0; color:#fff; padding:6px 14px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer;">📊 Facturar mes</button>
                <button type="button" onclick="window.openNewSucursalModal('${d.id}')" style="background:#5DADE2; border:0; color:#000; padding:6px 14px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer;">+ Nueva sucursal</button>
            </div>
        </div>
        <div id="fc-sucursales-list" style="margin-bottom:10px;"></div>
        `}

        ${_sectionTitle('manage_accounts', 'Acceso online & Albarán', '#FF4D00')}
        <div id="fc-access-banner" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:8px 12px; margin-bottom:8px; font-size:0.78rem; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
            <div id="fc-access-label" style="color:#aaa;">Cargando estado…</div>
            <div id="fc-access-actions" style="display:flex; gap:5px; flex-wrap:wrap;"></div>
        </div>
        <div id="fc-access-loginline" style="display:none; font-size:0.7rem; color:#888; font-family:monospace; word-break:break-all; margin-bottom:8px;"></div>
        <div style="display:grid; grid-template-columns: 200px 1fr 1fr 1fr; gap:6px; margin-bottom:6px;">
            <div style="min-width:auto; display:flex; align-items:center; gap:6px; padding-top:18px;">
                <input type="checkbox" id="fc-access-active" ${(d.accessActive === undefined || d.accessActive) ? 'checked' : ''} style="scale:1.2;">
                <label for="fc-access-active" style="color:#ccc; font-size:0.78rem; cursor:pointer;">Cuenta activa</label>
            </div>
            ${_field('Prefijo albarán', 'fc-prefix', '', { placeholder: 'NP', minWidth: 'auto' })}
            ${_field('Próximo nº', 'fc-startnum', '', { type: 'number', placeholder: '1001', minWidth: 'auto' })}
            <div style="min-width:auto;">
                <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">Vista previa siguiente ID</label>
                <div id="fc-albaran-preview" style="padding:5px 7px; background:rgba(76,175,80,0.06); border:1px solid rgba(76,175,80,0.25); border-radius:4px; font-family:monospace; font-size:0.85rem; color:#4CAF50; font-weight:700; text-align:center;">—</div>
            </div>
        </div>
        `;

        // Hooks de preview y carga asíncrona de comp_main + estado de acceso
        setTimeout(_fichaWireAccessSection, 50);

        // Auto-detección silenciosa del teléfono de ruta SI el campo está vacío.
        // Usa el CP de ESTA ficha (parent o sucursal — cada una su CP).
        setTimeout(function() {
            const phoneEl = document.getElementById('fc-default-route-phone');
            if (phoneEl && !phoneEl.value.trim()) {
                try { window._fichaDetectRoutePhone(true); } catch(_) {}
            }
        }, 200);
    }

    function _fichaUpdateAlbaranPreview() {
        const pfxEl = document.getElementById('fc-prefix');
        const snEl = document.getElementById('fc-startnum');
        const prev = document.getElementById('fc-albaran-preview');
        if (!pfxEl || !snEl || !prev) return;
        let p = (pfxEl.value || pfxEl.placeholder || 'NP').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'NP';
        let n = parseInt(snEl.value || snEl.placeholder || '1001', 10);
        if (isNaN(n) || n < 1) n = 1001;
        prev.textContent = p + '-' + n;
    }

    async function _fichaLoadSucursales() {
        const d = _fichaClientData;
        if (!d || d.parentClientId) return; // las sucursales no listan otras sucursales
        const list = document.getElementById('fc-sucursales-list');
        const countEl = document.getElementById('fc-sucursales-count');
        if (!list) return;
        try {
            const snap = await db.collection('users').where('parentClientId', '==', d.id).get();
            const branches = [];
            snap.forEach(doc => branches.push({ id: doc.id, ...doc.data() }));
            if (countEl) countEl.textContent = branches.length;
            if (branches.length === 0) {
                list.innerHTML = '<div style="font-size:0.78rem; color:#666; padding:10px 12px; background:rgba(255,255,255,0.02); border-radius:6px;">Aún no hay sucursales. Pulsa <strong>+ Nueva sucursal</strong> para crear la primera.</div>';
                return;
            }
            branches.sort((a, b) => (a.idNum || '').toString().localeCompare((b.idNum || '').toString()));
            list.innerHTML = '<div style="display:flex; flex-direction:column; gap:6px;">' + branches.map(b => {
                const accessChip = b.authUid
                    ? '<span style="background:rgba(52,199,89,0.15); color:#34C759; padding:2px 8px; border-radius:8px; font-size:0.65rem;">🟢 Login activo</span>'
                    : '<span style="background:rgba(255,159,10,0.15); color:#FF9F0A; padding:2px 8px; border-radius:8px; font-size:0.65rem;">🔴 Sin acceso</span>';
                return ''
                    + '<div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:rgba(93,173,226,0.04); border:1px solid rgba(93,173,226,0.15); border-radius:6px; font-size:0.8rem;">'
                    + '  <div>'
                    + '    <span style="color:#5DADE2; font-weight:700; font-family:monospace;">#' + (b.idNum || '?') + '</span>'
                    + '    <span style="color:#fff; margin-left:8px; font-weight:500;">' + (b.name || 'Sin nombre') + '</span>'
                    + '    <span style="color:#888; margin-left:10px; font-size:0.7rem;">' + (b.localidad || '') + '</span>'
                    + '    <span style="margin-left:10px;">' + accessChip + '</span>'
                    + (b.loginEmail ? '<div style="font-size:0.65rem; color:#666; font-family:monospace; margin-top:2px;">login: ' + b.loginEmail + '</div>' : '')
                    + '  </div>'
                    + '  <div style="display:flex; gap:4px;">'
                    + '    <button type="button" onclick="openFichaCliente(\'' + b.id + '\')" style="background:transparent; border:1px solid #5DADE2; color:#5DADE2; padding:3px 9px; border-radius:5px; font-size:0.7rem; cursor:pointer;">Abrir ficha</button>'
                    + (b.authUid
                        ? '<button type="button" onclick="impersonateClient(\'' + b.id + '\')" style="background:transparent; border:1px solid #AB47BC; color:#AB47BC; padding:3px 9px; border-radius:5px; font-size:0.7rem; cursor:pointer;">👁️ Entrar</button>'
                        : '<button type="button" onclick="openActivateAccessModal(\'' + b.id + '\')" style="background:transparent; border:1px solid #FF9F0A; color:#FF9F0A; padding:3px 9px; border-radius:5px; font-size:0.7rem; cursor:pointer;">🔓 Activar</button>')
                    + '  </div>'
                    + '</div>';
            }).join('') + '</div>';
        } catch(e) {
            list.innerHTML = '<div style="color:#FF3B30; font-size:0.78rem;">Error cargando sucursales: ' + e.message + '</div>';
        }
    }

    // Modal "Nueva sucursal" — formulario minimal con los campos necesarios.
    // Hereda NIF + tarifa + paymentTerms del padre. parentClientId apunta al
    // padre. Crea comp_main con prefijo y nº inicial. Activa Auth opcional.
    window.openNewSucursalModal = async function(parentId) {
        const parent = (window.userMap && window.userMap[parentId])
                    || (window._advClientsCache && window._advClientsCache.find(c => c.id === parentId))
                    || _fichaClientData;
        if (!parent) { alert('No encuentro al cliente padre. Recarga la página.'); return; }

        // Sugerir siguiente sufijo libre: A, B, C…
        let suggestedSuffix = 'A';
        try {
            const snap = await db.collection('users').where('parentClientId', '==', parentId).get();
            const used = new Set();
            snap.forEach(doc => {
                const idn = (doc.data().idNum || '').toString();
                const m = idn.match(/[A-Z]$/i);
                if (m) used.add(m[0].toUpperCase());
            });
            const letters = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
            suggestedSuffix = letters.find(l => !used.has(l)) || 'X';
        } catch(e) {}

        const baseIdNum = (parent.idNum || 'X').toString();
        const suggestedIdNum = baseIdNum + suggestedSuffix;
        const basePrefix = (parent.prefix || baseIdNum).toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        const suggestedPrefix = basePrefix + suggestedSuffix;

        const existing = document.getElementById('modal-new-sucursal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'modal-new-sucursal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100000; display:flex; align-items:center; justify-content:center; padding:20px;';
        modal.innerHTML = ''
            + '<div style="background:#1e1e1e; border:1px solid #5DADE2; border-radius:12px; padding:24px; max-width:560px; width:100%; color:#d4d4d4;">'
            + '<h3 style="margin:0 0 6px; color:#5DADE2; font-size:1.05rem;">+ Nueva sucursal de ' + (parent.name || parent.idNum || '?') + '</h3>'
            + '<p style="margin:0 0 18px; font-size:0.78rem; color:#888;">Hereda NIF ' + (parent.nif || '—') + ' y la tarifa del padre. Tiene su propio login y prefijo de albarán.</p>'
            + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">ID Cliente</label><input type="text" id="ns-idnum" value="' + suggestedIdNum + '" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px; font-family:monospace;"></div>'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">Nombre sucursal</label><input type="text" id="ns-name" placeholder="Ej: ' + (parent.name || 'Cliente') + ' Vélez-Málaga" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;"></div>'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">Prefijo albarán</label><input type="text" id="ns-prefix" value="' + suggestedPrefix + '" maxlength="6" oninput="this.value=this.value.toUpperCase()" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px; font-family:monospace;"></div>'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">Próximo nº albarán</label><input type="number" id="ns-startnum" value="1001" min="1" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px; font-family:monospace;"></div>'
            + '  <div style="grid-column:1 / span 2;"><label style="font-size:0.7rem; color:#aaa;">Localidad / Dirección breve</label><input type="text" id="ns-localidad" placeholder="Localidad o dirección corta" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;"></div>'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">CP</label><input type="text" id="ns-cp" maxlength="5" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px; font-family:monospace;"></div>'
            + '  <div><label style="font-size:0.7rem; color:#aaa;">Provincia</label><input type="text" id="ns-province" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;"></div>'
            + '</div>'
            + '<div style="margin-top:16px; padding:12px; background:rgba(255,159,10,0.06); border:1px solid rgba(255,159,10,0.2); border-radius:6px;">'
            + '  <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; color:#FF9F0A; font-weight:600;"><input type="checkbox" id="ns-activate" checked> Activar acceso online ahora</label>'
            + '  <div id="ns-auth-fields" style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;">'
            + '    <div><label style="font-size:0.68rem; color:#aaa;">Email login (opcional — si vacío genera sintético)</label><input type="email" id="ns-email" placeholder="(auto)" style="width:100%; padding:7px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:4px; font-size:0.8rem;"></div>'
            + '    <div><label style="font-size:0.68rem; color:#aaa;">Contraseña</label><input type="text" id="ns-password" placeholder="mín 6 chars" style="width:100%; padding:7px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:4px; font-size:0.8rem;"></div>'
            + '  </div>'
            + '</div>'
            + '<div style="display:flex; gap:10px; justify-content:flex-end; margin-top:18px;">'
            + '  <button type="button" id="ns-cancel" style="background:#333; border:1px solid #555; color:#fff; padding:8px 18px; border-radius:6px; cursor:pointer;">Cancelar</button>'
            + '  <button type="button" id="ns-save" style="background:#5DADE2; border:0; color:#000; padding:8px 22px; border-radius:6px; font-weight:700; cursor:pointer;">Crear sucursal</button>'
            + '</div>'
            + '</div>';
        document.body.appendChild(modal);

        document.getElementById('ns-activate').addEventListener('change', function() {
            document.getElementById('ns-auth-fields').style.display = this.checked ? 'grid' : 'none';
        });
        document.getElementById('ns-cancel').addEventListener('click', () => modal.remove());
        document.getElementById('ns-save').addEventListener('click', async function() {
            const idnum = document.getElementById('ns-idnum').value.trim();
            const name = document.getElementById('ns-name').value.trim();
            const prefix = document.getElementById('ns-prefix').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            const startNum = parseInt(document.getElementById('ns-startnum').value, 10) || 1001;
            const localidad = document.getElementById('ns-localidad').value.trim();
            const cp = document.getElementById('ns-cp').value.trim();
            const province = document.getElementById('ns-province').value.trim();
            const wantActivate = document.getElementById('ns-activate').checked;
            const customEmail = document.getElementById('ns-email').value.trim().toLowerCase();
            const password = document.getElementById('ns-password').value;

            if (!idnum) { alert('Introduce el ID de la sucursal.'); return; }
            if (!name) { alert('Introduce el nombre de la sucursal.'); return; }
            if (!prefix) { alert('El prefijo de albarán no puede estar vacío.'); return; }
            if (wantActivate && (!password || password.length < 6)) { alert('Si activas el acceso, la contraseña debe tener mínimo 6 caracteres.'); return; }

            // Comprobar que el idNum no existe ya
            const dup = await db.collection('users').where('idNum', '==', idnum).limit(1).get();
            if (!dup.empty) { alert('Ya existe un cliente con ID #' + idnum + '. Elige otro.'); return; }

            this.disabled = true;
            this.textContent = 'Creando…';
            try {
                let newDocId, newAuthUid = null, loginEmail = null;

                // 1. Crear Auth si toca
                if (wantActivate) {
                    // Determinar email para Auth: custom si lo pone, si no sintético
                    let emailToUse = customEmail;
                    if (!emailToUse) {
                        emailToUse = typeof window.generateLoginEmail === 'function'
                            ? window.generateLoginEmail({ idNum: idnum, name: name }).toLowerCase()
                            : ('c' + idnum.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + Date.now().toString(36).slice(-4) + '@novapack.com');
                    }
                    const secApp = firebase.apps.find(a => a.name === 'Secondary') || firebase.initializeApp(firebaseConfig, 'Secondary');
                    try {
                        const cred = await secApp.auth().createUserWithEmailAndPassword(emailToUse, password);
                        newAuthUid = cred.user.uid;
                        loginEmail = emailToUse;
                        newDocId = newAuthUid; // usar uid como docId (consistente con flujo create cliente)
                        try { await secApp.auth().signOut(); } catch(e) {}
                    } catch(authErr) {
                        if (authErr.code === 'auth/email-already-in-use' && !customEmail) {
                            // Reintentar con email sintético distinto
                            alert('Email sintético colisionó (raro). Reintentar manualmente.');
                            this.disabled = false; this.textContent = 'Crear sucursal'; return;
                        }
                        if (authErr.code === 'auth/email-already-in-use') {
                            alert('Ese email ya tiene una cuenta Auth. Quita el email custom (dejaremos sintético) o usa otro distinto.');
                            this.disabled = false; this.textContent = 'Crear sucursal'; return;
                        }
                        throw authErr;
                    }
                } else {
                    newDocId = db.collection('users').doc().id;
                }

                // 2. Crear users/{newDocId}
                const sucursalData = {
                    idNum: idnum,
                    name: name,
                    parentClientId: parentId,
                    nif: parent.nif || '',  // hereda NIF del padre
                    // ⬇ Hereda el email REAL del padre. Es lo que usaremos como
                    //   destinatario de la bienvenida y demás comunicaciones.
                    //   El loginEmail (sintético) se setea aparte más abajo.
                    email: parent.email || '',
                    adminEmail: parent.adminEmail || '',
                    tariffId: parent.tariffId || '',
                    billingCompanyId: parent.billingCompanyId || '',
                    paymentTerms: parent.paymentTerms || 'contado',
                    iban: parent.iban || '',
                    sepaRef: parent.sepaRef || '',
                    sepaDate: parent.sepaDate || '',
                    // Sucursal NO hereda flat rate — su facturación es por consumo real (Formato 2)
                    isFlatRate: false,
                    flatRateAmount: 0,
                    localidad: localidad,
                    cp: cp,
                    province: province,
                    role: 'client',
                    accessActive: true,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    createdBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || 'admin'
                };
                if (newAuthUid) {
                    sucursalData.authUid = newAuthUid;
                    sucursalData.loginEmail = loginEmail;
                    sucursalData.accessActivatedAt = firebase.firestore.FieldValue.serverTimestamp();
                    // Guardamos la contraseña en claro: es NECESARIO para el
                    // flujo de "email consolidado de accesos al admin del
                    // padre". El admin de la empresa cliente reparte las
                    // claves a sus sucursales por sus canales internos.
                    // Las reglas Firestore ya restringen lectura de /users a
                    // admin / owner.
                    sucursalData.loginPasswordPlain = password;
                }
                await db.collection('users').doc(newDocId).set(sucursalData);

                // 3. comp_main para la sucursal
                await db.collection('users').doc(newDocId).collection('companies').doc('comp_main').set({
                    name: name,
                    idNum: parseInt(idnum.replace(/\D/g, ''), 10) || null,
                    nif: parent.nif || '',
                    prefix: prefix,
                    startNum: startNum,
                    localidad: localidad,
                    cp: cp,
                    province: province,
                    address: (localidad + (cp ? ' ' + cp : '')).trim(),
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                // 4. Cache local
                if (window.userMap) window.userMap[newDocId] = { id: newDocId, ...sucursalData };
                if (window._advClientsCache) window._advClientsCache.push({ id: newDocId, ...sucursalData });

                modal.remove();
                alert('✅ Sucursal creada.\n\n' + (newAuthUid
                    ? 'Login: ' + loginEmail + '\nContraseña: ' + password + '\n\nComunícaselo al responsable de la sucursal.'
                    : 'Sin acceso online activado. Puedes activarlo después desde su ficha.'));
                // Refrescar lista
                _fichaLoadSucursales();
                if (typeof loadUsers === 'function') loadUsers('current');
            } catch(e) {
                console.error(e);
                alert('Error creando sucursal: ' + e.message);
            } finally {
                this.disabled = false;
                this.textContent = 'Crear sucursal';
            }
        });
    };

    // ============================================================
    //  MIGRACIÓN cuota plana legacy → tarifa v2 con flat_monthly
    // ============================================================
    // Convierte un cliente con isFlatRate=true + flatRateAmount=X en un
    // cliente con tarifa v2 que contiene un item flat_monthly de X €/mes.
    // Crea la tarifa global GLOBAL_PLANA_<idNum>_v2 si no existe, asigna
    // tariffId al cliente, y limpia los flags legacy.
    window._migrateClientFlatRateToV2 = async function(clientId) {
        if (!clientId) return;
        const c = (window.userMap && window.userMap[clientId])
               || (window._advClientsCache && window._advClientsCache.find(x => x.id === clientId));
        if (!c) { alert('Cliente no encontrado en cache.'); return; }
        const flatAmt = Number(c.flatRateAmount) || 0;
        if (flatAmt <= 0) { alert('Este cliente no tiene cuota plana legacy (flatRateAmount = 0). Nada que migrar.'); return; }

        const tariffId = 'GLOBAL_PLANA_' + (c.idNum || clientId).toString().toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_v2';
        const confirm1 = confirm(
            'Migración cuota plana legacy → tarifa v2\n\n' +
            'Cliente: ' + (c.name || c.idNum) + '\n' +
            'Cuota actual: ' + flatAmt.toFixed(2) + ' €/mes (legacy)\n\n' +
            'Acciones a realizar:\n' +
            '  1. Crear tarifa global "' + tariffId + '" con un item flat_monthly de ' + flatAmt.toFixed(2) + ' €/mes\n' +
            '  2. Asignar esta tarifa al cliente (users/' + clientId + '.tariffId)\n' +
            '  3. Limpiar flags legacy (isFlatRate=false, flatRateAmount=0)\n\n' +
            'El comportamiento de facturación será IDÉNTICO (cuota plana de ' + flatAmt.toFixed(2) + ' €/mes), ' +
            'pero pasará por el motor nuevo y podrás añadirle artículos extras facturados aparte.\n\n' +
            '¿Continuar?'
        );
        if (!confirm1) return;

        try {
            if (typeof showLoading === 'function') showLoading();

            // 1. Crear/actualizar tarifa v2
            const tariffPayload = {
                name: 'Plana ' + (c.name || ('#' + c.idNum)),
                version: 2,
                items: [
                    {
                        id: 'cuota_mensual',
                        name: 'Cuota mensual',
                        mode: 'flat_monthly',
                        basePrice: flatAmt,
                        unit: 'mes',
                        pricingRule: null
                    }
                ],
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                createdBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || 'admin',
                migratedFrom: 'legacy_flat_rate',
                migratedFromClientId: clientId,
                migratedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('tariffs').doc(tariffId).set(tariffPayload, { merge: true });

            // 2. Asignar al cliente + limpiar legacy
            await db.collection('users').doc(clientId).update({
                tariffId: tariffId,
                isFlatRate: false,         // ⚠️ desactivamos el legacy para no doblar cobro
                flatRateAmount: 0,
                tariffMigratedFromLegacyAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // 3. Update cache local + tariffsCache para que el render lo pille al vuelo
            if (window.userMap && window.userMap[clientId]) {
                Object.assign(window.userMap[clientId], {
                    tariffId: tariffId,
                    isFlatRate: false,
                    flatRateAmount: 0
                });
            }
            if (typeof tariffsCache !== 'undefined') {
                tariffsCache[tariffId] = tariffPayload;
            }
            _fichaClientData = { ..._fichaClientData, tariffId: tariffId, isFlatRate: false, flatRateAmount: 0 };

            if (typeof hideLoading === 'function') hideLoading();
            alert('✅ Migración completada.\n\nTarifa creada: ' + tariffId + '\nCliente actualizado.\n\nLa facturación seguirá emitiendo la misma cuota mensual.');
            _fichaRender();
        } catch(e) {
            if (typeof hideLoading === 'function') hideLoading();
            console.error('[migrate]', e);
            alert('Error en migración: ' + e.message);
        }
    };

    // Migración masiva: itera TODOS los clientes con cuota plana legacy
    window._migrateAllFlatRateClientsToV2 = async function() {
        if (!confirm('⚠️ MIGRACIÓN MASIVA\n\nVa a migrar TODOS los clientes con isFlatRate=true + flatRateAmount>0 al modelo v2.\n\nPara cada uno:\n  • Crea tarifa GLOBAL_PLANA_<idNum>_v2\n  • Asigna esa tarifa\n  • Limpia los flags legacy\n\nNO TOCA sucursales (los sucursales con isFlatRate=true son anomalía, no se migran automáticamente).\n\n¿Continuar?')) return;
        try {
            if (typeof showLoading === 'function') showLoading();
            const snap = await db.collection('users').where('isFlatRate', '==', true).get();
            const candidates = [];
            snap.forEach(d => {
                const data = d.data();
                if (data.parentClientId) return; // skip sucursales
                if ((Number(data.flatRateAmount) || 0) <= 0) return;
                candidates.push({ id: d.id, ...data });
            });

            if (candidates.length === 0) {
                if (typeof hideLoading === 'function') hideLoading();
                alert('No hay clientes a migrar.');
                return;
            }

            let ok = 0, fail = 0;
            for (const c of candidates) {
                try {
                    const tariffId = 'GLOBAL_PLANA_' + (c.idNum || c.id).toString().toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_v2';
                    await db.collection('tariffs').doc(tariffId).set({
                        name: 'Plana ' + (c.name || ('#' + c.idNum)),
                        version: 2,
                        items: [{
                            id: 'cuota_mensual',
                            name: 'Cuota mensual',
                            mode: 'flat_monthly',
                            basePrice: Number(c.flatRateAmount) || 0,
                            unit: 'mes',
                            pricingRule: null
                        }],
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                        migratedFromClientId: c.id
                    }, { merge: true });
                    await db.collection('users').doc(c.id).update({
                        tariffId: tariffId,
                        isFlatRate: false,
                        flatRateAmount: 0,
                        tariffMigratedFromLegacyAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    ok++;
                } catch(e) {
                    console.error('[migrate-all]', c.id, e);
                    fail++;
                }
            }

            if (typeof hideLoading === 'function') hideLoading();
            alert('Migración masiva terminada.\n\n  Migrados OK: ' + ok + '\n  Fallidos: ' + fail + '\n\nRefresca el listado de clientes.');
            if (typeof window.advLoadClients === 'function') window.advLoadClients();
        } catch(e) {
            if (typeof hideLoading === 'function') hideLoading();
            alert('Error en migración masiva: ' + e.message);
        }
    };

    // ============================================================
    //  DIAGNÓSTICO DE CONFIGURACIÓN PADRE + SUCURSALES
    //  Lee Firestore en vivo y reporta qué está bien, qué tiene aviso
    //  y qué hay que arreglar para que la facturación mensual salga
    //  correctamente.
    // ============================================================
    window.openParentDiagnostic = async function(parentId) {
        if (!parentId) return;
        const _esc = (s) => (typeof escapeHtml === 'function')
            ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

        // Contenedor: ERP tab si está disponible, modal si no.
        const _opener = (typeof window.openWorkspaceOrModal === 'function')
            ? window.openWorkspaceOrModal({
                tabKey: 'parent-diagnostic',
                tabTitle: '🩺 Diagnóstico',
                tabIcon: 'monitor_heart',
                modalId: 'parent-diag-modal',
                modalStyle: 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100000; display:flex; align-items:center; justify-content:center; padding:18px;'
              })
            : (function() {
                // Fallback si helper no cargado todavía
                const old = document.getElementById('parent-diag-modal');
                if (old) old.remove();
                const m = document.createElement('div');
                m.id = 'parent-diag-modal';
                m.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100000; display:flex; align-items:center; justify-content:center; padding:18px;';
                document.body.appendChild(m);
                return { container: m, close: () => m.remove(), useERP: false };
              })();
        const modal = _opener.container;
        const _diagClose = _opener.close;
        modal.innerHTML = '<div style="background:#1e1e1e; border:1px solid #444; border-radius:12px; padding:22px; max-width:920px; width:100%; max-height:' + (_opener.useERP ? 'none' : '92vh') + '; ' + (_opener.useERP ? '' : 'overflow-y:auto; ') + 'margin:' + (_opener.useERP ? '18px auto' : '0') + '; color:#d4d4d4;"><div style="text-align:center; padding:60px 20px; color:#888;">Verificando configuración…</div></div>';

        const issues = []; // {level:'ok'|'warn'|'err', msg:''}
        const add = (level, msg) => issues.push({ level, msg });
        let parent = null;
        let children = [];

        try {
            // 1. Cargar padre fresco desde Firestore
            const parentDoc = await db.collection('users').doc(parentId).get();
            if (!parentDoc.exists) {
                modal.innerHTML = '<div style="background:#1e1e1e; border:1px solid #f44; border-radius:12px; padding:22px; max-width:600px; color:#FF3B30;">❌ Cliente padre no encontrado en Firestore.</div>';
                return;
            }
            parent = { id: parentDoc.id, ...parentDoc.data() };

            // 2. Cargar sucursales (los que apuntan al padre por docId o idNum)
            const childByDoc = await db.collection('users').where('parentClientId', '==', parentDoc.id).get();
            childByDoc.forEach(d => children.push({ id: d.id, ...d.data() }));
            if (parent.idNum) {
                const childByIdNum = await db.collection('users').where('parentClientId', '==', String(parent.idNum)).get();
                childByIdNum.forEach(d => {
                    if (!children.find(c => c.id === d.id)) children.push({ id: d.id, ...d.data() });
                });
            }

            // 3. Cargar comp_main del padre (prefijo + startNum)
            let parentComp = {};
            try {
                const cm = await db.collection('users').doc(parentDoc.id).collection('companies').doc('comp_main').get();
                if (cm.exists) parentComp = cm.data();
            } catch(_) {}

            // ─── CHECKS DEL PADRE ────────────────────────────────────
            if (parent.parentClientId) add('err', 'El padre tiene parentClientId — debería ser independiente. Quítalo desde su ficha.');
            else add('ok', 'Es cliente padre/independiente (sin parentClientId).');

            if (parent.nif) add('ok', 'Tiene NIF: <code>' + _esc(parent.nif) + '</code>.');
            else add('warn', 'No tiene NIF — sus sucursales no podrán heredarlo y las facturas saldrán sin NIF.');

            // ─── DETECTAR CUOTA PLANA (v2 manda; legacy como fallback) ───
            // Cargar la tarifa asignada para ver si tiene items flat_monthly.
            let v2FlatTotal = 0;
            let v2FlatItems = [];
            let tariffDocData = null;
            if (parent.tariffId) {
                try {
                    const candidates = [parent.tariffId, 'GLOBAL_' + parent.tariffId];
                    for (const tid of candidates) {
                        try {
                            const tdoc = await db.collection('tariffs').doc(tid).get();
                            if (tdoc.exists) {
                                tariffDocData = { id: tdoc.id, ...tdoc.data() };
                                if (tariffDocData.version === 2 && Array.isArray(tariffDocData.items)) {
                                    // Aplicar overrides del cliente
                                    let resolvedItems = tariffDocData.items;
                                    if (parent.tariffOverrides && typeof window.pricingEngine !== 'undefined') {
                                        try {
                                            const res = window.pricingEngine.resolveTariff(tariffDocData, parent.tariffOverrides);
                                            resolvedItems = res.items || resolvedItems;
                                        } catch(_) {}
                                    }
                                    resolvedItems.forEach(it => {
                                        if (it.mode === 'flat_monthly') {
                                            v2FlatTotal += Number(it.basePrice) || 0;
                                            v2FlatItems.push(it);
                                        }
                                    });
                                }
                                break;
                            }
                        } catch(_) {}
                    }
                } catch(_) {}
            }

            // Cuota plana: combina v2 y legacy, da prioridad a v2 si existe
            const legacyAmt = Number(parent.flatRateAmount) || 0;
            if (v2FlatTotal > 0) {
                add('ok', 'Cuota plana mensual ACTIVA (vía tarifa v2): <code>' + v2FlatTotal.toFixed(2).replace('.', ',') + ' €/mes</code>. Formato 1 emitirá esta cuota una vez al mes.');
                if (parent.isFlatRate && legacyAmt > 0) {
                    add('warn', 'Tienes ADEMÁS los campos legacy activos (isFlatRate=Sí, ' + legacyAmt.toFixed(2).replace('.', ',') + ' €). La v2 manda — los legacy se ignoran al facturar pero deberías limpiarlos para no confundir (pon Cuota Plana=No e Importe=0 en pestaña Económico, o desaparecerán solos cuando guardes).');
                }
            } else if (parent.isFlatRate && legacyAmt > 0) {
                add('ok', 'Cuota plana mensual ACTIVA (legacy): <code>' + legacyAmt.toFixed(2).replace('.', ',') + ' €/mes</code>. Formato 1 emitirá esta cuota una vez al mes. Recomendación: migra a tarifa v2 con item flat_monthly desde la ficha → Económico → 🔄 Migrar a v2.');
            } else if (parent.isFlatRate && legacyAmt === 0) {
                add('warn', 'isFlatRate=Sí pero flatRateAmount=0 y la tarifa no tiene flat_monthly. La factura del Formato 1 saldrá a 0 €. Edita el importe o asigna tarifa v2 con cuota.');
            } else {
                add('warn', 'Sin cuota plana mensual. La facturación será por consumo real (Formato 2) — solo se cobrarán los albaranes individuales. Si tenías acuerdo de cuota plana, ponla desde 💰 Gestionar (item flat_monthly) o desde la pestaña Económico (legacy).');
            }

            if (parent.tariffId) {
                let tariffLabel = parent.tariffId;
                if (tariffDocData && tariffDocData.name) tariffLabel = tariffDocData.name + ' [' + (tariffDocData.version === 2 ? 'v2' : 'v1') + ']';
                add('ok', 'Tarifa asignada: <code>' + _esc(tariffLabel) + '</code>.');
            } else {
                add('warn', 'Sin tariffId. Sus extras (paletizados, etc.) y los albaranes reales de sucursales no tendrán tarifa de referencia. Asigna una en pestaña Principal.');
            }

            if (parentComp.prefix && parentComp.startNum) add('ok', 'Prefijo de albarán del padre: <code>' + _esc(parentComp.prefix) + '-' + parentComp.startNum + '</code>.');
            else add('warn', 'Falta prefijo o nº inicial de albarán en comp_main del padre.');

            if (parent.accessActive === false) add('warn', 'Acceso online DESACTIVADO en el padre. No podrá entrar a su app.');
            else add('ok', 'Acceso online activo en el padre.');

            // ─── CHECKS POR SUCURSAL ─────────────────────────────────
            const childReports = [];
            for (const c of children) {
                const r = { id: c.id, idNum: c.idNum, name: c.name, ok: [], warn: [], err: [] };

                if (String(c.parentClientId) === String(parent.id) || String(c.parentClientId) === String(parent.idNum)) {
                    r.ok.push('parentClientId apunta al padre correctamente.');
                } else {
                    r.err.push('parentClientId apunta a "' + _esc(c.parentClientId) + '" — NO al padre.');
                }

                if (c.nif && parent.nif && c.nif === parent.nif) r.ok.push('NIF heredado del padre.');
                else if (!c.nif) r.warn.push('Sin NIF — sus facturas independientes (Formato 2) saldrán sin NIF.');
                else if (parent.nif && c.nif !== parent.nif) r.warn.push('NIF distinto al del padre — confirma que sea intencional.');

                if (c.isFlatRate) r.err.push('isFlatRate=Sí en la sucursal. ❌ Duplicará la cuota plana del padre. Pon isFlatRate=No.');
                else r.ok.push('isFlatRate=No (no duplica cuota plana).');

                if (Number(c.flatRateAmount) > 0) r.warn.push('flatRateAmount > 0 (' + c.flatRateAmount + ' €). Ponlo a 0 para que no salga cuota en su factura.');

                if (c.tariffId) r.ok.push('Tarifa: <code>' + _esc(c.tariffId) + '</code>' + (c.tariffId === parent.tariffId ? ' (misma que el padre)' : ' (distinta a la del padre)') + '.');
                else r.warn.push('Sin tariffId — no podrá facturar extras si los tiene.');

                // comp_main de la sucursal
                let scComp = {};
                try {
                    const sc = await db.collection('users').doc(c.id).collection('companies').doc('comp_main').get();
                    if (sc.exists) scComp = sc.data();
                } catch(_) {}
                if (scComp.prefix && scComp.startNum) {
                    if (parentComp.prefix && scComp.prefix === parentComp.prefix) {
                        r.err.push('Prefijo de albarán <code>' + _esc(scComp.prefix) + '</code> IGUAL al del padre → colisionarán IDs. Cambia el prefijo de la sucursal (típicamente padre+letra).');
                    } else {
                        r.ok.push('Prefijo único: <code>' + _esc(scComp.prefix) + '-' + scComp.startNum + '</code>.');
                    }
                } else {
                    r.warn.push('Falta prefijo o nº inicial de albarán en comp_main.');
                }

                if (c.accessActive === false) r.warn.push('Acceso online DESACTIVADO.');
                else if (c.authUid) r.ok.push('Acceso online activo (login: <code>' + _esc(c.loginEmail || c.email || '?') + '</code>).');
                else r.warn.push('Sin authUid — la sucursal no tiene cuenta de login todavía. Actívala con 🔓 en el listado.');

                childReports.push(r);
            }

            // ─── PREDICCIÓN DE FACTURACIÓN ───────────────────────────
            // Cuota efectiva: v2 manda, legacy como fallback (mismo orden que
            // window.getMonthlyFlatAmount). El motor real factura por el
            // primero que tenga > 0.
            const effectiveFlat = v2FlatTotal > 0 ? v2FlatTotal : (Number(parent.flatRateAmount) || 0);
            const flatSource = v2FlatTotal > 0 ? 'tarifa v2' : (parent.isFlatRate && parent.flatRateAmount > 0 ? 'legacy' : null);
            let predict = '';
            if (effectiveFlat > 0) {
                predict += '<p><strong>📊 Formato 1 (consolidado tarifa plana):</strong> emite UNA factura al padre <strong>' + _esc(parent.name || '') + '</strong> por <code>' + effectiveFlat.toFixed(2).replace('.', ',') + ' €</code> (' + flatSource + '). Las sucursales aparecen como desglose informativo de volumen (sin precio).</p>';
                predict += '<p><strong>📊 Formato 2 (factura por sucursal):</strong> emite UNA factura por cada sucursal con sus albaranes a precio real (según tariffId) + UNA factura al padre por la cuota plana <code>' + effectiveFlat.toFixed(2).replace('.', ',') + ' €</code>. Total: <strong>' + (children.length + 1) + '</strong> facturas.</p>';
            } else {
                predict += '<p><strong>📊 Formato 1 NO aplicable</strong> (el padre no tiene cuota plana ni en v2 ni en legacy). Sólo Formato 2.</p>';
                predict += '<p><strong>📊 Formato 2:</strong> emite UNA factura por cada sucursal con sus albaranes a precio real. Total: <strong>' + children.length + '</strong> facturas + 1 al padre si tiene movimientos propios.</p>';
            }
            const errs = issues.filter(i => i.level === 'err').length + childReports.reduce((a,r) => a + r.err.length, 0);
            const warns = issues.filter(i => i.level === 'warn').length + childReports.reduce((a,r) => a + r.warn.length, 0);

            // ─── RENDER REPORT ───────────────────────────────────────
            const chip = (level) => level === 'ok'
                ? '<span style="background:rgba(76,175,80,0.18); color:#4CAF50; padding:2px 7px; border-radius:8px; font-size:0.7rem; font-weight:700; margin-right:6px;">✓ OK</span>'
                : level === 'warn'
                    ? '<span style="background:rgba(255,193,7,0.18); color:#FFC107; padding:2px 7px; border-radius:8px; font-size:0.7rem; font-weight:700; margin-right:6px;">⚠ AVISO</span>'
                    : '<span style="background:rgba(255,59,48,0.18); color:#FF3B30; padding:2px 7px; border-radius:8px; font-size:0.7rem; font-weight:700; margin-right:6px;">✗ ERROR</span>';

            let html = '<div style="background:#1e1e1e; border:1px solid #444; border-radius:12px; padding:22px; max-width:920px; width:100%; max-height:92vh; overflow-y:auto; color:#d4d4d4;">'
                + '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">'
                + '  <div><h2 style="margin:0; color:' + (errs ? '#FF3B30' : (warns ? '#FFC107' : '#4CAF50')) + ';">🩺 Diagnóstico: ' + _esc(parent.name || parent.idNum || '?') + '</h2>'
                + '  <div style="font-size:0.78rem; color:#aaa; margin-top:3px;">' + children.length + ' sucursales · ' + errs + ' error' + (errs === 1 ? '' : 'es') + ' · ' + warns + ' aviso' + (warns === 1 ? '' : 's') + '</div></div>'
                + '  <button id="pd-close" style="background:#333; border:1px solid #555; color:#fff; padding:7px 16px; border-radius:6px; cursor:pointer;">Cerrar</button>'
                + '</div>';

            html += '<div style="background:#0a0a0a; border:1px solid #2d2d30; border-radius:8px; padding:12px; margin-bottom:14px;">'
                + '<h3 style="margin:0 0 8px; color:#FF6600; font-size:0.9rem;">CLIENTE PADRE</h3>';
            issues.forEach(i => {
                html += '<div style="padding:5px 0; font-size:0.82rem;">' + chip(i.level) + i.msg + '</div>';
            });
            html += '</div>';

            html += '<div style="background:#0a0a0a; border:1px solid #2d2d30; border-radius:8px; padding:12px; margin-bottom:14px;">'
                + '<h3 style="margin:0 0 8px; color:#5DADE2; font-size:0.9rem;">SUCURSALES (' + children.length + ')</h3>';
            if (!children.length) {
                html += '<div style="color:#888; font-style:italic; font-size:0.82rem;">Este padre no tiene sucursales vinculadas.</div>';
            } else {
                childReports.forEach(r => {
                    html += '<div style="border:1px solid #2d2d30; border-radius:6px; padding:9px 12px; margin-bottom:8px;">'
                        + '<div style="font-weight:700; color:#fff; margin-bottom:5px;">#' + _esc(r.idNum || '?') + ' · ' + _esc(r.name || r.id) + '</div>';
                    r.err.forEach(m => html += '<div style="font-size:0.78rem; padding:2px 0;">' + chip('err') + m + '</div>');
                    r.warn.forEach(m => html += '<div style="font-size:0.78rem; padding:2px 0;">' + chip('warn') + m + '</div>');
                    r.ok.forEach(m => html += '<div style="font-size:0.78rem; padding:2px 0;">' + chip('ok') + m + '</div>');
                    html += '</div>';
                });
            }
            html += '</div>';

            html += '<div style="background:rgba(255,102,0,0.05); border:1px solid rgba(255,102,0,0.25); border-radius:8px; padding:12px; margin-bottom:14px;">'
                + '<h3 style="margin:0 0 8px; color:#FF8A50; font-size:0.9rem;">PREDICCIÓN DE FACTURACIÓN MENSUAL</h3>'
                + '<div style="font-size:0.82rem; line-height:1.5;">' + predict + '</div>'
                + '</div>';

            const verdict = errs
                ? '<div style="background:rgba(255,59,48,0.08); border:2px solid #FF3B30; border-radius:8px; padding:14px; color:#FF3B30; font-weight:700; text-align:center;">❌ HAY ' + errs + ' ERROR' + (errs === 1 ? '' : 'ES') + ' QUE DEBES CORREGIR ANTES DE FACTURAR.</div>'
                : warns
                    ? '<div style="background:rgba(255,193,7,0.08); border:2px solid #FFC107; border-radius:8px; padding:14px; color:#FFC107; font-weight:700; text-align:center;">⚠ ' + warns + ' AVISO' + (warns === 1 ? '' : 'S') + ' — la facturación funcionará pero conviene revisarlos.</div>'
                    : '<div style="background:rgba(76,175,80,0.08); border:2px solid #4CAF50; border-radius:8px; padding:14px; color:#4CAF50; font-weight:700; text-align:center;">✅ TODO CORRECTO. La facturación se emitirá según lo previsto arriba.</div>';
            html += verdict;
            html += '</div>';

            modal.innerHTML = html;
            const closeBtn = document.getElementById('pd-close');
            if (closeBtn) closeBtn.onclick = _diagClose;
        } catch(e) {
            console.error('[Diagnóstico]', e);
            modal.innerHTML = '<div style="background:#1e1e1e; border:1px solid #f44; border-radius:12px; padding:22px; max-width:600px; color:#FF3B30;">❌ Error en diagnóstico: ' + _esc(e.message) + '<br><br><button id="pd-close-err" style="background:#333; border:1px solid #555; color:#fff; padding:7px 16px; border-radius:6px; cursor:pointer; margin-top:10px;">Cerrar</button></div>';
            const eb = document.getElementById('pd-close-err');
            if (eb) eb.onclick = _diagClose;
        }
    };

    async function _fichaWireAccessSection() {
        const d = _fichaClientData;
        if (!d) return;
        // Cargar sucursales en paralelo si es padre
        if (!d.parentClientId) _fichaLoadSucursales();
        // Carga comp_main para prefix + startNum
        try {
            const compDoc = await db.collection('users').doc(d.id).collection('companies').doc('comp_main').get();
            const c = compDoc.exists ? compDoc.data() : {};
            const pfx = c.prefix || (d.idNum || 'NP').toString().toUpperCase().slice(0, 3);
            const sn = c.startNum || 1001;
            const pfxEl = document.getElementById('fc-prefix');
            const snEl = document.getElementById('fc-startnum');
            if (pfxEl) pfxEl.value = pfx;
            if (snEl) snEl.value = sn;
        } catch(e) { console.warn('comp_main load (ficha):', e); }

        // Wire preview live
        const pfxEl = document.getElementById('fc-prefix');
        const snEl = document.getElementById('fc-startnum');
        if (pfxEl) pfxEl.addEventListener('input', function() { this.value = this.value.toUpperCase(); _fichaUpdateAlbaranPreview(); });
        if (snEl) snEl.addEventListener('input', _fichaUpdateAlbaranPreview);
        _fichaUpdateAlbaranPreview();

        // Estado de acceso + acciones
        const label = document.getElementById('fc-access-label');
        const actions = document.getElementById('fc-access-actions');
        const lineInfo = document.getElementById('fc-access-loginline');
        if (label && actions) {
            if (d.authUid) {
                label.innerHTML = '<span style="font-size:0.95rem;">🟢</span> <strong>Acceso activo</strong>';
                actions.innerHTML =
                    '<button type="button" onclick="openChangeLoginModal(\'' + d.id + '\')" style="background:rgba(255,179,0,0.10); border:1px solid #FFB300; color:#FFB300; padding:4px 10px; border-radius:5px; font-size:0.72rem; cursor:pointer;">🔄 Cambiar login</button>'
                  + '<button type="button" onclick="composeWelcomeEmail(userMap[\'' + d.id + '\'] || _fichaClientData)" style="background:rgba(52,199,89,0.10); border:1px solid #34C759; color:#34C759; padding:4px 10px; border-radius:5px; font-size:0.72rem; cursor:pointer;">✉️ Reenviar</button>'
                  + '<button type="button" onclick="impersonateClient(\'' + d.id + '\')" style="background:rgba(171,71,188,0.10); border:1px solid #AB47BC; color:#AB47BC; padding:4px 10px; border-radius:5px; font-size:0.72rem; cursor:pointer;">👁️ Entrar como</button>';
                if (lineInfo) {
                    lineInfo.style.display = 'block';
                    lineInfo.textContent = 'Login: ' + (d.loginEmail || d.email || '?') + ' · UID: ' + d.authUid;
                }
            } else {
                label.innerHTML = '<span style="font-size:0.95rem;">🔴</span> Acceso online <strong>no activado</strong>';
                actions.innerHTML =
                    '<button type="button" onclick="openActivateAccessModal(\'' + d.id + '\')" style="background:rgba(255,159,10,0.10); border:1px solid #FF9F0A; color:#FF9F0A; padding:4px 10px; border-radius:5px; font-size:0.72rem; cursor:pointer;">🔓 Activar</button>'
                  + '<button type="button" onclick="openLinkAuthModal(\'' + d.id + '\')" style="background:rgba(93,173,226,0.10); border:1px solid #5DADE2; color:#5DADE2; padding:4px 10px; border-radius:5px; font-size:0.72rem; cursor:pointer;">🔗 Vincular</button>';
                if (lineInfo) lineInfo.style.display = 'none';
            }
        }
    }

    // ============================================================
    //  SUB-TAB: DATOS ECONÓMICOS
    // ============================================================
    function _fichaRenderEconomico() {
        const c = document.getElementById('ficha-subtab-content');
        const d = _fichaClientData;
        if (!c) return;

        c.innerHTML = `
        ${_sectionTitle('payments', 'Condiciones de Pago', '#FF9800')}
        <div style="display:grid; grid-template-columns: 200px 1fr; gap:6px; margin-bottom:6px;">
            ${_field('Forma de Pago', 'fc-payment-terms', d.paymentTerms || 'contado', {
                type: 'select', minWidth: 'auto',
                options: [
                    { value: 'contado', label: 'Contado' },
                    { value: 'giro_30', label: 'Giro a 30 d\u00edas' },
                    { value: 'giro_60', label: 'Giro a 60 d\u00edas' },
                    { value: 'giro_90', label: 'Giro a 90 d\u00edas' },
                    { value: 'giro_120', label: 'Giro a 120 d\u00edas' },
                    { value: 'transferencia', label: 'Transferencia' },
                    { value: 'recibo_sepa', label: 'Recibo domiciliado (SEPA)' }
                ]
            })}
            ${_field('IBAN Bancario', 'fc-iban', d.iban, { placeholder: 'ES00 0000 0000 0000 0000 0000', minWidth: 'auto' })}
        </div>

        ${_sectionTitle('description', 'Mandato SEPA', '#E040FB')}
        <div style="display:grid; grid-template-columns: 1fr 150px; gap:6px; margin-bottom:6px;">
            ${_field('Referencia SEPA', 'fc-sepa-ref', d.sepaRef, { minWidth: 'auto' })}
            ${_field('Fecha Mandato', 'fc-sepa-date', d.sepaDate, { type: 'date', minWidth: 'auto' })}
        </div>

        ${_sectionTitle('sell', 'Tarifa y Cuota Plana', '#FFD700')}
        <div style="display:grid; grid-template-columns: 1fr; gap:6px; margin-bottom:6px;">
            <div style="min-width:auto;">
                <label style="display:flex; justify-content:space-between; align-items:center; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">
                    <span>Tarifa Global asignada</span>
                    <span style="display:flex; gap:5px;">
                        <button type="button" onclick="openTariffManager('${d.id}')" title="Personalizar precios o crear tarifa para este cliente" style="background:#FF6600; border:0; color:#fff; padding:2px 8px; border-radius:3px; font-size:0.65rem; font-weight:700; cursor:pointer;">\ud83d\udcb0 Gestionar</button>
                        <button type="button" onclick="window._fichaReloadTariffs()" title="Recargar listado" style="background:#2d2d30; border:1px solid #3c3c3c; color:#aaa; padding:2px 7px; border-radius:3px; cursor:pointer; font-size:0.7rem;">\ud83d\udd04</button>
                    </span>
                </label>
                <select id="fc-tariff-eco" style="width:100%; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem;">
                    <option value="">-- Cargando... --</option>
                </select>
                <div style="font-size:0.65rem; color:#666; margin-top:3px;">\u2139\ufe0f Mismo campo que en Principal \u2014 sincronizados.</div>
            </div>
        </div>
        <!-- Cuota mensual: contenedor din\u00e1mico. _fichaWireFlatRateBlock decide si mostrar info-read-only (la tarifa manda) o campos legacy editables. -->
        <div id="fc-cuota-block" style="margin-bottom:6px;"></div>
        ${d.isFlatRate && d.flatRateAmount > 0 ? `
        <div style="background:rgba(94,160,255,0.06); border:1px solid rgba(94,160,255,0.3); border-radius:6px; padding:10px 12px; margin:6px 0 10px 0; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <div style="font-size:0.78rem; color:#aaa;">
                \ud83d\udd04 <strong style="color:#5DADE2;">Migrar a Tarifa v2</strong>: convierte esta cuota legacy en una tarifa v2 con item <code>flat_monthly</code>. Funciona igual pero usa el motor nuevo (permite combinar con paletizados/extras facturados aparte).
            </div>
            <button type="button" onclick="window._migrateClientFlatRateToV2('${d.id}')" style="background:#5DADE2; border:0; color:#000; padding:6px 14px; border-radius:6px; font-size:0.75rem; font-weight:700; cursor:pointer; white-space:nowrap;">\ud83d\udd04 Migrar a v2</button>
        </div>
        ` : ''}

        ${_sectionTitle('tune', 'Subtarifa Especial (Precios Exclusivos)', '#E040FB')}
        <div style="background:rgba(224,64,251,0.05); border:1px solid rgba(224,64,251,0.2); border-radius:8px; padding:10px; margin-bottom:12px;">
            <div id="fc-custom-tariff-status" style="margin-bottom:8px; font-size:0.8rem; color:#aaa;">Cargando subtarifa...</div>
            <div style="display:grid; grid-template-columns: 1fr 120px auto; gap:6px; align-items:end; margin-bottom:8px;">
                <div>
                    <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; margin-bottom:2px;">Articulo / Medida</label>
                    <input type="text" id="fc-custom-item-name" placeholder="Ej: Bulto, Palet, Sobre..." list="fc-custom-suggest" style="width:100%; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem; box-sizing:border-box;">
                    <datalist id="fc-custom-suggest"></datalist>
                </div>
                <div>
                    <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; margin-bottom:2px;">Precio Especial</label>
                    <input type="number" step="0.01" id="fc-custom-item-price" placeholder="0.00" style="width:100%; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem; box-sizing:border-box;">
                </div>
                <button onclick="window._fichaAddCustomPrice()" style="background:linear-gradient(135deg,#E040FB,#9C27B0); border:none; color:#fff; padding:6px 12px; border-radius:5px; font-weight:bold; font-size:0.8rem; cursor:pointer; white-space:nowrap;">
                    <span class="material-symbols-outlined" style="font-size:0.9rem; vertical-align:middle;">add</span> A\u00f1adir
                </button>
            </div>
            <div id="fc-custom-tariff-table" style="max-height:300px; overflow-y:auto;"></div>
        </div>

        ${_sectionTitle('account_balance_wallet', 'Saldo y Estado de Cuenta', '#4CAF50')}
        <div id="fc-balance-container" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-bottom:12px;">
            <div style="background:linear-gradient(135deg, #1a237e, #283593); border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.6rem; color:#9fa8da; text-transform:uppercase; letter-spacing:1px;">Facturado Total</div>
                <div id="fc-total-facturado" style="font-size:1.3rem; font-weight:bold; color:#fff; margin:4px 0;">Cargando...</div>
            </div>
            <div style="background:linear-gradient(135deg, #1b5e20, #2e7d32); border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.6rem; color:#a5d6a7; text-transform:uppercase; letter-spacing:1px;">Cobrado</div>
                <div id="fc-total-cobrado" style="font-size:1.3rem; font-weight:bold; color:#fff; margin:4px 0;">Cargando...</div>
            </div>
            <div style="background:linear-gradient(135deg, #b71c1c, #c62828); border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.6rem; color:#ef9a9a; text-transform:uppercase; letter-spacing:1px;">Pendiente</div>
                <div id="fc-total-pendiente" style="font-size:1.3rem; font-weight:bold; color:#fff; margin:4px 0;">Cargando...</div>
            </div>
        </div>
        `;

        // Load balance data asynchronously
        _fichaLoadBalance();
        // Load custom tariff
        _fichaLoadCustomTariff();
        // Wire flat-rate block (decide si mostrar read-only desde tarifa o legacy editable)
        _fichaWireFlatRateBlock();
    }

    // ============================================================
    //  BLOQUE CUOTA MENSUAL — la tarifa manda
    // ============================================================
    // Lógica: si la tarifa asignada tiene un item flat_monthly, el importe
    // SALE DE AHÍ y los campos legacy quedan ocultos / read-only. Si no
    // hay tarifa v2 con flat_monthly, mostramos los campos legacy para
    // que el admin pueda meter cuota a la antigua.
    async function _fichaWireFlatRateBlock() {
        const wrap = document.getElementById('fc-cuota-block');
        if (!wrap) return;
        if (!_fichaClientData) return;
        // Refrescar _fichaClientData desde Firestore para que la cuota mostrada
        // refleje el último estado (importante tras editar la tarifa en el
        // constructor — el importe debe actualizarse aquí).
        try {
            if (_fichaClientId) {
                const fresh = await db.collection('users').doc(_fichaClientId).get();
                if (fresh.exists) {
                    _fichaClientData = { ..._fichaClientData, ...fresh.data(), id: _fichaClientId };
                }
            }
        } catch(_) {}
        // d capturado DESPUÉS del refresh para que tenga el tariffId actual.
        const d = _fichaClientData;

        const _money = (n) => (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';

        // 1) Detectar si la tarifa asignada es v2 con flat_monthly
        let v2FlatTotal = 0;
        let v2Items = [];
        let tariffName = '';
        let tariffDocId = null;
        if (d.tariffId) {
            try {
                const candidates = [d.tariffId, 'GLOBAL_' + d.tariffId];
                for (const id of candidates) {
                    try {
                        const doc = await db.collection('tariffs').doc(id).get();
                        if (doc.exists) {
                            const data = doc.data();
                            tariffDocId = doc.id;
                            tariffName = data.name || doc.id;
                            if (data.version === 2 && Array.isArray(data.items)) {
                                // Aplicar overrides del cliente para que la cuota mostrada coincida con lo que se facturará
                                let resolvedItems = data.items.slice();
                                if (d.tariffOverrides && typeof window.pricingEngine !== 'undefined') {
                                    try {
                                        const resolved = window.pricingEngine.resolveTariff(data, d.tariffOverrides);
                                        resolvedItems = resolved.items || resolvedItems;
                                    } catch(_) {}
                                }
                                resolvedItems.forEach(it => {
                                    if (it.mode === 'flat_monthly') {
                                        v2FlatTotal += Number(it.basePrice) || 0;
                                        v2Items.push(it);
                                    }
                                });
                            }
                            break;
                        }
                    } catch(_) {}
                }
            } catch(e) { console.warn('[ficha cuota] error leyendo tarifa:', e); }
        }

        // 2) Render según escenario
        if (v2FlatTotal > 0) {
            // ─── La tarifa MANDA — read-only, datos legacy ocultos ───
            const itemsHtml = v2Items.map(it => '<li style="margin:2px 0;"><strong>' + (it.name || it.id) + '</strong> — ' + _money(it.basePrice) + '/' + (it.unit || 'mes') + '</li>').join('');
            wrap.innerHTML = ''
                + '<div style="background:rgba(76,175,80,0.06); border:1px solid rgba(76,175,80,0.3); border-radius:8px; padding:12px 14px;">'
                + '  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">'
                + '    <div>'
                + '      <div style="font-size:0.7rem; color:#4CAF50; text-transform:uppercase; letter-spacing:0.5px; font-weight:700;">📊 Cuota mensual (gestionada por la tarifa)</div>'
                + '      <div style="font-size:1.4rem; font-weight:700; color:#fff; margin-top:3px;">' + _money(v2FlatTotal) + ' / mes</div>'
                + '      <div style="font-size:0.72rem; color:#aaa; margin-top:3px;">Tarifa: <code style="color:#FFD700;">' + (tariffName || tariffDocId) + '</code></div>'
                + '    </div>'
                + '    <button type="button" onclick="window.openTariffBuilder(\'' + tariffDocId + '\')" style="background:#FF6600; border:0; color:#fff; padding:7px 14px; border-radius:6px; font-size:0.78rem; font-weight:700; cursor:pointer;">✏️ Editar cuota en tarifa</button>'
                + '  </div>'
                + (itemsHtml ? '<details style="margin-top:10px;"><summary style="cursor:pointer; font-size:0.72rem; color:#888;">Ver desglose (' + v2Items.length + ' item' + (v2Items.length === 1 ? '' : 's') + ')</summary><ul style="margin:6px 0 0 18px; font-size:0.78rem; color:#ccc;">' + itemsHtml + '</ul></details>' : '')
                + '</div>'
                // Campos legacy ocultos pero presentes para no romper el save
                + '<input type="hidden" id="fc-flatrate" value="No">'
                + '<input type="hidden" id="fc-flatrate-amt" value="0">'
                + '<div style="font-size:0.65rem; color:#666; margin-top:6px;">ℹ️ La cuota se factura automáticamente al cerrar mes. Para cambiar el importe, edita el item <code>flat_monthly</code> dentro de la tarifa pulsando ✏️ arriba.</div>';
        } else {
            // ─── Sin v2 flat_monthly — mostramos campos legacy editables ───
            const isFlatRate = d.isFlatRate;
            const amt = d.flatRateAmount || '';
            wrap.innerHTML = ''
                + '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin-bottom:6px;">'
                + '  <div style="min-width:auto;">'
                + '    <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">Cuota Plana (legacy)</label>'
                + '    <select id="fc-flatrate" style="width:100%; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem;">'
                + '      <option value="No"' + (!isFlatRate ? ' selected' : '') + '>No</option>'
                + '      <option value="Sí"' + (isFlatRate ? ' selected' : '') + '>Sí</option>'
                + '    </select>'
                + '  </div>'
                + '  <div style="min-width:auto;">'
                + '    <label style="display:block; color:#888; font-size:0.65rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">Importe (€/mes)</label>'
                + '    <input type="number" id="fc-flatrate-amt" value="' + amt + '" style="width:100%; padding:5px 7px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:4px; font-size:0.8rem;">'
                + '  </div>'
                + '</div>'
                + '<div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px 12px; font-size:0.7rem; color:#aaa;">'
                + '  💡 Estos campos son del modelo <strong>legacy</strong>. La forma moderna de poner cuota plana es '
                + '  crear una tarifa v2 con item <code>flat_monthly</code> desde <strong>💰 Gestionar</strong>. Tras hacerlo, '
                + '  estos campos desaparecen y la cuota la maneja la tarifa.'
                + '</div>';
        }
    }

    // ============================================================
    //  SUBTARIFA ESPECIAL (Custom Prices per Client)
    // ============================================================
    let _fichaCustomPrices = {};

    async function _fichaLoadCustomTariff() {
        const statusEl = document.getElementById('fc-custom-tariff-status');
        const tableEl = document.getElementById('fc-custom-tariff-table');
        if (!statusEl || !tableEl) return;

        try {
            const doc = await db.collection('tariffs').doc(_fichaClientId).get();
            if (doc.exists && doc.data().customPrices && Object.keys(doc.data().customPrices).length > 0) {
                _fichaCustomPrices = doc.data().customPrices;
                statusEl.innerHTML = '<span style="color:#E040FB; font-weight:bold;">Subtarifa activa</span> — <span style="color:#aaa;">' + Object.keys(_fichaCustomPrices).length + ' precios exclusivos</span>';
            } else {
                _fichaCustomPrices = {};
                statusEl.innerHTML = '<span style="color:#888;">Sin subtarifa especial. Anade articulos para crear precios exclusivos para este cliente.</span>';
            }
            _fichaRenderCustomTable();

            // Populate datalist suggestions from global tariff
            const suggestEl = document.getElementById('fc-custom-suggest');
            if (suggestEl && doc.exists && doc.data().items) {
                suggestEl.innerHTML = Object.keys(doc.data().items).map(k => '<option value="' + k + '">').join('');
            } else if (suggestEl) {
                // Try from global tariff
                const tid = _fichaClientData.tariffId;
                if (tid) {
                    const globalDoc = await db.collection('tariffs').doc('GLOBAL_' + tid).get();
                    if (globalDoc.exists && globalDoc.data().items) {
                        suggestEl.innerHTML = Object.keys(globalDoc.data().items).map(k => '<option value="' + k + '">').join('');
                    }
                }
            }
        } catch (e) {
            console.error('[Ficha] Error loading custom tariff:', e);
            statusEl.innerHTML = '<span style="color:#f44336;">Error cargando subtarifa</span>';
        }
    }

    function _fichaRenderCustomTable() {
        const tableEl = document.getElementById('fc-custom-tariff-table');
        if (!tableEl) return;

        const keys = Object.keys(_fichaCustomPrices);
        if (keys.length === 0) {
            tableEl.innerHTML = '';
            return;
        }

        keys.sort((a, b) => a.localeCompare(b));
        let html = '<table style="width:100%; border-collapse:collapse;">';
        html += '<thead><tr style="border-bottom:1px solid #444;">';
        html += '<th style="padding:8px; text-align:left; color:#E040FB; font-size:0.75rem;">ARTICULO</th>';
        html += '<th style="padding:8px; text-align:right; color:#E040FB; font-size:0.75rem;">PRECIO ESPECIAL</th>';
        html += '<th style="padding:8px; text-align:center; color:#E040FB; font-size:0.75rem; width:100px;">ACCIONES</th>';
        html += '</tr></thead><tbody>';

        keys.forEach(k => {
            const price = _fichaCustomPrices[k];
            html += '<tr style="border-bottom:1px solid #333;">';
            html += '<td style="padding:6px 8px; color:#ddd; font-weight:600; font-size:0.85rem;">' + k + '</td>';
            html += '<td style="padding:6px 8px; text-align:right; color:#4CAF50; font-weight:bold; font-size:0.85rem;">' + parseFloat(price).toFixed(2) + ' &euro;</td>';
            html += '<td style="padding:6px 8px; text-align:center;">';
            html += '<button onclick="window._fichaEditCustomPrice(\'' + k.replace(/'/g, "\\'") + '\')" style="background:transparent; border:1px solid #555; color:#2196F3; padding:3px 8px; font-size:0.75rem; cursor:pointer; border-radius:3px; margin-right:4px;" title="Editar precio"><span class="material-symbols-outlined" style="font-size:0.9rem;">edit</span></button>';
            html += '<button onclick="window._fichaDeleteCustomPrice(\'' + k.replace(/'/g, "\\'") + '\')" style="background:transparent; border:1px solid #555; color:#FF3B30; padding:3px 8px; font-size:0.75rem; cursor:pointer; border-radius:3px;" title="Eliminar"><span class="material-symbols-outlined" style="font-size:0.9rem;">delete</span></button>';
            html += '</td></tr>';
        });

        html += '</tbody></table>';
        tableEl.innerHTML = html;
    }

    window._fichaAddCustomPrice = async function() {
        const nameEl = document.getElementById('fc-custom-item-name');
        const priceEl = document.getElementById('fc-custom-item-price');
        if (!nameEl || !priceEl) return;

        const name = nameEl.value.trim();
        const price = parseFloat(priceEl.value);
        if (!name) { alert('Introduce el nombre del articulo'); return; }
        if (isNaN(price) || price < 0) { alert('Introduce un precio valido'); return; }

        try {
            _fichaCustomPrices[name] = price;
            await db.collection('tariffs').doc(_fichaClientId).set({
                customPrices: _fichaCustomPrices,
                customPricesUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            nameEl.value = '';
            priceEl.value = '';

            const statusEl = document.getElementById('fc-custom-tariff-status');
            if (statusEl) statusEl.innerHTML = '<span style="color:#E040FB; font-weight:bold;">Subtarifa activa</span> — <span style="color:#aaa;">' + Object.keys(_fichaCustomPrices).length + ' precios exclusivos</span>';
            _fichaRenderCustomTable();
        } catch (e) {
            console.error('[Ficha] Error saving custom price:', e);
            alert('Error al guardar: ' + e.message);
        }
    };

    window._fichaEditCustomPrice = function(key) {
        const newPrice = prompt('Nuevo precio para "' + key + '" (actual: ' + parseFloat(_fichaCustomPrices[key]).toFixed(2) + ' EUR):', _fichaCustomPrices[key]);
        if (newPrice === null) return;
        const parsed = parseFloat(newPrice);
        if (isNaN(parsed) || parsed < 0) { alert('Precio no valido'); return; }

        _fichaCustomPrices[key] = parsed;
        db.collection('tariffs').doc(_fichaClientId).set({
            customPrices: _fichaCustomPrices,
            customPricesUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).then(() => {
            _fichaRenderCustomTable();
        }).catch(e => alert('Error: ' + e.message));
    };

    window._fichaDeleteCustomPrice = async function(key) {
        if (!confirm('Eliminar precio exclusivo de "' + key + '"?')) return;

        delete _fichaCustomPrices[key];
        try {
            const updateData = { customPricesUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() };
            updateData['customPrices.' + key] = firebase.firestore.FieldValue.delete();
            await db.collection('tariffs').doc(_fichaClientId).update(updateData);

            const statusEl = document.getElementById('fc-custom-tariff-status');
            if (Object.keys(_fichaCustomPrices).length === 0) {
                if (statusEl) statusEl.innerHTML = '<span style="color:#888;">Sin subtarifa especial.</span>';
            } else {
                if (statusEl) statusEl.innerHTML = '<span style="color:#E040FB; font-weight:bold;">Subtarifa activa</span> — <span style="color:#aaa;">' + Object.keys(_fichaCustomPrices).length + ' precios exclusivos</span>';
            }
            _fichaRenderCustomTable();
        } catch (e) {
            console.error('[Ficha] Error deleting custom price:', e);
            alert('Error: ' + e.message);
        }
    };

    async function _fichaLoadBalance() {
        try {
            const snap = await db.collection('invoices')
                .where('clientId', '==', _fichaClientId)
                .orderBy('date', 'desc')
                .limit(5000)
                .get();

            let totalFacturado = 0, totalCobrado = 0, totalPendiente = 0;
            snap.forEach(doc => {
                const inv = doc.data();
                const total = inv.total || 0;
                totalFacturado += total;
                if (inv.paid) totalCobrado += total;
                else totalPendiente += total;
            });

            const fmt = (n) => n.toFixed(2) + '€';
            const el1 = document.getElementById('fc-total-facturado');
            const el2 = document.getElementById('fc-total-cobrado');
            const el3 = document.getElementById('fc-total-pendiente');
            if (el1) el1.textContent = fmt(totalFacturado);
            if (el2) el2.textContent = fmt(totalCobrado);
            if (el3) el3.textContent = fmt(totalPendiente);
        } catch (e) {
            console.error('[Ficha] Error loading balance:', e);
        }
    }

    // ============================================================
    //  SUB-TAB: ALBARANES
    // ============================================================
    function _fichaRenderAlbaranes() {
        const c = document.getElementById('ficha-subtab-content');
        if (!c) return;

        c.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <div style="display:flex; gap:8px; align-items:center;">
                <span class="material-symbols-outlined" style="color:#2196F3; font-size:1.2rem;">inventory_2</span>
                <span style="color:#2196F3; font-size:0.9rem; font-weight:bold;">ALBARANES DEL CLIENTE</span>
                <span id="fc-tickets-count" style="color:#888; font-size:0.8rem;"></span>
            </div>
            <div style="display:flex; gap:6px;">
                <select id="fc-tickets-filter" onchange="window._fichaFilterTickets()" style="background:#2d2d30; border:1px solid #3c3c3c; color:#ccc; padding:6px 10px; font-size:0.8rem; border-radius:4px;">
                    <option value="all">Todos</option>
                    <option value="pending">Pendientes de facturar</option>
                    <option value="billed">Ya facturados</option>
                </select>
                <button onclick="window._fichaFacturarSeleccionados()" style="background:#4CAF50; border:none; color:#fff; padding:6px 14px; font-size:0.8rem; cursor:pointer; border-radius:4px; font-weight:bold; display:flex; align-items:center; gap:4px;">
                    <span class="material-symbols-outlined" style="font-size:0.9rem;">receipt</span> Facturar Seleccionados
                </button>
            </div>
        </div>
        <div id="fc-tickets-table" style="overflow-y:auto; max-height:calc(100vh - 350px);">
            <div style="text-align:center; padding:40px; color:#888;">Cargando albaranes...</div>
        </div>`;

        _fichaLoadTickets();
    }

    async function _fichaLoadTickets() {
        try {
            const d = _fichaClientData;
            const idNumStr = String(d.idNum || '').trim();
            const authUid = d.authUid || d.id || _fichaClientId;

            // Query tickets by clientIdNum or uid
            let q1 = db.collection('tickets');
            if (idNumStr) q1 = q1.where('clientIdNum', '==', idNumStr);
            else q1 = q1.where('uid', '==', authUid);
            const snap1 = await q1.limit(3000).get();

            // Also query debidos assigned
            let q2 = db.collection('tickets').where('shippingType', '==', 'Debidos');
            if (idNumStr) q2 = q2.where('billToClientIdNum', '==', idNumStr);
            else q2 = q2.where('billToUid', '==', authUid);
            const snap2 = await q2.limit(3000).get();

            const seen = new Set();
            _fichaTicketsCache = [];
            [snap1, snap2].forEach(snap => {
                snap.forEach(doc => {
                    if (seen.has(doc.id)) return;
                    seen.add(doc.id);
                    _fichaTicketsCache.push({ docId: doc.id, ...doc.data() });
                });
            });

            // Sort by date desc
            _fichaTicketsCache.sort((a, b) => {
                const da = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : new Date(a.createdAt || 0);
                const db2 = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
                return db2 - da;
            });

            _fichaRenderTicketsTable(_fichaTicketsCache);
        } catch (e) {
            const t = document.getElementById('fc-tickets-table');
            if (t) t.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
        }
    }

    window._fichaFilterTickets = function() {
        const filter = document.getElementById('fc-tickets-filter').value;
        let filtered = _fichaTicketsCache;
        if (filter === 'pending') {
            filtered = _fichaTicketsCache.filter(t => !t.invoiceId || t.invoiceId === '' || t.invoiceId === 'null');
        } else if (filter === 'billed') {
            filtered = _fichaTicketsCache.filter(t => t.invoiceId && t.invoiceId !== '' && t.invoiceId !== 'null');
        }
        _fichaRenderTicketsTable(filtered);
    };

    function _fichaRenderTicketsTable(tickets) {
        const container = document.getElementById('fc-tickets-table');
        const countEl = document.getElementById('fc-tickets-count');
        if (!container) return;
        if (countEl) countEl.textContent = `(${tickets.length} albaranes)`;

        if (tickets.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">No hay albaranes para mostrar.</div>';
            return;
        }

        let html = `
        <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
            <thead style="position:sticky; top:0; z-index:1;">
                <tr style="background:#2d2d30; color:#9cdcfe; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:center; width:30px;"><input type="checkbox" id="fc-tickets-all" onchange="document.querySelectorAll('.fc-ticket-chk').forEach(c=>c.checked=this.checked)" style="scale:1.2;"></th>
                    <th style="padding:8px 6px; text-align:left;">Fecha</th>
                    <th style="padding:8px 6px; text-align:left;">Nº Albarán</th>
                    <th style="padding:8px 6px; text-align:left;">Destinatario</th>
                    <th style="padding:8px 6px; text-align:left;">Ciudad</th>
                    <th style="padding:8px 6px; text-align:center;">Bultos</th>
                    <th style="padding:8px 6px; text-align:center;">Kg</th>
                    <th style="padding:8px 6px; text-align:center;">Tipo</th>
                    <th style="padding:8px 6px; text-align:center;">Estado</th>
                </tr>
            </thead>
            <tbody>`;

        tickets.forEach(t => {
            const date = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate().toLocaleDateString('es-ES') : 'N/A';
            const isBilled = t.invoiceId && t.invoiceId !== '' && t.invoiceId !== 'null';
            const statusHtml = isBilled
                ? `<span style="color:#4CAF50; font-size:0.7rem;">✅ Facturado</span>`
                : `<span style="color:#FF9800; font-size:0.7rem;">⏳ Pendiente</span>`;
            const typeColor = t.shippingType === 'Debidos' ? '#E040FB' : '#2196F3';
            const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages || 1);

            html += `
            <tr style="border-bottom:1px solid #2d2d30;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                <td style="padding:6px; text-align:center;">${!isBilled ? `<input type="checkbox" class="fc-ticket-chk" value="${t.docId}" style="scale:1.1;">` : ''}</td>
                <td style="padding:6px; color:#ccc;">${date}</td>
                <td style="padding:6px; color:#FFD700; font-weight:bold;">${t.id || '-'}</td>
                <td style="padding:6px; color:#fff;">${t.receiver || t.receiverName || '-'}</td>
                <td style="padding:6px; color:#888;">${t.city || t.receiverCity || '-'}</td>
                <td style="padding:6px; text-align:center; color:#ccc;">${pkgs}</td>
                <td style="padding:6px; text-align:center; color:#ccc;">${t.weight || t.kilos || '-'}</td>
                <td style="padding:6px; text-align:center; color:${typeColor}; font-size:0.7rem; font-weight:bold;">${t.shippingType || 'Pagados'}</td>
                <td style="padding:6px; text-align:center;">${statusHtml}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    window._fichaFacturarSeleccionados = function() {
        const checks = document.querySelectorAll('.fc-ticket-chk:checked');
        if (checks.length === 0) {
            alert('Selecciona al menos un albarán pendiente para facturar.');
            return;
        }

        // Switch to Factura tab and load client
        if (typeof window.erpOpenTab === 'function') {
            window.erpOpenTab('factura');
        }

        // Select client in billing picker
        setTimeout(() => {
            const select = document.getElementById('adv-client-picker');
            const searchInput = document.getElementById('adv-client-search');
            if (select) {
                select.value = _fichaClientId;
                if (searchInput) searchInput.value = `[#${_fichaClientData.idNum || '?'}] ${_fichaClientData.name || ''}`;
                if (typeof window.advLoadClientDetails === 'function') {
                    window.advLoadClientDetails(_fichaClientId);
                }
            }
        }, 500);

        alert(`Se van a facturar ${checks.length} albaranes. Se ha abierto la pestaña de Facturación con el cliente seleccionado.`);
    };

    // ============================================================
    //  SUB-TAB: FACTURACIÓN
    // ============================================================
    function _fichaRenderFacturacion() {
        const c = document.getElementById('ficha-subtab-content');
        if (!c) return;

        c.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <div style="display:flex; gap:8px; align-items:center;">
                <span class="material-symbols-outlined" style="color:#4CAF50; font-size:1.2rem;">receipt</span>
                <span style="color:#4CAF50; font-size:0.9rem; font-weight:bold;">FACTURAS EMITIDAS</span>
                <span id="fc-invoices-count" style="color:#888; font-size:0.8rem;"></span>
            </div>
            <div style="display:flex; gap:6px;">
                <button onclick="window._fichaNewInvoice()" style="background:#007acc; border:none; color:#fff; padding:6px 14px; font-size:0.8rem; cursor:pointer; border-radius:4px; font-weight:bold; display:flex; align-items:center; gap:4px;">
                    <span class="material-symbols-outlined" style="font-size:0.9rem;">add</span> Nueva Factura
                </button>
            </div>
        </div>

        <div id="fc-invoices-summary" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:15px;">
        </div>

        <div id="fc-invoices-table" style="overflow-y:auto; max-height:calc(100vh - 400px);">
            <div style="text-align:center; padding:40px; color:#888;">Cargando facturas...</div>
        </div>`;

        _fichaLoadInvoices();
    }

    async function _fichaLoadInvoices() {
        try {
            const snap = await db.collection('invoices')
                .where('clientId', '==', _fichaClientId)
                .orderBy('date', 'desc')
                .limit(500)
                .get();

            _fichaInvoicesCache = [];
            let totalFacturado = 0, totalCobrado = 0, totalPendiente = 0, totalVencidas = 0;
            const now = new Date();

            snap.forEach(doc => {
                const inv = { docId: doc.id, ...doc.data() };
                _fichaInvoicesCache.push(inv);
                const total = inv.total || 0;
                totalFacturado += total;
                if (inv.paid) totalCobrado += total;
                else {
                    totalPendiente += total;
                    // Check if overdue
                    const dueDate = inv.dueDate && inv.dueDate.toDate ? inv.dueDate.toDate() : (inv.dueDate ? new Date(inv.dueDate) : null);
                    if (dueDate && dueDate < now) totalVencidas++;
                }
            });

            // Summary cards
            const summary = document.getElementById('fc-invoices-summary');
            if (summary) {
                const fmt = (n) => n.toFixed(2) + '€';
                summary.innerHTML = `
                    <div style="background:rgba(26,35,126,0.3); border:1px solid #3949ab; border-radius:8px; padding:12px; text-align:center;">
                        <div style="font-size:0.65rem; color:#9fa8da; text-transform:uppercase;">Facturado</div>
                        <div style="font-size:1.3rem; font-weight:bold; color:#fff; margin:4px 0;">${fmt(totalFacturado)}</div>
                        <div style="font-size:0.7rem; color:#7986cb;">${_fichaInvoicesCache.length} facturas</div>
                    </div>
                    <div style="background:rgba(27,94,32,0.3); border:1px solid #43a047; border-radius:8px; padding:12px; text-align:center;">
                        <div style="font-size:0.65rem; color:#a5d6a7; text-transform:uppercase;">Cobrado</div>
                        <div style="font-size:1.3rem; font-weight:bold; color:#fff; margin:4px 0;">${fmt(totalCobrado)}</div>
                    </div>
                    <div style="background:rgba(183,28,28,0.3); border:1px solid #e53935; border-radius:8px; padding:12px; text-align:center;">
                        <div style="font-size:0.65rem; color:#ef9a9a; text-transform:uppercase;">Pendiente</div>
                        <div style="font-size:1.3rem; font-weight:bold; color:#fff; margin:4px 0;">${fmt(totalPendiente)}</div>
                        ${totalVencidas > 0 ? `<div style="font-size:0.7rem; color:#ff1744; font-weight:bold; animation: pulse 1s infinite;">⚠️ ${totalVencidas} VENCIDA${totalVencidas > 1 ? 'S' : ''}</div>` : ''}
                    </div>`;
            }

            // Count
            const countEl = document.getElementById('fc-invoices-count');
            if (countEl) countEl.textContent = `(${_fichaInvoicesCache.length} facturas)`;

            // Table
            const container = document.getElementById('fc-invoices-table');
            if (!container) return;

            if (_fichaInvoicesCache.length === 0) {
                container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">No hay facturas emitidas para este cliente.</div>';
                return;
            }

            let html = `
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                <thead style="position:sticky; top:0; z-index:1;">
                    <tr style="background:#2d2d30; color:#9cdcfe; font-size:0.7rem;">
                        <th style="padding:8px 6px; text-align:left;">Nº Factura</th>
                        <th style="padding:8px 6px; text-align:left;">Fecha</th>
                        <th style="padding:8px 6px; text-align:left;">Vencimiento</th>
                        <th style="padding:8px 6px; text-align:right;">Base</th>
                        <th style="padding:8px 6px; text-align:right;">IVA</th>
                        <th style="padding:8px 6px; text-align:right;">Total</th>
                        <th style="padding:8px 6px; text-align:center;">Estado</th>
                        <th style="padding:8px 6px; text-align:center;">Acciones</th>
                    </tr>
                </thead>
                <tbody>`;

            _fichaInvoicesCache.forEach(inv => {
                const date = inv.date && inv.date.toDate ? inv.date.toDate().toLocaleDateString('es-ES') : (inv.date ? new Date(inv.date).toLocaleDateString('es-ES') : 'N/A');
                const dueDate = inv.dueDate && inv.dueDate.toDate ? inv.dueDate.toDate() : (inv.dueDate ? new Date(inv.dueDate) : null);
                const dueDateStr = dueDate ? dueDate.toLocaleDateString('es-ES') : 'Contado';
                const isOverdue = !inv.paid && dueDate && dueDate < now;
                const statusHtml = inv.paid
                    ? '<span style="color:#4CAF50; font-weight:bold;">✅ Cobrada</span>'
                    : (isOverdue
                        ? '<span style="color:#ff1744; font-weight:bold;">🔴 VENCIDA</span>'
                        : '<span style="color:#ff6b6b; font-weight:bold;">⏳ Pendiente</span>');
                const rowBg = isOverdue ? 'background:rgba(255,23,68,0.08);' : '';

                html += `
                <tr style="border-bottom:1px solid #2d2d30; ${rowBg}" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='${isOverdue ? 'rgba(255,23,68,0.08)' : 'transparent'}'">
                    <td style="padding:6px; color:#FFD700; font-weight:bold;">${inv.invoiceId || '-'}</td>
                    <td style="padding:6px; color:#ccc;">${date}</td>
                    <td style="padding:6px; color:${isOverdue ? '#ff1744' : '#888'}; font-weight:${isOverdue ? 'bold' : 'normal'};">${dueDateStr}</td>
                    <td style="padding:6px; text-align:right; color:#ccc;">${(inv.subtotal || 0).toFixed(2)}€</td>
                    <td style="padding:6px; text-align:right; color:#81C784;">${(inv.iva || 0).toFixed(2)}€</td>
                    <td style="padding:6px; text-align:right; color:#fff; font-weight:bold;">${(inv.total || 0).toFixed(2)}€</td>
                    <td style="padding:6px; text-align:center; font-size:0.7rem;">${statusHtml}</td>
                    <td style="padding:6px; text-align:center; white-space:nowrap;">
                        ${typeof window.printInvoice === 'function' ? `<button onclick="window.printInvoice('${inv.docId}')" style="background:#333; border:1px solid #555; color:#ccc; padding:3px 8px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Imprimir PDF">🖨️</button>` : ''}
                        ${typeof window.emailInvoice === 'function' ? `<button onclick="window.emailInvoice('${inv.docId}')" style="background:#333; border:1px solid #555; color:#ccc; padding:3px 8px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Enviar por email">📧</button>` : ''}
                        ${!inv.paid ? `<button onclick="window._fichaMarkPaid('${inv.docId}')" style="background:#4CAF50; border:none; color:#fff; padding:3px 8px; font-size:0.7rem; cursor:pointer; border-radius:3px; margin:1px;" title="Marcar cobrada">💰</button>` : ''}
                    </td>
                </tr>`;
            });

            html += '</tbody></table>';
            container.innerHTML = html;
        } catch (e) {
            const t = document.getElementById('fc-invoices-table');
            if (t) t.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
        }
    }

    window._fichaNewInvoice = function() {
        if (typeof window.erpOpenTab === 'function') window.erpOpenTab('factura');
        setTimeout(() => {
            const select = document.getElementById('adv-client-picker');
            const searchInput = document.getElementById('adv-client-search');
            if (select) {
                select.value = _fichaClientId;
                if (searchInput) searchInput.value = `[#${_fichaClientData.idNum || '?'}] ${_fichaClientData.name || ''}`;
                if (typeof window.advLoadClientDetails === 'function') window.advLoadClientDetails(_fichaClientId);
            }
        }, 500);
    };

    window._fichaMarkPaid = async function(invoiceDocId) {
        if (!confirm('¿Marcar esta factura como COBRADA?')) return;
        try {
            await db.collection('invoices').doc(invoiceDocId).update({ paid: true, paidDate: new Date() });
            // Generate payment journal entry if contabilidad exists
            if (typeof window.generatePaymentJournalEntry === 'function') {
                const invDoc = await db.collection('invoices').doc(invoiceDocId).get();
                if (invDoc.exists) window.generatePaymentJournalEntry(invDoc.data(), invoiceDocId);
            }
            alert('✅ Factura marcada como cobrada.');
            _fichaLoadInvoices();
        } catch (e) {
            alert('Error: ' + e.message);
        }
    };

    // ============================================================
    //  CLOSE FICHA (sin guardar)
    // ============================================================
    window._fichaClose = function() {
        // Confirm sólo si parece que ha tocado algo. Heurística barata:
        // si hay un input/textarea/select que está enfocado o si el usuario
        // pulsa con shift saltamos confirm. Para evitar molestar siempre,
        // confirm SIEMPRE con un texto claro: el admin sabe que sale.
        const ok = confirm('¿Salir de la ficha sin guardar?\n\nSi has hecho cambios y no has pulsado «Guardar», se perderán.');
        if (!ok) return;
        if (typeof window.erpCloseTab === 'function') {
            window.erpCloseTab('ficha-cliente');
        } else {
            // Fallback: limpia el contenedor y vuelve al inicio
            const c = document.getElementById('erp-tab-ficha-cliente');
            if (c) c.innerHTML = '';
            if (typeof window.erpOpenTab === 'function') window.erpOpenTab('inicio');
        }
    };

    // Atajo de teclado Ctrl+S → Guardar (cuando la ficha está visible).
    // Se registra una sola vez por sesión.
    if (!window._fichaCtrlSWired) {
        window._fichaCtrlSWired = true;
        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 's') {
                const tab = document.getElementById('erp-tab-ficha-cliente');
                // Sólo si la pestaña ficha está renderizada y visible
                if (tab && tab.offsetParent !== null && typeof window._fichaSaveAll === 'function') {
                    e.preventDefault();
                    window._fichaSaveAll();
                }
            }
            if (e.key === 'Escape') {
                const tab = document.getElementById('erp-tab-ficha-cliente');
                if (tab && tab.offsetParent !== null && typeof window._fichaClose === 'function') {
                    window._fichaClose();
                }
            }
        });
    }

    // ============================================================
    //  SAVE ALL (from Principal + Económico)
    // ============================================================
    window._fichaSaveAll = async function() {
        if (!_fichaClientId) return;

        const getVal = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : null; };

        const updates = {};
        // Principal fields
        if (getVal('fc-idnum') !== null) updates.idNum = getVal('fc-idnum');
        if (getVal('fc-name') !== null) updates.name = getVal('fc-name');
        if (getVal('fc-nif') !== null) updates.nif = getVal('fc-nif').toUpperCase();
        if (getVal('fc-email') !== null) updates.email = getVal('fc-email').toLowerCase();
        if (getVal('fc-admin-email') !== null) updates.adminEmail = getVal('fc-admin-email').toLowerCase();
        if (getVal('fc-phone') !== null) updates.senderPhone = getVal('fc-phone');
        if (getVal('fc-street') !== null) updates.street = getVal('fc-street');
        if (getVal('fc-number') !== null) updates.number = getVal('fc-number');
        if (getVal('fc-cp') !== null) updates.cp = getVal('fc-cp');
        if (getVal('fc-city') !== null) updates.localidad = getVal('fc-city');
        if (getVal('fc-province') !== null) updates.province = getVal('fc-province');
        if (getVal('fc-billing-company') !== null) updates.billingCompanyId = getVal('fc-billing-company');
        // fc-tariff (Principal) y fc-tariff-eco (Económico) editan el mismo
        // tariffId. Cogemos el que tenga valor — están sincronizados en
        // tiempo real vía onchange, pero por si el render no fue idempotente.
        const tariffPrincipal = getVal('fc-tariff');
        const tariffEco = getVal('fc-tariff-eco');
        const tariffFinal = (tariffEco !== null && tariffEco !== '') ? tariffEco
                          : (tariffPrincipal !== null ? tariffPrincipal : null);
        if (tariffFinal !== null) updates.tariffId = tariffFinal;

        // Recogidas fields
        if (getVal('fc-pickup-cutoff-am') !== null) updates.pickupCutoffAM = getVal('fc-pickup-cutoff-am');
        if (getVal('fc-pickup-cutoff-pm') !== null) updates.pickupCutoffPM = getVal('fc-pickup-cutoff-pm');
        if (getVal('fc-default-route-phone') !== null) updates.defaultRoutePhone = getVal('fc-default-route-phone');

        // Económico fields
        if (getVal('fc-payment-terms') !== null) updates.paymentTerms = getVal('fc-payment-terms');
        if (getVal('fc-iban') !== null) updates.iban = getVal('fc-iban');
        if (getVal('fc-sepa-ref') !== null) updates.sepaRef = getVal('fc-sepa-ref');
        if (getVal('fc-sepa-date') !== null) updates.sepaDate = getVal('fc-sepa-date');
        if (getVal('fc-flatrate') !== null) updates.isFlatRate = getVal('fc-flatrate') === 'Sí';
        if (getVal('fc-flatrate-amt') !== null) updates.flatRateAmount = parseFloat(getVal('fc-flatrate-amt')) || 0;

        // Acceso online (fc-access-active)
        const accCb = document.getElementById('fc-access-active');
        if (accCb) {
            updates.accessActive = !!accCb.checked;
            updates.accessActiveUpdatedAt = firebase.firestore.FieldValue.serverTimestamp();
        }

        // Prefijo y nº de albarán → van a comp_main (no a /users)
        let compMainUpdate = null;
        const pfxVal = getVal('fc-prefix');
        const snVal = getVal('fc-startnum');
        if (pfxVal !== null || snVal !== null) {
            compMainUpdate = {};
            if (pfxVal !== null) {
                const cleaned = pfxVal.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                if (cleaned) compMainUpdate.prefix = cleaned;
            }
            if (snVal !== null) {
                const n = parseInt(snVal, 10);
                if (!isNaN(n) && n > 0) compMainUpdate.startNum = n;
            }
            if (Object.keys(compMainUpdate).length === 0) compMainUpdate = null;
            else compMainUpdate.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        }

        // Remove null entries
        Object.keys(updates).forEach(k => { if (updates[k] === null) delete updates[k]; });

        if (Object.keys(updates).length === 0) {
            alert('No hay cambios que guardar.');
            return;
        }

        try {
            if (typeof showLoading === 'function') showLoading();
            let savedId = _fichaClientId;
            const oldRoutePhone = (_fichaClientData && _fichaClientData.defaultRoutePhone) || '';
            if (Object.keys(updates).length > 0) {
                // Update resiliente: corrige el docId si la ficha se abrió con
                // un authUid o alias en vez del docId real.
                savedId = await _fichaUpdateUserDoc(updates);
            }
            if (compMainUpdate) {
                await db.collection('users').doc(savedId).collection('companies').doc('comp_main').set(compMainUpdate, { merge: true });
            }

            // Update local cache (id resuelto + id original por si difieren)
            if (window.userMap) {
                if (window.userMap[savedId]) Object.assign(window.userMap[savedId], updates);
                if (window.userMap[_fichaClientId]) Object.assign(window.userMap[_fichaClientId], updates);
            }
            _fichaClientData = { ..._fichaClientData, ...updates };

            // Sincronizar directorio de rutas si cambió el tel. de ruta
            // (o si cambiaron CP/localidad/nombre/NIF que aparecen en el directorio).
            try {
                const newRoutePhone = updates.defaultRoutePhone !== undefined
                    ? updates.defaultRoutePhone
                    : oldRoutePhone;
                const touchesDirFields = Object.prototype.hasOwnProperty.call(updates, 'defaultRoutePhone')
                    || Object.prototype.hasOwnProperty.call(updates, 'cp')
                    || Object.prototype.hasOwnProperty.call(updates, 'localidad')
                    || Object.prototype.hasOwnProperty.call(updates, 'companyName')
                    || Object.prototype.hasOwnProperty.call(updates, 'businessName')
                    || Object.prototype.hasOwnProperty.call(updates, 'cif')
                    || Object.prototype.hasOwnProperty.call(updates, 'nif');
                if (touchesDirFields && typeof window._routeDirectoryUpdateForClient === 'function') {
                    window._routeDirectoryUpdateForClient(oldRoutePhone, newRoutePhone, savedId, _fichaClientData)
                        .catch(function(){});
                }
            } catch(rde) { console.warn('[ficha save] dir sync fail:', rde); }

            alert('✅ Ficha de cliente actualizada correctamente.' + (compMainUpdate ? '\n\n📦 Prefijo / nº albarán también guardados.' : ''));

            // Re-render header with updated data
            _fichaRender();
        } catch (e) {
            alert('Error guardando: ' + e.message);
        } finally {
            if (typeof hideLoading === 'function') hideLoading();
        }
    };

})();
