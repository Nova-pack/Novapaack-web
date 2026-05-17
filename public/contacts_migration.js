// =============================================================
// NOVAPACK — Migración de contactos unificados
// Combina gesco_clients.json + /users en una única colección /contacts
//
// Estrategia (definida por admin 2026-05-16):
//   - GESCO MANDA en idNum (número cliente) — el equipo está
//     acostumbrado a esos números, no queremos perderlos.
//   - NOVAPACK MANDA en DATOS COMPLETOS (NIF, email, etc.) — para
//     enriquecer la entrada Gesco con datos que falten.
//   - Si Gesco tiene un cliente que también está en NOVAPACK
//     (match por NIF o por nombre+CP) → fusiona: idNum=Gesco,
//     datos enriquecidos con NOVAPACK.
//   - Clientes NOVAPACK que NO están en Gesco → se añaden como
//     entradas nuevas (con su idNum propio o uno generado).
// =============================================================
(function() {
'use strict';

const COL = 'contacts';

// Normalización de nombres para matching
function _normName(s) {
    if (!s) return '';
    return String(s)
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')  // sin acentos
        .replace(/[^a-z0-9]/g, '')                          // solo alfanum
        .trim();
}
function _normNif(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}
function _normCp(s) {
    return String(s || '').replace(/[^0-9]/g, '').padStart(5, '0').slice(-5);
}

// Build payload desde una entrada Gesco
function _gescoToContact(g) {
    return {
        idNum: g.idNum || '',
        name: (g.name || '').trim(),
        nif: _normNif(g.nif),
        phone: (g.senderPhone || g.phone || '').trim(),
        address: (g.street || g.address || '').trim(),
        cp: _normCp(g.cp),
        localidad: (g.localidad || '').trim(),
        province: (g.province || '').trim(),
        source: 'gesco',
        novapackUid: '',          // se rellena si se enriquece
        gescoIdNum: g.idNum || '',
        _searchName: _normName(g.name),
        _searchNif: _normNif(g.nif)
    };
}

// Build payload desde un /users doc
function _userToContact(uid, u) {
    const name = u.companyName || u.businessName || u.name || u.nombreFiscal || '';
    return {
        idNum: u.idNum || '',
        name: name.trim(),
        nif: _normNif(u.cif || u.nif),
        phone: (u.phone || u.senderPhone || '').trim(),
        address: (u.address || u.senderAddress || '').trim(),
        cp: _normCp(u.cp),
        localidad: (u.localidad || u.city || '').trim(),
        province: (u.province || '').trim(),
        source: 'novapack',
        novapackUid: uid,
        gescoIdNum: '',
        _searchName: _normName(name),
        _searchNif: _normNif(u.cif || u.nif)
    };
}

// Enriquece un contacto base con datos de otro (solo rellena campos vacíos)
function _enrich(base, other) {
    ['name', 'nif', 'phone', 'address', 'cp', 'localidad', 'province'].forEach(k => {
        if (!base[k] && other[k]) base[k] = other[k];
    });
    if (other.novapackUid && !base.novapackUid) base.novapackUid = other.novapackUid;
    // Refresca campos de búsqueda
    base._searchName = _normName(base.name);
    base._searchNif = _normNif(base.nif);
}

// =========================================================
// DRY RUN — analiza pero NO escribe nada
// =========================================================
window.contactsMigrationDryRun = async function() {
    if (typeof db === 'undefined') { alert('Firebase no está inicializado.'); return; }

    if (typeof showLoading === 'function') showLoading();

    try {
        // 1. Cargar Gesco
        const gescoRes = await fetch('/gesco_clients.json');
        const gescoData = await gescoRes.json();
        console.log('[migration] gesco entries:', gescoData.length);

        // 2. Cargar /users
        const usersSnap = await db.collection('users').get();
        const users = [];
        usersSnap.forEach(d => {
            const u = d.data();
            if (u.role === 'admin') return;
            users.push({ uid: d.id, ...u });
        });
        console.log('[migration] novapack users:', users.length);

        // 3. Indexar NOVAPACK por NIF y por nombre+CP
        const nvByNif = {};
        const nvByNameCp = {};
        users.forEach(u => {
            const c = _userToContact(u.uid, u);
            if (c.nif) nvByNif[c.nif] = c;
            const key = c._searchName + '|' + c.cp;
            if (c._searchName) nvByNameCp[key] = c;
        });

        // 4. Recorrer Gesco y matchear
        const matched = [];     // contactos Gesco enriquecidos con NOVAPACK
        const gescoOnly = [];   // contactos Gesco sin match en NOVAPACK
        const matchedNvUids = new Set();

        gescoData.forEach(g => {
            const gc = _gescoToContact(g);
            let nv = null;

            // 1º: match por NIF (más confiable)
            if (gc._searchNif && nvByNif[gc._searchNif]) {
                nv = nvByNif[gc._searchNif];
            }
            // 2º: match por nombre+CP
            else if (gc._searchName && gc.cp) {
                const key = gc._searchName + '|' + gc.cp;
                if (nvByNameCp[key]) nv = nvByNameCp[key];
            }

            if (nv) {
                _enrich(gc, nv);
                matched.push(gc);
                matchedNvUids.add(nv.novapackUid);
            } else {
                gescoOnly.push(gc);
            }
        });

        // 5. NOVAPACK que NO están en Gesco → entradas nuevas
        const novapackOnly = users
            .filter(u => !matchedNvUids.has(u.uid))
            .map(u => _userToContact(u.uid, u));

        // 6. Stats
        const stats = {
            gescoTotal: gescoData.length,
            novapackTotal: users.length,
            matched: matched.length,
            gescoOnly: gescoOnly.length,
            novapackOnly: novapackOnly.length,
            totalContacts: matched.length + gescoOnly.length + novapackOnly.length,
            withNif: matched.filter(c => c.nif).length + gescoOnly.filter(c => c.nif).length + novapackOnly.filter(c => c.nif).length,
            withPhone: matched.filter(c => c.phone).length + gescoOnly.filter(c => c.phone).length + novapackOnly.filter(c => c.phone).length
        };

        // Cachear para commit
        window._contactsMigrationCache = {
            matched, gescoOnly, novapackOnly, stats
        };

        if (typeof hideLoading === 'function') hideLoading();

        // Mostrar preview en modal
        _showMigrationPreview(stats, matched.slice(0, 5), gescoOnly.slice(0, 3), novapackOnly.slice(0, 3));

        return stats;
    } catch(err) {
        if (typeof hideLoading === 'function') hideLoading();
        console.error('[migration] dry-run fail:', err);
        alert('Error en análisis: ' + err.message);
    }
};

function _showMigrationPreview(stats, sampleMatched, sampleGesco, sampleNv) {
    let html = '<div style="max-width:680px;">';
    html += '<h2 style="margin:0 0 10px; color:#FF9800; font-size:1.1rem;">📊 Vista previa de la migración (dry-run, nada escrito)</h2>';
    html += '<p style="color:#888; font-size:0.78rem; margin:0 0 15px;">Revisa los números antes de aplicar. La migración crea/sobreescribe la colección <code>/contacts</code>.</p>';

    html += '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:18px;">';
    html += _statCard('Gesco entradas', stats.gescoTotal, '#5DADE2');
    html += _statCard('NOVAPACK clientes', stats.novapackTotal, '#4CAF50');
    html += _statCard('Match enriquecido', stats.matched, '#FF9800');
    html += _statCard('Solo Gesco', stats.gescoOnly, '#888');
    html += _statCard('Solo NOVAPACK', stats.novapackOnly, '#9C27B0');
    html += _statCard('TOTAL contactos', stats.totalContacts, '#FF6600');
    html += '</div>';

    html += '<div style="background:rgba(76,175,80,0.08); border:1px solid rgba(76,175,80,0.3); padding:10px; border-radius:6px; margin-bottom:12px; font-size:0.82rem;">';
    html += '✅ Con NIF: <strong>' + stats.withNif + '</strong> de ' + stats.totalContacts + ' (' + Math.round(100 * stats.withNif / stats.totalContacts) + '%)<br>';
    html += '📞 Con teléfono: <strong>' + stats.withPhone + '</strong>';
    html += '</div>';

    html += '<details style="margin-bottom:10px;"><summary style="cursor:pointer; font-size:0.85rem; color:#FF9800; font-weight:700;">Ejemplos de match enriquecido (' + sampleMatched.length + ')</summary>';
    html += '<div style="margin-top:6px; font-family:monospace; font-size:0.72rem; background:#0a0a0a; padding:8px; border-radius:4px; max-height:200px; overflow-y:auto;">';
    sampleMatched.forEach(c => {
        html += '<div style="padding:4px 0; border-bottom:1px dotted #333;">' +
            '<strong style="color:#FF9800;">' + _esc(c.name) + '</strong> · ' +
            'Gesco#' + _esc(c.gescoIdNum) + ' + NOVAPACK ' + _esc(c.novapackUid).slice(0, 8) + '... · ' +
            'NIF: ' + _esc(c.nif || '—') +
            '</div>';
    });
    html += '</div></details>';

    html += '<details style="margin-bottom:10px;"><summary style="cursor:pointer; font-size:0.85rem; color:#5DADE2; font-weight:700;">Ejemplos Solo NOVAPACK (' + sampleNv.length + ')</summary>';
    html += '<div style="margin-top:6px; font-family:monospace; font-size:0.72rem; background:#0a0a0a; padding:8px; border-radius:4px;">';
    sampleNv.forEach(c => {
        html += '<div style="padding:4px 0; border-bottom:1px dotted #333;"><strong>' + _esc(c.name) + '</strong> · NIF: ' + _esc(c.nif || '—') + '</div>';
    });
    html += '</div></details>';

    html += '<div style="display:flex; gap:10px; margin-top:14px;">';
    html += '<button onclick="document.getElementById(\'_contacts-migration-modal\').remove();" style="flex:1; background:#444; border:0; color:#fff; padding:10px; border-radius:6px; cursor:pointer; font-weight:700;">Cancelar</button>';
    html += '<button onclick="contactsMigrationCommit();" style="flex:2; background:#FF9800; border:0; color:#000; padding:10px; border-radius:6px; cursor:pointer; font-weight:900;">✅ Aplicar — Escribir ' + stats.totalContacts + ' contactos</button>';
    html += '</div>';
    html += '</div>';

    let modal = document.getElementById('_contacts-migration-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = '_contacts-migration-modal';
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:99999; display:flex; align-items:center; justify-content:center; padding:20px;';
    modal.innerHTML = '<div style="background:#1e1e20; border:2px solid #FF9800; border-radius:10px; padding:20px; max-width:740px; max-height:85vh; overflow-y:auto; color:#ddd;">' + html + '</div>';
    document.body.appendChild(modal);
}

function _statCard(label, value, color) {
    return '<div style="background:rgba(255,255,255,0.04); border:1px solid ' + color + '40; border-left:3px solid ' + color + '; padding:8px 12px; border-radius:4px;">' +
        '<div style="font-size:1.4rem; font-weight:900; color:' + color + '; line-height:1;">' + value + '</div>' +
        '<div style="font-size:0.7rem; color:#888; margin-top:2px; text-transform:uppercase; letter-spacing:1px;">' + label + '</div>' +
    '</div>';
}

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// =========================================================
// COMMIT — escribe la colección /contacts
// =========================================================
window.contactsMigrationCommit = async function() {
    const cache = window._contactsMigrationCache;
    if (!cache) { alert('Primero ejecuta el análisis (dry-run).'); return; }
    if (!confirm('CONFIRMAR: se van a escribir ' + cache.stats.totalContacts + ' contactos en /contacts.\n\nLa colección /contacts existente se MEZCLA (no se borra de golpe). Para empezar limpio, usa "Vaciar /contacts" antes.\n\n¿Continuar?')) return;

    const modal = document.getElementById('_contacts-migration-modal');
    if (modal) modal.remove();

    if (typeof showLoading === 'function') showLoading();

    try {
        const all = cache.matched.concat(cache.gescoOnly, cache.novapackOnly);
        let batch = db.batch();
        let ops = 0;
        let written = 0;
        const now = firebase.firestore.FieldValue.serverTimestamp();

        for (const c of all) {
            // ID del doc: usa gescoIdNum si existe, sino novapackUid, sino auto
            let docId;
            if (c.gescoIdNum) docId = 'gesco_' + c.gescoIdNum;
            else if (c.novapackUid) docId = 'np_' + c.novapackUid;
            else docId = db.collection(COL).doc().id;

            const payload = Object.assign({}, c, {
                _updatedAt: now,
                _migrationVersion: 'v1_2026_05_16'
            });

            batch.set(db.collection(COL).doc(docId), payload, { merge: true });
            ops++;
            written++;

            if (ops >= 450) {
                await batch.commit();
                batch = db.batch();
                ops = 0;
                console.log('[migration] batch commit, written so far:', written);
            }
        }
        if (ops > 0) await batch.commit();

        if (typeof hideLoading === 'function') hideLoading();
        alert('✅ Migración completada\n\nContactos escritos: ' + written + '\n\nUsa el client-picker en app cliente para verificar que se carga el NIF correctamente.');
    } catch(err) {
        if (typeof hideLoading === 'function') hideLoading();
        console.error('[migration] commit fail:', err);
        alert('Error escribiendo: ' + err.message);
    }
};

// Helper para vaciar /contacts antes de migrar limpio (opcional)
window.contactsMigrationClear = async function() {
    if (!confirm('VACIAR completamente la colección /contacts.\n\nEsto borra TODOS los contactos. Solo úsalo si vas a re-ejecutar la migración a continuación.\n\n¿Continuar?')) return;
    if (typeof showLoading === 'function') showLoading();
    try {
        let snap = await db.collection(COL).limit(500).get();
        let total = 0;
        while (!snap.empty) {
            let batch = db.batch();
            snap.forEach(d => batch.delete(d.ref));
            await batch.commit();
            total += snap.size;
            snap = await db.collection(COL).limit(500).get();
        }
        if (typeof hideLoading === 'function') hideLoading();
        alert('🗑️ Borrados: ' + total + ' contactos. Listo para re-migrar.');
    } catch(err) {
        if (typeof hideLoading === 'function') hideLoading();
        alert('Error: ' + err.message);
    }
};

})();
