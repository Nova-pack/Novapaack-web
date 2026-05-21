/**
 * NOVAPACK CLOUD — public_tickets_sync
 *
 * Mantiene la colección `public_tickets` espejo de `tickets` con SOLO los
 * campos seguros para mostrar en la página pública de seguimiento. Sin PII
 * sensible (teléfonos del remitente, importes, ID fiscal, firma, etc.).
 *
 * Estrategia: una vez que el admin entra en sesión, abre un onSnapshot sobre
 * `tickets` con cambios incrementales y escribe los docs equivalentes en
 * `public_tickets`. El espejo se mantiene mientras el admin tenga la pestaña
 * abierta — aceptable para v1.
 *
 * Backfill: window.publicTicketsBackfill() recorre todos los tickets con
 * batches y reconstruye el espejo. Pensado para una primera vez o tras
 * cambios de esquema.
 */
(function() {
    'use strict';

    if (typeof db === 'undefined') return;

    var _listener = null;
    var _lastSyncCount = 0;
    var _booted = false;

    // Subset of ticket fields that are safe to expose publicly. Anything with
    // PII, billing, or signature data is omitted. Matches the firestore.rules
    // blacklist for public_tickets.
    function _projectPublic(t) {
        if (!t) return null;
        var statusKey = t.status || (t.delivered ? 'Entregado' : 'Pendiente');
        return {
            id: t.id || null,
            status: statusKey,
            statusKey: _statusKey(statusKey, t),
            receiver: (t.receiver || '').toString().slice(0, 80),
            destinationCity: (t.localidad || '').toString().slice(0, 60),
            destinationCp: (t.cp || '').toString().slice(0, 8),
            destinationProvince: (t.province || '').toString().slice(0, 40),
            shippingType: t.shippingType || '',
            packages: t.packagesList ? t.packagesList.length : (parseInt(t.packages, 10) || 0),
            packagesScanned: parseInt(t.packagesScanned || 0, 10),
            createdAt: t.createdAt || null,
            distributedAt: t.distributedAt || null,
            deliveredAt: t.deliveredAt || null,
            deliveredTo: t.deliveryReceiverName ? String(t.deliveryReceiverName).slice(0, 80) : null,
            signatureRefused: !!t.signatureRefused,
            // Public tracking link uses driver routeLabel (no phone, no name)
            routeLabel: t.routeLabel || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
    }

    // High-level state buckets the public page can show as a timeline.
    function _statusKey(status, t) {
        if (status === 'Entregado' || t.delivered) return 'delivered';
        if (status === 'Anulado') return 'cancelled';
        if (status === 'Devuelto') return 'returned';
        if (status === 'Incidencia') return 'incident';
        if (parseInt(t.packagesScanned || 0, 10) > 0) return 'in_transit';
        return 'pending';
    }

    // The public-tickets doc is indexed by the BUSINESS id (e.g. "NP-12345")
    // so that a /track.html?id=NP-12345 link is a single doc get — no list
    // permission required, and the link is human-shareable.
    function _publicDocId(t, sourceDocId) {
        var bid = (t && t.id) ? String(t.id).trim() : '';
        return bid || sourceDocId;
    }

    function _start() {
        if (_listener || _booted === false) return;
        // Skip the initial batch on first snapshot — those are existing tickets
        // already in the mirror (or pending backfill). Only react to real changes
        // from the moment the admin opens the panel onward.
        var firstSnapshotConsumed = false;
        try {
            _listener = db.collection('tickets')
                .orderBy('updatedAt', 'desc')
                .limit(1000)
                .onSnapshot(function(snap) {
                    if (!firstSnapshotConsumed) {
                        firstSnapshotConsumed = true;
                        return;
                    }
                    var batch = db.batch();
                    var ops = 0;
                    snap.docChanges().forEach(function(change) {
                        var data = change.doc.data();
                        var pubId = _publicDocId(data, change.doc.id);
                        var ref = db.collection('public_tickets').doc(pubId);
                        if (change.type === 'removed') {
                            batch.delete(ref);
                        } else {
                            var pub = _projectPublic(data);
                            if (pub) {
                                pub._sourceDocId = change.doc.id;  // crumb for debugging
                                batch.set(ref, pub, { merge: true });
                            }
                        }
                        ops++;
                        if (ops >= 450) {
                            batch.commit().catch(function(e) {
                                console.warn('[PUBLIC-SYNC] batch error:', e.message);
                            });
                            batch = db.batch();
                            ops = 0;
                        }
                    });
                    if (ops > 0) {
                        batch.commit().then(function() {
                            _lastSyncCount += ops;
                        }).catch(function(e) {
                            console.warn('[PUBLIC-SYNC] final batch error:', e.message);
                        });
                    }
                }, function(err) {
                    console.warn('[PUBLIC-SYNC] listener error:', err.message);
                });
        } catch(e) {
            console.warn('[PUBLIC-SYNC] start failed:', e.message);
        }
    }

    function _stop() {
        if (_listener) { _listener(); _listener = null; }
    }

    // ============ MANUAL BACKFILL ============
    window.publicTicketsBackfill = async function publicTicketsBackfill(opts) {
        opts = opts || {};
        var statusUpdate = opts.onProgress || function(msg) { console.log('[PUBLIC-SYNC]', msg); };
        var pageSize = 400;
        var lastDoc = null;
        var totalProcessed = 0;
        statusUpdate('Iniciando backfill…');
        // eslint-disable-next-line no-constant-condition
        while (true) {
            var q = db.collection('tickets').orderBy(firebase.firestore.FieldPath.documentId()).limit(pageSize);
            if (lastDoc) q = q.startAfter(lastDoc);
            var snap = await q.get();
            if (snap.empty) break;
            var batch = db.batch();
            snap.docs.forEach(function(doc) {
                var data = doc.data();
                var pub = _projectPublic(data);
                if (!pub) return;
                pub._sourceDocId = doc.id;
                var pubId = _publicDocId(data, doc.id);
                batch.set(db.collection('public_tickets').doc(pubId), pub, { merge: true });
            });
            await batch.commit();
            totalProcessed += snap.docs.length;
            statusUpdate('Procesados ' + totalProcessed + ' tickets…');
            lastDoc = snap.docs[snap.docs.length - 1];
            if (snap.docs.length < pageSize) break;
        }
        statusUpdate('✅ Backfill completado: ' + totalProcessed + ' tickets espejados.');
        return totalProcessed;
    };

    window.publicTicketsSyncStatus = function() {
        return {
            running: !!_listener,
            booted: _booted,
            syncedSinceBoot: _lastSyncCount
        };
    };

    // ============ BOOT ============
    function _waitAndBoot() {
        if (typeof firebase === 'undefined' || !firebase.auth) {
            setTimeout(_waitAndBoot, 500);
            return;
        }
        firebase.auth().onAuthStateChanged(async function(user) {
            if (!user) { _stop(); _booted = false; return; }
            // Only run from admin context. Detect by checking the admin doc.
            try {
                var adminDoc = await db.collection('config').doc('admin').get();
                if (adminDoc.exists && adminDoc.data().uid === user.uid) {
                    _booted = true;
                    _start();
                    console.log('[PUBLIC-SYNC] espejo público activo');
                }
            } catch(e) { /* not admin or no perms — silent */ }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _waitAndBoot);
    } else {
        _waitAndBoot();
    }
})();
