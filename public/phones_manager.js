// Phones Manager - Novapack ERP
// Manages driver routes and phone numbers
// Firestore: config/phones/list

(function() {
    'use strict';

    let phonesCache = [];

    window.loadPhonesManager = async () => {
        const container = document.getElementById('erp-tab-phones');
        if (!container) return;

        // Build UI if not already built
        if (!container.querySelector('#phones-mgr-table')) {
            container.innerHTML = `
                <div style="max-width:1200px; margin:0 auto; width:100%;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:25px; flex-wrap:wrap; gap:15px;">
                        <div>
                            <h2 style="margin:0; color:white; font-size:1.4rem;">
                                <span class="material-symbols-outlined" style="color:#FF9800; vertical-align:middle; margin-right:8px;">call</span>
                                Rutas y Repartidores
                            </h2>
                            <p style="color:#666; margin:5px 0 0; font-size:0.85rem;">Gestión de teléfonos y chóferes asignados a cada ruta de reparto.</p>
                        </div>
                        <div style="display:flex; gap:8px;" id="phones-toolbar">
                            <button onclick="openPhoneModal()" style="background:#FF9800; border:none; color:#fff; padding:8px 16px; font-size:0.82rem; cursor:pointer; border-radius:4px; font-weight:bold; display:flex; align-items:center; gap:5px;">
                                <span class="material-symbols-outlined" style="font-size:16px;">add</span> Nueva Ruta
                            </button>
                            <button onclick="loadPhonesManager()" style="background:#333; border:1px solid #555; color:#d4d4d4; padding:6px 16px; font-size:0.82rem; cursor:pointer; border-radius:4px; display:flex; align-items:center; gap:5px;">
                                <span class="material-symbols-outlined" style="font-size:16px;">refresh</span> Refrescar
                            </button>
                        </div>
                    </div>

                    <!-- MASTER PINS -->
                    <div style="background:linear-gradient(135deg, rgba(156,39,176,0.08), rgba(103,58,183,0.08)); border:1px solid rgba(156,39,176,0.3); border-radius:10px; padding:16px 20px; margin-bottom:20px;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                            <span class="material-symbols-outlined" style="color:#AB47BC; font-size:1.2rem;">admin_panel_settings</span>
                            <span style="color:#AB47BC; font-weight:bold; font-size:0.85rem; text-transform:uppercase; letter-spacing:1px;">PIN Maestro — Acceso Admin al Terminal</span>
                        </div>
                        <p style="color:#888; font-size:0.8rem; margin:0 0 12px;">Estos PIN permiten acceder al terminal de cualquier ruta desde la app repartidor sin necesidad de SMS.</p>
                        <div style="display:flex; gap:15px; flex-wrap:wrap; align-items:flex-end;">
                            <div>
                                <label style="display:block; color:#888; font-size:0.7rem; text-transform:uppercase; margin-bottom:4px;">PIN Maestro 1</label>
                                <input type="text" id="master-pin-1" maxlength="8" placeholder="Ej: 1234" style="width:140px; padding:8px 12px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:5px; font-size:1rem; font-weight:bold; letter-spacing:3px; text-align:center;">
                            </div>
                            <div>
                                <label style="display:block; color:#888; font-size:0.7rem; text-transform:uppercase; margin-bottom:4px;">PIN Maestro 2</label>
                                <input type="text" id="master-pin-2" maxlength="8" placeholder="Ej: 5678" style="width:140px; padding:8px 12px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:5px; font-size:1rem; font-weight:bold; letter-spacing:3px; text-align:center;">
                            </div>
                            <button onclick="saveMasterPins()" style="background:linear-gradient(135deg,#AB47BC,#7B1FA2); border:none; color:#fff; padding:8px 20px; border-radius:6px; font-weight:bold; font-size:0.85rem; cursor:pointer; display:flex; align-items:center; gap:5px;">
                                <span class="material-symbols-outlined" style="font-size:16px;">save</span> Guardar PINs
                            </button>
                            <span id="master-pin-status" style="color:#888; font-size:0.8rem;"></span>
                        </div>
                    </div>

                    <!-- PIN Panel Conductor -->
                    <div style="background:#1e2a1e; border:1px solid #2e7d32; border-radius:8px; padding:14px 18px; margin-top:15px; margin-bottom:15px;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                            <span class="material-symbols-outlined" style="color:#4CAF50; font-size:1.2rem;">local_shipping</span>
                            <span style="color:#4CAF50; font-weight:bold; font-size:0.85rem; text-transform:uppercase; letter-spacing:1px;">PIN Panel Conductor</span>
                        </div>
                        <p style="color:#888; font-size:0.8rem; margin:0 0 12px;">PIN exclusivo para acceder al panel de conductor (/conductor/). Permite ver todas las rutas e imprimir albaranes.</p>
                        <div style="display:flex; gap:15px; flex-wrap:wrap; align-items:flex-end;">
                            <div>
                                <label style="display:block; color:#888; font-size:0.7rem; text-transform:uppercase; margin-bottom:4px;">PIN Conductor</label>
                                <input type="text" id="conductor-pin" maxlength="4" placeholder="4 dígitos" style="width:140px; padding:8px 12px; background:#2d2d30; border:1px solid #3c3c3c; color:#fff; border-radius:5px; font-size:1rem; font-weight:bold; letter-spacing:3px; text-align:center;">
                            </div>
                            <button onclick="saveConductorPin()" style="background:linear-gradient(135deg,#4CAF50,#2E7D32); border:none; color:#fff; padding:8px 20px; border-radius:6px; font-weight:bold; font-size:0.85rem; cursor:pointer; display:flex; align-items:center; gap:5px;">
                                <span class="material-symbols-outlined" style="font-size:16px;">save</span> Guardar PIN
                            </button>
                            <span id="conductor-pin-status" style="color:#888; font-size:0.8rem;"></span>
                        </div>
                    </div>

                    <table id="phones-mgr-table" style="width:100%; border-collapse:collapse; font-size:0.85rem;">
                        <thead style="background:#333;">
                            <tr>
                                <th style="padding:10px; text-align:left; color:#aaa; font-weight:600;">Localidad / Ruta</th>
                                <th style="padding:10px; text-align:left; color:#aaa; font-weight:600;">Teléfono</th>
                                <th style="padding:10px; text-align:left; color:#aaa; font-weight:600;">Chóferes</th>
                                <th style="padding:10px; text-align:right; color:#aaa; font-weight:600;">Acciones</th>
                            </tr>
                        </thead>
                        <tbody id="phones-mgr-body">
                            <tr><td colspan="4" style="text-align:center; padding:30px; color:#555;">Cargando...</td></tr>
                        </tbody>
                    </table>
                </div>
            `;
        }

        const tbody = document.getElementById('phones-mgr-body');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#aaa;">Cargando rutas...</td></tr>';

        try {
            const snap = await db.collection('config').doc('phones').collection('list').get();
            phonesCache = [];
            snap.forEach(doc => {
                phonesCache.push({ ...doc.data(), docId: doc.id });
            });

            renderPhonesTable();

            // Add export button
            if (typeof addExportButton === 'function') {
                addExportButton('phones-toolbar', () => {
                    return phonesCache.map(p => ({
                        'Ruta': p.label || '',
                        'Teléfono': p.number || '',
                        'Chófer 1': p.driverName || '',
                        'Chófer 2': p.driverName2 || '',
                        'Chófer 3': p.driverName3 || '',
                        'Chófer 4': p.driverName4 || ''
                    }));
                }, 'rutas_telefonos');
            }
        } catch(e) {
            console.error('[Phones] Error:', e);
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:red; padding:20px;">Error: ${e.message}</td></tr>`;
        }
    };

    function _renderRouteRow(p, indent) {
        const names = [p.driverName, p.driverName2, p.driverName3, p.driverName4].filter(n => n && n.trim());
        const namesStr = names.length > 0 ? names.join(' <span style="color:#555;">\u00b7</span> ') : '<span style="color:#666;">Sin asignar</span>';
        const docIdSafe = (p.docId || '').replace(/'/g, "\\'");
        const labelColor = indent ? '#FFCC80' : '#FF9800';
        const prefix = indent ? '<span style="color:#555; margin-right:4px;">\u2514</span>' : '';

        return `
            <tr style="border-bottom:1px solid #333; cursor:pointer; transition:background 0.2s;"
                onmouseover="this.style.background='rgba(255,152,0,0.08)'"
                onmouseout="this.style.background='transparent'">
                <td style="padding:10px ${indent ? '10px 10px 28px' : ''}; font-weight:bold; color:${labelColor};">${prefix}${p.label || 'Sin nombre'}</td>
                <td style="padding:10px;">
                    <a href="tel:${p.number || ''}" style="color:#4FC3F7; text-decoration:none;">${p.number || '-'}</a>
                </td>
                <td style="padding:10px; color:#d4d4d4;">${namesStr}</td>
                <td style="padding:10px; text-align:right;">
                    <div style="display:flex; gap:5px; justify-content:flex-end;">
                        <button onclick="event.stopPropagation(); openPhoneModal('${docIdSafe}')" style="background:#333; border:1px solid #555; color:#4CAF50; padding:4px 10px; font-size:0.75rem; cursor:pointer; border-radius:3px; display:flex; align-items:center; gap:3px;">
                            <span class="material-symbols-outlined" style="font-size:14px;">edit</span> Editar
                        </button>
                        <button onclick="event.stopPropagation(); deletePhoneRoute('${docIdSafe}')" style="background:#333; border:1px solid #555; color:#FF5252; padding:4px 10px; font-size:0.75rem; cursor:pointer; border-radius:3px; display:flex; align-items:center; gap:3px;">
                            <span class="material-symbols-outlined" style="font-size:14px;">delete</span>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }

    function renderPhonesTable() {
        const tbody = document.getElementById('phones-mgr-body');
        if (!tbody) return;

        if (phonesCache.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:#888;">No hay rutas configuradas. Pulsa "Nueva Ruta" para crear una.</td></tr>';
            return;
        }

        // Group routes: grouped (with parentRoute) and standalone (without)
        const groups = {};
        const standalone = [];
        phonesCache.forEach(p => {
            if (p.parentRoute && p.parentRoute.trim()) {
                const key = p.parentRoute.trim();
                if (!groups[key]) groups[key] = [];
                groups[key].push(p);
            } else {
                standalone.push(p);
            }
        });

        let html = '';

        // Render grouped routes first
        Object.keys(groups).sort((a, b) => a.localeCompare(b)).forEach(groupName => {
            const children = groups[groupName];
            const totalChildren = children.length;
            html += `
                <tr style="border-bottom:1px solid #444; background:rgba(33,150,243,0.06);">
                    <td colspan="3" style="padding:10px 10px 6px; font-weight:bold; color:#2196F3; font-size:0.9rem;">
                        <span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; margin-right:4px;">folder</span>
                        ${groupName} <span style="color:#666; font-size:0.75rem; font-weight:400;">(${totalChildren} subrutas)</span>
                    </td>
                    <td style="padding:10px; text-align:right;">
                        <button onclick="event.stopPropagation(); openPhoneModal(null, '${groupName.replace(/'/g, "\\'")}')" style="background:#1e3a5f; border:1px solid #2d5a8e; color:#5dade2; padding:4px 10px; font-size:0.75rem; cursor:pointer; border-radius:3px; display:flex; align-items:center; gap:3px; margin-left:auto;">
                            <span class="material-symbols-outlined" style="font-size:14px;">add</span> A\u00f1adir Subruta
                        </button>
                    </td>
                </tr>
            `;
            children.forEach(p => { html += _renderRouteRow(p, true); });
        });

        // Render standalone routes
        standalone.forEach(p => { html += _renderRouteRow(p, false); });

        tbody.innerHTML = html;
    }

    // ================== MODAL CREAR/EDITAR ==================

    window.openPhoneModal = (docId, presetParent) => {
        let modal = document.getElementById('modal-edit-phone');
        if (modal) modal.remove();

        const existing = docId ? phonesCache.find(p => p.docId === docId) : null;
        const isEdit = !!existing;

        modal = document.createElement('div');
        modal.id = 'modal-edit-phone';
        modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:50000; display:flex; align-items:center; justify-content:center;';
        modal.innerHTML = `
            <div style="background:#1e1e1e; border:1px solid #3c3c3c; border-radius:12px; width:95%; max-width:550px; padding:25px; color:#d4d4d4; box-shadow:0 20px 60px rgba(0,0,0,0.6);">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #3c3c3c; padding-bottom:12px; margin-bottom:20px;">
                    <h2 style="margin:0; color:#FF9800; font-size:1.2rem;">${isEdit ? '✏️ Editar Ruta' : '➕ Nueva Ruta'}</h2>
                    <button onclick="document.getElementById('modal-edit-phone').remove()" style="background:none; border:none; color:#aaa; font-size:1.5rem; cursor:pointer;">&times;</button>
                </div>

                <input type="hidden" id="phone-edit-docid" value="${docId || ''}">

                <div style="margin-bottom:15px;">
                    <label style="font-size:0.75rem; color:#888; text-transform:uppercase; letter-spacing:1px;">Localidad / Nombre de Ruta</label>
                    <input id="phone-edit-label" value="${(existing?.label || '').replace(/"/g, '&quot;')}" placeholder="Ej: Barcelona Centro" style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.9rem; margin-top:4px;">
                </div>

                <div style="margin-bottom:15px;">
                    <label style="font-size:0.75rem; color:#2196F3; text-transform:uppercase; letter-spacing:1px;">Grupo / Ruta Padre <span style="color:#888; font-size:0.65rem; font-weight:400; text-transform:none;">(dejar vacío si es independiente)</span></label>
                    <input id="phone-edit-parent" list="phone-parent-suggestions" value="${(existing?.parentRoute || presetParent || '').replace(/"/g, '&quot;')}" placeholder="Ej: Sevilla, Madrid..." autocomplete="off" style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.9rem; margin-top:4px;">
                    <datalist id="phone-parent-suggestions">${[...new Set(phonesCache.map(p => p.parentRoute).filter(Boolean))].map(g => '<option value="' + g.replace(/"/g, '&quot;') + '">').join('')}</datalist>
                </div>

                <div style="margin-bottom:15px;">
                    <label style="font-size:0.75rem; color:#888; text-transform:uppercase; letter-spacing:1px;">Teléfono Repartidor</label>
                    <input id="phone-edit-number" value="${(existing?.number || '').replace(/"/g, '&quot;')}" placeholder="Ej: 612345678" style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.9rem; margin-top:4px;">
                </div>

                <div style="padding:12px; background:rgba(76,175,80,0.08); border:1px solid rgba(76,175,80,0.2); border-radius:8px;">
                    <div style="font-size:0.75rem; color:#4CAF50; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">Chóferes / Turnos</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                        <input id="phone-edit-d1" value="${(existing?.driverName || '').replace(/"/g, '&quot;')}" placeholder="Chófer 1" style="background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:6px; border-radius:4px; font-size:0.85rem;">
                        <input id="phone-edit-d2" value="${(existing?.driverName2 || '').replace(/"/g, '&quot;')}" placeholder="Chófer 2" style="background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:6px; border-radius:4px; font-size:0.85rem;">
                        <input id="phone-edit-d3" value="${(existing?.driverName3 || '').replace(/"/g, '&quot;')}" placeholder="Chófer 3" style="background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:6px; border-radius:4px; font-size:0.85rem;">
                        <input id="phone-edit-d4" value="${(existing?.driverName4 || '').replace(/"/g, '&quot;')}" placeholder="Chófer 4" style="background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:6px; border-radius:4px; font-size:0.85rem;">
                    </div>
                </div>

                <div style="margin-top:15px; padding:12px; background:rgba(206,147,216,0.08); border:1px solid rgba(206,147,216,0.3); border-radius:8px; position:relative;">
                    <label style="font-size:0.75rem; color:#CE93D8; text-transform:uppercase; letter-spacing:1px; font-weight:700;">Zonas de Cobertura <span style="color:#888; font-size:0.65rem; font-weight:400; text-transform:none;">(CPs y/o localidades separados por comas)</span></label>
                    <input id="phone-edit-zones" value="${(existing?.coverageZones || '').replace(/"/g, '&quot;')}" placeholder="Escribe provincia, localidad o CP..." autocomplete="off" style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.85rem; margin-top:4px;">
                    <div id="phone-zones-suggestions" style="display:none; position:absolute; left:0; right:0; max-height:200px; overflow-y:auto; background:#1e1e2e; border:1px solid #CE93D8; border-top:none; border-radius:0 0 8px 8px; z-index:10; box-shadow:0 8px 24px rgba(0,0,0,0.5);"></div>
                    <div style="color:#888; font-size:0.7rem; margin-top:4px;">Escribe una provincia para añadir todos sus CPs, o una localidad/CP para buscar</div>
                </div>

                <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px; border-top:1px solid #3c3c3c; padding-top:15px;">
                    <button onclick="document.getElementById('modal-edit-phone').remove()" style="background:#333; border:1px solid #555; color:#ccc; padding:8px 20px; font-size:0.85rem; cursor:pointer; border-radius:4px;">Cancelar</button>
                    <button onclick="savePhoneRoute()" style="background:#FF9800; border:none; color:#fff; padding:8px 20px; font-size:0.85rem; cursor:pointer; border-radius:4px; font-weight:bold; display:flex; align-items:center; gap:5px;">
                        <span class="material-symbols-outlined" style="font-size:16px;">save</span> ${isEdit ? 'Guardar Cambios' : 'Crear Ruta'}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // Initialize coverage zones autocomplete
        _initZonesAutocomplete();
    };

    function _normalizeRoutePhone(p) {
        let d = (p || '').toString().replace(/\D/g, '');
        if (d.length > 9 && d.indexOf('0034') === 0) d = d.slice(4);
        else if (d.length > 9 && d.indexOf('34') === 0) d = d.slice(2);
        if (d.length > 9) d = d.slice(-9);
        return d;
    }

    window.savePhoneRoute = async () => {
        const docId = document.getElementById('phone-edit-docid').value;
        const data = {
            label: document.getElementById('phone-edit-label').value.trim(),
            number: _normalizeRoutePhone(document.getElementById('phone-edit-number').value),
            driverName: document.getElementById('phone-edit-d1').value.trim(),
            driverName2: document.getElementById('phone-edit-d2').value.trim(),
            driverName3: document.getElementById('phone-edit-d3').value.trim(),
            driverName4: document.getElementById('phone-edit-d4').value.trim(),
            parentRoute: document.getElementById('phone-edit-parent').value.trim(),
            coverageZones: (document.getElementById('phone-edit-zones')?.value || '').trim(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (!data.label) { alert('El nombre de la ruta es obligatorio'); return; }

        try {
            if (docId) {
                await db.collection('config').doc('phones').collection('list').doc(docId).update(data);
            } else {
                data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                await db.collection('config').doc('phones').collection('list').add(data);
            }

            document.getElementById('modal-edit-phone').remove();
            loadPhonesManager(); // Refresh
            alert('✅ Ruta guardada correctamente');
        } catch(e) {
            alert('Error: ' + e.message);
            console.error(e);
        }
    };

    window.deletePhoneRoute = async (docId) => {
        if (!confirm('¿Eliminar esta ruta?')) return;
        try {
            await db.collection('config').doc('phones').collection('list').doc(docId).delete();
            phonesCache = phonesCache.filter(p => p.docId !== docId);
            renderPhonesTable();
        } catch(e) {
            alert('Error: ' + e.message);
        }
    };

    // ============ MASTER PINS (stored hashed; plain values are never re-shown) ============

    async function _sha256Hex(str) {
        const enc = new TextEncoder().encode(str);
        const buf = await crypto.subtle.digest('SHA-256', enc);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    }

    async function loadMasterPins() {
        try {
            const doc = await db.collection('config').doc('phones').get();
            if (!doc.exists) return;
            const data = doc.data();
            const pin1El = document.getElementById('master-pin-1');
            const pin2El = document.getElementById('master-pin-2');
            const statusEl = document.getElementById('master-pin-status');

            // Auto-migrate: if plain PINs exist without hashes, hash them and clear plaintext.
            const needsMigration = (data.masterPin1 && !data.masterPin1Hash)
                                || (data.masterPin2 && !data.masterPin2Hash);
            if (needsMigration) {
                const upd = {
                    masterPinsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    masterPin1: firebase.firestore.FieldValue.delete(),
                    masterPin2: firebase.firestore.FieldValue.delete()
                };
                if (data.masterPin1) upd.masterPin1Hash = await _sha256Hex(data.masterPin1);
                if (data.masterPin2) upd.masterPin2Hash = await _sha256Hex(data.masterPin2);
                await db.collection('config').doc('phones').set(upd, { merge: true });
                console.log('[Phones] Migrated plain PINs → SHA-256 hashes');
            }

            // Never show the original PIN. Indicate whether one is configured.
            if (pin1El) {
                pin1El.value = '';
                pin1El.placeholder = (data.masterPin1Hash || data.masterPin1) ? '•••• (configurado)' : 'Introduce un PIN';
            }
            if (pin2El) {
                pin2El.value = '';
                pin2El.placeholder = (data.masterPin2Hash || data.masterPin2) ? '•••• (configurado)' : 'Introduce un PIN';
            }
            if (statusEl && needsMigration) {
                statusEl.textContent = 'PINs migrados a almacenamiento seguro (hash)';
                statusEl.style.color = '#4CAF50';
                setTimeout(() => { statusEl.textContent = ''; }, 4000);
            }
        } catch (e) {
            console.error('[Phones] Error loading master PINs:', e);
        }
    }

    window.saveMasterPins = async () => {
        const pin1 = (document.getElementById('master-pin-1')?.value || '').trim();
        const pin2 = (document.getElementById('master-pin-2')?.value || '').trim();
        const statusEl = document.getElementById('master-pin-status');

        if (!pin1 && !pin2) {
            alert('Introduce al menos un PIN maestro');
            return;
        }

        try {
            const upd = {
                masterPinsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                masterPin1: firebase.firestore.FieldValue.delete(),
                masterPin2: firebase.firestore.FieldValue.delete()
            };
            if (pin1) upd.masterPin1Hash = await _sha256Hex(pin1);
            if (pin2) upd.masterPin2Hash = await _sha256Hex(pin2);
            await db.collection('config').doc('phones').set(upd, { merge: true });
            // Clear inputs so plain PIN never lingers in DOM
            const pin1El = document.getElementById('master-pin-1');
            const pin2El = document.getElementById('master-pin-2');
            if (pin1El) { pin1El.value = ''; pin1El.placeholder = pin1 ? '•••• (configurado)' : pin1El.placeholder; }
            if (pin2El) { pin2El.value = ''; pin2El.placeholder = pin2 ? '•••• (configurado)' : pin2El.placeholder; }
            if (statusEl) {
                statusEl.textContent = 'PINs guardados (hash SHA-256)';
                statusEl.style.color = '#4CAF50';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (e) {
            alert('Error: ' + e.message);
        }
    };

    // ============ CONDUCTOR PIN ============

    async function loadConductorPin() {
        try {
            const doc = await db.collection('config').doc('phones').get();
            if (doc.exists) {
                const data = doc.data();
                const pinEl = document.getElementById('conductor-pin');
                if (pinEl && data.conductorPin) pinEl.value = data.conductorPin;
            }
        } catch (e) {
            console.error('[Phones] Error loading conductor PIN:', e);
        }
    }

    window.saveConductorPin = async () => {
        const pin = (document.getElementById('conductor-pin')?.value || '').trim();
        const statusEl = document.getElementById('conductor-pin-status');

        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            alert('El PIN debe ser de 4 dígitos');
            return;
        }

        try {
            await db.collection('config').doc('phones').set({
                conductorPin: pin,
                conductorPinUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            if (statusEl) {
                statusEl.textContent = 'PIN conductor guardado';
                statusEl.style.color = '#4CAF50';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (e) {
            alert('Error: ' + e.message);
        }
    };

    // Auto-load PINs after rendering
    const _origLoad = window.loadPhonesManager;
    window.loadPhonesManager = async () => {
        await _origLoad();
        loadMasterPins();
        loadConductorPin();
    };

    // ============ COVERAGE ZONES AUTOCOMPLETE ============

    var _czProvMap = {'01':'ALAVA','02':'ALBACETE','03':'ALICANTE','04':'ALMERIA','05':'AVILA','06':'BADAJOZ','07':'BALEARES','08':'BARCELONA','09':'BURGOS','10':'CACERES','11':'CADIZ','12':'CASTELLON','13':'CIUDAD REAL','14':'CORDOBA','15':'A CORUÑA','16':'CUENCA','17':'GIRONA','18':'GRANADA','19':'GUADALAJARA','20':'GUIPUZKOA','21':'HUELVA','22':'HUESCA','23':'JAEN','24':'LEON','25':'LLEIDA','26':'LA RIOJA','27':'LUGO','28':'MADRID','29':'MALAGA','30':'MURCIA','31':'NAVARRA','32':'OURENSE','33':'ASTURIAS','34':'PALENCIA','35':'LAS PALMAS','36':'PONTEVEDRA','37':'SALAMANCA','38':'TENERIFE','39':'CANTABRIA','40':'SEGOVIA','41':'SEVILLA','42':'SORIA','43':'TARRAGONA','44':'TERUEL','45':'TOLEDO','46':'VALENCIA','47':'VALLADOLID','48':'VIZCAYA','49':'ZAMORA','50':'ZARAGOZA'};
    var _czNameToPrefix = {};
    Object.keys(_czProvMap).forEach(function(k) { _czNameToPrefix[_czProvMap[k]] = k; });

    function _initZonesAutocomplete() {
        var inp = document.getElementById('phone-edit-zones');
        var sugg = document.getElementById('phone-zones-suggestions');
        if (!inp || !sugg) return;

        var timer = null;
        inp.addEventListener('input', function() {
            clearTimeout(timer);
            timer = setTimeout(function() { _czDoSearch(inp, sugg); }, 250);
        });
        inp.addEventListener('focus', function() { if (inp.value.trim()) _czDoSearch(inp, sugg); });
        document.addEventListener('click', function(e) {
            if (!sugg.contains(e.target) && e.target !== inp) sugg.style.display = 'none';
        });
    }

    function _czGetChunk(inp) {
        var val = inp.value;
        var lastComma = val.lastIndexOf(',');
        return (lastComma === -1 ? val : val.substring(lastComma + 1)).trim();
    }

    function _czAppend(inp, sugg, text) {
        var val = inp.value;
        var lastComma = val.lastIndexOf(',');
        var before = lastComma === -1 ? '' : val.substring(0, lastComma + 1) + ' ';
        inp.value = before + text + ', ';
        sugg.style.display = 'none';
        inp.focus();
    }

    function _czDoSearch(inp, sugg) {
        var chunk = _czGetChunk(inp).toLowerCase();
        if (chunk.length < 2) { sugg.style.display = 'none'; return; }

        var results = [];

        // 1. Province names
        Object.keys(_czNameToPrefix).forEach(function(prov) {
            if (prov.toLowerCase().indexOf(chunk) !== -1) {
                results.push({ type: 'province', label: prov, prefix: _czNameToPrefix[prov], desc: 'Añadir todos los CPs ' + _czNameToPrefix[prov] + 'xxx' });
            }
        });

        // 2. Localities from PhantomDirectory
        if (window.isPhantomLoaded && window.PhantomDirectory && chunk.length >= 3) {
            var seen = {};
            window.PhantomDirectory.forEach(function(c) {
                if (!c.localidad || !c.cp) return;
                var loc = c.localidad.trim().toLowerCase();
                var key = c.cp + '_' + loc;
                if (seen[key]) return;
                if (loc.indexOf(chunk) !== -1 || c.cp.indexOf(chunk) !== -1) {
                    seen[key] = true;
                    results.push({ type: 'locality', label: c.localidad.trim(), cp: c.cp, desc: 'CP ' + c.cp + ' — ' + (_czProvMap[c.cp.substring(0, 2)] || '') });
                }
            });
        }

        // 3. Partial CP number
        if (/^\d{2,4}$/.test(chunk) && window.isPhantomLoaded && window.PhantomDirectory) {
            var seenCp = {};
            window.PhantomDirectory.forEach(function(c) {
                if (!c.cp) return;
                if (c.cp.startsWith(chunk) && !seenCp[c.cp]) {
                    seenCp[c.cp] = true;
                    results.push({ type: 'cp', label: c.cp, desc: (c.localidad || '') + ' — ' + (_czProvMap[c.cp.substring(0, 2)] || '') });
                }
            });
        }

        // Deduplicate and limit
        var unique = [], keys = {};
        results.forEach(function(r) {
            var k = r.type + '_' + (r.cp || r.prefix || r.label);
            if (!keys[k]) { keys[k] = true; unique.push(r); }
        });
        results = unique.slice(0, 15);

        if (results.length === 0) { sugg.style.display = 'none'; return; }

        function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

        var html = '';
        results.forEach(function(r, i) {
            var bg = i % 2 === 0 ? '#1e1e2e' : '#232338';
            if (r.type === 'province') {
                html += '<div data-cz-province="' + r.prefix + '" style="padding:8px 12px; cursor:pointer; background:' + bg + '; border-bottom:1px solid #2d2d44;" onmouseover="this.style.background=\'#2d2d5a\'" onmouseout="this.style.background=\'' + bg + '\'">';
                html += '<div style="color:#CE93D8; font-size:0.82rem; font-weight:700;">📍 ' + esc(r.label) + '</div>';
                html += '<div style="color:#888; font-size:0.7rem;">' + esc(r.desc) + '</div></div>';
            } else {
                html += '<div data-cz-val="' + esc(r.cp || r.label) + '" style="padding:8px 12px; cursor:pointer; background:' + bg + '; border-bottom:1px solid #2d2d44;" onmouseover="this.style.background=\'#2d2d5a\'" onmouseout="this.style.background=\'' + bg + '\'">';
                html += '<div style="color:#eee; font-size:0.82rem;">' + esc(r.label) + '</div>';
                html += '<div style="color:#888; font-size:0.7rem;">' + esc(r.desc) + '</div></div>';
            }
        });
        sugg.innerHTML = html;
        sugg.style.display = 'block';

        // Bind clicks
        sugg.querySelectorAll('[data-cz-province]').forEach(function(el) {
            el.onclick = function() {
                var prefix = el.getAttribute('data-cz-province');
                var cps = {};
                if (window.isPhantomLoaded && window.PhantomDirectory) {
                    window.PhantomDirectory.forEach(function(c) {
                        if (c.cp && c.cp.substring(0, 2) === prefix) cps[c.cp] = true;
                    });
                }
                var cpList = Object.keys(cps).sort();
                if (cpList.length === 0) { _czAppend(inp, sugg, prefix + '000'); return; }
                var val = inp.value;
                var lastComma = val.lastIndexOf(',');
                var before = lastComma === -1 ? '' : val.substring(0, lastComma + 1) + ' ';
                inp.value = before + cpList.join(', ') + ', ';
                sugg.style.display = 'none';
                inp.focus();
            };
        });
        sugg.querySelectorAll('[data-cz-val]').forEach(function(el) {
            el.onclick = function() { _czAppend(inp, sugg, el.getAttribute('data-cz-val')); };
        });
    }

    console.log('[Phones Manager] ✅ Módulo cargado');
})();
