// --- GLOBAL STATE ---
console.log("NOVAPACK CLOUD - ENGINE v2.2 ACTIVE");

// Security: escape user-supplied strings before inserting into innerHTML
function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Atomic sequential counter via Firestore transaction. Use for invoice/journal/etc.
// numbering to prevent collisions when multiple admins act concurrently.
//   counterPath: e.g. 'sequence_counters/invoices_2026' or 'sequence_counters/journal'
//   seedFn (optional): async () => number, returns the highest existing seq when
//                      the counter doc doesn't exist yet (one-time bootstrap).
// Returns the freshly reserved next integer.
window.allocSequentialNumber = async function allocSequentialNumber(counterPath, seedFn) {
    if (!counterPath || typeof counterPath !== 'string') throw new Error('counterPath required');
    const ref = db.doc(counterPath);
    return await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        let next;
        if (snap.exists && typeof snap.data().currentMax === 'number') {
            next = snap.data().currentMax + 1;
        } else {
            const seed = (typeof seedFn === 'function') ? await seedFn() : 0;
            next = (parseInt(seed, 10) || 0) + 1;
        }
        tx.set(ref, {
            currentMax: next,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return next;
    });
};

// Canonicalize a Spanish phone number to its 9-digit form.
// Tolerates +34, 0034, spaces, dashes, parentheses. MUST stay in sync with reparto.js.
window.normalizePhone = function normalizePhone(p) {
    var d = (p == null ? '' : p).toString().replace(/\D/g, '');
    if (d.length > 9 && d.indexOf('0034') === 0) d = d.slice(4);
    else if (d.length > 9 && d.indexOf('34') === 0) d = d.slice(2);
    if (d.length > 9) d = d.slice(-9);
    return d;
};
const DEBUG_MODE = location.hostname === 'localhost';

// --- RATE LIMITER: client-side throttle for critical operations ---
const _rateLimiter = {
    _counters: {},  // { key: { count, windowStart } }
    WINDOW_MS: 60000, // 1 minute window

    check: function(operationKey, maxPerMinute) {
        var now = Date.now();
        var entry = this._counters[operationKey];
        if (!entry || (now - entry.windowStart) > this.WINDOW_MS) {
            this._counters[operationKey] = { count: 1, windowStart: now };
            return true;
        }
        if (entry.count >= maxPerMinute) {
            console.warn('[RATE LIMIT] Operación bloqueada:', operationKey, entry.count + '/' + maxPerMinute);
            return false;
        }
        entry.count++;
        return true;
    }
};

window.onerror = function(msg, url, lineNo, columnNo, error) {
    console.error("GLOBAL JS ERROR:", msg, "Line:", lineNo, "Col:", columnNo, error);
    if (typeof Sentry !== 'undefined' && Sentry.captureException && error) Sentry.captureException(error);
};
window.addEventListener('unhandledrejection', function(event) {
    if (event.reason && event.reason.message && event.reason.message.includes("offline")) return;
    console.error("PROMISE ERROR:", event.reason);
    if (typeof Sentry !== 'undefined' && Sentry.captureException && event.reason) Sentry.captureException(event.reason);
});

// ============ AUDIT TRAIL: Operador oculto ============
// Devuelve { _operadoPor, _operadoAt, _operadorUid } para inyectar en cada escritura Firestore
// Usa Firebase Auth como fuente de verdad (no window.adminIdentity que es inyectable por consola)
window.getOperatorStamp = function() {
    var user = typeof firebase !== 'undefined' && firebase.auth ? firebase.auth().currentUser : null;
    var identity = sessionStorage.getItem('adminActiveIdentity') || (user && user.email) || 'sistema';
    var stamp = {
        _operadoPor: identity,
        _operadoAt: new Date().toISOString(),
        _operadorUid: user ? user.uid : null
    };
    // Audit: when super-admin is impersonating a client, tag the write so we
    // can trace it back. Visible in any ticket / company / destination doc.
    if (window._adminImpersonating) {
        stamp._actingAsClient = window._adminImpersonating;
        stamp._actingByAdmin = user ? user.email : 'admin';
    }
    return stamp;
};
// ======================================================

// Configuración global y estado
let currentUser = null;
let userData = null; // Stored profile data (idNum, name, etc.)
let currentCompanyId = 'default';
let effectiveStorageUid = null;
let companies = [];
let editingId = null;
let editingClientId = null;
let currentReportData = [];
let activeTariffArticles = [];
let cachedProvinces = []; // Global cache to avoid UI race conditions and over-fetching

// NEW: Robust Global Logout
window.logout = () => {
    if (confirm("¿Cerrar sesión en Novapack Cloud?")) {
        if (typeof showLoading === 'function') showLoading();
        auth.signOut().then(() => {
            window.location.href = 'index.html';
        }).catch(e => {
            console.error("Logout Error:", e);
            window.location.href = 'index.html'; // Force redirect anyway
        });
    }
};

// Safety timeout for loading overlay (max 8s)
setTimeout(() => { if (typeof hideLoading === 'function') hideLoading(); }, 8000);

const DEFAULT_SIZES = "Pequeño, Mediano, Grande, Sobre, Palet, BATERIA 45AH, BATERIA 75AH, BATERIA 100AH, BATERIA CAMION, TAMBOR CAMION, CALIPER DE CAMION, CAJAS DE ACEITE O AGUA, GARRAFAS ADBLUE";

// --- PRINT HELPERS ---
function setPrintPageSize(size) {
    let s = document.getElementById('print-page-size');
    if (!s) {
        s = document.createElement('style');
        s.id = 'print-page-size';
        document.head.appendChild(s);
    }
    // "auto" forces the browser to adopt the user's printer hardware settings
    const parsedSize = size === "101.6mm 152.4mm" ? "auto" : size;
    s.innerHTML = `@media print { @page { size: ${parsedSize}; margin: 0; } }`;
}

// Global reference to current afterprint handler so we can remove stale listeners
let _currentAfterPrintHandler = null;

function cleanPrintArea() {
    const area = document.getElementById('print-area');
    if (area) area.innerHTML = '';
    document.body.classList.remove('printing-labels');
    if (_currentAfterPrintHandler) {
        window.removeEventListener('afterprint', _currentAfterPrintHandler);
        _currentAfterPrintHandler = null;
    }
    // Quita la regla @page inyectada para que un Ctrl+P posterior fuera
    // del flujo no herede un tamaño concreto. Cada print job vuelve a
    // declarar el suyo en setPrintPageSize().
    const styleEl = document.getElementById('print-page-size');
    if (styleEl) styleEl.remove();
}

function registerAfterPrint(handler) {
    // Remove any stale listener from a previous print job
    if (_currentAfterPrintHandler) {
        window.removeEventListener('afterprint', _currentAfterPrintHandler);
    }
    _currentAfterPrintHandler = handler;
    window.addEventListener('afterprint', handler);
}

// --- CUSTOM STORAGE (Firestore-backed User Settings) ---
async function getCustomData(key) {
    if (!currentUser) return null;
    try {
        const doc = await db.collection('users').doc(currentUser.uid).collection('config').doc('settings').get();
        return doc.exists ? doc.data()[key] : null;
    } catch (e) {
        console.warn("Error getting custom data:", e);
        return null;
    }
}

async function getGlobalData(key) {
    try {
        const doc = await db.collection('config').doc('settings').get();
        return doc.exists ? doc.data()[key] : null;
    } catch (e) {
        console.warn("Error getting global data:", e);
        return null;
    }
}

async function saveCustomData(key, value) {
    if (!currentUser) return;
    try {
        await db.collection('users').doc(currentUser.uid).collection('config').doc('settings').set({ [key]: value }, { merge: true });
    } catch (e) {
        console.error("Error saving custom data:", e);
    }
}

// --- INITIALIZATION ---
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    currentUser = user;

    showLoading();
    try {
        let profile = null;
        // 1. Buscar si hay algún documento en la colección 'users' con este email (creado por el Admin)
        if (user.email) {
            if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log("Buscando cuenta maestra por Email...", user.email);
            try {
                // Fetch all matching docs, remove limit(1) to prevent race conditions with the clone
                const emailSnap = await db.collection('users').where('email', '==', user.email.toLowerCase()).get();
                if (!emailSnap.empty) {
                    // CRITICAL FIX: The true master document is the one created by the admin (auto-id).
                    // We must ignore the clone we make at `user.uid`, unless it is the ONLY document.
                    let masterDoc = emailSnap.docs.find(d => d.id !== user.uid) || emailSnap.docs[0];
                    
                    profile = { id: masterDoc.id, ...masterDoc.data() };
                    profile.isLinked = true;
                    // Forzar vinculación en documento de UID para búsquedas rápidas secundarias
                    await db.collection('users').doc(user.uid).set({ ...profile, authUid: user.uid }, { merge: true });
                }
            } catch (err) {
                 console.warn("Fallo búsqueda where email:", err.message);
            }
        }

        // 2a. Fallback: si el login es un email sintético (clientes con
        // sucursales comparten email real, así que el admin les creó un
        // loginEmail único @novapack.com), busca por authUid.
        if (!profile) {
            try {
                const authUidSnap = await db.collection('users').where('authUid', '==', user.uid).limit(1).get();
                if (!authUidSnap.empty) {
                    const masterDoc = authUidSnap.docs[0];
                    profile = { id: masterDoc.id, ...masterDoc.data() };
                    profile.isLinked = true;
                    // Clona al docId del uid para acelerar futuros logins
                    await db.collection('users').doc(user.uid).set({ ...profile, authUid: user.uid }, { merge: true });
                }
            } catch(err) {
                console.warn('Fallo búsqueda where authUid:', err.message);
            }
        }

        // 2b. Fallback: leer documento del UID propio (caso normal de
        // cliente cuya cuenta auth se creó con su email real).
        if (!profile) {
             let userDoc = await db.collection('users').doc(user.uid).get();
             if (userDoc.exists) {
                 profile = { id: user.uid, ...userDoc.data() };
             }
        }

        // 3. Fallback final heredado: Buscar textualmente por email (ignorando error)
        if (!profile && user.email) {
            try {
                let directDoc = await db.collection('users').doc(user.email.toLowerCase()).get();
                if (directDoc.exists) {
                    profile = { id: user.email.toLowerCase(), ...directDoc.data() };
                    await db.collection('users').doc(user.uid).set({ ...profile, authUid: user.uid }, { merge: true });
                }
            } catch(e) {}
        }
        // 4. Fallback extremo: Creación Sintética si no existe en base de datos.
        if (!profile) {
            console.warn("[SYNC] Perfil de usuario no hallado en la DB global. Inicializando perfil sintético en memoria.");
            profile = {
                id: user.uid,
                authUid: user.uid,
                email: user.email || 'usuario@desconocido.com',
                name: user.email ? user.email.split('@')[0].toUpperCase() : 'USER',
                idNum: user.uid,
                isSynthetic: true
            };
            try { 
                await db.collection('users').doc(user.uid).set(profile, { merge: true });
            } catch(e) {}
        }

        userData = profile;

        // ───── Acceso bloqueado por admin ─────
        // Si la ficha tiene accessActive === false, el admin ha desactivado
        // el acceso. Se le muestra al cliente un mensaje claro y se le saca.
        // (Solo aplica si NO estamos en modo super-admin impersonando.)
        try {
            const _urlAA = new URLSearchParams(window.location.search).get('adminAs');
            if (!_urlAA && profile && profile.accessActive === false) {
                hideLoading();
                await new Promise(r => setTimeout(r, 200));
                alert('⛔ Acceso desactivado por administración.\n\nTu cuenta está marcada como INACTIVA. Contacta con NOVAPACK para reactivarla.');
                try { await auth.signOut(); } catch(e) {}
                window.location.href = 'index.html';
                return;
            }
        } catch(e) { console.warn('accessActive check:', e); }

        // CRITICAL FIX: effectiveStorageUid MUST be the user.uid to comply with Firestore security rules.
        // It cannot be the email, otherwise the user is denied permission to save their own companies and tariffs.
        effectiveStorageUid = user.uid;

        // ───── SUPER-ADMIN: modo "Entrar como cliente" ─────
        // El admin abre app.html?adminAs={docId}. Verificamos que el user
        // actual sea el admin del sistema (config/admin.uid) y, si todo cuadra,
        // re-escribimos userData y effectiveStorageUid apuntando al cliente
        // objetivo. El resto del código carga sus albaranes, sedes, agenda y
        // tarifa como si fuera él.
        try {
            const _urlAA = new URLSearchParams(window.location.search).get('adminAs');
            if (_urlAA) {
                const _adminCheck = await db.collection('config').doc('admin').get();
                const isCurrentAdmin = _adminCheck.exists && _adminCheck.data().uid === user.uid;
                if (!isCurrentAdmin) {
                    alert('No tienes permisos para usar el modo super-admin.');
                } else {
                    const _targetDoc = await db.collection('users').doc(_urlAA).get();
                    if (!_targetDoc.exists) {
                        alert('Cliente no encontrado: ' + _urlAA);
                    } else {
                        userData = { id: _targetDoc.id, ..._targetDoc.data() };
                        effectiveStorageUid = userData.authUid || _targetDoc.id;
                        window._adminImpersonating = userData.id;
                        // Banner naranja persistente
                        const _bnr = document.createElement('div');
                        _bnr.id = 'admin-impersonate-banner';
                        _bnr.style.cssText = 'position:fixed; top:0; left:0; right:0; background:linear-gradient(90deg,#FF9F0A,#FF6B00); color:#000; text-align:center; padding:8px 16px; z-index:99999; font-weight:800; font-size:0.85rem; letter-spacing:0.5px; box-shadow:0 2px 8px rgba(0,0,0,0.3);';
                        _bnr.innerHTML = '👁️ SUPER-ADMIN — actuando como <strong>' + (userData.name || userData.id) + '</strong> (#' + (userData.idNum || '?') + ') · <a href="#" onclick="window.close();return false;" style="color:#000;text-decoration:underline;">Cerrar pestaña</a>';
                        document.body.appendChild(_bnr);
                        // Empuja el cuerpo hacia abajo para no tapar contenido
                        document.body.style.paddingTop = (document.body.style.paddingTop || '0px');
                        document.body.style.marginTop = '36px';
                        console.warn('[SUPER-ADMIN] Impersonando a', userData.id, userData.name);
                    }
                }
            }
        } catch(e) { console.warn('SUPER-ADMIN setup error:', e.message); }
        // ───── fin super-admin ─────

        console.log("[SYNC] Effective Storage UID set to:", effectiveStorageUid);

        if (userData) {
            const userDisplay = document.getElementById('user-display-name');
            if (userDisplay) {
                userDisplay.textContent = `[#${userData.idNum || ''}] ${userData.name || user.email}`;
                userDisplay.classList.add('synced');
                userDisplay.style.color = 'var(--brand-primary)';
            }
            console.log("Identidad Operativa:", userData.idNum, "DocID:", userData.id);
        } else {
            console.error("No se pudo sincronizar el perfil.");
            const userDisplay = document.getElementById('user-display-name');
            if (userDisplay) {
                userDisplay.textContent = `[ERROR SYNC] ${user.email}`;
                userDisplay.style.color = '#FF3B30';
            }
        }

        // Carga paralela de recursos restantes (Usando el storageId correcto)
        await Promise.all([
            loadCompanies(),
            loadActiveTariff(),
            loadProvinces(),
            loadPredefinedPhones()
        ]);

        // --- DYNAMIC WELCOME ANIMATION ---
        const welcomeEl = document.getElementById('intro-welcome');
        if (welcomeEl && typeof companies !== 'undefined') {
            const comp = companies.find(c => c.id === currentCompanyId);
            if (comp && comp.name) {
                welcomeEl.textContent = "BIENVENIDO " + comp.name.toUpperCase();
                welcomeEl.style.color = "var(--brand-primary)";
            }
        }

        // Iniciar sincronización de albaranes ahora que tenemos la Empresa correcta configurada
        initTicketListener();
        console.log("[SYNC] Sincronización iniciada con Empresa Activa:", currentCompanyId);
        
        // Iniciar listener de notificaciones POD (Proof of Delivery)
        if (typeof initUserNotifications === 'function') {
            initUserNotifications(currentUser.uid);
        }

        // Auto-open scanner if mode=reparto (from reparto.html)
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('mode') === 'reparto') {
            setTimeout(() => {
                if (typeof showView === 'function') showView('scanner-view');
                if (typeof startAppScanner === 'function') startAppScanner();
                console.log("[REPARTO] Modo reparto activado, escáner abierto.");
            }, 1000);
        }

        await renderCompanySelector();

        // Finalmente resetear el editor (Ahora que ya tenemos empresas y tickets cargados)
        await resetEditor();

        // --- CHECK TERMS ACCEPTANCE ---
        if (userData && !userData.termsAccepted) {
            const termsModal = document.getElementById('modal-terms');
            if (termsModal) termsModal.style.display = 'flex';
        }

    } catch (e) {
        console.error("Critical Sync Error:", e);
    } finally {
        hideLoading();
    }
});

async function loadPredefinedPhones() {
    try {
        const snap = await db.collection('config').doc('phones').collection('list').get();
        const list = document.getElementById('predefined-phones');
        if (!list) return;
        list.innerHTML = '';
        snap.forEach(doc => {
            const data = doc.data();
            const opt = document.createElement('option');
            opt.value = data.number;
            opt.textContent = data.label;
            list.appendChild(opt);
        });
    } catch (e) {
        console.warn("Predefined phones ignored (possibly no permissions):", e);
    }
}

async function loadActiveTariff() {
    activeTariffArticles = [];
    if (!currentUser) return;

    try {
        let tariffData = null;

        // 1. Tarifa global asignada — probar varias formas del docId
        //    porque tariffId puede venir como 'GLOBAL_X_v2', 'X', etc.
        if (userData && userData.tariffId) {
            const tid = String(userData.tariffId).trim();
            const candidates = [tid, 'GLOBAL_' + tid, 'GLOBAL_' + tid + '_v2'];
            for (const c of candidates) {
                try {
                    const d = await db.collection('tariffs').doc(c).get();
                    if (d.exists) {
                        tariffData = d.data();
                        console.log("Cargando Tarifa Global:", c);
                        break;
                    }
                } catch(e) {}
            }
        }

        // 2. Fallback: tarifa específica del usuario (por su uid)
        if (!tariffData) {
            const userDoc = await db.collection('tariffs').doc(currentUser.uid).get();
            if (userDoc.exists) {
                tariffData = userDoc.data();
                console.log("Cargando Tarifa Personalizada de Usuario");
            }
        }

        if (!tariffData || !tariffData.items) return;

        // ─── Extraer artículos según versión de la tarifa ───
        if (Array.isArray(tariffData.items)) {
            // V2: items es un array de objetos { id, name, mode, basePrice, ... }
            let items = tariffData.items.slice();
            // Aplicar overrides del cliente (precios/exclusiones personalizadas)
            if (userData && userData.tariffOverrides && typeof window.pricingEngine !== 'undefined') {
                try {
                    const resolved = window.pricingEngine.resolveTariff(tariffData, userData.tariffOverrides);
                    if (resolved && Array.isArray(resolved.items)) items = resolved.items;
                } catch(e) { console.warn('resolveTariff falló, uso items base:', e.message); }
            }
            // El cliente NO elige "cuota mensual" como tipo de bulto → filtrar flat_monthly.
            // Mostramos el NOMBRE del artículo (lo que el cliente entiende).
            activeTariffArticles = items
                .filter(it => it && it.mode !== 'flat_monthly')
                .map(it => (it.name || it.id || '').toString().trim())
                .filter(Boolean);
        } else if (typeof tariffData.items === 'object') {
            // V1 legacy: items es un objeto { "nombre artículo": precio }
            activeTariffArticles = Object.keys(tariffData.items);
        }

        console.log("Artículos de Tarifa activos (" + activeTariffArticles.length + "):", activeTariffArticles);
    } catch (e) {
        console.warn("Error al cargar tarifa activa:", e);
    }
}

let targetContext = null; // { uid, compId, idNum, name, address, phone }

// --- CLOUD HELPERS ---
// --- LINEAR STORAGE ENGINE ---
const getCollection = (name) => {
    if (!currentUser) return null;

    // Operación en Colección Global (Tickets / Facturas)
    if (name === 'tickets' || name === 'invoices') {
        return db.collection(name);
    }

    // Identificador de usuario para subcolecciones (Agenda, Contadores, Empresas)
    // Usamos el effectiveStorageUid (ID Maestro) para asegurar que vemos los datos migrados/legacy
    const storageId = effectiveStorageUid || currentUser.uid;
    const userRef = db.collection('users').doc(storageId);

    if (name === 'destinations' || name === 'nextId') {
        return userRef.collection(name);
    }

    // Configuración específica de empresa
    return userRef.collection('companies').doc(currentCompanyId).collection(name);
};

// --- DATE HELPERS ---
function formatDateLocal(d) {
    if (!d || isNaN(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getTodayLocal() {
    return formatDateLocal(new Date());
}

// --- DATA ACCESS: COMPANIES ---
async function loadCompanies() {
    companies = [];
    // Check all possible user document IDs for companies subcollection
    const uidsToCheck = [currentUser.uid];
    if (effectiveStorageUid && effectiveStorageUid !== currentUser.uid) {
        uidsToCheck.push(effectiveStorageUid);
    }
    // CRITICAL FIX: Also check the master document ID (admin-created profile) for companies
    if (userData && userData.id && !uidsToCheck.includes(userData.id)) {
        uidsToCheck.push(userData.id);
    }
    // Also check by authUid if different
    if (userData && userData.authUid && !uidsToCheck.includes(userData.authUid)) {
        uidsToCheck.push(userData.authUid);
    }

    console.log('[SYNC] loadCompanies checking UIDs:', uidsToCheck);

    try {
        for (const targetId of uidsToCheck) {
            let snap = await db.collection('users').doc(targetId).collection('companies').get();
            snap.forEach(doc => {
                if (!companies.find(c => c.id === doc.id)) {
                    companies.push({ id: doc.id, ...doc.data() });
                }
            });
            // If we found companies, also clone them to the current UID for future fast access
            if (snap.size > 0 && targetId !== currentUser.uid) {
                console.log(`[SYNC] Cloning ${snap.size} companies from ${targetId} to ${currentUser.uid}`);
                for (const doc of snap.docs) {
                    try {
                        await db.collection('users').doc(currentUser.uid).collection('companies').doc(doc.id).set(doc.data(), { merge: true });
                    } catch(cloneErr) { console.warn('Company clone error:', cloneErr); }
                }
            }
        }
    } catch (e) {
        console.error("Error loading companies:", e);
    }

    if (companies.length === 0) {
        // Create first company using data provided by admin
        console.log("Creando empresa inicial vinculado al nombre del cliente...");
        const clientName = (userData && userData.name) ? userData.name : 'Mi Empresa Novapack';

        // Intentar desglosar la dirección del admin si existe
        const rawAddr = (userData && userData.senderAddress) ? userData.senderAddress : '';
        const addrParts = rawAddr.split(',').map(p => p.trim());

        const defaultComp = {
            name: clientName,
            prefix: (userData && userData.idNum) ? String(userData.idNum) : 'NP',
            address: rawAddr || 'Dirección no configurada',
            street: (userData && userData.street) ? userData.street : (addrParts[0] || ''),
            number: (userData && userData.number) ? userData.number : ((addrParts[1] || "").replace(/Nº\s*/i, '')),
            localidad: (userData && userData.localidad) ? userData.localidad : (addrParts[2] || ''),
            cp: (userData && userData.cp) ? userData.cp : ((addrParts[3] || "").replace(/[()CP\s]/g, '')),
            province: (userData && userData.province) ? userData.province : '',
            nif: (userData && userData.nif) ? userData.nif : '',
            phone: (userData && userData.senderPhone) ? String(userData.senderPhone) : '',
            startNum: 1,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        // Use fixed ID 'comp_main' for consistency with Admin Console
        try {
            await db.collection('users').doc(effectiveStorageUid || currentUser.uid).collection('companies').doc('comp_main').set(defaultComp);
        } catch (err) {
            console.warn("No se pudo crear la empresa en Firestore (Permisos/Red), se usará en memoria local.", err);
        }
        currentCompanyId = 'comp_main';
        companies.push({ id: 'comp_main', ...defaultComp });
    } else {
        // Sync existing primary company with Admin settings (Ensures updates propagate)
        if (userData && companies.length > 0) {
            const mainComp = companies.find(c => c.id === 'comp_main') || companies[0];
            const needsUpdate = (userData.name && mainComp.name !== userData.name) ||
                (userData.senderAddress && mainComp.address !== userData.senderAddress) ||
                (userData.senderPhone && mainComp.phone !== userData.senderPhone) ||
                (userData.nif && mainComp.nif !== userData.nif) ||
                (userData.street && mainComp.street !== userData.street) ||
                (userData.localidad && mainComp.localidad !== userData.localidad) ||
                (userData.cp && mainComp.cp !== userData.cp) ||
                (userData.province && mainComp.province !== userData.province);

            if (needsUpdate && mainComp.id === 'comp_main') {
                console.log("Actualizando datos de remitente principal según configuración de Administrador...");
                const syncData = {
                    name: userData.name || mainComp.name || "Mi Empresa Novapack",
                    address: userData.senderAddress || mainComp.address || "Dirección no configurada",
                    phone: userData.senderPhone || mainComp.phone || "",
                    nif: userData.nif || mainComp.nif || "",
                    street: userData.street || mainComp.street || "",
                    number: userData.number || mainComp.number || "",
                    localidad: userData.localidad || mainComp.localidad || "",
                    cp: userData.cp || mainComp.cp || "",
                    province: userData.province || mainComp.province || ""
                };
                
                try {
                    await db.collection('users').doc(effectiveStorageUid || currentUser.uid).collection('companies').doc(mainComp.id).update(syncData);
                } catch (err) {
                    console.warn("No se pudo sincronizar empresa con perfil maestro (Permisos/Red). Ignorando.", err);
                }
                
                Object.assign(mainComp, syncData);
            }
        }

        // Check if there's a stored preference, or use first
        const savedId = localStorage.getItem('last_company_id');
        if (savedId && companies.find(c => c.id === savedId)) {
            currentCompanyId = savedId;
        } else {
            currentCompanyId = companies[0].id;
        }
    }
    renderCompanySelector();
    renderCompanyList(); // Also update list if modal is open
}

function renderCompanySelector() {
    const sel = document.getElementById('company-selector');
    sel.innerHTML = '';
    companies.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (c.id === currentCompanyId) opt.selected = true;
        sel.appendChild(opt);
    });
}

// --- TICKET SEARCH & LIST (Real-time Multi-station) ---
let lastTicketsBatch = [];
let ticketListener = null;
let searchDebounceTimer = null;

async function initTicketListener(retryCount = 0) {
    if (ticketListener) ticketListener();

    return new Promise((resolve, reject) => {
        let isFirstLoad = true;

        if (!userData || !userData.idNum) {
            if (retryCount < 5) {
                console.warn(`[SYNC] Esperando perfil de usuario (#${retryCount})...`);
                setTimeout(() => initTicketListener(retryCount + 1).then(resolve).catch(reject), 1500);
                return; // CRITICAL: Stop execution during wait phase!
            } else {
                console.warn("[SYNC] No se encontró un ID Numérico tras varios reintentos. Procediendo con acceso básico UID.");
                if (!userData) {
                    userData = { name: currentUser.email || 'Mi Usuario', idNum: currentUser.uid, email: currentUser.email || '' };
                } else if (!userData.idNum) {
                    userData.idNum = currentUser.uid;
                }
                if (isFirstLoad) { isFirstLoad = false; resolve(); }
                // Fallback exitoso, permitimos que el listener continúe usando la UID
            }
        }

        const myIdNum = userData && userData.idNum ? userData.idNum.toString() : (currentUser ? currentUser.uid : null);
        if (!myIdNum) {
            console.warn("[SYNC] ID de cliente no disponible.");
            resolve();
            return;
        }
        const cid = currentCompanyId;

        console.log(`[SYNC-LINEA] Escuchando Albaranes para ID: ${myIdNum}, Empresa: ${cid}`);

        // Variantes exhaustivas de ID para capturar históricos (Email, UID, ID Numérico)
        let identityIds = [currentUser.uid, userData.email, userData.id, userData.authUid].filter(x => x);
        let idVariants = [myIdNum];
        const n = parseInt(myIdNum);
        if (!isNaN(n)) {
            idVariants.push(n, n.toString());
            idVariants.push(n.toString().padStart(2, '0'));
            idVariants.push(n.toString().padStart(3, '0'));
            idVariants.push(n.toString().padStart(4, '0'));
        }

        // ─── Consolidado padre + sucursales ───
        // Si este usuario es PADRE (tiene clientes con parentClientId apuntando a él),
        // añadimos las identidades de sus sucursales al listener. Así el padre ve
        // de un vistazo todos los albaranes de sus sedes en su panel online.
        // Las sucursales NO ven a otros — solo los suyos.
        //
        // IMPORTANTE: estamos DENTRO de un `new Promise((resolve, reject) => {...})`
        // cuyo executor NO es async. Por eso NO podemos usar `await` aquí —
        // hacerlo rompía el parse de TODO firebase-app.js (Autocristal vio cero
        // botones funcionando). Usamos .then() y arrancamos el listener tras
        // resolver la búsqueda (o inmediatamente si el usuario es sucursal).
        let branchIdentities = [];
        const branchPromise = userData.parentClientId
            ? Promise.resolve()
            : db.collection('users')
                .where('parentClientId', '==', userData.id || currentUser.uid)
                .limit(20)
                .get()
                .then(childSnap => {
                    childSnap.forEach(doc => {
                        const d = doc.data();
                        if (d.idNum) branchIdentities.push(d.idNum.toString());
                        if (d.authUid) branchIdentities.push(d.authUid);
                    });
                    if (branchIdentities.length > 0) {
                        console.log('[SYNC-LINEA] Consolidando ' + childSnap.size + ' sucursales:', branchIdentities);
                    }
                })
                .catch(e => { console.warn('[SYNC-LINEA] No pude cargar sucursales:', e.message); });

        let mergedTickets = new Map();
        let q1Fired = false, q2Fired = false;
        let unsub1 = () => {}, unsub2 = () => {};

        branchPromise.then(() => {
        // Unión de todas las identidades posibles para búsqueda universal, asegurando que TODO sea String
        const finalVariantsRaw = [...new Set([...idVariants, ...identityIds, ...branchIdentities])].filter(v => v !== null && v !== undefined && v !== "");
        // Firestore "in" se limita a 10 valores. Si hay más, prima identidades propias.
        const finalVariants = finalVariantsRaw.map(v => String(v).trim()).slice(0, 10);
        if (finalVariantsRaw.length > 10) {
            console.warn('[SYNC-LINEA] Más de 10 identidades (' + finalVariantsRaw.length + '). Truncando a las primeras 10. Las sucursales por encima de ese límite no se mostrarán en el consolidado.');
        }

        console.log(`[SYNC-LINEA] Escuchando Albaranes por UID/Alias:`, finalVariants);

        const processMapAndRender = () => {
            let raw = Array.from(mergedTickets.values());
            let filtered = raw;
            const liveCid = currentCompanyId; // USE LIVE GLOBAL VARIABLE
            if (liveCid && liveCid !== "ALL") {
                filtered = raw.filter(t => {
                    const tcid = t.compId || 'comp_main';
                    return tcid === liveCid || tcid === 'comp_main' || tcid === 'default';
                });
            }
            updateTicketsList(filtered);
            if (isFirstLoad && q1Fired && q2Fired) { isFirstLoad = false; resolve(); }
        };

        // EXTREMELY CRITICAL: We cannot use .orderBy('createdAt', 'desc') here because combined with 'in'
        // it requires a pre-built Firestore Composite Index, which will crash the entire app if missing.
        // Instead, we fetch a large limit of tickets and sort them descending locally in updateTicketsList.
        const q1 = db.collection('tickets').where('uid', 'in', finalVariants).limit(3000);
        const q2 = db.collection('tickets').where('clientIdNum', 'in', finalVariants).limit(3000);

        // Helper: mostrar UN solo toast no bloqueante por error de listener.
        // Antes hacíamos alert() que bloqueaba la UI repetidamente y dejaba al
        // cliente sin poder pulsar botones.
        let _ticketsErrorShown = false;
        function _ticketsListenerErrorToast(label, err) {
            console.error('[SYNC-LINEA] Error ' + label, err);
            if (_ticketsErrorShown) return;
            _ticketsErrorShown = true;
            try {
                const banner = document.createElement('div');
                banner.style.cssText = 'position:fixed; top:10px; right:10px; max-width:340px; background:#7a2727; color:#fff; padding:10px 14px; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.4); font-size:0.82rem; z-index:99999;';
                banner.innerHTML = '<strong>⚠️ Sincronización limitada</strong><br>No hemos podido cargar todos los albaranes en tiempo real (' + (err && err.code ? err.code : 'error') + '). Refresca la página si no ves tus envíos. Los botones siguen activos.';
                document.body.appendChild(banner);
                setTimeout(() => { try { banner.remove(); } catch(e){} }, 8000);
            } catch(_) {}
        }

        unsub1 = q1.onSnapshot(snap => {
            snap.forEach(doc => mergedTickets.set(doc.id, { ...doc.data(), docId: doc.id, docRef: doc }));
            q1Fired = true;
            processMapAndRender();
        }, err => {
            _ticketsListenerErrorToast('Q1', err);
            q1Fired = true; processMapAndRender();
        });

        unsub2 = q2.onSnapshot(snap => {
            snap.forEach(doc => mergedTickets.set(doc.id, { ...doc.data(), docId: doc.id, docRef: doc }));
            q2Fired = true;
            processMapAndRender();
        }, err => {
            _ticketsListenerErrorToast('Q2', err);
            q2Fired = true; processMapAndRender();
        });

        // Backup safety resolve
        setTimeout(() => { if (isFirstLoad) { isFirstLoad = false; resolve(); } }, 3000);

        ticketListener = () => { unsub1(); unsub2(); };
        }); // cierre de branchPromise.then
    });
}

function parseSafeDate(val) {
    if (!val) return new Date();
    if (typeof val.toDate === 'function') return val.toDate();
    if (typeof val === 'string' || typeof val === 'number') return new Date(val);
    return new Date(); // Fallback to current time for pending serverTimestamps
}

function updateTicketsList(newList) {
    lastTicketsBatch = newList.sort((a, b) => {
        const da = parseSafeDate(a.createdAt);
        const db_ = parseSafeDate(b.createdAt);
        return db_ - da;
    });
    console.log(`[SYNC-LINEA] Datos actualizados: ${lastTicketsBatch.length} albaranes.`);
    requestAnimationFrame(() => renderTicketsList());
}

document.getElementById('ticket-search').oninput = () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        renderTicketsList();
    }, 300); // 300ms debounce
};

function renderTicketsList() {
    const list = document.getElementById('tickets-list');
    const searchQuery = document.getElementById('ticket-search').value.toLowerCase().trim();
    const dateFilter = document.getElementById('date-filter').value;

    let filtered = [...lastTicketsBatch];
    console.log(`[DASHBOARD] Renderizado iniciado. Total en memoria: ${filtered.length}. Filtro fecha: ${dateFilter}`);

    // 1. Filtro por Fecha
    if (dateFilter) {
        filtered = filtered.filter(t => {
            const d = parseSafeDate(t.createdAt);
            return formatDateLocal(d) === dateFilter;
        });
        console.log(`[DASHBOARD] Tras filtro fecha: ${filtered.length} albaranes.`);
    }

    // 2. Filtro por Búsqueda (ID o Destinatario)
    if (searchQuery) {
        filtered = filtered.filter(t =>
            (t.id || "").toLowerCase().includes(searchQuery) ||
            (t.receiver || "").toLowerCase().includes(searchQuery) ||
            (t.address || "").toLowerCase().includes(searchQuery)
        );
    }

    // 3. AUTO-LIMPIEZA: Ocultar albaranes impresos/entregados de días anteriores
    //    Solo se muestran: albaranes de HOY + albaranes de días anteriores que NO estén impresos ni entregados
    const todayStr = getTodayLocal();
    if (!searchQuery) { // Solo aplicar auto-limpieza si NO hay búsqueda activa
        const beforeClean = filtered.length;
        filtered = filtered.filter(t => {
            const ticketDate = formatDateLocal(parseSafeDate(t.createdAt));
            const isToday = ticketDate === todayStr;
            if (isToday) return true; // Siempre mostrar los de hoy
            // De días anteriores: ocultar si ya están impresos O entregados
            const isDone = t.printed || t.delivered || t.status === 'Entregado';
            return !isDone;
        });
        const hiddenCount = beforeClean - filtered.length;
        if (hiddenCount > 0) {
            console.log(`[DASHBOARD] Auto-limpieza: ${hiddenCount} albaranes impresos/entregados de días anteriores ocultados.`);
        }
    }

    // Optimización: Limpiar contenedor antes de renderizar
    list.innerHTML = '';

    if (filtered.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.8rem;">No hay albaranes para esta fecha.</div>';
        return;
    }

    // Paginamos el renderizado para no bloquear el hilo principal en móviles
    const toRender = filtered.slice(0, 50);
    toRender.forEach(t => renderTicketItem(t, list));

    if (filtered.length > 50) {
        const moreBtn = document.createElement('button');
        moreBtn.className = "btn btn-xs btn-outline";
        moreBtn.style = "width:100%; margin-top:10px; font-size:0.6rem;";
        moreBtn.textContent = `VER ${filtered.length - 50} MÁS...`;
        moreBtn.onclick = () => {
            moreBtn.remove();
            filtered.slice(50, 200).forEach(t => renderTicketItem(t, list));
        };
        list.appendChild(moreBtn);
    }
}

// Mantenemos loadTickets para compatibilidad de eventos pero redirigimos al render
// Mantenemos loadTickets para compatibilidad de eventos pero redirigimos al render
async function loadTickets() {
    if (lastTicketsBatch.length === 0) {
        initTicketListener();
    } else {
        renderTicketsList();
    }
}

// Listeners unificados para evitar renderizados múltiples
const dateFilter = document.getElementById('date-filter');
if (dateFilter) dateFilter.onchange = renderTicketsList;


function renderTicketItem(t, list) {
    const div = document.createElement('div');
    div.className = `ticket-list-item ${t.printed ? 'printed' : ''} ${editingId === t.id ? 'active' : ''}`;

    const d = parseSafeDate(t.createdAt);
    const dateStr = d.toLocaleDateString();
    const pkgCount = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages || 1);

    const isBilled = !!(t.invoiceId || t.invoiceNum);
    const isDelivered = t.delivered || t.status === 'Entregado';
    const isPendingDelete = !!t.deleteRequested;
    const docIdDisplay = t.id || t.docId || 'S/ID';
    const receiverName = (t.receiver || t.destinatario || "SIN NOMBRE").toUpperCase();

    let badgeClass = 'new';
    let badgeText = 'NUEVO';
    if (isPendingDelete) { badgeClass = 'billed'; badgeText = '🚨 PEND. ANULAR'; }
    else if (isBilled) { badgeClass = 'billed'; badgeText = '🔒 FACTURADO'; }
    else if (t.status === 'Incidencia') { badgeClass = 'billed'; badgeText = '⚠️ INCIDENCIA'; }
    else if (t.status === 'Devuelto') { badgeClass = 'billed'; badgeText = '↩️ DEVUELTO'; }
    else if (isDelivered) { badgeClass = 'delivered'; badgeText = '✅ ENTREGADO'; }
    else if (t.printed) { badgeClass = 'printed'; badgeText = 'IMPRESO'; }

    const sfFont = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', sans-serif";
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
            <strong style="font-family:${sfFont}; color:var(--brand-primary); font-size:0.85rem; letter-spacing:0.5px;">${escapeHtml(docIdDisplay)}</strong>
            <span class="status-badge ${badgeClass}" style="font-size:0.55rem; padding:2px 4px; ${isPendingDelete ? 'background:#FF3B30; color:white; border-radius:4px; font-weight:bold;' : ''}">${badgeText}</span>
        </div>
        <div style="font-family:${sfFont}; font-weight:600; font-size:0.9rem; margin:2px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-main);">${escapeHtml(receiverName)}</div>
        <div style="font-family:${sfFont}; display:flex; justify-content:space-between; font-size:0.7rem; color:var(--text-dim); opacity:0.8;">
            <span>${dateStr}</span>
            <span>📦 ${pkgCount}</span>
        </div>
    `;
    div.onclick = () => {
        loadEditor(t);
        // Cerrar sidebar en movil tras seleccionar
        document.querySelector('.ticket-sidebar').classList.remove('mobile-active');
    };
    list.appendChild(div);
}

// --- POD NOTIFICATIONS LOGIC ---
let notificationsListener = null;
let _prevUnreadCount = -1; // Track previous unread count for alert detection

// Notification alert sound (short beep using Web Audio API)
function _playNotifSound() {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
        setTimeout(function() { ctx.close(); }, 600);
    } catch(e) {}
}

// Pulse animation on notification bell
function _pulseNotifBell() {
    var btn = document.getElementById('nav-notifications');
    if (!btn) return;
    btn.style.transition = 'none';
    btn.style.animation = 'none';
    // Inject keyframes if not already present
    if (!document.getElementById('notif-pulse-style')) {
        var style = document.createElement('style');
        style.id = 'notif-pulse-style';
        style.textContent =
            '@keyframes notifPulse { 0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,59,48,0.7); } ' +
            '40% { transform: scale(1.12); box-shadow: 0 0 0 10px rgba(255,59,48,0); } ' +
            '100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,59,48,0); } }';
        document.head.appendChild(style);
    }
    // Force reflow to restart animation
    void btn.offsetWidth;
    btn.style.animation = 'notifPulse 0.6s ease-out 3';
    setTimeout(function() { btn.style.animation = ''; }, 2000);
}

window.initUserNotifications = function(uid) {
    if (notificationsListener) notificationsListener(); // Limpiar previo
    _prevUnreadCount = -1; // Reset on init

    const badge = document.getElementById('notification-badge');
    const list = document.getElementById('notification-list');
    const markBtn = document.getElementById('btn-mark-all-read');
    const statsEl = document.getElementById('notifications-inbox-stats');

    if (!badge || !list) return;

    notificationsListener = db.collection('user_notifications')
        .where('uid', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .onSnapshot(snap => {
            let unreadCount = 0;
            let totalCount = 0;
            list.innerHTML = '';

            if (snap.empty) {
                list.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-dim); font-size:0.9rem;"><div style="font-size:2.5rem; margin-bottom:10px; opacity:0.3;">🔔</div>No tienes notificaciones.</div>';
                badge.classList.add('hidden');
                if(markBtn) markBtn.classList.add('hidden');
                if(statsEl) statsEl.innerHTML = '';
                return;
            }

            if(markBtn) markBtn.classList.remove('hidden');

            snap.forEach(docSnap => {
                const data = docSnap.data();
                const docId = docSnap.id;
                totalCount++;
                if (!data.read) unreadCount++;

                const d = data.createdAt ? data.createdAt.toDate() : (data.timestamp ? data.timestamp.toDate() : new Date());
                const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                const dateStr = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

                // Type icons
                let typeIcon = '🔔';
                let typeLabel = 'Notificación';
                let accentColor = '#4CAF50';
                if (data.type === 'ticket_modified') { typeIcon = '✏️'; typeLabel = 'Modificación'; accentColor = '#2196F3'; }
                else if (data.type === 'delivery_confirmed') { typeIcon = '📦'; typeLabel = 'Entrega'; accentColor = '#4CAF50'; }
                else if (data.type === 'POD_AVAILABLE') { typeIcon = '📋'; typeLabel = 'Justificante'; accentColor = '#FF9800'; }
                else if (data.type === 'campaign') { typeIcon = '📢'; typeLabel = 'Comunicación'; accentColor = '#E91E63'; }
                else if (data.type === 'incident') { typeIcon = '⚠️'; typeLabel = 'Incidencia'; accentColor = '#F44336'; }
                else if (data.type === 'incident_resolved') { typeIcon = '✅'; typeLabel = 'Incidencia Resuelta'; accentColor = '#4CAF50'; }

                const item = document.createElement('div');
                item.style.cssText = 'padding:16px 20px; border-radius:10px; border-left:4px solid ' + (data.read ? 'var(--border-glass)' : accentColor) + '; background:rgba(255,255,255,' + (data.read ? '0.02' : '0.05') + '); transition:background 0.2s;';
                item.onmouseover = function() { this.style.background = 'rgba(255,255,255,0.07)'; };
                item.onmouseout = function() { this.style.background = 'rgba(255,255,255,' + (data.read ? '0.02' : '0.05') + ')'; };

                // Build header row with delete button
                var headerHtml =
                    '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">' +
                        '<div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">' +
                            '<span style="font-size:1.2rem;">' + typeIcon + '</span>' +
                            '<span style="font-weight:800; color:var(--text-main); font-size:0.9rem; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(data.title || typeLabel) + '</span>' +
                            (!data.read ? '<span class="notif-nuevo-badge" style="background:' + accentColor + '; color:white; font-size:0.6rem; padding:1px 6px; border-radius:8px; font-weight:bold; flex-shrink:0;">NUEVO</span>' : '') +
                        '</div>' +
                        '<div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">' +
                            '<span style="font-size:0.7rem; color:var(--text-dim); white-space:nowrap;">' + dateStr + ' ' + timeStr + '</span>' +
                            '<button class="notif-delete-btn" data-docid="' + docId + '" style="background:none; border:1px solid rgba(255,59,48,0.4); color:#FF3B30; font-size:0.7rem; padding:2px 6px; border-radius:4px; cursor:pointer; line-height:1; flex-shrink:0;" title="Eliminar">✕</button>' +
                        '</div>' +
                    '</div>';

                // Build body
                var bodyHtml = '<div style="font-size:0.85rem; color:var(--text-dim); line-height:1.5; padding-left:28px;">' + escapeHtml(data.body || data.message || '') + '</div>';

                // Photo thumbnail (clickable) — or placeholder for async load from ticket
                var photoHtml = '';
                var photoUrl = data.photoURL || '';
                if (photoUrl) {
                    photoHtml = '<div style="padding-left:28px; margin-top:8px;"><img class="notif-photo" data-url="' + escapeHtml(photoUrl) + '" src="' + escapeHtml(photoUrl) + '" alt="Foto" style="max-width:200px; max-height:150px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); cursor:pointer;"></div>';
                } else if (data.type === 'incident' && data.docId) {
                    // Fallback: load photo from ticket for old notifications
                    photoHtml = '<div class="notif-photo-placeholder" data-ticketdocid="' + escapeHtml(data.docId) + '" style="padding-left:28px; margin-top:8px;"></div>';
                }

                // Ticket reference link + mark as read button
                var footerHtml = '<div style="padding-left:28px; margin-top:6px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">';
                if (data.ticketId || data.docId) {
                    var linkDocId = data.docId || data.ticketId || '';
                    var linkLabel = data.ticketId || data.docId || '';
                    footerHtml += '<button class="notif-goto-ticket" data-ticketdocid="' + escapeHtml(linkDocId) + '" data-ticketid="' + escapeHtml(linkLabel) + '" style="background:rgba(33,150,243,0.15); border:1px solid rgba(33,150,243,0.4); color:#2196F3; font-size:0.72rem; padding:3px 10px; border-radius:4px; cursor:pointer; font-weight:bold;">📋 Ver Albarán #' + escapeHtml(linkLabel) + '</button>';
                }
                if (!data.read) {
                    footerHtml += '<button class="notif-read-btn" data-docid="' + docId + '" style="background:rgba(76,175,80,0.15); border:1px solid rgba(76,175,80,0.4); color:#4CAF50; font-size:0.68rem; padding:2px 8px; border-radius:4px; cursor:pointer; font-weight:bold;">Marcar leído</button>';
                }
                footerHtml += '</div>';

                item.innerHTML = headerHtml + bodyHtml + photoHtml + footerHtml;

                // Attach event listeners via delegation (not inline onclick)
                // Photo click — open in new tab
                var photoEl = item.querySelector('.notif-photo');
                if (photoEl) {
                    photoEl.addEventListener('click', function(e) {
                        e.stopPropagation();
                        window.open(this.dataset.url, '_blank');
                    });
                }

                // Mark as read button
                var readBtn = item.querySelector('.notif-read-btn');
                if (readBtn) {
                    readBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        this.textContent = '...';
                        this.disabled = true;
                        db.collection('user_notifications').doc(this.dataset.docid).update({ read: true }).catch(function(){});
                    });
                }

                // Delete button
                var delBtn = item.querySelector('.notif-delete-btn');
                if (delBtn) {
                    delBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        if (confirm('¿Eliminar esta notificación?')) {
                            item.style.opacity = '0.3';
                            db.collection('user_notifications').doc(this.dataset.docid).delete().catch(function(){});
                        }
                    });
                }

                // "Ver Albarán" button — navigate to ticket in editor
                var gotoBtn = item.querySelector('.notif-goto-ticket');
                if (gotoBtn) {
                    gotoBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        var tdocid = this.dataset.ticketdocid;
                        var tid = this.dataset.ticketid;
                        // Switch to dashboard view (closes notifications view)
                        if (typeof showView === 'function') showView('dashboard-view');
                        // Load ticket into editor from Firestore
                        db.collection('tickets').doc(tdocid).get().then(function(snap) {
                            if (snap.exists) {
                                loadEditor({ ...snap.data(), docId: snap.id });
                            } else {
                                alert('Albarán #' + tid + ' no encontrado.');
                            }
                        }).catch(function() { alert('Error cargando albarán.'); });
                    });
                }

                // Async fallback: load incident photo from ticket if not in notification
                var phPlaceholder = item.querySelector('.notif-photo-placeholder');
                if (phPlaceholder) {
                    (function(el) {
                        var tid = el.dataset.ticketdocid;
                        db.collection('tickets').doc(tid).get().then(function(tSnap) {
                            if (tSnap.exists && tSnap.data().incidentPhotoURL) {
                                var url = tSnap.data().incidentPhotoURL;
                                var img = document.createElement('img');
                                img.className = 'notif-photo';
                                img.dataset.url = url;
                                img.src = url;
                                img.alt = 'Foto';
                                img.style.cssText = 'max-width:200px; max-height:150px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); cursor:pointer;';
                                img.addEventListener('click', function(e) {
                                    e.stopPropagation();
                                    window.open(this.dataset.url, '_blank');
                                });
                                el.appendChild(img);
                            }
                        }).catch(function(){});
                    })(phPlaceholder);
                }

                list.appendChild(item);
            });

            // Update badge
            if (unreadCount > 0) {
                badge.textContent = unreadCount;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }

            // Visual + sound alert when new unread notifications arrive
            if (_prevUnreadCount >= 0 && unreadCount > _prevUnreadCount) {
                _pulseNotifBell();
                _playNotifSound();
            }
            _prevUnreadCount = unreadCount;

            // Update stats
            if (statsEl) {
                statsEl.innerHTML =
                    '<div style="background:rgba(76,175,80,0.1); border:1px solid rgba(76,175,80,0.3); border-radius:8px; padding:8px 16px; text-align:center;">' +
                        '<div style="font-size:1.4rem; font-weight:900; color:#4CAF50;">' + totalCount + '</div>' +
                        '<div style="font-size:0.7rem; color:var(--text-dim);">Total</div>' +
                    '</div>' +
                    '<div style="background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.3); border-radius:8px; padding:8px 16px; text-align:center;">' +
                        '<div style="font-size:1.4rem; font-weight:900; color:#FF9800;">' + unreadCount + '</div>' +
                        '<div style="font-size:0.7rem; color:var(--text-dim);">Sin leer</div>' +
                    '</div>';
            }
        }, err => {
            console.error('[NOTIF] Error en listener de notificaciones:', err);
            if (list) list.innerHTML = '<div style="text-align:center; padding:40px; color:#F44336; font-size:0.85rem;">Error cargando notificaciones. Recarga la página.</div>';
        });

    // Auto-cleanup: delete notifications older than 60 days
    _cleanupOldNotifications(uid);
};

function _cleanupOldNotifications(uid) {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    db.collection('user_notifications')
        .where('uid', '==', uid)
        .where('createdAt', '<', cutoff)
        .get()
        .then(function(snap) {
            if (snap.empty) return;
            var batch = db.batch();
            var count = 0;
            snap.forEach(function(doc) {
                batch.delete(doc.ref);
                count++;
            });
            return batch.commit().then(function() {
                console.log('[NOTIF] Limpieza automática: ' + count + ' notificaciones antiguas eliminadas (>60 días)');
            });
        })
        .catch(function(e) { console.warn('[NOTIF] Error en limpieza automática:', e); });
}

document.addEventListener('DOMContentLoaded', () => {
    // Portes Debidos Toggle
    const shippingTypeSelect = document.getElementById('ticket-shipping-type');
    const boxNif = document.getElementById('box-receiver-nif');
    if(shippingTypeSelect && boxNif) {
        shippingTypeSelect.addEventListener('change', (e) => {
            boxNif.style.display = e.target.value === 'Debidos' ? 'block' : 'none';
        });
    }

    // Notification badge click → open inbox view
    const navNotifDom = document.getElementById('nav-notifications');
    // (navigation handler is set up separately after showView definition)

    // Marcar todo como leído
    const markAllBtn = document.getElementById('btn-mark-all-read');
    if (markAllBtn) {
        markAllBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!currentUser) return;
            try {
                const snap = await db.collection('user_notifications')
                    .where('uid', '==', currentUser.uid)
                    .where('read', '==', false).get();
                
                const batch = db.batch();
                snap.forEach(doc => batch.update(doc.ref, { read: true }));
                await batch.commit();
            } catch(err) { console.error("Error marcando notificaciones:", err); }
        };
    }
});

// --- TICKET EDITOR ---
const btnAddPackage = document.getElementById('btn-add-package');
if (btnAddPackage) btnAddPackage.onclick = () => addPackageRow();

const btnActionNew = document.getElementById('action-new');
if (btnActionNew) btnActionNew.onclick = () => resetEditor();

const createTicketForm = document.getElementById('create-ticket-form');
if (createTicketForm) createTicketForm.onsubmit = handleFormSubmit;

const btnCancelTicket = document.getElementById('btn-cancel-ticket');
if (btnCancelTicket) btnCancelTicket.onclick = () => resetEditor();

async function loadEditor(t) {
    editingId = t.docId || t.id;
    // Bloqueado si está facturado o si el cliente pidió borrarlo
    const isBilled = !!(t.invoiceId || t.invoiceNum);
    const isPendingDelete = !!t.deleteRequested;
    const isLocked = isBilled || isPendingDelete;

    // Base UI State
    document.getElementById('editor-title').textContent = "Visualizando Albarán";
    document.getElementById('editor-status').textContent = `ID: ${t.id}`;
    document.getElementById('action-delete').style.display = 'inline-block';

    const submitBtn = document.querySelector('#create-ticket-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = 'block';

    const form = document.getElementById('create-ticket-form');
    let inputs = form.querySelectorAll('input, select, textarea');
    inputs.forEach(inp => inp.disabled = false);

    const addPkgBtn = document.getElementById('btn-add-package');
    if (addPkgBtn) addPkgBtn.style.display = 'inline-block';

    document.getElementById('editor-actions').classList.remove('hidden');

    // Form data
    document.getElementById('ticket-sender').value = t.sender || '';
    document.getElementById('ticket-sender-address').value = t.senderAddress || '';
    document.getElementById('ticket-sender-phone').value = t.senderPhone || '';
    document.getElementById('ticket-receiver').value = t.receiver || '';
    document.getElementById('ticket-address').value = t.street || t.address || '';
    document.getElementById('ticket-number').value = t.number || '';
    document.getElementById('ticket-phone').value = t.phone || '';
    document.getElementById('ticket-province').value = t.province || '';
    document.getElementById('ticket-shipping-type').value = t.shippingType || 'Pagados';
    document.getElementById('ticket-cod').value = t.cod || '';
    document.getElementById('ticket-notes').value = t.notes || '';
    document.getElementById('ticket-time-slot').value = t.timeSlot || 'MAÑANA';

    // Packages
    const list = document.getElementById('packages-list');
    list.innerHTML = '';
    if (t.packagesList && t.packagesList.length > 0) {
        for (const p of t.packagesList) await addPackageRow(p);
    } else {
        await addPackageRow();
    }

    // Actions
    document.getElementById('action-print').onclick = () => printTicket(t);
    document.getElementById('action-label').onclick = () => printLabel(t);
    document.getElementById('action-delete').onclick = () => {
        if (isLocked) {
            alert("Este albarán está bloqueado y no puede eliminarse ni volver a solicitar su eliminación.");
            return;
        }
        deleteTicket(t.docId || t.id);
    };
    
    

    // Hide legacy pending-confirmation alert if present
    const alertBox = document.getElementById('pending-confirmation-alert');
    if (alertBox) alertBox.classList.add('hidden');

    // Show modification notice (read-only info) if admin modified this ticket
    if (t.lastModifiedBy === 'admin' && t.lastModifiedNote) {
        document.getElementById('editor-title').innerHTML = `<span style="color:#2196F3; font-weight:900;">ℹ️ ALBARÁN MODIFICADO POR CENTRAL</span>`;
        document.getElementById('editor-status').innerHTML = `ID: ${escapeHtml(t.id)} | <span style="background:#2196F3; color:white; padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.75rem;">MODIFICADO</span>`;
    }

    // Show incident info banner (informative, read-only)
    let incidentBanner = document.getElementById('incident-info-banner');
    if (!incidentBanner) {
        incidentBanner = document.createElement('div');
        incidentBanner.id = 'incident-info-banner';
        // Insert before the pending-confirmation-alert (after the editor header flex row)
        const anchor = document.getElementById('pending-confirmation-alert');
        if (anchor) anchor.parentNode.insertBefore(incidentBanner, anchor);
        else document.getElementById('editor-title').parentNode.parentNode.appendChild(incidentBanner);
    }
    if (t.incidentReason || t.status === 'Incidencia' || t.status === 'Devuelto') {
        const incColor = t.status === 'Devuelto' ? '#9C27B0' : '#F44336';
        const incIcon = t.status === 'Devuelto' ? '↩️' : '⚠️';
        const incLabel = t.status === 'Devuelto' ? 'DEVUELTO' : 'INCIDENCIA';
        let reportInfo = '';
        if (t.incidentReportedBy) {
            let dateInfo = '';
            if (t.incidentReportedAt) {
                const rd = t.incidentReportedAt.toDate ? t.incidentReportedAt.toDate() : new Date(t.incidentReportedAt);
                dateInfo = ' — ' + rd.toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric' }) + ' ' + rd.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            }
            reportInfo = '<div style="font-size:0.72rem; color:' + incColor + '; margin-top:6px; opacity:0.8;">Reportado por: ' + escapeHtml(t.incidentReportedBy) + dateInfo + '</div>';
        }
        let photoHtml = '';
        if (t.incidentPhotoURL) {
            photoHtml = '<div style="margin-top:8px;"><img src="' + escapeHtml(t.incidentPhotoURL) + '" style="max-width:100%; max-height:200px; border-radius:6px; border:1px solid ' + incColor + '; cursor:pointer;" id="incident-banner-photo"></div>';
        }
        incidentBanner.innerHTML =
            '<div style="background:rgba(' + (t.status === 'Devuelto' ? '156,39,176' : '244,67,54') + ',0.1); border:1px solid ' + incColor + '; border-radius:8px; padding:12px 16px; margin:10px 0;">' +
                '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">' +
                    '<span style="font-size:1.1rem;">' + incIcon + '</span>' +
                    '<span style="color:' + incColor + '; font-weight:900; font-size:0.85rem;">' + incLabel + '</span>' +
                '</div>' +
                '<div style="color:#ddd; font-size:0.85rem; line-height:1.5;">' + escapeHtml(t.incidentReason || 'Sin detalle') + '</div>' +
                reportInfo +
                photoHtml +
            '</div>';
        incidentBanner.style.display = 'block';
        // Photo click handler
        setTimeout(function() {
            var ph = document.getElementById('incident-banner-photo');
            if (ph) ph.addEventListener('click', function() { window.open(this.src, '_blank'); });
        }, 50);
    } else {
        incidentBanner.innerHTML = '';
        incidentBanner.style.display = 'none';
    }

    // GPS TRACKING BANNER — Show "Track my shipment" when driver is assigned and not delivered
    _renderTrackingBanner(t);

    // Final lock state if billed or pending delete
    if (isLocked) {
        if (isPendingDelete) {
            document.getElementById('editor-title').innerHTML = `<span style="color:#FF3B30; font-weight:900;">🚨 ANULACIÓN SOLICITADA</span>`;
            document.getElementById('editor-status').innerHTML = `ID: ${escapeHtml(t.id)} | <span style="background:#FF3B30; color:white; padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.75rem;">ESPERANDO APROBACIÓN</span>`;
        } else {
            document.getElementById('editor-title').innerHTML = `<span style="color:#FF3B30; font-weight:900;">🔒 ALBARÁN FACTURADO (SÓLO LECTURA)</span>`;
            document.getElementById('editor-status').innerHTML = `ID: ${escapeHtml(t.id)} | <span style="background:#FF3B30; color:white; padding:2px 6px; border-radius:4px; font-weight:bold;">FACTURA: ${escapeHtml(t.invoiceNum || 'ASIGNADA')}</span>`;
        }

        // Bloqueo físico mediante CSS (Inapelable)
        form.style.pointerEvents = 'none';
        form.style.opacity = '0.7';
        form.style.filter = 'grayscale(0.5)';

        document.getElementById('action-delete').style.display = 'none';
        if (submitBtn) submitBtn.style.display = 'none';
        if (addPkgBtn) addPkgBtn.style.display = 'none';

        // Desactivar todos los inputs por si acaso el CSS no basta
        const allInputs = form.querySelectorAll('input, select, textarea');
        allInputs.forEach(inp => {
            inp.disabled = true;
            inp.style.backgroundColor = 'rgba(0,0,0,0.05)';
        });

        // Hide all remove buttons in rows
        const removeButtons = document.querySelectorAll('.btn-remove-pkg');
        removeButtons.forEach(btn => btn.style.display = 'none');
    } else {
        // Restaurar estado si no está facturado
        form.style.pointerEvents = 'auto';
        form.style.opacity = '1';
        form.style.filter = 'none';
    }

    // UI Refresh
    renderTicketsList();
    setTimeout(() => window.scrollTo(0, 0), 100);
}

async function resetEditor() {
    editingId = null;
    const form = document.getElementById('create-ticket-form');

    // 1. Limpieza total de campos
    const inputs = form.querySelectorAll('input, select, textarea');
    inputs.forEach(inp => {
        inp.disabled = false;
        inp.style.backgroundColor = '';
        const isPersistent = inp.id.includes('ticket-sender') || inp.id === 'date-filter';
        if (!isPersistent) inp.value = '';
    });

    // Explicitly clear destination fields for safety
    const destFields = ['ticket-receiver', 'ticket-address', 'ticket-number', 'ticket-localidad', 'ticket-cp', 'ticket-phone', 'ticket-notes'];
    destFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    document.getElementById('editor-title').textContent = "Nuevo Albarán";
    
    document.getElementById('action-delete').style.display = 'none';
    document.getElementById('editor-actions').classList.add('hidden');

    form.style.pointerEvents = 'auto';
    form.style.opacity = '1';
    form.style.filter = 'none';

    // 2. Resetear estructura de bultos
    document.getElementById('packages-list').innerHTML = '';
    document.getElementById('display-total-packages').textContent = '0';
    document.getElementById('ticket-packages-count').value = '0';
    document.getElementById('ticket-weight-total').value = '0.00';

    // 3. Metadatos y ID
    showLoading();
    const nextId = await getNextId();
    document.getElementById('editor-status').innerHTML = `ALBARÁN NÚMERO: <strong style="color:var(--brand-primary);">${escapeHtml(String(nextId))}</strong>`;

    if (!document.getElementById('date-filter').value) {
        document.getElementById('date-filter').value = getTodayLocal();
    }

    // 4. Forzar datos del Remitente desde Perfil de Empresa (o Maestro)
    const currentComp = companies.find(c => c.id === currentCompanyId);
    if (currentComp) {
        document.getElementById('ticket-sender').value = currentComp.name || (userData ? userData.name : '');
        document.getElementById('ticket-sender-address').value = currentComp.address || (userData ? userData.senderAddress : '');
        document.getElementById('ticket-sender-phone').value = currentComp.phone || (userData ? userData.senderPhone : '');
    } else if (userData) {
        document.getElementById('ticket-sender').value = userData.name || '';
        document.getElementById('ticket-sender-address').value = userData.senderAddress || '';
        document.getElementById('ticket-sender-phone').value = userData.senderPhone || '';
    }

    // 5. Turno automático y Portes por defecto
    const hour = new Date().getHours();
    document.getElementById('ticket-time-slot').value = (hour >= 8 && hour < 15) ? 'MAÑANA' : 'TARDE';
    document.getElementById('ticket-shipping-type').value = 'Pagados';

    // 6. NO añadimos fila inicial por defecto (Solicitado por el usuario para vacío total)
    // El usuario deberá pulsar "+" para añadir artículos.

    // NO llamamos a loadTickets() aquí para evitar bucles durante el inicio,
    // ya que el initTicketListener ya se encarga del renderizado inicial.
    renderTicketsList();
    hideLoading();
    setTimeout(() => window.scrollTo(0, 0), 100);
}

async function getNextId() {
    const comp = companies.find(c => c.id === currentCompanyId);
    if (!comp) return "NP-" + String(new Date().getFullYear()).slice(-2) + "-0";
    const prefix = comp.prefix || "NP";
    const currentYY = String(new Date().getFullYear()).slice(-2);
    const yearPrefix = prefix + "-" + currentYY + "-";

    const myIdNum = userData && userData.idNum ? userData.idNum.toString() : (currentUser ? currentUser.uid : null);
    if (!myIdNum) return yearPrefix + "0";

    const cid = currentCompanyId;
    const counterDocId = cid + "_" + myIdNum + "_" + currentYY;
    const counterRef = db.collection('ticket_counters').doc(counterDocId);

    try {
        // ATOMIC TRANSACTION: guarantees unique sequential numbers across all sessions/devices
        const nextNum = await db.runTransaction(async (transaction) => {
            const counterDoc = await transaction.get(counterRef);

            if (counterDoc.exists) {
                // Counter exists: increment atomically
                const currentMax = counterDoc.data().currentMax || 0;
                const newMax = currentMax + 1;
                transaction.update(counterRef, {
                    currentMax: newMax,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                return newMax;
            } else {
                // First time: scan existing tickets to find real max, then create counter
                const identityIds = [currentUser.uid, userData.email, userData.id, userData.authUid].filter(x => x);
                const idVariants = [...new Set([myIdNum, myIdNum.padStart(3, '0'), parseInt(myIdNum).toString(), ...identityIds])].filter(v => v).map(v => String(v).trim()).slice(0, 10);

                const extractMaxNum = (snap, currentMax) => {
                    let m = currentMax;
                    snap.forEach(doc => {
                        const d = doc.data();
                        if (d.compId !== cid) return;
                        const bid = d.id || "";
                        if (bid.startsWith(yearPrefix)) {
                            const seq = parseInt(bid.substring(yearPrefix.length), 10);
                            if (!isNaN(seq) && seq > m) m = seq;
                        }
                    });
                    return m;
                };

                let maxNum = -1;
                // Note: queries inside transactions are read-only and consistent
                const serverSnap1 = await db.collection('tickets')
                    .where('uid', 'in', idVariants)
                    .limit(5000)
                    .get();
                maxNum = extractMaxNum(serverSnap1, maxNum);

                const serverSnap2 = await db.collection('tickets')
                    .where('clientIdNum', 'in', idVariants)
                    .limit(5000)
                    .get();
                maxNum = extractMaxNum(serverSnap2, maxNum);

                const newMax = maxNum + 1;
                transaction.set(counterRef, {
                    compId: cid,
                    clientIdNum: myIdNum,
                    year: currentYY,
                    prefix: prefix,
                    currentMax: newMax,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                return newMax;
            }
        });

        console.log('[SYNC] getNextId atomic counter:', counterDocId, '→', nextNum);
        return yearPrefix + nextNum;

    } catch (e) {
        console.warn("Atomic counter failed, using scan fallback:", e);
        // Fallback: scan tickets (less safe but functional)
        try {
            const identityIds = [currentUser.uid, userData.email, userData.id, userData.authUid].filter(x => x);
            const idVariants = [...new Set([myIdNum, myIdNum.padStart(3, '0'), parseInt(myIdNum).toString(), ...identityIds])].filter(v => v).map(v => String(v).trim()).slice(0, 10);

            let maxNum = -1;
            const snap1 = await db.collection('tickets').where('uid', 'in', idVariants).limit(5000).get();
            snap1.forEach(doc => {
                const bid = (doc.data().id || "");
                if (bid.startsWith(yearPrefix)) {
                    const seq = parseInt(bid.substring(yearPrefix.length), 10);
                    if (!isNaN(seq) && seq > maxNum) maxNum = seq;
                }
            });
            const snap2 = await db.collection('tickets').where('clientIdNum', 'in', idVariants).limit(5000).get();
            snap2.forEach(doc => {
                const bid = (doc.data().id || "");
                if (bid.startsWith(yearPrefix)) {
                    const seq = parseInt(bid.substring(yearPrefix.length), 10);
                    if (!isNaN(seq) && seq > maxNum) maxNum = seq;
                }
            });
            return yearPrefix + (maxNum + 1);
        } catch (e2) {
            console.warn("All getNextId methods failed, using local fallback:", e2);
            let maxNum = -1;
            lastTicketsBatch.forEach(t => {
                if (t.id && t.id.startsWith(yearPrefix)) {
                    const seq = parseInt(t.id.substring(yearPrefix.length), 10) || 0;
                    if (seq > maxNum) maxNum = seq;
                }
            });
            return yearPrefix + (maxNum + 1);
        }
    }
}

// --- COMPANY MANAGEMENT LOGIC ---
function renderCompanyList() {
    const container = document.getElementById('company-list-container');
    if (!container) return;
    container.innerHTML = '';

    companies.forEach(c => {
        const item = document.createElement('div');
        item.style = "display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px 15px; border-radius:10px; border:1px solid var(--border-glass);";
        item.innerHTML = `
            <div>
                <div style="font-weight:bold; font-size:0.9rem;">${escapeHtml(c.name)}</div>
                <div style="font-size:0.7rem; color:var(--text-dim);">${escapeHtml(c.prefix || 'NP')} | ${escapeHtml(c.address)}</div>
            </div>
            <div style="display:flex; gap:8px;">
                <button class="btn btn-xs btn-outline" onclick="editCompanyUI('${escapeHtml(c.id)}')">✏️</button>
                <button class="btn btn-xs btn-danger" onclick="deleteCompanyCloud('${escapeHtml(c.id)}')">🗑️</button>
            </div>
        `;
        container.appendChild(item);
    });
}

window.editCompanyUI = (id) => {
    const c = companies.find(x => x.id === id);
    if (!c) return;

    document.getElementById('comp-edit-id').value = c.id;
    document.getElementById('comp-name').value = c.name;
    document.getElementById('comp-nif').value = c.nif || '';
    const ibanEl = document.getElementById('comp-iban');
    if(ibanEl) ibanEl.value = c.iban || '';
    if(c.iban && window.getBankName) document.getElementById('comp-bank-name').textContent = window.getBankName(c.iban);
    else if(document.getElementById('comp-bank-name')) document.getElementById('comp-bank-name').textContent = '';
    document.getElementById('comp-id-num').value = c.idNum || '';
    document.getElementById('comp-street').value = c.street || '';
    document.getElementById('comp-number').value = c.number || '';
    document.getElementById('comp-city').value = c.localidad || '';
    document.getElementById('comp-cp').value = c.cp || '';
    document.getElementById('comp-phone').value = c.phone || '';
    document.getElementById('comp-prefix').value = c.prefix || 'NP';
    document.getElementById('comp-start-num').value = c.startNum || 1;
    document.getElementById('comp-province').value = c.province || '';
    
    

    document.getElementById('company-form-title').textContent = "EDITAR EMPRESA";
    document.getElementById('btn-cancel-comp-edit').classList.remove('hidden');
};

function resetCompanyForm() {
    const container = document.getElementById('company-form');
    if (container) {
        const inputs = container.querySelectorAll('input, select');
        inputs.forEach(inp => {
            if (inp.id === 'comp-prefix') inp.value = 'NP';
            else if (inp.id === 'comp-start-num') inp.value = '1';
            else inp.value = '';
        });
    }
    
    document.getElementById('comp-edit-id').value = '';
    document.getElementById('comp-id-num').value = '';
    if(document.getElementById('comp-nif')) document.getElementById('comp-nif').value = '';
    if(document.getElementById('comp-iban')) document.getElementById('comp-iban').value = '';
    if(document.getElementById('comp-bank-name')) document.getElementById('comp-bank-name').textContent = '';
    document.getElementById('company-form-title').textContent = "AÑADIR NUEVA EMPRESA";
    document.getElementById('btn-cancel-comp-edit').classList.add('hidden');
}
async function handleCompanyFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('comp-edit-id').value;

    const street = document.getElementById('comp-street').value.trim();
    const num = document.getElementById('comp-number').value.trim();
    const city = document.getElementById('comp-city').value.trim();
    const cp = document.getElementById('comp-cp').value.trim();

    // Componer dirección para el informe / albarán
    const parts = [];
    if (street) parts.push(street);
    if (num) parts.push("Nº " + num);
    if (city) parts.push(city);
    if (cp) parts.push(`(CP ${cp})`);
    const fullAddr = parts.join(', ');

    const selectedProvince = document.getElementById('comp-province').value.trim();
    if (!selectedProvince || selectedProvince === 'create_new') {
        alert("Por favor, selecciona una Provincia válida o crea una nueva pulsando en la opción '+ CREAR NUEVA...'");
        return;
    }

    const data = {
        name: document.getElementById('comp-name').value.trim(),
        idNum: parseInt(document.getElementById('comp-id-num').value) || null,
        nif: document.getElementById('comp-nif') ? document.getElementById('comp-nif').value.trim().toUpperCase() : '',
        iban: document.getElementById('comp-iban') ? document.getElementById('comp-iban').value.trim().toUpperCase() : '',
        address: fullAddr,
        street: street,
        number: num,
        localidad: city,
        cp: cp,
        phone: document.getElementById('comp-phone').value.trim(),
        province: selectedProvince,
        prefix: (document.getElementById('comp-prefix').value.trim() || 'NP').toUpperCase(),
        startNum: parseInt(document.getElementById('comp-start-num').value) || 1,
        
        
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    showLoading();
    try {
        const targetUid = effectiveStorageUid || currentUser.uid;
        const col = db.collection('users').doc(targetUid).collection('companies');
        if (id) {
            await col.doc(id).update(data);
        } else {
            console.log("Intentando grabar nueva sede en Firestore...", data);
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            try {
                const newDoc = await col.add(data);
                console.log("Grabación Offline Confirmada. Verificando servidor...");
                // FORCE SERVER CHECK bypassed to avoid infinite offline deadlock drops
                // await newDoc.get({ source: 'server' });
                // Switch to the new company automatically
                currentCompanyId = newDoc.id;
                localStorage.setItem('last_company_id', currentCompanyId);
            } catch (addErr) {
                console.error("Fallo crítico en Firestore al añadir empresa:", addErr);
                alert("Firebase bloqueó el guardado permanentemente: " + addErr.message);
                throw addErr; // Abort local UI update
            }
        }
        await loadCompanies();
        resetCompanyForm();
        // Force refresh editor to use the new company as sender
        await resetEditor();

        // CERRAR MODAL AUTOMÁTICAMENTE
        document.getElementById('company-modal').classList.add('hidden');

        console.log("Empresa guardada con éxito.");
        // Opcional: Notificación menos intrusiva si se prefiere, pero alert está bien.
    } catch (err) {
        console.error("Error general guardando empresa:", err);
        alert("Error: " + err.message);
    } finally {
        hideLoading();
    }
}

window.deleteCompanyCloud = async (id) => {
    if (companies.length <= 1) {
        alert("No puedes eliminar la única empresa.");
        return;
    }
    const c = companies.find(x => x.id === id);
    if (!confirm(`¿Eliminar la empresa "${c.name}" y TODOS sus datos asociados?`)) return;

    showLoading();
    try {
        const targetUid = currentUser.uid;
        await db.collection('users').doc(targetUid).collection('companies').doc(id).delete();
        if (currentCompanyId === id) {
            const next = companies.find(x => x.id !== id);
            currentCompanyId = next.id;
            localStorage.setItem('last_company_id', currentCompanyId);
        }
        await loadCompanies();
        await resetEditor();
        alert("Empresa eliminada.");
    } catch (err) {
        alert("Error al eliminar: " + err.message);
    } finally {
        hideLoading();
    }
};

window.getBankName = function(iban) {
    const clean = (iban || '').replace(/[\s-]/g, '').toUpperCase();
    if (clean.length >= 8 && clean.startsWith('ES')) {
        const c = clean.substring(4, 8);
        const b = {'0182':'BBVA','0049':'SANTANDER','0030':'SANTANDER','2100':'CAIXABANK','0081':'SABADELL','2038':'CAIXABANK (BANKIA)','0128':'BANKINTER','0138':'BANKOA','0239':'EVO BANCO','3025':'CAJA INGENIEROS','3190':'IBERCAJA','0073':'OPENBANK','0149':'MYINVESTOR','1465':'ING DIRECT','0237':'CAJASUR','2085':'IBERCAJA','3058':'CAJAMAR','0019':'BANESTO','2095':'KUTXABANK','2048':'KUTXABANK'};
        return b[c] || 'ENTIDAD: ' + c;
    }
    return '';
};

document.addEventListener('DOMContentLoaded', () => {
    const ibEl = document.getElementById('comp-iban');
    if(ibEl) {
        ibEl.addEventListener('input', (e) => {
            let val = e.target.value.toUpperCase().replace(/[^\dA-Z]/g, '');
            e.target.value = val.match(/.{1,4}/g)?.join(' ') || '';
            document.getElementById('comp-bank-name').textContent = window.getBankName(val);
        });
    }
});

// --- PACKAGE MANAGEMENT ---
async function addPackageRow(data = null) {
    const list = document.getElementById('packages-list');
    const row = document.createElement('div');
    row.className = 'package-row';
    row.style = "display: flex; gap: 8px; margin-bottom: 8px; align-items: flex-end; padding: 6px 8px; background: rgba(255,255,255,0.01); border-radius: 4px; border: 1px solid rgba(255,255,255,0.03);";

    // Generate options: Prioritize active tariff articles if they exist
    let optionsHtml = '<option value="" disabled selected>-- Seleccionar Artículo --</option>';
    let availableSet = new Set();
    
    if (activeTariffArticles.length > 0) {
        activeTariffArticles.forEach(s => availableSet.add(s.trim()));
    } else {
        const customSizes = await getCustomData('custom_sizes') || [];
        DEFAULT_SIZES.split(',').forEach(s => availableSet.add(s.trim()));
        customSizes.forEach(s => availableSet.add(s.trim()));
    }
    
    if (data && data.size && !availableSet.has(data.size.trim())) {
        availableSet.add(data.size.trim());
    }

    // GEOGRAPHIC FILTER: Ensure user can only select origin packages matching their province
    const normalize = str => {
        if (!str) return "";
        return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    };
    
    // Attempt to identify user province (needs window.userData or userData in scope)
    const userProvStr = (typeof userData !== 'undefined' && userData && userData.province) ? normalize(userData.province) : "";

    const geoFilter = (s) => {
        if (!userProvStr || userProvStr === "todas" || userProvStr === "") return true; // No profile mapping, allow all
        if (s === "create_new_size") return true; 

        const t = normalize(s);
        const provinces = ["alava", "albacete", "alicante", "almeria", "asturias", "avila", "badajoz", "barcelona", "burgos", "caceres", "cadiz", "cantabria", "castellon", "ciudad real", "cordoba", "cuenca", "girona", "gerona", "granada", "guadalajara", "guipuzcoa", "huelva", "huesca", "islas baleares", "baleares", "jaen", "a coruna", "la coruna", "la rioja", "las palmas", "leon", "lleida", "lerida", "lugo", "madrid", "malaga", "murcia", "navarra", "ourense", "orense", "palencia", "pontevedra", "salamanca", "segovia", "sevilla", "soria", "tarragona", "tenerife", "teruel", "toledo", "valencia", "valladolid", "vizcaya", "bizkaia", "zamora", "zaragoza", "ceuta", "melilla"];
        
        let found = [];
        provinces.forEach(p => {
            let regex = new RegExp(`\\b${p}\\b`, 'g');
            let match;
            while ((match = regex.exec(t)) !== null) {
                found.push({ name: p, index: match.index });
            }
        });
        found.sort((a,b) => a.index - b.index);

        if (found.length > 0) {
            // Re-map common alternate names to standardize for comparison
            let originProv = found[0].name;
            if (originProv === 'gerona') originProv = 'girona';
            if (originProv === 'lerida') originProv = 'lleida';
            if (originProv === 'orense') originProv = 'ourense';
            if (originProv === 'la coruna') originProv = 'a coruna';
            if (originProv === 'baleares') originProv = 'islas baleares';
            if (originProv === 'bizkaia') originProv = 'vizcaya';

            // Check if origin matches user's province
            if (originProv === userProvStr || userProvStr.includes(originProv) || originProv.includes(userProvStr)) {
                return true; // Match!
            }
            return false; // Origin explicit but DOES NOT MATCH user province, hide it.
        }
        return true; // Generic item with no province in name (e.g. Nacional, Caja grande)
    };

    availableSet.forEach(s => {
        if (geoFilter(s)) {
            optionsHtml += `<option value="${s}">${s}</option>`;
        }
    });

    optionsHtml += `<option value="create_new_size" style="color:var(--brand-primary); font-weight:bold;">+ CREAR NUEVO...</option>`;

    row.innerHTML = `
        <div style="width: 60px;">
            <label style="font-size:0.6rem; color:var(--text-dim); font-weight:600;">CANT.</label>
            <input type="number" class="pkg-qty form-control" value="" placeholder="1" min="1" style="text-align:center; padding:4px;">
        </div>
        <div style="width: 70px;">
            <label style="font-size:0.6rem; color:var(--text-dim); font-weight:600;">PESO</label>
            <input type="number" class="pkg-weight form-control" value="5" step="0.1" placeholder="5.0" style="text-align:center; padding:4px;">
        </div>
        <div style="flex:1;">
            <label style="font-size:0.65rem; color:var(--text-dim);">TAMAÑO / TIPO</label>
            <select class="pkg-size form-control">${optionsHtml}</select>
        </div>
        <button type="button" class="btn-remove-pkg" style="background:none; border:none; color:#FF3B30; font-size:1.5rem; cursor:pointer; padding-bottom:5px;">&times;</button>
    `;

    list.appendChild(row);

    const qtyIn = row.querySelector('.pkg-qty');
    const weightIn = row.querySelector('.pkg-weight');
    const sizeSel = row.querySelector('.pkg-size');
    const removeBtn = row.querySelector('.btn-remove-pkg');

    if (qtyIn) qtyIn.oninput = updateContext;
    if (weightIn) weightIn.oninput = updateContext;
    if (removeBtn) removeBtn.onclick = () => { row.remove(); updateContext(); };

    // Create new size logic
    sizeSel.onchange = async () => {
        if (sizeSel.value === 'create_new_size') {
            const newSize = prompt("Nombre del nuevo tamaño/tipo:");
            if (newSize && newSize.trim()) {
                const current = await getCustomData('custom_sizes') || [];
                current.push(newSize.trim());
                await saveCustomData('custom_sizes', [...new Set(current)]);

                // Add to all selects in UI
                document.querySelectorAll('.pkg-size').forEach(sel => {
                    const opt = document.createElement('option');
                    opt.value = newSize.trim();
                    opt.textContent = newSize.trim();
                    sel.add(opt, sel.options[sel.options.length - 1]);
                });
                sizeSel.value = newSize.trim();
            } else {
                sizeSel.value = "Mediano";
            }
        }

        // Auto-weight logic
        const val = sizeSel.value;
        const weights = { 'BATERIA 45AH': 15, 'BATERIA 75AH': 25, 'BATERIA 100AH': 45, 'BATERIA CAMION': 60, 'TAMBOR CAMION': 50, 'GARRAFAS ADBLUE': 10 };
        if (weights[val]) {
            weightIn.value = weights[val];
        }
        updateContext();
    };

    if (data) {
        qtyIn.value = data.qty || 1;
        weightIn.value = data.weight || 0;
        sizeSel.value = data.size || 'Pequeño';
    }
    updateContext();
}

function updateContext() {
    const rows = document.querySelectorAll('.package-row');
    let totalQty = 0;
    let totalWeight = 0;
    rows.forEach(r => {
        const q = parseInt(r.querySelector('.pkg-qty').value) || 0;
        const w = parseFloat(r.querySelector('.pkg-weight').value) || 0;
        totalQty += q;
        totalWeight += (q * w);
    });
    const displayQty = document.getElementById('display-total-packages');
    if (displayQty) displayQty.textContent = totalQty;

    const inputQty = document.getElementById('ticket-packages-count');
    if (inputQty) inputQty.value = totalQty;

    const inputWeight = document.getElementById('ticket-weight-total');
    if (inputWeight) inputWeight.value = totalWeight.toFixed(2);
}

function getPackagesData() {
    return Array.from(document.querySelectorAll('.package-row')).map(row => ({
        qty: parseInt(row.querySelector('.pkg-qty').value) || 1,
        weight: parseFloat(row.querySelector('.pkg-weight').value) || 0,
        size: row.querySelector('.pkg-size').value
    }));
}

// --- TERMS ACCEPTANCE ---
window.acceptTerms = async function() {
    try {
        if (currentUser && currentUser.uid) {
            await db.collection('users').doc(currentUser.uid).update({
                termsAccepted: true,
                termsAcceptedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            if (userData) userData.termsAccepted = true;
        }
        const modal = document.getElementById('modal-terms');
        if (modal) modal.style.display = 'none';
    } catch (e) {
        console.error('Error accepting terms:', e);
        alert('Error al guardar. Intentalo de nuevo.');
    }
};

// --- DAILY REMINDER (Point 1: Package count/type verification) ---
let _dailyReminderShown = false;
let _dailyReminderCallback = null;

window.dismissDailyReminder = function() {
    const modal = document.getElementById('modal-daily-reminder');
    if (modal) modal.style.display = 'none';
    // Save today's date so it doesn't show again today
    try { localStorage.setItem('novapack_daily_reminder', new Date().toISOString().slice(0, 10)); } catch(e) {}
    _dailyReminderShown = true;
    if (_dailyReminderCallback) {
        _dailyReminderCallback();
        _dailyReminderCallback = null;
    }
};

function checkDailyReminder() {
    if (_dailyReminderShown) return Promise.resolve(true);
    // Check if already shown today
    try {
        const lastShown = localStorage.getItem('novapack_daily_reminder');
        const today = new Date().toISOString().slice(0, 10);
        if (lastShown === today) {
            _dailyReminderShown = true;
            return Promise.resolve(true);
        }
    } catch(e) {}
    // Show the reminder
    return new Promise(function(resolve) {
        const modal = document.getElementById('modal-daily-reminder');
        if (modal) {
            modal.style.display = 'flex';
            _dailyReminderCallback = function() { resolve(true); };
        } else {
            _dailyReminderShown = true;
            resolve(true);
        }
    });
}

// --- FIRST TICKET WARNING ---
let _firstTicketWarningShown = false;
let _firstTicketContinueCallback = null;

window.dismissFirstTicketWarning = function() {
    const modal = document.getElementById('modal-first-ticket-warning');
    if (modal) modal.style.display = 'none';
    if (_firstTicketContinueCallback) {
        _firstTicketContinueCallback();
        _firstTicketContinueCallback = null;
    }
};

async function checkFirstTicketWarning() {
    if (_firstTicketWarningShown) return true;

    // Check if user already has tickets
    try {
        const myId = userData ? (userData.idNum || userData.id) : null;
        if (!myId) return true;

        const snap = await db.collection('tickets')
            .where('clientIdNum', '==', String(myId))
            .limit(1)
            .get();

        if (!snap.empty) {
            _firstTicketWarningShown = true;
            return true; // Has tickets, no warning needed
        }
    } catch (e) {
        console.warn('[FirstTicket] Check error:', e);
        return true; // On error, allow through
    }

    // Show warning and wait for dismissal
    return new Promise(function(resolve) {
        const modal = document.getElementById('modal-first-ticket-warning');
        if (modal) {
            modal.style.display = 'flex';
            _firstTicketContinueCallback = function() {
                _firstTicketWarningShown = true;
                resolve(true);
            };
        } else {
            resolve(true);
        }
    });
}

// --- FORM SUBMIT (SAVE TICKET) ---
let isSubmittingTicket = false;
async function handleFormSubmit(e) {
    e.preventDefault();
    if (isSubmittingTicket) return;
    if (!_rateLimiter.check('ticket_create', 20)) {
        alert('Has creado demasiados albaranes en poco tiempo. Espera un momento.');
        return;
    }

    // Daily reminder (Point 1: verify packages)
    const dailyOk = await checkDailyReminder();
    if (!dailyOk) return;

    // First ticket warning check
    const canProceed = await checkFirstTicketWarning();
    if (!canProceed) return;

    const receiverField = document.getElementById('ticket-receiver').value.trim();
    const addressField = document.getElementById('ticket-address').value.trim();
    const provinceField = document.getElementById('ticket-province').value;
    const timeSlotField = document.getElementById('ticket-time-slot').value;

    const cpField = (document.getElementById('ticket-cp').value || '').trim();
    const nifField = (document.getElementById('ticket-receiver-nif') ? document.getElementById('ticket-receiver-nif').value.trim() : '');

    if (!receiverField) {
        alert("Debe indicar el NOMBRE DEL CLIENTE (Destinatario).");
        return;
    }
    if (!addressField) {
        alert("Debe indicar la DIRECCIÓN de destino.");
        return;
    }
    if (!cpField) {
        alert("Debe indicar el CÓDIGO POSTAL.");
        document.getElementById('ticket-cp').focus();
        return;
    }
    if (!nifField) {
        alert("Debe indicar el NIF / CIF del destinatario.");
        const nifBox = document.getElementById('box-receiver-nif');
        if (nifBox) nifBox.style.display = 'block';
        const nifInput = document.getElementById('ticket-receiver-nif');
        if (nifInput) nifInput.focus();
        return;
    }
    if (!provinceField) {
        alert("Debe seleccionar una PROVINCIA de destino.");
        return;
    }
    if (!timeSlotField) {
        alert("Debe seleccionar un TURNO DE RECOGIDA.");
        return;
    }

    const pkgs = getPackagesData();
    if (pkgs.length === 0) {
        alert("Debe añadir al menos un bulto mercancia pulsando el botón '+'.");
        return;
    }
    if (!pkgs[0].size) {
        alert("Debe seleccionar un artículo para el bulto.");
        return;
    }

    const street = (document.getElementById('ticket-address').value || "").trim();
    const number = (document.getElementById('ticket-number').value || "").trim();
    const locality = (document.getElementById('ticket-localidad').value || "").trim();
    const cp = (document.getElementById('ticket-cp').value || "").trim();

    const addrParts = [];
    if (street) addrParts.push(street);
    if (number) addrParts.push("Nº " + number);
    if (locality) addrParts.push(locality);
    if (cp) addrParts.push(`(CP ${cp})`);

    const fullAddr = addrParts.join(', ');
    // Unified ID identification (must match initTicketListener)
    const myIdNum = userData && userData.idNum ? userData.idNum.toString() : currentUser.uid;

    showLoading();
    isSubmittingTicket = true;

    try {
        let targetDriverPhone = '';
        try {
            const routeProvince = (document.getElementById('ticket-province').value || '').trim();
            const resolved = await resolveDriverPhone(cp, locality, routeProvince);
            targetDriverPhone = resolved.driverPhone;
        } catch(e) { console.error("Auto-routing error:", e); }

        const data = {
            uid: currentUser.uid,
            clientIdNum: myIdNum,
            compId: currentCompanyId,
            sender: document.getElementById('ticket-sender').value,
            senderAddress: document.getElementById('ticket-sender-address').value,
            senderPhone: document.getElementById('ticket-sender-phone').value,
            receiver: document.getElementById('ticket-receiver').value.trim().toUpperCase(),
            receiverNif: document.getElementById('ticket-receiver-nif') ? document.getElementById('ticket-receiver-nif').value.trim() : '',
            street: street,
            number: number,
            localidad: locality,
            cp: cp,
            address: fullAddr,
            phone: document.getElementById('ticket-phone').value,
            province: document.getElementById('ticket-province').value,
            shippingType: document.getElementById('ticket-shipping-type').value,
            cod: document.getElementById('ticket-cod').value,
            notes: document.getElementById('ticket-notes').value,
            timeSlot: document.getElementById('ticket-time-slot').value,
            status: 'Pendiente',
            packagesList: pkgs,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        // resolveDriverPhone already returns the canonical 9-digit form
        if (targetDriverPhone) {
            data.driverPhone = window.normalizePhone(targetDriverPhone);
        }

        if (editingId) {
            const currentDoc = await db.collection('tickets').doc(editingId).get();
            const cData = currentDoc.data();
            if (currentDoc.exists && cData && (cData.invoiceId || cData.invoiceNum)) {
                alert("Albarán bloqueado por facturación.");
                hideLoading();
                return;
            }
            Object.assign(data, getOperatorStamp());
            await db.collection('tickets').doc(editingId).update(data);
        } else {
            const businessId = await getNextId();
            data.id = businessId;
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            data.printed = false;
            Object.assign(data, getOperatorStamp());

            const docId = `${myIdNum}_${currentCompanyId}_${businessId}`;
            await db.collection('tickets').doc(docId).set(data);
            
        }

        if (document.getElementById('save-destination-check').checked) {
            await saveClientToAgenda(data);
        }

        await resetEditor();
    } catch (err) {
        console.error(err);
        alert("Error al guardar: " + err.message);
    } finally {
        isSubmittingTicket = false;
        hideLoading();
    }
}



async function deleteTicket(id) {
    try {
        const doc = await getCollection('tickets').doc(id).get();
        const data = doc.data();
        const isBilled = !!(data.invoiceId || data.invoiceNum);
        if (isBilled) {
            alert("Este albarán no puede eliminarse porque ya ha sido facturado por administración.");
            return;
        }

        const deleteReason = prompt(`Por tu seguridad, la eliminación de albaranes requiere autorización de Administración.\n\nPor favor, indica el motivo para anular el albarán ${id}:`);
        if (deleteReason !== null) {
            if (deleteReason.trim() === '') {
                alert("Debes indicar un motivo para solicitar la anulación.");
                return;
            }
            showLoading();
            await getCollection('tickets').doc(id).update({
                deleteRequested: true,
                deleteReason: deleteReason.trim(),
                status: "Pendiente Anulación",
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            alert("Solicitud de anulación enviada a Administración. El albarán quedará bloqueado hasta su revisión.");
            await resetEditor();
            hideLoading();
        }
    } catch (e) {
        alert("Error al intentar eliminar: " + e.message);
    }
}

// --- CLIENT AGENDA ---
let isSubmittingAgenda = false;

// Generador de Firma de Dirección para evitar duplicados reales
function getAddressSignature(a) {
    const norm = (s) => (s || "").toString().replace(/[^a-z0-9\-_]/gi, '').toLowerCase();
    return norm(a.address) + norm(a.street) + norm(a.number) + norm(a.localidad) + norm(a.cp);
}

async function saveClientToAgenda(t) {
    if (!t.receiver || isSubmittingAgenda) return;
    const agenda = getCollection('destinations');
    
    // SANITIZACIÓN ESTRICTA:
    // 1. Quitar acentos 
    // 2. Convertir múltiples espacios seguidos en un solo espacio 
    // 3. Trim y minúsculas
    let cleanName = (t.receiver || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ').trim().toLowerCase();
    
    // Luego se quitan caracteres raros y se usa "_"
    const docId = cleanName.replace(/[^a-z0-9\-_]/gi, '_');

    const newAddr = {
        id: "addr_" + Date.now().toString(36),
        address: t.address,
        street: (t.street || "").trim(),
        number: (t.number || "").trim(),
        localidad: (t.localidad || "").trim(),
        cp: (t.cp || "").trim(),
        province: t.province || ""
    };

    isSubmittingAgenda = true;
    try {
        const docRef = agenda.doc(docId);
        const doc = await docRef.get();

        if (!doc.exists) {
            await docRef.set({
                name: t.receiver.toUpperCase(),
                phone: (t.phone || "").trim(),
                addresses: [newAddr]
            });
        } else {
            const data = doc.data();
            const sigNew = getAddressSignature(newAddr);
            const exists = (data.addresses || []).some(a => getAddressSignature(a) === sigNew);

            if (!exists) {
                const updatedAddrs = [...(data.addresses || []), newAddr];
                await docRef.update({
                    addresses: updatedAddrs,
                    phone: (t.phone || data.phone || "").trim()
                });
            }
        }
    } finally {
        isSubmittingAgenda = false;
        agendaCache = null; // Invalidar cache tras guardar
    }
}

async function renderClientsList() {
    const list = document.getElementById('clients-view-list');
    const search = document.getElementById('client-view-search').value.toLowerCase();

    list.innerHTML = '<div style="padding:20px; text-align:center;">Cargando clientes...</div>';

    try {
        const snap = await getCollection('destinations').get();

        let clients = [];
        snap.forEach(doc => clients.push({ id: doc.id, ...doc.data() }));
        clients.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

        if (search) {
            clients = clients.filter(c => String(c.name || '').toLowerCase().includes(search));
        }

        list.innerHTML = '';
        if (clients.length === 0) {
            list.innerHTML = '<div style="padding:20px; text-align:center; color:#888;">No hay clientes.</div>';
        }

        clients.forEach(c => {
            const item = document.createElement('div');
            item.style = `padding:10px 15px; border-bottom:1px solid var(--border-glass); cursor:pointer; background:${editingClientId === c.id ? 'var(--surface-active)' : 'transparent'}; transition: background 0.2s; display:flex; align-items:center; gap:15px;`;
            const addrCount = c.addresses ? c.addresses.length : 0;
            const displayName = String(c.name || 'Cliente sin nombre').toUpperCase();
            
            item.innerHTML = `
                <input type="checkbox" class="client-list-check" value="${escapeHtml(c.id)}" onclick="event.stopPropagation(); updateClientDeleteButton();" style="width:20px; height:20px; cursor:pointer;">
                <div style="flex:1;">
                    <div style="font-weight:600; color:var(--text-main); font-size:0.9rem;">${escapeHtml(displayName)}</div>
                    <div style="font-size:0.7rem; color:var(--text-dim); opacity:0.8;">${addrCount} DIRECCIONES</div>
                </div>
            `;
            item.onclick = () => loadClientToEdit(c);
            list.appendChild(item);
        });
        updateClientDeleteButton();
    } catch (e) {
        console.error("Error al renderizar lista de clientes:", e);
        list.innerHTML = '<div style="padding:20px; text-align:center; color:red;">Error al cargar agenda.</div>';
    }
}

window.updateClientDeleteButton = function() {
    const checks = document.querySelectorAll('.client-list-check:checked');
    const btn = document.getElementById('btn-delete-selected-clients');
    if (checks.length > 0) {
        btn.style.display = 'block';
        btn.innerHTML = `🗑️ BORRAR (${checks.length})`;
    } else {
        btn.style.display = 'none';
    }
};

window.deleteSelectedClients = async function() {
    const checks = document.querySelectorAll('.client-list-check:checked');
    if (checks.length === 0) return;
    if (confirm(`¿Estás seguro de ELIMINAR ${checks.length} clientes de tu agenda para siempre?`)) {
        showLoading();
        try {
            const batch = db.batch();
            checks.forEach(c => {
                batch.delete(getCollection('destinations').doc(c.value));
            });
            await batch.commit();
            alert("Clientes eliminados de la agenda.");
            
            const selectAll = document.getElementById('client-select-all');
            if (selectAll) selectAll.checked = false;
            
            agendaCache = null;
            document.getElementById('client-edit-id').value = '';
            document.getElementById('client-edit-name').value = '';
            const btnDel = document.getElementById('btn-client-delete');
            if (btnDel) btnDel.classList.add('hidden');
            
            await renderClientsList();
        } catch (e) {
            console.error(e);
            alert("Error al eliminar clientes: " + e.message);
        } finally {
            hideLoading();
        }
    }
};

const selectAllClientsBtn = document.getElementById('client-select-all');
if (selectAllClientsBtn) {
    selectAllClientsBtn.onchange = function(e) {
        document.querySelectorAll('.client-list-check').forEach(chk => chk.checked = e.target.checked);
        updateClientDeleteButton();
    };
}

const btnDeleteSelectedClients = document.getElementById('btn-delete-selected-clients');
if (btnDeleteSelectedClients) {
    btnDeleteSelectedClients.onclick = deleteSelectedClients;
}

var _clientViewSearchTimer;
document.getElementById('client-view-search').oninput = function() {
    clearTimeout(_clientViewSearchTimer);
    _clientViewSearchTimer = setTimeout(function() { renderClientsList(); }, 500);
};

let isLoadingClientData = false;
async function loadClientToEdit(c) {
    if (isLoadingClientData) return;
    isLoadingClientData = true;

    editingClientId = c.id;
    const btnDel = document.getElementById('btn-client-delete');
    if(btnDel) btnDel.classList.remove('hidden');

    document.getElementById('client-edit-id').value = c.id;
    document.getElementById('client-edit-name').value = c.name;
    document.getElementById('client-edit-phone').value = c.phone || "";
    document.getElementById('client-edit-nif').value = c.nif || "";
    document.getElementById('client-edit-email').value = c.email || "";
    document.getElementById('client-edit-notes').value = c.notes || "";

    const container = document.getElementById('client-edit-addresses-container');
    container.innerHTML = '';

    if (c.addresses && c.addresses.length > 0) {
        c.addresses.forEach(a => addAddressRowToEditor(a));
    } else {
        addAddressRowToEditor();
    }

    isLoadingClientData = false;
    renderClientsList();
}

function addAddressRowToEditor(data = null) {
    const container = document.getElementById('client-edit-addresses-container');
    const row = document.createElement('div');
    row.className = 'address-edit-row';
    row.style = "background:rgba(255,255,255,0.03); padding:15px; border-radius:12px; border:1px solid var(--border-glass); margin-bottom:15px;";

    row.innerHTML = `
        <div class="form-group mb-2">
            <label style="font-size:0.6rem;">DIRECCIÓN COMPLETA (CALLE, Nº, PISO)</label>
            <input type="text" class="edit-addr-full form-control" placeholder="Ej: Calle Mayor 5, Madrid" value="${escapeHtml(data ? (data.address || data.street || '') : '')}">
        </div>
        <div style="display:grid; grid-template-columns: 2fr 1fr 1.5fr; gap:10px;">
            <div>
                <label style="font-size:0.6rem;">LOCALIDAD / CIUDAD</label>
                <input type="text" class="edit-addr-city form-control" value="${escapeHtml(data ? (data.localidad || '') : '')}">
            </div>
            <div>
                <label style="font-size:0.6rem;">C. POSTAL</label>
                <input type="text" class="edit-addr-cp form-control" value="${escapeHtml(data ? (data.cp || '') : '')}" maxlength="5">
            </div>
            <div>
                <label style="font-size:0.6rem;">PROVINCIA (ZONA)</label>
                <select class="edit-addr-prov form-control"></select>
            </div>
        </div>
        <button class="btn-remove-addr" style="background:none; border:none; color:#FF3B30; font-size:0.7rem; font-weight:bold; cursor:pointer; margin-top:10px;">🗑️ ELIMINAR DIRECCIÓN</button>
    `;

    const cpInput = row.querySelector('.edit-addr-cp');
    const locInput = row.querySelector('.edit-addr-city');
    if (cpInput && locInput) {
        // 1. CP -> Localidad & Provincia
        cpInput.addEventListener('input', async (e) => {
            const cp = e.target.value.trim();
            if(cp.length === 5 && !isNaN(cp)) {
                try {
                    const res = await fetch(`https://api.zippopotam.us/es/${cp}`);
                    if(res.ok) {
                        const dat = await res.json();
                        const place = dat.places[0];
                        locInput.value = `${place['place name']}`;
                        locInput.style.borderColor = "var(--success)";
                        setTimeout(() => locInput.style.borderColor = "", 2000);
                        
                        // Auto-fill province
                        const provSel = row.querySelector('.edit-addr-prov');
                        if (provSel && !provSel.value) {
                            const prefix = cp.substring(0, 2);
                            const provMap = {'29':'MALAGA','18':'GRANADA','14':'CORDOBA','41':'SEVILLA','23':'JAEN','04':'ALMERIA','21':'HUELVA','11':'CADIZ','28':'MADRID','08':'BARCELONA','46':'VALENCIA','30':'MURCIA','03':'ALICANTE','06':'BADAJOZ','10':'CACERES','50':'ZARAGOZA','33':'ASTURIAS','48':'VIZCAYA','20':'GUIPUZKOA','39':'CANTABRIA','47':'VALLADOLID','15':'A CORUÑA','36':'PONTEVEDRA','27':'LUGO','32':'OURENSE','07':'BALEARES','35':'LAS PALMAS','38':'TENERIFE','01':'ALAVA','31':'NAVARRA','26':'LA RIOJA','45':'TOLEDO','13':'CIUDAD REAL','02':'ALBACETE','16':'CUENCA','19':'GUADALAJARA','05':'AVILA','09':'BURGOS','34':'PALENCIA','24':'LEON','37':'SALAMANCA','40':'SEGOVIA','42':'SORIA','49':'ZAMORA','12':'CASTELLON','43':'TARRAGONA','25':'LLEIDA','17':'GIRONA','22':'HUESCA','44':'TERUEL'};
                            const provName = provMap[prefix];
                            if (provName && Array.from(provSel.options).some(o => o.value === provName)) {
                                provSel.value = provName;
                            }
                        }
                    }
                } catch(err) { console.log(err); }
            }
        });

        // 2. Localidad -> CP & Provincia (Reverse lookup via PhantomDirectory)
        let debounceLoc = null;
        locInput.addEventListener('input', () => {
            clearTimeout(debounceLoc);
            debounceLoc = setTimeout(() => {
                const val = locInput.value.trim().toUpperCase();
                if (val.length < 3) return;
                
                if (window.isPhantomLoaded && window.PhantomDirectory) {
                    let cp = null;
                    // Exact match
                    for (const c of window.PhantomDirectory) {
                        if (c.localidad && c.localidad.trim().toUpperCase() === val) { cp = c.cp; break; }
                    }
                    // Fuzzy match
                    if (!cp) {
                        for (const c of window.PhantomDirectory) {
                            if (c.localidad && c.localidad.trim().toUpperCase().startsWith(val)) { cp = c.cp; break; }
                        }
                    }
                    
                    if (cp) {
                        if (!cpInput.value.trim()) {
                            cpInput.value = cp;
                            cpInput.style.borderColor = 'var(--success)';
                            setTimeout(() => cpInput.style.borderColor = '', 2000);
                        }
                        
                        // Auto-fill province
                        const provSel = row.querySelector('.edit-addr-prov');
                        if (provSel && !provSel.value) {
                            const prefix = String(cp).substring(0, 2);
                            const provMap = {'29':'MALAGA','18':'GRANADA','14':'CORDOBA','41':'SEVILLA','23':'JAEN','04':'ALMERIA','21':'HUELVA','11':'CADIZ','28':'MADRID','08':'BARCELONA','46':'VALENCIA','30':'MURCIA','03':'ALICANTE','06':'BADAJOZ','10':'CACERES','50':'ZARAGOZA','33':'ASTURIAS','48':'VIZCAYA','20':'GUIPUZKOA','39':'CANTABRIA','47':'VALLADOLID','15':'A CORUÑA','36':'PONTEVEDRA','27':'LUGO','32':'OURENSE','07':'BALEARES','35':'LAS PALMAS','38':'TENERIFE','01':'ALAVA','31':'NAVARRA','26':'LA RIOJA','45':'TOLEDO','13':'CIUDAD REAL','02':'ALBACETE','16':'CUENCA','19':'GUADALAJARA','05':'AVILA','09':'BURGOS','34':'PALENCIA','24':'LEON','37':'SALAMANCA','40':'SEGOVIA','42':'SORIA','49':'ZAMORA','12':'CASTELLON','43':'TARRAGONA','25':'LLEIDA','17':'GIRONA','22':'HUESCA','44':'TERUEL'};
                            const provName = provMap[prefix];
                            if (provName && Array.from(provSel.options).some(o => o.value === provName)) {
                                provSel.value = provName;
                            }
                        }
                    }
                }
            }, 400);
        });
    }

    const provSel = row.querySelector('.edit-addr-prov');
    if (provSel) {
        let html = '<option value="">-- Zona --</option>';
        cachedProvinces.forEach(z => html += `<option value="${z}">${z}</option>`);
        html += '<option value="create_new" style="color:var(--brand-primary); font-weight:bold;">+ CREAR NUEVA...</option>';
        provSel.innerHTML = html;
        if (data && data.province) provSel.value = data.province;

        provSel.onchange = async (e) => {
            if (e.target.value === 'create_new') {
                const name = prompt("Nombre de la nueva zona:");
                if (name && name.trim()) {
                    const custom = await getCustomData('provinces') || [];
                    custom.push(name.trim().toUpperCase());
                    await saveCustomData('provinces', [...new Set(custom)]);
                    await loadProvinces();
                    
                    let newHtml = '<option value="">-- Zona --</option>';
                    cachedProvinces.forEach(z => newHtml += `<option value="${z}">${z}</option>`);
                    newHtml += '<option value="create_new" style="color:var(--brand-primary); font-weight:bold;">+ CREAR NUEVA...</option>';
                    
                    document.querySelectorAll('.edit-addr-prov').forEach(sel => {
                        const curr = sel.value;
                        sel.innerHTML = newHtml;
                        sel.value = curr;
                    });
                    
                    e.target.value = name.trim().toUpperCase();
                } else {
                    e.target.value = "";
                }
            }
        };
    }

    container.appendChild(row);
    row.querySelector('.btn-remove-addr').onclick = () => row.remove();
}

let isSubmittingClientForm = false;
document.getElementById('btn-client-save').onclick = async () => {
    if (isSubmittingClientForm) return;

    const name = document.getElementById('client-edit-name').value.trim();
    const phone = document.getElementById('client-edit-phone').value.trim();
    const nif = document.getElementById('client-edit-nif').value.trim();
    const email = document.getElementById('client-edit-email').value.trim();
    const notes = document.getElementById('client-edit-notes').value.trim();

    if (!name) { alert("El nombre es obligatorio"); return; }

    const rows = document.querySelectorAll('.address-edit-row');
    const rawAddresses = Array.from(rows).map(row => {
        const fullAddr = row.querySelector('.edit-addr-full').value.trim();
        const locality = row.querySelector('.edit-addr-city').value.trim();
        const cp = row.querySelector('.edit-addr-cp').value.trim();
        const province = row.querySelector('.edit-addr-prov').value;

        return {
            id: "addr_" + Math.random().toString(36).substr(2, 9),
            address: fullAddr,
            street: fullAddr, // Backup mapping
            number: '',
            localidad: locality, 
            cp: cp, 
            province: province
        };
    }).filter(a => a.address);

    // Filtrar duplicados dentro del propio formulario antes de guardar
    const addresses = [];
    const seenSigs = new Set();
    rawAddresses.forEach(addr => {
        const sig = getAddressSignature(addr);
        if (!seenSigs.has(sig)) {
            seenSigs.add(sig);
            addresses.push(addr);
        }
    });

    if (addresses.length === 0) { alert("Añade al menos una dirección"); return; }

    showLoading();
    isSubmittingClientForm = true;
    try {
        const agenda = getCollection('destinations');
        // Respetar el ID original si estamos editando para evitar duplicar al cambiar el nombre
        const docId = editingClientId || name.replace(/[^a-z0-9\-_]/gi, '_').toLowerCase();

        await agenda.doc(docId).set({
            name: name.toUpperCase(),
            phone: phone,
            nif: nif,
            email: email,
            notes: notes,
            addresses: addresses
        }, { merge: true });

        alert("Cliente guardado correctamente.");
        await renderClientsList();
    } catch (e) {
        alert("Error: " + e.message);
    } finally {
        isSubmittingClientForm = false;
        hideLoading();
    }
};

window.deleteEditingClient = async () => {
    if (!editingClientId) return;
    if (confirm("¿Estás seguro de que quieres ELIMINAR a este cliente de tu agenda para siempre?")) {
        showLoading();
        try {
            await getCollection('destinations').doc(editingClientId).delete();
            alert("Cliente eliminado de la agenda.");
            document.getElementById('btn-client-new').click(); // Reset form
            await renderClientsList();
        } catch (e) {
            alert("Error al eliminar: " + e.message);
        } finally {
            hideLoading();
        }
    }
};

// --- BACKUP & RESTORE AGENDA ---
async function exportClientAgenda() {
    try {
        showLoading();
        const snap = await getCollection('destinations').get();
        const clients = [];
        snap.forEach(doc => clients.push({ id: doc.id, ...doc.data() }));

        if (clients.length === 0) {
            alert("La agenda está vacía. No hay datos que exportar.");
            hideLoading();
            return;
        }

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(clients, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `BACKUP_AGENDA_${userData ? userData.idNum : 'USER'}_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        hideLoading();
    } catch (e) {
        console.error("Export error:", e);
        alert("Error al exportar agenda.");
        hideLoading();
    }
}

async function importClientAgenda(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const raw = JSON.parse(e.target.result);
            
            // Smart routing: If user accidentally uploaded a full offline backup here
            if (!Array.isArray(raw)) {
                if (typeof raw === 'object' && Object.keys(raw).some(k => k.startsWith('novapack_'))) {
                    console.log("Detected full offline backup in agenda import. Rerouting...");
                    // Reroute to the correct migration bridge
                    importOfflineBackup({ target: { files: [file] } });
                    return;
                }
                // Detect Cloud full backup format (NOVAPACK_FULL_BACKUP_*.json)
                if (typeof raw === 'object' && raw.backup_info && raw.collections) {
                    console.log("Detected Cloud full backup in agenda import. Rerouting to Cloud restore...");
                    importCloudBackupInClient(raw);
                    return;
                }
                alert("Error: El archivo de backup no tiene el formato correcto.");
                return;
            }

            if (!confirm(`¿Restaurar ${raw.length} clientes desde el archivo? Esto fusionará los datos existentes.`)) return;

            showLoading();
            const agenda = getCollection('destinations');
            let batch = db.batch();
            let count = 0;

            for (const c of raw) {
                const docId = c.id || c.name.replace(/[^a-z0-9\-_]/gi, '_').toLowerCase();
                const data = { ...c };
                delete data.id; // Evitar duplicar ID en el documento

                // NORMALIZE: Wrap flat address fields into addresses array if missing
                if (!data.addresses || !Array.isArray(data.addresses) || data.addresses.length === 0) {
                    const hasAddrFields = data.address || data.street || data.localidad || data.cp || data.province;
                    if (hasAddrFields) {
                        data.addresses = [{
                            id: "addr_" + Date.now().toString(36),
                            address: data.address || data.street || '',
                            street: data.street || data.address || '',
                            number: data.number || '',
                            localidad: data.localidad || data.city || '',
                            cp: data.cp || '',
                            province: data.province || ''
                        }];
                    }
                }

                batch.set(agenda.doc(docId), data, { merge: true });
                count++;

                if (count >= 400) {
                    await batch.commit();
                    batch = db.batch();
                    count = 0;
                }
            }
            await batch.commit();

            alert("✅ Agenda restaurada con éxito.");
            agendaCache = null; // Limpiar cache de búsqueda
            await renderClientsList();
        } catch (err) {
            console.error("Import error:", err);
            alert("Error procesando el archivo: " + err.message);
        } finally {
            hideLoading();
            event.target.value = ''; // Reset input
        }
    };
    reader.readAsText(file);
}

// --- EXCEL IMPORT FOR CLIENT AGENDA ---
async function importClientAgendaFromExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === 'undefined') {
        alert("Error: La librería de Excel no está cargada. Recarga la página e intenta de nuevo.");
        return;
    }

    showLoading();
    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const sheetName = wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rows.length === 0) {
            alert("El archivo Excel está vacío o no tiene datos válidos.");
            hideLoading();
            return;
        }

        // Smart column mapping (case-insensitive)
        const colKeys = Object.keys(rows[0]);
        const findCol = (...aliases) => colKeys.find(k => aliases.some(a => k.toLowerCase().includes(a.toLowerCase())));

        const colName     = findCol('cliente', 'nombre', 'name', 'razón', 'razon');
        const colAddress  = findCol('direccion', 'dirección', 'address', 'calle', 'domicilio');
        const colCity     = findCol('poblacion', 'población', 'localidad', 'ciudad', 'city');
        const colProvince = findCol('provincia', 'zone', 'zona');
        const colPhone    = findCol('telefono', 'teléfono', 'phone', 'telf', 'tlf', 'móvil', 'movil');
        const colCP       = findCol('cp', 'código postal', 'codigo postal', 'c.p.', 'postal');
        const colNif      = findCol('nif', 'cif', 'dni');
        const colEmail    = findCol('email', 'correo', 'e-mail');
        const colNotes    = findCol('notas', 'observaciones', 'notes');

        if (!colName) {
            alert("No se encontró una columna de NOMBRE/CLIENTE en el Excel.\nColumnas detectadas: " + colKeys.join(', '));
            hideLoading();
            return;
        }

        // Group rows by client name (a client may have multiple addresses)
        const clientMap = new Map();
        rows.forEach(row => {
            let rawName = String(row[colName] || '').trim();
            if (!rawName) return;

            // Clean name: remove leading numeric codes like "148508 - "
            const cleanName = rawName.replace(/^\d+\s*[-–]\s*/, '').trim().toUpperCase();
            if (!cleanName || cleanName === '.' || cleanName.length < 2) return;

            const addr = {
                id: "addr_" + Math.random().toString(36).substr(2, 9),
                address: colAddress ? String(row[colAddress] || '').trim() : '',
                street: colAddress ? String(row[colAddress] || '').trim() : '',
                number: '',
                localidad: colCity ? String(row[colCity] || '').trim() : '',
                cp: colCP ? String(row[colCP] || '').trim() : '',
                province: colProvince ? String(row[colProvince] || '').trim() : ''
            };

            if (!clientMap.has(cleanName)) {
                clientMap.set(cleanName, {
                    name: cleanName,
                    phone: colPhone ? String(row[colPhone] || '').trim() : '',
                    nif: colNif ? String(row[colNif] || '').trim() : '',
                    email: colEmail ? String(row[colEmail] || '').trim() : '',
                    notes: colNotes ? String(row[colNotes] || '').trim() : '',
                    addresses: []
                });
            }
            // Avoid duplicate addresses for same client
            const client = clientMap.get(cleanName);
            const sigNew = (addr.address + addr.localidad + addr.cp).replace(/\s/g, '').toLowerCase();
            const isDup = client.addresses.some(a => (a.address + a.localidad + a.cp).replace(/\s/g, '').toLowerCase() === sigNew);
            if (!isDup && addr.address) {
                client.addresses.push(addr);
            }
            // Update phone if missing
            if (!client.phone && colPhone) {
                client.phone = String(row[colPhone] || '').trim();
            }
        });

        hideLoading();

        const clientArray = Array.from(clientMap.values());
        const fileName = file.name;

        // Show preview modal
        showExcelPreviewModal(clientArray, fileName);

    } catch (err) {
        console.error("Excel import error:", err);
        alert("Error al leer el archivo Excel: " + err.message);
        hideLoading();
    } finally {
        event.target.value = ''; // Reset input
    }
}

function showExcelPreviewModal(clients, fileName) {
    // Remove existing modal if any
    let existing = document.getElementById('modal-excel-preview');
    if (existing) existing.remove();

    const preview = clients.slice(0, 8);
    let tableRows = preview.map(c => {
        const addrText = c.addresses.map(a => escapeHtml(a.address) + ', ' + escapeHtml(a.localidad) + ' ' + escapeHtml(a.cp)).join(' | ') || 'Sin dirección';
        return `<tr>
            <td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.8rem; font-weight:600; color:white;">${escapeHtml(c.name)}</td>
            <td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.75rem; color:#CCC; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${addrText}</td>
            <td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.75rem; color:#CCC;">${escapeHtml(c.phone || '-')}</td>
            <td style="padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.75rem; color:#CCC;">${escapeHtml(c.addresses[0]?.province || '-')}</td>
        </tr>`;
    }).join('');

    const modal = document.createElement('div');
    modal.id = 'modal-excel-preview';
    modal.style = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:9999; display:flex; justify-content:center; align-items:center; backdrop-filter:blur(5px);";
    modal.innerHTML = `
        <div style="background:var(--bg-dark, #1a1a2e); border:1px solid var(--border-glass, #333); border-radius:16px; padding:30px; width:90%; max-width:800px; max-height:85vh; overflow-y:auto; position:relative;">
            <button onclick="document.getElementById('modal-excel-preview').remove()" style="position:absolute; top:15px; right:15px; background:none; border:none; color:white; font-size:1.5rem; cursor:pointer;">&times;</button>
            <h3 style="color:#21a366; margin-top:0; display:flex; align-items:center; gap:10px;">
                <span style="font-size:1.8rem;">📊</span> PREVISUALIZACIÓN EXCEL
            </h3>
            <div style="margin-bottom:15px; padding:12px; background:rgba(33,163,102,0.1); border:1px solid rgba(33,163,102,0.3); border-radius:8px;">
                <div style="color:#21a366; font-weight:700; font-size:0.85rem;">📁 ${escapeHtml(fileName)}</div>
                <div style="color:#CCC; font-size:0.8rem; margin-top:4px;">
                    ✅ <strong>${clients.length}</strong> clientes únicos detectados
                    ${clients.length > preview.length ? ` (mostrando primeros ${preview.length})` : ''}
                </div>
            </div>
            <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
                <thead>
                    <tr style="border-bottom:2px solid var(--brand-primary, #ff6600);">
                        <th style="padding:8px; text-align:left; font-size:0.7rem; color:#ff6600; text-transform:uppercase;">Cliente</th>
                        <th style="padding:8px; text-align:left; font-size:0.7rem; color:#ff6600; text-transform:uppercase;">Dirección</th>
                        <th style="padding:8px; text-align:left; font-size:0.7rem; color:#ff6600; text-transform:uppercase;">Teléfono</th>
                        <th style="padding:8px; text-align:left; font-size:0.7rem; color:#ff6600; text-transform:uppercase;">Provincia</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
            <div style="display:flex; gap:12px; justify-content:flex-end;">
                <button onclick="document.getElementById('modal-excel-preview').remove()" class="btn btn-outline" style="padding:12px 25px; font-weight:700;">❌ CANCELAR</button>
                <button id="btn-confirm-excel-import" class="btn" style="background:#21a366; color:white; padding:12px 30px; font-weight:900; border:none; border-radius:8px; cursor:pointer; font-size:1rem;">
                    ✅ IMPORTAR ${clients.length} CLIENTES
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('btn-confirm-excel-import').onclick = async () => {
        modal.remove();
        await executeExcelClientImport(clients);
    };
}

async function executeExcelClientImport(clients) {
    showLoading();
    try {
        const agenda = getCollection('destinations');
        if (!agenda) {
            alert("Error: No se pudo acceder a la colección de destinos. ¿Estás autenticado?");
            hideLoading();
            return;
        }

        let batch = db.batch();
        let count = 0;
        let totalImported = 0;

        for (const c of clients) {
            const docId = (c.name || "").replace(/[^a-z0-9\-_]/gi, '_').toLowerCase();
            if (!docId || docId.length < 2) continue;

            const clientData = {
                name: c.name,
                phone: c.phone || '',
                nif: c.nif || '',
                email: c.email || '',
                notes: c.notes || '',
                addresses: c.addresses || []
            };

            batch.set(agenda.doc(docId), clientData, { merge: true });
            count++;
            totalImported++;

            // Firestore batch limit is 500
            if (count >= 450) {
                await batch.commit();
                batch = db.batch();
                count = 0;
                console.log(`[EXCEL IMPORT] Batch committed, ${totalImported} clientes procesados...`);
            }
        }

        // Commit remaining
        if (count > 0) {
            await batch.commit();
        }

        agendaCache = null; // Invalidate search cache
        alert(`✅ IMPORTACIÓN COMPLETADA\n\n${totalImported} clientes importados con éxito a tu Agenda Nube.`);
        
        // Refresh client list if visible
        if (typeof renderClientsList === 'function') {
            await renderClientsList();
        }

    } catch (err) {
        console.error("Excel import commit error:", err);
        alert("Error al guardar los clientes: " + err.message);
    } finally {
        hideLoading();
    }
}


async function importOfflineBackup(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!userData || !currentCompanyId) {
        alert("Error: Identificación de cliente o empresa no establecida.");
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const raw = JSON.parse(e.target.result);
            if (typeof raw !== 'object' || Array.isArray(raw)) {
                alert("Error: Formato de archivo de seguridad offline no válido.");
                return;
            }

            // Extract flat tickets, destinations, sizes, and provinces
            let allTickets = [];
            let allDestinations = [];
            let allSizes = [];
            let allProvinces = [];

            Object.keys(raw).forEach(key => {
                if (key.includes("tickets")) {
                    try {
                        const arr = JSON.parse(raw[key]);
                        if (Array.isArray(arr)) allTickets = allTickets.concat(arr);
                    } catch (err) {}
                }
                if (key.includes("destinations")) {
                    try {
                        const arr = JSON.parse(raw[key]);
                        if (Array.isArray(arr)) allDestinations = allDestinations.concat(arr);
                    } catch (err) {}
                }
                if (key.includes("custom_sizes")) {
                    try {
                        const arr = JSON.parse(raw[key]);
                        if (Array.isArray(arr)) allSizes = allSizes.concat(arr);
                    } catch (err) {}
                }
                if (key.includes("provinces")) {
                    try {
                        const arr = JSON.parse(raw[key]);
                        if (Array.isArray(arr)) allProvinces = allProvinces.concat(arr);
                    } catch (err) {}
                }
            });

            if (allTickets.length === 0 && allDestinations.length === 0) {
                alert("No se encontraron albaranes válidos ni agenda en el archivo.");
                return;
            }

            if (!confirm(`DETECTADO EN LA COPIA DE SEGURIDAD:\n\n- ${allTickets.length} Albaranes.\n- ${allDestinations.length} Destinatarios en la Agenda.\n- ${allSizes.length} Tamaños de Bulto personalizados.\n\n¿MIGRAR TODO ESTO a la Nube?`)) return;

            showLoading();
            
            let batch = db.batch();
            let count = 0;
            let totalTicketsImported = 0;
            let totalDestImported = 0;
            
            const myIdNum = String(userData.idNum || "0");
            // CRITICAL: Use effectiveStorageUid to match the path used by getCollection('destinations')
            const storageUid = effectiveStorageUid || auth.currentUser.uid;
            const userRef = db.collection('users').doc(storageUid);

            // 1. IMPORT TICKETS
            for (const t of allTickets) {
                const docId = `${myIdNum}_${currentCompanyId}_${t.id}`;
                const payload = {
                    ...t,
                    uid: storageUid,
                    clientIdNum: myIdNum,
                    compId: currentCompanyId
                };
                
                if (payload.createdAt && typeof payload.createdAt === 'string') payload.createdAt = new Date(payload.createdAt);
                if (payload.updatedAt && typeof payload.updatedAt === 'string') payload.updatedAt = new Date(payload.updatedAt);

                batch.set(db.collection('tickets').doc(docId), payload, { merge: true });
                count++;
                totalTicketsImported++;

                if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
            }

            // 2. IMPORT DESTINATIONS (AGENDA)
            // Desduplicación básica por ID o nombre
            const seenDests = new Set();
            for (const d of allDestinations) {
                if (!d.name || seenDests.has(d.name)) continue;
                seenDests.add(d.name);
                
                const destId = d.id || `cli_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                const payload = { ...d };

                // NORMALIZE: If offline backup has flat address fields but no addresses array,
                // wrap them into the array format expected by the Cloud app
                if (!payload.addresses || !Array.isArray(payload.addresses) || payload.addresses.length === 0) {
                    const hasAddrFields = payload.address || payload.street || payload.localidad || payload.cp || payload.province;
                    if (hasAddrFields) {
                        payload.addresses = [{
                            id: "addr_" + Date.now().toString(36),
                            address: payload.address || payload.street || '',
                            street: payload.street || payload.address || '',
                            number: payload.number || '',
                            localidad: payload.localidad || payload.city || '',
                            cp: payload.cp || '',
                            province: payload.province || ''
                        }];
                    } else {
                        payload.addresses = [];
                    }
                }

                batch.set(userRef.collection('destinations').doc(destId), payload, { merge: true });
                count++;
                totalDestImported++;

                if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
            }


            // 3. ACTUALIZAR CONFIGURACIÓN DEL USUARIO (Tamaños y Provincias)
            let userUpdates = {};
            if (allSizes.length > 0) userUpdates.customPackageSizes = [...new Set(allSizes)];
            if (allProvinces.length > 0) userUpdates.customProvinces = [...new Set(allProvinces)];
            
            if (Object.keys(userUpdates).length > 0) {
                batch.set(userRef, userUpdates, { merge: true });
                count++;
            }

            if (count > 0) await batch.commit();

            alert(`✅ MIGRACIÓN COMPLETADA.\n\nSe han restaurado:\n- ${totalTicketsImported} Albaranes.\n- ${totalDestImported} Direcciones de Destino.`);
            
            // Invalidar cache de agenda para que se muestren los nuevos clientes
            agendaCache = null;
            
            // Re-inicializar listener de tickets para capturar los nuevos albaranes
            if (typeof initTicketListener === 'function') {
                await initTicketListener();
            }
            
            // Refrescar la lista de clientes si la vista está activa
            if (typeof renderClientsList === 'function') {
                await renderClientsList();
            }

        } catch (err) {
            console.error("Migration error:", err);
            alert("Error procesando la migración: " + err.message);
        } finally {
            hideLoading();
            event.target.value = ''; // Reset input
        }
    };
    reader.readAsText(file);
}

// --- CLOUD BACKUP IMPORT (For users importing NOVAPACK_FULL_BACKUP_*.json from admin panel) ---
async function importCloudBackupInClient(raw) {
    if (!userData || !currentCompanyId) {
        alert("Error: Identificación de cliente o empresa no establecida.");
        return;
    }

    try {
        // Extract data from Cloud backup format
        const collections = raw.collections || {};
        const allTickets = Array.isArray(collections.tickets) ? collections.tickets : [];
        
        // Extract destinations from user sub-documents
        let allDestinations = [];
        if (collections.users && typeof collections.users === 'object') {
            // Look for destinations in each user profile
            Object.values(collections.users).forEach(u => {
                if (u.destinations && Array.isArray(u.destinations)) {
                    allDestinations = allDestinations.concat(u.destinations);
                }
            });
        }

        if (allTickets.length === 0 && allDestinations.length === 0) {
            alert(`No se encontraron datos importables en el backup Cloud.\n\nEl archivo contiene ${Object.keys(collections).length} colecciones pero no se pudieron extraer albaranes ni agenda para tu sesión.`);
            return;
        }

        if (!confirm(`DETECTADO BACKUP CLOUD (${raw.backup_info ? raw.backup_info.timestamp : 'Sin fecha'}):\n\n- ${allTickets.length} Albaranes.\n- ${allDestinations.length} Destinatarios.\n\n¿RESTAURAR en tu sesión activa?`)) return;

        showLoading();

        let batch = db.batch();
        let count = 0;
        let totalTicketsImported = 0;
        let totalDestImported = 0;

        const myIdNum = String(userData.idNum || "0");
        const storageUid = effectiveStorageUid || auth.currentUser.uid;
        const userRef = db.collection('users').doc(storageUid);

        // 1. IMPORT TICKETS — Only import tickets that belong to this user
        for (const t of allTickets) {
            // Filter: only import tickets matching this user's UID or clientIdNum
            const matchesUid = t.uid === storageUid || t.uid === userData.authUid;
            const matchesIdNum = t.clientIdNum && (t.clientIdNum === myIdNum || t.clientIdNum === userData.idNum);
            
            if (!matchesUid && !matchesIdNum) continue;

            const docId = t.id ? `${myIdNum}_${currentCompanyId}_${t.id}` : `imported_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const payload = {
                ...t,
                uid: storageUid,
                clientIdNum: myIdNum,
                compId: t.compId || currentCompanyId
            };

            // Convert Firestore timestamp objects back to Dates
            if (payload.createdAt && typeof payload.createdAt === 'object' && payload.createdAt.seconds) {
                payload.createdAt = new Date(payload.createdAt.seconds * 1000);
            } else if (payload.createdAt && typeof payload.createdAt === 'string') {
                payload.createdAt = new Date(payload.createdAt);
            }
            if (payload.updatedAt && typeof payload.updatedAt === 'object' && payload.updatedAt.seconds) {
                payload.updatedAt = new Date(payload.updatedAt.seconds * 1000);
            } else if (payload.updatedAt && typeof payload.updatedAt === 'string') {
                payload.updatedAt = new Date(payload.updatedAt);
            }

            batch.set(db.collection('tickets').doc(docId), payload, { merge: true });
            count++;
            totalTicketsImported++;

            if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
        }

        // 2. IMPORT DESTINATIONS
        const seenDests = new Set();
        for (const d of allDestinations) {
            if (!d.name || seenDests.has(d.name)) continue;
            seenDests.add(d.name);

            const destId = d.id || `cli_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const payload = { ...d };

            batch.set(userRef.collection('destinations').doc(destId), payload, { merge: true });
            count++;
            totalDestImported++;

            if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
        }

        if (count > 0) await batch.commit();

        alert(`✅ RESTAURACIÓN CLOUD COMPLETADA.\n\nSe han restaurado:\n- ${totalTicketsImported} Albaranes.\n- ${totalDestImported} Direcciones de Destino.`);

        // Invalidar cache y refrescar vistas
        agendaCache = null;

        if (typeof initTicketListener === 'function') {
            await initTicketListener();
        }
        if (typeof renderClientsList === 'function') {
            await renderClientsList();
        }

    } catch (err) {
        console.error("Cloud backup import error:", err);
        alert("Error procesando el backup Cloud: " + err.message);
    } finally {
        hideLoading();
    }
}

const btnClientNew = document.getElementById('btn-client-new');
if (btnClientNew) {
    btnClientNew.onclick = () => {
        editingClientId = null;
        const btnDel = document.getElementById('btn-client-delete');
        if(btnDel) btnDel.classList.add('hidden');

        document.getElementById('client-edit-id').value = '';
        document.getElementById('client-edit-name').value = '';
        document.getElementById('client-edit-phone').value = '';
        document.getElementById('client-edit-nif').value = '';
        document.getElementById('client-edit-email').value = '';
        document.getElementById('client-edit-notes').value = '';
        document.getElementById('client-edit-addresses-container').innerHTML = '';
        addAddressRowToEditor();
    };
}

const btnAddAddressRow = document.getElementById('btn-add-address-row');
if (btnAddAddressRow) {
    btnAddAddressRow.onclick = () => addAddressRowToEditor();
}

// --- CLIENT PICKER (AUTO-COMPLETE CON CACHE Y DEBOUNCE) ---
const clientPickerInput = document.getElementById('client-picker');
const clientPickerResults = document.getElementById('client-picker-results');
let agendaCache = null;
let agendaSearchTimer = null;

if (clientPickerInput) {
    clientPickerInput.oninput = () => {
    if (agendaSearchTimer) clearTimeout(agendaSearchTimer);

    agendaSearchTimer = setTimeout(async () => {
        const q = clientPickerInput.value.toLowerCase().trim();
        if (q.length < 1) {
            clientPickerResults.classList.add('hidden');
            return;
        }

        // Carga inicial de cache si está vacío
        if (!agendaCache) {
            console.log("[CACHE] Cargando agenda de clientes para búsqueda rápida...");
            try {
                const snap = await getCollection('destinations').get();
                agendaCache = [];
                snap.forEach(doc => agendaCache.push({ id: doc.id, ...doc.data() }));
            } catch (err) {
                console.warn("No se pudo cargar la agenda local, continuando con busqueda global.", err);
                agendaCache = [];
            }
        }

        let matches = [];
        agendaCache.forEach(c => {
            // Normalize addresses for older clients that don't have the array structure
            const addrs = (c.addresses && Array.isArray(c.addresses)) ? c.addresses : [{
                address: c.address || '', street: c.street || '', number: c.number || '',
                localidad: c.localidad || '', cp: c.cp || '', province: c.province || ''
            }];

            if ((c.name || '').toLowerCase().includes(q)) {
                addrs.forEach(a => matches.push({ name: c.name, phone: c.phone, nif: c.nif || '', isGlobal: false, ...a }));
            } else {
                addrs.forEach(a => {
                    if ((a.address || '').toLowerCase().includes(q)) matches.push({ name: c.name, phone: c.phone, nif: c.nif || '', isGlobal: false, ...a });
                });
            }
        });

        // ----------------------------------------------------
        // INYECTAR DIRECTORIO GLOBAL (FANTASMA)
        // ----------------------------------------------------
        if (typeof window.searchPhantomDirectory === 'function') {
            const phantomResults = window.searchPhantomDirectory(q);
            phantomResults.forEach(pc => {
                // Verificar que no sea un duplicado exacto por Nombre localmente
                const existsLocally = matches.some(m => m.name.toLowerCase() === (pc.name || '').toLowerCase());
                if (!existsLocally) {
                    matches.push({
                        name: pc.name || '',
                        phone: pc.senderPhone || '',
                        nif: pc.nif || '',
                        address: pc.street || '',
                        street: pc.street || '',
                        number: '',
                        localidad: pc.localidad || '',
                        cp: pc.cp || '',
                        province: pc.province || '',
                        isGlobal: true
                    });
                }
            });
        }

        if (matches.length > 0) {
            clientPickerResults.innerHTML = '';
            clientPickerResults.classList.remove('hidden');
            matches.slice(0, 15).forEach(m => {
                const div = document.createElement('div');
                div.className = 'suggestion-item';
                div.style = "padding:10px; border-bottom:1px solid var(--border-glass); cursor:pointer;";
                
                const badge = m.isGlobal ? `<span style="font-size:0.65rem; background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; margin-left:8px; color:#aaa; border:1px solid #555;">🌐 Global</span>` : `<span style="font-size:0.65rem; background:rgba(76,175,80,0.2); padding:2px 6px; border-radius:4px; margin-left:8px; color:#4CAF50; border:1px solid #4CAF50;">👤 Mi Agenda</span>`;
                
                div.innerHTML = `<strong>${escapeHtml(m.name)}</strong> ${badge}<br><span style="font-size:0.8rem; color:#888;">${escapeHtml(m.address)} - ${escapeHtml(m.localidad)}</span>`;
                div.onclick = () => {
                    document.getElementById('ticket-receiver').value = m.name;
                    document.getElementById('ticket-address').value = m.street || m.address;
                    document.getElementById('ticket-number').value = m.number || '';
                    document.getElementById('ticket-localidad').value = m.localidad || '';
                    document.getElementById('ticket-cp').value = m.cp || '';
                    document.getElementById('ticket-phone').value = m.phone || '';
                    document.getElementById('ticket-province').value = m.province || '';
                    var nifInput = document.getElementById('ticket-receiver-nif');
                    if (nifInput && m.nif) { nifInput.value = m.nif; var nifBox = document.getElementById('box-receiver-nif'); if (nifBox) nifBox.style.display = 'block'; }
                    clientPickerInput.value = '';
                    clientPickerResults.classList.add('hidden');
                };
                clientPickerResults.appendChild(div);
            });
        } else {
            clientPickerResults.classList.add('hidden');
        }
    }, 300); // 300ms debounce
    };
}

// --- PROVINCES ---
async function loadProvinces() {
    const selectors = [
        document.getElementById('ticket-province'),
        document.getElementById('report-province'),
        document.getElementById('comp-province')
    ];
    const dataList = document.getElementById('province-list');
    
    const custom = await getCustomData('provinces') || [];
    const deleted = await getCustomData('provinces_deleted') || [];

    const DEFAULTS = ["MALAGA", "GRANADA", "SEVILLA", "CORDOBA", "VELEZ-MALAGA", "TORRE DEL MAR", "ALGARROBO", "NERJA", "TORROX COSTA", "LOJA", "ANTEQUERA", "ESTEPONA", "MARBELLA", "TORREMOLINOS", "FUENGIROLA", "MIJAS", "BENALMADENA"];
    cachedProvinces = [...new Set([...DEFAULTS, ...custom])].filter(p => !deleted.includes(p)).sort();

    let html = '<option value="">-- PROVINCIA --</option>';
    let datalistHtml = '';
    
    cachedProvinces.forEach(z => {
        html += `<option value="${z}">${z}</option>`;
        datalistHtml += `<option value="${z}"></option>`;
    });

    selectors.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = html + '<option value="create_new" style="color:var(--brand-primary); font-weight:bold;">+ CREAR NUEVA...</option>';
        sel.value = currentVal;
    });

    if (dataList) {
        dataList.innerHTML = datalistHtml;
    }
}

// Auto-populate driver phone based on company province and save new provinces automatically
const compProv = document.getElementById('comp-province');
if (compProv) {
    compProv.onchange = async (e) => {
        let selectedProv = e.target.value.trim().toUpperCase();
        if (!selectedProv) return;

        if (selectedProv === 'CREATE_NEW') {
            const newProv = prompt("Introduce el nombre de la nueva Provincia/Zona:");
            if (!newProv || !newProv.trim()) {
                e.target.value = '';
                return;
            }
            selectedProv = newProv.trim().toUpperCase();
        }

        // Auto-save new province if it doesn't exist
        if (!cachedProvinces.includes(selectedProv)) {
            const custom = await getCustomData('provinces') || [];
            if (!custom.includes(selectedProv)) {
                custom.push(selectedProv);
                await saveCustomData('provinces', [...new Set(custom)]);
                // We reload provinces quietly
                loadProvinces(); 
                
                // Wait briefly for DOM to update then reselect
                setTimeout(() => { if(e.target) e.target.value = selectedProv; }, 300);
            }
        }
        e.target.value = selectedProv;

        // Try to find a matching phone in the datalist options
        const datalist = document.getElementById('predefined-phones');
        if (!datalist) return;

        const smsPickup = document.getElementById('comp-sms-pickup');
        for (const opt of datalist.options) {
            // Check if the label contains the province name
            if (opt.textContent.toUpperCase().includes(selectedProv)) {
                if (smsPickup) smsPickup.value = opt.value;
                break;
            }
        }
    };
}

const ticketProvinceSel = document.getElementById('ticket-province');
if (ticketProvinceSel) {
    ticketProvinceSel.onchange = async (e) => {
        if (e.target.value === 'create_new') {
            const name = prompt("Nombre de la nueva zona:");
            if (name && name.trim()) {
                const custom = await getCustomData('provinces') || [];
                custom.push(name.trim().toUpperCase());
                await saveCustomData('provinces', [...new Set(custom)]);
                await loadProvinces();
                e.target.value = name.trim().toUpperCase();
            } else {
                e.target.value = "";
            }
        }
    };
}

// --- REPORTS ---
async function runReport() {
    const list = document.getElementById('report-results');
    const client = document.getElementById('report-client').value.toLowerCase();
    const startStr = document.getElementById('report-date-start').value;
    const endStr = document.getElementById('report-date-end').value;

    showLoading();
    try {
        const myIdNum = userData && userData.idNum ? userData.idNum.toString() : "0";
        
        // Fetch strictly by UID to bypass restrictive Firestore rules
        const snap = await getCollection('tickets')
            .where('uid', '==', currentUser.uid)
            .limit(5000)
            .get();
            
        let tickets = [];
        snap.forEach(doc => tickets.push({ id: doc.id, ...doc.data() }));

        tickets = tickets.filter(t => {
            if (!t.createdAt) return false;
            // Solo albaranes de la sede actual (o coincidencia legacy)
            if (t.compId !== currentCompanyId && t.clientIdNum !== myIdNum) return false;

            const ts = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
            const dStr = formatDateLocal(ts);
            const matchesClient = !client || (t.receiver || "").toLowerCase().includes(client) || (t.id || "").toLowerCase().includes(client);
            const matchesDate = (!startStr || dStr >= startStr) && (!endStr || dStr <= endStr);
            return matchesClient && matchesDate;
        });

        tickets.sort((a, b) => (b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt)) - (a.createdAt.toDate ? a.createdAt.toDate() : new Date(a.createdAt)));
        currentReportData = tickets;

        document.getElementById('report-total-count').textContent = tickets.length;
        list.innerHTML = '';

        if (tickets.length === 0) {
            document.getElementById('report-empty').style.display = 'block';
        } else {
            document.getElementById('report-empty').style.display = 'none';
            tickets.forEach(t => {
                const tr = document.createElement('tr');
                const dStr = (t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt)).toLocaleDateString();
                const pkgCount = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : 1;
                const weight = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseFloat(p.weight) || 0), 0) : 0;

                tr.innerHTML = `
                <td data-label="ID" style="padding:12px; border-bottom:1px solid #222;">${escapeHtml(t.id)}</td>
                <td data-label="FECHA" style="padding:12px; border-bottom:1px solid #222;">${escapeHtml(dStr)}</td>
                <td data-label="CLIENTE" style="padding:12px; border-bottom:1px solid #222;">${escapeHtml(t.receiver)}</td>
                <td data-label="ZONA" style="padding:12px; border-bottom:1px solid #222;">${escapeHtml(t.province || '-')}</td>
                <td data-label="BULTOS" style="padding:12px; border-bottom:1px solid #222; text-align:center;">${pkgCount}</td>
                <td data-label="PESO" style="padding:12px; border-bottom:1px solid #222; text-align:center;">${weight.toFixed(1)}kg</td>
                <td data-label="PORTES" style="padding:12px; border-bottom:1px solid #222; text-align:center;">${escapeHtml(t.shippingType)}</td>
                <td data-label="ESTADO" style="padding:12px; border-bottom:1px solid #222; text-align:center;">${t.printed ? '✅' : '⏳'}</td>
            `;
                list.appendChild(tr);
            });
        }
    } catch (err) {
        console.error("Report Error:", err);
        alert("Error al generar informe: " + err.message);
    } finally {
        hideLoading();
    }
}

const btnRunReport = document.getElementById('btn-run-report');
if (btnRunReport) {
    btnRunReport.onclick = runReport;
}

// Export CSV Logic
function handleExportCSV() {
    if (currentReportData.length === 0) {
        alert("Primero genera un listado con datos para exportar.");
        return;
    }

    try {
        let csv = "ID;FECHA;REMITENTE;DESTINATARIO;ZONA;BULTOS;PESO;TURNO;PORTES;REEMBOLSO;NOTAS\n";
        currentReportData.forEach(t => {
            const d = (t.createdAt && t.createdAt.toDate) ? t.createdAt.toDate() : new Date(t.createdAt);
            const dStr = d.toLocaleDateString();
            const pkgCount = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : 1;
            const weight = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseFloat(p.weight) || 0), 0) : 0;

            const row = [
                t.id || '',
                dStr,
                (t.sender || '').replace(/;/g, ','),
                (t.receiver || '').replace(/;/g, ','),
                t.province || '',
                pkgCount,
                weight.toFixed(2),
                t.timeSlot || '',
                t.shippingType || '',
                t.cod || '0.00',
                (t.notes || '').replace(/[\n\r;]/g, ' ')
            ];
            csv += row.join(';') + "\n";
        });

        const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `reporte_novapack_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Export Error:", e);
        alert("Error al exportar CSV: " + e.message);
    } finally {
        hideLoading();
    }
}

function printReportResults() {
    if (currentReportData.length === 0) {
        alert("Primero genera un informe con resultados.");
        return;
    }

    cleanPrintArea();
    const area = document.getElementById('print-area');
    setPrintPageSize('A4');

    const dateStart = document.getElementById('report-date-start').value;
    const dateEnd = document.getElementById('report-date-end').value;

    let tableRows = '';
    currentReportData.forEach(t => {
        const dStr = (t.createdAt && t.createdAt.toDate) ? t.createdAt.toDate().toLocaleDateString() : new Date(t.createdAt).toLocaleDateString();
        const pkgCount = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : 1;
        const weight = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseFloat(p.weight) || 0), 0) : 0;

        tableRows += `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding:8px; font-size:0.8rem;">${t.id}</td>
                <td style="padding:8px; font-size:0.8rem;">${dStr}</td>
                <td style="padding:8px; font-size:0.8rem;">${t.receiver}</td>
                <td style="padding:8px; font-size:0.8rem;">${t.province || '-'}</td>
                <td style="padding:8px; font-size:0.8rem; text-align:center;">${pkgCount}</td>
                <td style="padding:8px; font-size:0.8rem; text-align:right;">${weight.toFixed(1)}kg</td>
                <td style="padding:8px; font-size:0.8rem; text-align:center;">${t.shippingType}</td>
                <td style="padding:8px; font-size:0.8rem; text-align:center;">${t.printed ? 'SI' : 'NO'}</td>
            </tr>
        `;
    });

    const reportHtml = `
        <div style="padding:20mm; font-family: sans-serif; color: black; background: white; width: 210mm; box-sizing: border-box;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 30px; border-bottom: 2px solid #FF4D00; padding-bottom: 15px;">
                <div>
                    <h1 style="margin:0; color:#FF4D00; font-size: 1.8rem;">REPORTE DE ENVÍOS</h1>
                    <div style="color:#666; font-size:0.9rem; margin-top:5px;">Novapack Cloud - Operativa de Albaranes</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-weight:bold;">FECHA INFORME: ${new Date().toLocaleDateString()}</div>
                    <div style="font-size:0.8rem; color:#666;">Periodo: ${dateStart || 'Inicio'} al ${dateEnd || 'Hoy'}</div>
                </div>
            </div>

            <table style="width:100%; border-collapse: collapse; margin-bottom: 30px;">
                <thead>
                    <tr style="background:#f5f5f5; border-bottom: 2px solid #333;">
                        <th style="padding:10px; text-align:left; font-size:0.75rem;">ID</th>
                        <th style="padding:10px; text-align:left; font-size:0.75rem;">FECHA</th>
                        <th style="padding:10px; text-align:left; font-size:0.75rem;">DESTINATARIO</th>
                        <th style="padding:10px; text-align:left; font-size:0.75rem;">PROVINCIA</th>
                        <th style="padding:10px; text-align:center; font-size:0.75rem;">BULTOS</th>
                        <th style="padding:10px; text-align:right; font-size:0.75rem;">PESO</th>
                        <th style="padding:10px; text-align:center; font-size:0.75rem;">ENVÍO</th>
                        <th style="padding:10px; text-align:center; font-size:0.75rem;">IMP</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>

            <div style="display:flex; justify-content:flex-end; gap:40px; border-top: 1px solid #333; padding-top: 15px;">
                <div style="text-align:center;">
                    <div style="font-size:0.7rem; color:#666; text-transform:uppercase;">Total Envíos</div>
                    <div style="font-size:1.4rem; font-weight:bold;">${currentReportData.length}</div>
                </div>
                <div style="text-align:center;">
                    <div style="font-size:0.7rem; color:#666; text-transform:uppercase;">Total Bultos</div>
                    <div style="font-size:1.4rem; font-weight:bold;">${currentReportData.reduce((s, t) => s + (t.packagesList ? t.packagesList.reduce((sp, p) => sp + (parseInt(p.qty) || 1), 0) : 1), 0)}</div>
                </div>
            </div>

            <div style="margin-top: 50px; font-size: 0.7rem; color: #999; text-align: center; border-top: 1px dashed #ccc; padding-top: 10px;">
                Documento generado automáticamente desde Novapack Cloud System. Reservados todos los derechos.
            </div>
        </div>
    `;

    area.innerHTML = reportHtml;

    setTimeout(() => {
        const handleAfterPrint = () => {
            cleanPrintArea();
        };
        registerAfterPrint(handleAfterPrint);
        window.print();
        setTimeout(() => { if (area.innerHTML.length > 0) cleanPrintArea(); }, 60000);
    }, 600);
}

const btnExportCsv = document.getElementById('btn-export-csv');
if (btnExportCsv) btnExportCsv.onclick = handleExportCSV;

const btnPrintReport = document.getElementById('btn-print-report');
if (btnPrintReport) btnPrintReport.onclick = printReportResults;

// --- PRINTING LOGIC ---

// QR Generation Helper
function generateQRCode(text, size = 512) {
    try {
        if (typeof QRious === 'undefined') {
            console.warn("QRious library not loaded");
            return "";
        }
        const qr = new QRious({
            value: text,
            size: size,
            level: 'H', // High error correction for better scanning when printed or scratched
            padding: 2  // Ensure a quiet zone around the QR
        });
        return qr.toDataURL('image/png');
    } catch (e) {
        console.error("QR Generation error:", e);
        return "";
    }
}


function generateTicketHTML(t, footerLabel) {
    const ts = (t.createdAt && typeof t.createdAt.toDate === 'function') ? t.createdAt.toDate() : (t.createdAt ? new Date(t.createdAt) : new Date());
    const validDateStr = !isNaN(ts.getTime()) ? (ts.toLocaleDateString() + " " + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : "Fecha pendiente";

    // Company name for header (use client's company, fallback to NOVAPACK)
    const _comp = (typeof companies !== 'undefined' && typeof currentCompanyId !== 'undefined') ? companies.find(c => c.id === currentCompanyId) : null;
    const companyName = (_comp && _comp.name) ? _comp.name : (t.compName || t.sender || 'NOVAPACK');
    const companyEmail = (_comp && _comp.email) ? _comp.email : (t.senderEmail || 'administracion@novapack.info');

    // Grouped Package List Logic (One line per UI row)
    let displayList = [];
    if (t.packagesList && t.packagesList.length > 0) {
        displayList = t.packagesList;
    } else {
        // Legacy support
        displayList = [{
            qty: parseInt(t.packages) || 1,
            weight: t.weight,
            size: t.size
        }];
    }

    // Check if COD (Reembolso) exists and is not zero
    const hasCod = t.cod && t.cod.toString().trim() !== '' && t.cod.toString() !== '0';

    let rowsHtml = '';
    displayList.forEach((p) => {
        // Handle "10 kg" string vs "10" number
        let w = p.weight;
        if (typeof w === 'number') w = w + " kg";
        if (typeof w === 'string' && !w.includes('kg')) w = w + " kg";

        const qty = p.qty || 1;

        rowsHtml += `
            <tr>
               <td style="border: 1px solid #000; padding: 1px 3px; text-align: center; font-size: 8pt;">${escapeHtml(qty)}</td>
               <td style="border: 1px solid #000; padding: 1px 3px; text-align: center; font-size: 8pt;">${escapeHtml(w)}</td>
               <td style="border: 1px solid #000; padding: 1px 3px; text-align: center; font-size: 8pt;">${escapeHtml(p.size || 'Bulto')}</td>
               ${hasCod ? `<td style="border: 1px solid #000; padding: 1px 3px; text-align: center; font-size: 8pt;">${escapeHtml(t.cod)} €</td>` : ''}
            </tr>
        `;
    });

    return `
    <div style="font-family: Arial, sans-serif; padding: 4px; border: 2px solid #000; min-height: 100mm; max-height: 130mm; position: relative; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; background: white;">
        <!-- Watermark (Province/Zone) -->
        ${t.province ? `<div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%) rotate(-25deg); font-size:4.5rem; color:#000; font-weight:900; white-space:nowrap; z-index:0; pointer-events:none; width: 100%; text-align: center; font-family: 'Arial Black', sans-serif; opacity: 0.04; text-transform: uppercase;">${escapeHtml(t.province)}</div>` : ''}
        
        <div style="z-index: 2;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 5px; margin-bottom: 5px; position:relative;">
                <!-- Left: Logo -->
                <div style="flex: 0 0 auto; max-width: 130px;">
                    <div style="font-family: 'Xenotron', sans-serif; font-size: 14pt; color: #FF6600; line-height: 1;">NOVAPACK<span style="color:#FF3B30; font-weight:900; font-family:sans-serif;">&#10148;</span></div>
                    <div style="font-size: 0.6rem; letter-spacing: 0.3px; color:#333; margin-top: 2px;">${escapeHtml(companyEmail)}</div>
                </div>

                 <!-- Center: Zona Reparto -->
                <div style="flex: 1; text-align: center; padding: 0 10px;">
                     <div style="padding: 5px; background:#FFF; display: inline-block; min-width: 140px;">
                        <div style="font-size: 0.9rem; font-weight: bold; color: #000; margin-bottom: 5px;">
                            PORTES ${t.shippingType === 'Debidos' ? 'DEBIDOS' : 'PAGADOS'}
                        </div>
                        <div style="font-size: 1.6rem; font-weight: 900; color: #FF6600; text-transform:uppercase; line-height: 1.1;">
                            ${t.province ? escapeHtml(t.province) : '&nbsp;'}
                        </div>
                            ${t.timeSlot ? `<div style="font-size: 0.9rem; font-weight: 900; background: #EEE; color: #000; text-align: center; padding: 3px 5px; margin-top: 4px; border-radius: 4px;">TURNO: ${escapeHtml(t.timeSlot)}</div>` : ''}
                            ${hasCod ? `<div style="font-size: 1.1rem; font-weight: 900; color: #FF3B30; margin-top: 5px; border-top: 1px solid #FF6600; padding-top:4px;">REEMBOLSO: ${escapeHtml(t.cod)} €</div>` : ''}
                         </div>
                    </div>

                     <!-- Right: Ticket ID & QR -->
                    <div style="flex: 1; text-align: right; display: flex; flex-direction: row-reverse; gap: 10px; align-items: start;">
                         <div style="text-align: right;">
                              <div style="font-size: 1rem; font-weight: bold; margin-bottom: 5px;">${validDateStr}</div>
                              <div style="font-size: 0.75rem; color: #555; text-transform:uppercase; font-weight: 800;">Albarán Nº</div>
                              <div style="font-family: 'Outfit', sans-serif; font-size: 1.28rem; color: #000; font-weight: 800; letter-spacing: -1px;">${escapeHtml(t.id)}</div>
                         </div>
                         <div style="background: white; padding: 2px; border: 1px solid #eee;">
                            <img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(`ID:${t.id}|DEST:${t.receiver || ''}|ADDR:${t.address || ''}|PROV:${t.province || ''}|TEL:${t.phone || ''}|COD:${t.cod || 0}|BULTOS:${t.packages || 1}|PESO:${t.weight || 0}|OBS:${t.notes || ''}|CLI:${t.clientIdNum || ''}|NIF:${t.receiverNif || ''}`)}" 
                                 alt="QR Albaran" style="display: block; width: 110px; height: 110px; image-rendering: pixelated; image-rendering: -moz-crisp-edges; image-rendering: crisp-edges;">
                         </div>
                    </div>
                </div>
            
            <div style="margin-top: 5px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; position:relative;">
                <div style="border: 1px solid #ccc; padding: 5px; font-size: 0.8rem;">
                    <strong>REMITENTE:</strong><br>
                    ${escapeHtml(t.sender)}<br>
                    ${escapeHtml(t.senderAddress || '')}<br>
                    ${t.senderPhone ? `Telf: ${escapeHtml(t.senderPhone)}` : ''}
                </div>
                <div style="border: 1px solid #000; padding: 5px; font-size: 10pt;">
                    <strong>DESTINATARIO:</strong><br>
                    <div style="font-weight:bold; font-size:1.1em;">${escapeHtml(t.receiver)}</div>
                    ${escapeHtml(t.address)}
                </div>
            </div>

            <table style="width: 100%; margin-top: 5px; border-collapse: collapse; border: 1px solid #ccc;">
                <thead>
                    <tr style="border-bottom: 1px solid #ccc; color: #000;">
                        <th style="border: 1px solid #ccc; padding: 1px; font-size: 0.7rem;">BULTOS</th>
                        <th style="border: 1px solid #ccc; padding: 1px; font-size: 0.7rem;">PESO</th>
                        <th style="border: 1px solid #ccc; padding: 1px; font-size: 0.7rem;">MEDIDA</th>
                        ${hasCod ? '<th style="border: 1px solid #ccc; padding: 1px; font-size: 0.7rem;">REEMBOLSO</th>' : ''}
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>

            <!-- Total Summary -->
            <div style="margin-top: 5px; border: 1px solid #ccc; padding: 5px; background:transparent; display:flex; justify-content:space-around; font-weight:bold; font-size:1rem;">
                <span>TOTAL BULTOS: ${displayList.reduce((sum, p) => sum + (parseInt(p.qty) || 1), 0)}</span>
                <span>TOTAL PESO: ${displayList.reduce((sum, p) => sum + ((parseFloat(p.weight) || 0) * (parseInt(p.qty) || 1)), 0).toFixed(2)} kg</span>
            </div>

             <div style="margin-top: 4px; border: 1px solid #ccc; padding: 2px 5px; font-size: 0.75rem; white-space: pre-wrap; word-break: break-word; overflow: hidden; max-height: 50px;">
                <strong>Observaciones:</strong> ${escapeHtml(t.notes)}
            </div>
        </div>

        <div style="margin-top: 5px; font-size: 0.7rem; width: 100%; display: flex; justify-content: flex-end; padding-right: 10px;">
            <div style="text-align:right;">
                <span>Firma y Sello:</span><br>
                <span style="font-weight: bold; text-transform: uppercase;">${escapeHtml(footerLabel)}</span>
            </div>
        </div>
    </div>
    `;
}

async function printTicket(t) {
    cleanPrintArea();
    const area = document.getElementById('print-area');
    setPrintPageSize('A4');

    const includeManifest = confirm("¿Deseas imprimir también el Manifiesto para este albarán?");

    const page = document.createElement('div');
    page.style = "width: 210mm; height: 297mm; display: flex; flex-direction: column; background: white; margin: 0 auto; box-sizing: border-box;";
    
    // Contenedores flex 1 para repartir el espacio y autoajustar al contenido
    const ticket1 = `<div style="flex: 1; width: 100%; box-sizing: border-box; padding: 8mm 10mm; display: flex; flex-direction: column; justify-content: center; align-items: center; border-bottom: 2px dashed #bbb;">
        ${generateTicketHTML(t, "Ejemplar para Administraci\u00f3n")}
    </div>`;

    const ticket2 = `<div style="flex: 1; width: 100%; box-sizing: border-box; padding: 8mm 10mm; display: flex; flex-direction: column; justify-content: center; align-items: center;">
        ${generateTicketHTML(t, "Ejemplar para el Cliente")}
    </div>`;

    page.innerHTML = ticket1 + ticket2;

    area.appendChild(page);

    if (includeManifest) {
        const manifestDiv = document.createElement('div');
        manifestDiv.style.pageBreakBefore = 'always';
        manifestDiv.innerHTML = generateManifestHTML([t]);
        area.appendChild(manifestDiv);
    }



    // Actualización síncrona en local para feedback inmediato y en la nube
    t.printed = true;
    renderTicketsList();

    try {
        const docId = t.docId || t.id;
        await db.collection('tickets').doc(docId).update({ printed: true });
        console.log("Ticket marked as printed in DB:", docId);
    } catch (e) {
        console.error("Error updating print status:", e);
    }
    document.body.classList.remove('printing-labels');

    setTimeout(() => {
        const handleAfterPrint = () => {
            cleanPrintArea();
        };
        registerAfterPrint(handleAfterPrint);
        window.print();
        setTimeout(() => { if (area.innerHTML.length > 0) cleanPrintArea(); }, 60000);
    }, 800);
}

function generateManifestHTML(tickets) {
    const today = new Date().toLocaleDateString();

    // Split tickets by Time Slot (tickets without timeSlot go to morning by default)
    const morningTickets = tickets.filter(t => t.timeSlot === 'MAÑANA' || (!t.timeSlot && t.timeSlot !== 'TARDE'));
    const afternoonTickets = tickets.filter(t => t.timeSlot === 'TARDE');

    // Helper to generate a table for a subset of tickets
    function generateTableHTML(subset, title) {
        if (subset.length === 0) return '';

        // Check columns availability
        const hasCOD = subset.some(t => t.cod && parseFloat(t.cod) > 0);
        const hasNotes = subset.some(t => t.notes && t.notes.trim().length > 0);

        let totalPackages = 0;
        let totalWeight = 0;

        subset.forEach(t => {
            const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (parseInt(t.packages) || 1);
            const weight = t.packagesList ? t.packagesList.reduce((s, p) => s + ((parseFloat(p.weight) || 0) * (parseInt(p.qty) || 1)), 0) : (parseFloat(t.weight) || 0);
            totalPackages += pkgs;
            totalWeight += weight;
        });

        return `
            <div style="margin-top: 20px;">
                <h3 style="background:#ddd; padding:5px; border:1px solid #999; text-align:center; margin-bottom:0;">${title} (${subset.length})</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 10pt; margin-top:5px;">
                    <thead>
                        <tr style="background-color: #f0f0f0;">
                            <th style="border: 1px solid #000; padding: 6px;">ALBARÁN</th>
                            <th style="border: 1px solid #000; padding: 6px;">DESTINATARIO</th>
                            <th style="border: 1px solid #000; padding: 6px;">CONTENIDO</th>
                            <th style="border: 1px solid #000; padding: 6px;">BULTOS</th>
                            <th style="border: 1px solid #000; padding: 6px;">PESO (kg)</th>
                            <th style="border: 1px solid #000; padding: 6px; width: 30px;">P/D</th>
                            ${hasCOD ? `<th style="border: 1px solid #000; padding: 6px;">REEMBOLSO</th>` : ''}
                            ${hasNotes ? `<th style="border: 1px solid #000; padding: 6px;">OBSERVACIONES</th>` : ''}
                        </tr>
                    </thead>
                    <tbody>
                        ${subset.map(t => {
            const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (parseInt(t.packages) || 1);
            const weight = t.packagesList ? t.packagesList.reduce((s, p) => s + ((parseFloat(p.weight) || 0) * (parseInt(p.qty) || 1)), 0) : (parseFloat(t.weight) || 0);

            let contentStr = '';
            if (t.packagesList && t.packagesList.length > 0) {
                const items = {};
                t.packagesList.forEach(p => {
                    const size = p.size || 'Bulto';
                    const qty = parseInt(p.qty) || 1;
                    items[size] = (items[size] || 0) + qty;
                });
                contentStr = Object.entries(items).map(([name, count]) => `${count}x ${escapeHtml(name)}`).join(', ');
            } else {
                contentStr = `${t.packages || 1}x Bulto`;
            }

            return `
                                <tr>
                                    <td style="border: 1px solid #999; padding: 4px; text-align: center; font-weight:bold;">${escapeHtml(t.id)}</td>
                                    <td style="border: 1px solid #999; padding: 4px;">${escapeHtml(t.receiver)}</td>
                                    <td style="border: 1px solid #999; padding: 4px; font-size: 0.9rem;">${contentStr}</td>
                                    <td style="border: 1px solid #999; padding: 4px; text-align: center;">${pkgs}</td>
                                    <td style="border: 1px solid #999; padding: 4px; text-align: center;">${weight.toFixed(2)}</td>
                                    <td style="border: 1px solid #999; padding: 4px; text-align: center; font-weight:bold;">${t.shippingType === 'Debidos' ? 'D' : 'P'}</td>
                                    ${hasCOD ? `<td style="border: 1px solid #999; padding: 4px; text-align: center; font-weight:bold; color:red;">${(t.cod && parseFloat(t.cod) > 0) ? escapeHtml(t.cod) + ' €' : ''}</td>` : ''}
                                    ${hasNotes ? `<td style="border: 1px solid #999; padding: 4px; font-size: 0.7rem;">${escapeHtml(t.notes || '')}</td>` : ''}
                                </tr>
                            `;
        }).join('')}
                    </tbody>
                    <tfoot>
                        <tr style="font-weight: bold; background-color: #fafafa;">
                            <td colspan="3" style="border: 1px solid #000; padding: 6px; text-align: right;">TOTALES ${title}:</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center;">${totalPackages}</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center;">${totalWeight.toFixed(2)}</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center;">-</td>
                            ${hasCOD ? `<td style="border: 1px solid #000; padding: 6px;"></td>` : ''}
                            ${hasNotes ? `<td style="border: 1px solid #000; padding: 6px;"></td>` : ''}
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;
    }

    const morningHTML = generateTableHTML(morningTickets, "TURNO DE MAÑANA");
    const afternoonHTML = generateTableHTML(afternoonTickets, "TURNO DE TARDE");

    // Fallback if empty
    let content = morningHTML + afternoonHTML;
    if (!content) content = '<div style="text-align:center; padding:20px;">No hay envíos para este manifiesto.</div>';

    return `
        <div class="manifest-page" style="width: 100%; min-height: 260mm; font-family: Calibri, Arial, sans-serif; padding: 20px; box-sizing: border-box; background: white;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 10px;">
                <div>
                    <h2 style="margin:0; text-transform:uppercase; color:#FF6600;">Manifiesto de Salida</h2>
                    <div style="font-size:0.9rem;">RELACIÓN DE ENVÍOS DIARIOS</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size: 1.2rem; font-weight:bold;">${escapeHtml(tickets[0] ? tickets[0].sender : (getCompanyName(db.companyId) || 'NOVAPACK'))}</div>
                    <div style="font-size: 1.2rem; font-weight:bold;">Fecha: ${new Date().toLocaleDateString()}</div>
                    <div style="font-size: 0.9rem;">Total Envíos: ${tickets.length}</div>
                </div>
            </div>
            
            ${content}
            
            <div style="margin-top: 40px; border-top: 1px solid #000; width: 300px; padding-top: 5px; text-align: center; float:right;">
                Firma y Sello del Transportista
            </div>
        </div>
    `;
}

// --- SHIFT BATCH PRINTING ---

async function printManifestOnlyBatch(slot = 'AMBOS') {
    cleanPrintArea();
    const area = document.getElementById('print-area');
    setPrintPageSize('A4');
    if (!area) return;
    const today = getTodayLocal();
    showLoading();
    let tickets = [];
    (lastTicketsBatch || []).forEach(d => {
        const ts = parseSafeDate(d.createdAt);
        const dStr = formatDateLocal(ts);

        if (dStr === today) {
            // El Manifiesto DEBE imprimir todos los albaranes de hoy, estén ya impresos (sus etiquetas) o no
            if (slot === 'AMBOS' || d.timeSlot === slot || !d.timeSlot) {
                tickets.push({ ...d, id: d.id || d.docId });
            }
        }
    });

    if (tickets.length === 0) {
        hideLoading();
        alert(slot === 'AMBOS' ? "No hay albaranes registrados hoy." : `No hay albaranes para el turno ${slot} hoy.`);
        return;
    }

    area.innerHTML = `
                <div style="background:white; padding:20px; min-height:297mm;">
                    <div style="text-align:center; font-weight:bold; font-size:1.2rem; margin-bottom:10px; color:#FF6600;">
                        MANIFIESTO - TURNO: ${escapeHtml(slot)}
                    </div>
            ${generateManifestHTML(tickets)}
        </div>
                `;

    hideLoading();
    setTimeout(() => {
        const handleAfterPrint = () => {
            cleanPrintArea();
        };
        registerAfterPrint(handleAfterPrint);
        window.print();
        setTimeout(() => { if (area.innerHTML.length > 0) cleanPrintArea(); }, 60000);
    }, 250);
}
function handleExportCSV() {
    if (currentReportData.length === 0) { alert("No hay datos para exportar."); return; }
    let csv = "ID;FECHA;CLIENTE;ZONA;BULTOS;PESO;TIPO;PORTES;REEMBOLSO\n";
    currentReportData.forEach(t => {
        const d = (t.createdAt && t.createdAt.toDate) ? t.createdAt.toDate() : new Date(t.createdAt);
        const dStr = d.toLocaleDateString();
        const pkgCount = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : 1;
        const weight = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseFloat(p.weight) || 0), 0) : 0;
        csv += `${t.id};${dStr};${t.receiver};${t.province || ''};${pkgCount};${weight.toFixed(1)};${t.timeSlot || ''};${t.shippingType};${t.cod || ''} \n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `reporte_novapack_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

async function printShiftBatch(slot, reprint = false) {
    const today = getTodayLocal();
    cleanPrintArea();
    setPrintPageSize('A4');
    showLoading();
    try {
        let tickets = [];
        (lastTicketsBatch || []).forEach(d => {
            const ts = parseSafeDate(d.createdAt);
            const dStr = formatDateLocal(ts);

            // Los turnos sí deben ocultar los ya impresos (a menos que se ordene reimprimir explícitamente)
            if (dStr === today && d.timeSlot === slot && (!d.printed || reprint)) {
                tickets.push({ ...d });
            }
        });
        hideLoading();

        if (tickets.length === 0) { alert(`No hay albaranes para el turno ${slot} hoy.`); return; }
        if (!confirm(`¿Imprimir ${tickets.length} albaranes y Manifiesto ? `)) return;

        const area = document.getElementById('print-area');
        window.printingTickets = tickets; // Prevent sidebar corruption

        const updatePromises = [];
        tickets.forEach(t => {
            const page = document.createElement('div');
            page.style = "width: 210mm; height: 297mm; display: flex; flex-direction: column; background: white; margin: 0 auto; box-sizing: border-box; page-break-after: always;";
            
            const ticket1 = `<div style="flex: 1; width: 100%; box-sizing: border-box; padding: 8mm 10mm; display: flex; flex-direction: column; justify-content: center; align-items: center; border-bottom: 2px dashed #bbb;">
                ${generateTicketHTML(t, "Ejemplar para Administraci\u00f3n")}
            </div>`;

            const ticket2 = `<div style="flex: 1; width: 100%; box-sizing: border-box; padding: 8mm 10mm; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                ${generateTicketHTML(t, "Ejemplar para el Cliente")}
            </div>`;

            page.innerHTML = ticket1 + ticket2;
            area.appendChild(page);

            t.printed = true;
            if (t.docId) {
                updatePromises.push(db.collection('tickets').doc(t.docId).update({ printed: true }));
            }
        });

        renderTicketsList();
        Promise.allSettled(updatePromises).then(function(results) {
            var failed = results.filter(function(r) { return r.status === 'rejected'; });
            if (failed.length > 0) {
                console.error("Batch update failures:", failed);
                alert("Aviso: " + failed.length + " ticket(s) no se pudieron marcar como impresos en la base de datos. Verifique la conexión.");
            }
        });

        // Append manifest via appendChild to avoid innerHTML re-serialization (preserves QR images)
        const manifestWrapper = document.createElement('div');
        manifestWrapper.style.pageBreakBefore = 'always';
        manifestWrapper.innerHTML = generateManifestHTML(tickets);
        area.appendChild(manifestWrapper);

        setTimeout(() => {
            const handleAfterPrint = () => {
                cleanPrintArea();
            };
            registerAfterPrint(handleAfterPrint);
            window.print();
            setTimeout(() => { if (area.innerHTML.length > 0) cleanPrintArea(); }, 60000);
        }, 800);
    } catch (e) {
        console.error("Print batch error:", e);
        alert("Error preparando impresión: " + e.message);
    } finally {
        hideLoading();
    }
}

// --- LABELS PRINTING ---
document.getElementById('btn-print-labels-morning').onclick = () => printLabelShiftBatch('MAÑANA');
document.getElementById('btn-print-labels-afternoon').onclick = () => printLabelShiftBatch('TARDE');

function generateLabelHTML(t, index, total, weightStr, isA4 = false) {
    // Company name for label header
    const _lComp = (typeof companies !== 'undefined' && typeof currentCompanyId !== 'undefined') ? companies.find(c => c.id === currentCompanyId) : null;
    const companyName = (_lComp && _lComp.name) ? _lComp.name : (t.compName || t.sender || 'NOVAPACK');
    const companyEmail = (_lComp && _lComp.email) ? _lComp.email : (t.senderEmail || 'administracion@novapack.info');

    if (!weightStr) {
        let w = t.packagesList ? (t.packagesList[index] ? t.packagesList[index].weight : (t.packagesList[0] ? t.packagesList[0].weight : 0)) : t.weight;
        if (typeof w === 'number') w = w + " kg";
        if (typeof w === 'string' && !w.includes('kg')) w = w + " kg";
        weightStr = w;
    }
    const inlineStyle = isA4 ? "height: 100%; padding: 10px; box-sizing: border-box; font-family: sans-serif; position: relative; overflow: hidden; margin: 0; display: flex; flex-direction: column; background:white; print-color-adjust: exact; -webkit-print-color-adjust: exact;" : "width: 100%; height: 100%; max-width: 4in; max-height: 6in; border: 3px solid #000; padding: 10px; box-sizing: border-box; font-family: sans-serif; position: relative; overflow: hidden; margin: 0 auto; display: flex; flex-direction: column; background:white; print-color-adjust: exact; -webkit-print-color-adjust: exact;";

    const contentBox = `
        <div class="label-item" style="${inlineStyle}">
            
            
            <!-- Header: Logo & Sender -->
            <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #FF6600; padding-bottom: 8px; margin-bottom: 8px; z-index:1;">
                <div style="width: 40%;">
                    <div style="font-family: 'Xenotron', sans-serif; font-size: 16pt; color: #FF6600; line-height: 0.9;">NOVAPACK<span style="color:#FF3B30; font-weight:900; font-family:sans-serif;">&#10148;</span></div>
                    <div style="font-size: 0.5rem; letter-spacing: 0.5px; color:#333;">${companyEmail}</div>
                    <div style="font-size: 0.65rem; color:#666; margin-top: 4px;">${new Date(t.createdAt).toLocaleDateString()} ${new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                <div style="width: 60%; text-align: right; font-size: 0.7rem; color: #000; line-height: 1.1;">
                    <strong style="font-size:0.6rem; color:#666;">REMITENTE:</strong><br>
                    <strong style="font-size:0.8rem; text-transform:uppercase;">${t.sender}</strong><br>
                    ${t.senderAddress || ''}
                </div>
            </div>

            <!-- Receiver -->
            <div style="flex:1; display:flex; flex-direction:column; justify-content:center; text-align: center; z-index:1; padding-bottom: 20px; padding-right: 110px; padding-left: 20mm; position:relative;">
                <div style="font-size:0.8rem; color:#666; text-align:left; width:100%; margin-bottom:5px;">DESTINATARIO:</div>
                <div style="font-size: 20pt; font-weight: 900; line-height: 1; text-transform: uppercase; margin-bottom: 10px; color: #000;">
                    ${t.receiver}
                </div>
                <div style="font-size: 10pt; line-height: 1.2; overflow: hidden;">
                    ${t.address}
                </div>
                ${t.province ? `<div style="font-size: 22pt; font-weight:900; text-transform:uppercase; color: #FF6600; margin-top: 4px;">${t.province}</div>` : ''}
                ${t.notes ? `<div style="font-size: 0.8rem; font-weight: bold; color: #333; margin-top: 10px; border-top: 1px dotted #ccc; padding-top: 5px; white-space: pre-wrap; word-break: break-word; overflow: hidden; line-height: 1.2;">OBS: ${t.notes}</div>` : ''}
                
                <!-- Label QR -->
                <div style="position: absolute; bottom: 0; right: 0;">
                     <img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(`ID:${t.id}|DEST:${t.receiver || ''}|ADDR:${t.address || ''}|PROV:${t.province || ''}|TEL:${t.phone || ''}|COD:${t.cod || 0}|BULTOS:${total}|PESO:${t.weight || 0}|PKG:${index+1}/${total}`)}&t=${Date.now()}" 
                         style="width: 100px !important; height: 100px !important; display: block; background: white; padding: 4px; image-rendering: pixelated; image-rendering: -moz-crisp-edges; image-rendering: crisp-edges; max-width: none !important; max-height: none !important; min-width: 100px !important; min-height: 100px !important;">
                </div>
            </div>


            <!-- Footer Info -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; border-top: 1px solid #ccc; padding-top: 8px; margin-top: 8px; z-index:1; background: transparent;">
                <div style="text-align: center; flex: 1;">
                    <div style="font-size: 7pt; color:#666;">Bulto</div>
                    <div style="font-size: 16pt; font-weight: bold;">${index + 1} / ${total}</div>
                </div>

                <div style="text-align: center; flex: 2; border-left: 1px solid #ccc; border-right: 1px solid #ccc; padding: 0 5px;">
                    <strong style="font-size: 12pt; display: block;">${t.id}</strong>
                    ${t.timeSlot ? `<div style="font-size: 0.75rem; font-weight: 800; color: #333; margin-top: 2px; text-transform: uppercase;">TURNO: ${t.timeSlot}</div>` : ''}
                </div>

                <div style="text-align: center; flex: 1;">
                    <div style="font-size: 7pt; color:#666;">Peso</div>
                    <div style="font-size: 12pt; font-weight:bold;">${weightStr}</div>
                </div>
            </div>

            ${(t.cod && parseFloat(t.cod) > 0) ? `
            <div style="position: absolute; top: 120px; right: -5px; transform: rotate(15deg); background: white; color: black; padding: 4px 10px; font-weight: 900; border-radius: 4px; font-size: 0.8rem; border: 3px solid black; box-shadow: 2px 2px 5px rgba(0,0,0,0.2); text-align: center; line-height: 1.1; z-index: 10;">
                ATENCIÓN<br>REEMBOLSO<br>
                <span style="font-size: 1.2rem; color: black;">${t.cod} €</span>
            </div>` : ''}
        </div>
    `;

    if (isA4) return contentBox;

    return `<div class="label-page-4x6">${contentBox}</div>`;
}

async function printLabelShiftBatch(slot) {
    const today = getTodayLocal();
    showLoading();
    try {
        let tickets = [];
        (lastTicketsBatch || []).forEach(d => {
            let dStr = today;
            if (d.createdAt) {
                const ts = d.createdAt.toDate ? d.createdAt.toDate() : new Date(d.createdAt);
                if (!isNaN(ts.getTime())) dStr = formatDateLocal(ts);
            }
            if (dStr === today && d.timeSlot === slot && !d.printed) tickets.push({ ...d });
        });
        hideLoading();

        if (tickets.length === 0) { alert(`No hay etiquetas para el turno ${slot} hoy.`); return; }
        
        // Show paper selector before printing
        showPaperSelectModal((paperMode) => {
            cleanPrintArea();
            const area = document.getElementById('print-area');
            window.printingTickets = tickets;
            
            if (paperMode === 'a4' || paperMode === 'pdf') {
                setPrintPageSize('A4 portrait');
            } else {
                setPrintPageSize('60mm 90mm');
            }

            // PDF reusa el mismo renderizado que A4 (grid 2x2) — sale como
            // PDF descargable que el cliente abre en su visor preferido y
            // donde sí puede afinar exactamente el tamaño desde Adobe/Edge.
            const isA4 = (paperMode === 'a4' || paperMode === 'pdf');

            let labelsHtml = [];
            tickets.forEach(t => {
                const totalPkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : 1;
                for (let i = 0; i < totalPkgs; i++) labelsHtml.push(generateLabelHTML(t, i, totalPkgs, null, isA4));
            });

            renderLabelsInA4Grid(area, labelsHtml, isA4 ? 'a4' : 'label');

            document.body.classList.add('printing-labels');

            tickets.forEach(t => {
                t.printed = true;
                if (t.docId) {
                    db.collection('tickets').doc(t.docId).update({ printed: true }).catch(e => console.error("Labels batch update fail:", e));
                }
            });
            renderTicketsList();

            setTimeout(async () => {
                if (paperMode === 'pdf' && typeof html2pdf === 'function') {
                    try {
                        await html2pdf().from(area).set({
                            margin: 0,
                            filename: 'Etiquetas_' + slot + '_' + new Date().toISOString().slice(0,10) + '.pdf',
                            image: { type: 'jpeg', quality: 0.95 },
                            html2canvas: { scale: 2, useCORS: true, allowTaint: true },
                            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                        }).save();
                    } catch(e) {
                        alert('Error generando PDF: ' + e.message + '\nUsando impresión normal como fallback.');
                        window.print();
                    } finally {
                        cleanPrintArea();
                    }
                    return;
                }
                const handleAfterPrint = () => {
                    cleanPrintArea();
                };
                registerAfterPrint(handleAfterPrint);
                window.print();
                setTimeout(() => { if (area.innerHTML.length > 0) cleanPrintArea(); }, 60000);
            }, 800);
        });
    } catch (e) {
        console.error("Print labels error:", e);
        alert("Error preparando etiquetas: " + e.message);
    } finally {
        hideLoading();
    }
}

function renderLabelsInA4Grid(container, labelsHtml, paperMode) {
    container.style = "display: flex; flex-wrap: wrap; width: 100%; align-content: flex-start; background: white;";
    
    if (paperMode === 'a4') {
        // A4 MODE: 4 labels per page (2x2 grid)
        for (let i = 0; i < labelsHtml.length; i += 4) {
            const page = document.createElement('div');
            page.className = "print-a4-page";
            page.style = `
                width: 210mm; height: 297mm; 
                display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
                gap: 4mm; padding: 10mm 8mm;
                box-sizing: border-box; page-break-after: always; background: white;
                overflow: hidden;
            `;
            
            for (let j = 0; j < 4; j++) {
                const cell = document.createElement('div');
                cell.style = "border: 1px solid #ccc; border-radius: 4px; overflow: hidden; box-sizing: border-box; background: white;";
                if (i + j < labelsHtml.length) {
                    cell.innerHTML = labelsHtml[i + j];
                }
                page.appendChild(cell);
            }
            container.appendChild(page);
        }
    } else {
        // LABEL PRINTER MODE: One label per page (6x9cm with generous margins)
        labelsHtml.forEach((html) => {
            const page = document.createElement('div');
            page.className = "print-label-page";
            page.style = `
                width: 60mm; min-height: 90mm; max-height: 90mm;
                page-break-after: always; page-break-inside: avoid; 
                overflow: hidden; background: white; 
                padding: 3mm; box-sizing: border-box;
            `;
            page.innerHTML = html;
            container.appendChild(page);
        });
    }
}

// --- PAPER TYPE SELECTOR MODAL ---
function showPaperSelectModal(callback) {
    let modal = document.getElementById('modal-paper-select');
    if (modal) modal.remove();

    // Recordamos la última elección del usuario para reducir clics y para
    // recordar a la impresora de oficinas distintas su configuración.
    const lastChoice = (function() {
        try { return localStorage.getItem('paperLastChoice') || ''; } catch(e) { return ''; }
    })();

    modal = document.createElement('div');
    modal.id = 'modal-paper-select';
    modal.style = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:9999; display:flex; justify-content:center; align-items:center; padding:20px;';
    modal.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #444; border-radius:16px; padding:30px; max-width:560px; width:100%; text-align:center;">
            <h3 style="color:var(--brand-primary, #FF4D00); margin-top:0; font-size:1.2rem;">🖨️ FORMATO DE IMPRESIÓN</h3>
            <p style="color:#888; font-size:0.85rem; margin-bottom:6px;">Elige según tu impresora. Tu última elección se recuerda.</p>
            ${lastChoice ? `<p style="color:#FF9F0A; font-size:0.72rem; margin:0 0 16px;">Último uso: <strong>${lastChoice === 'label' ? 'Etiquetadora' : (lastChoice === 'a4' ? 'A4' : 'PDF')}</strong></p>` : '<div style="margin-bottom:14px;"></div>'}

            <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
                <button id="btn-paper-label" style="flex:1; min-width:150px; padding:22px 12px; background:${lastChoice==='label'?'rgba(255,77,0,0.10)':'#2d2d30'}; border:2px solid ${lastChoice==='label'?'#FF4D00':'#555'}; cursor:pointer; border-radius:12px; text-align:center; transition:all 0.2s;" onmouseover="this.style.borderColor='#FF4D00'" onmouseout="this.style.borderColor='${lastChoice==='label'?'#FF4D00':'#555'}'">
                    <div style="font-size:2.2rem; margin-bottom:6px;">🏷️</div>
                    <div style="color:#d4d4d4; font-weight:900; font-size:0.95rem;">ETIQUETADORA</div>
                    <div style="color:#888; font-size:0.72rem; margin-top:4px;">60 × 90 mm</div>
                    <div style="color:#666; font-size:0.62rem; margin-top:3px;">1 etiqueta / hoja</div>
                </button>

                <button id="btn-paper-a4" style="flex:1; min-width:150px; padding:22px 12px; background:${lastChoice==='a4'?'rgba(255,77,0,0.10)':'#2d2d30'}; border:2px solid ${lastChoice==='a4'?'#FF4D00':'#555'}; cursor:pointer; border-radius:12px; text-align:center; transition:all 0.2s;" onmouseover="this.style.borderColor='#FF4D00'" onmouseout="this.style.borderColor='${lastChoice==='a4'?'#FF4D00':'#555'}'">
                    <div style="font-size:2.2rem; margin-bottom:6px;">📄</div>
                    <div style="color:#d4d4d4; font-weight:900; font-size:0.95rem;">A4</div>
                    <div style="color:#888; font-size:0.72rem; margin-top:4px;">210 × 297 mm</div>
                    <div style="color:#666; font-size:0.62rem; margin-top:3px;">4 etiquetas / hoja</div>
                </button>

                <button id="btn-paper-pdf" style="flex:1; min-width:150px; padding:22px 12px; background:${lastChoice==='pdf'?'rgba(255,77,0,0.10)':'#2d2d30'}; border:2px solid ${lastChoice==='pdf'?'#FF4D00':'#555'}; cursor:pointer; border-radius:12px; text-align:center; transition:all 0.2s;" onmouseover="this.style.borderColor='#FF4D00'" onmouseout="this.style.borderColor='${lastChoice==='pdf'?'#FF4D00':'#555'}'">
                    <div style="font-size:2.2rem; margin-bottom:6px;">📥</div>
                    <div style="color:#d4d4d4; font-weight:900; font-size:0.95rem;">PDF</div>
                    <div style="color:#888; font-size:0.72rem; margin-top:4px;">Descargar archivo</div>
                    <div style="color:#666; font-size:0.62rem; margin-top:3px;">Imprime desde el visor</div>
                </button>
            </div>

            <div style="margin-top:18px; background:rgba(255,159,10,0.08); border:1px solid rgba(255,159,10,0.25); border-radius:8px; padding:10px 14px; font-size:0.72rem; color:#FF9F0A; text-align:left; line-height:1.45;">
                <strong>💡 Importante:</strong> en el diálogo de impresión que aparecerá después, verifica que:
                <ul style="margin:4px 0 0 18px; padding:0;">
                    <li>Tamaño de papel = el que elegiste arriba</li>
                    <li>Márgenes = <strong>Ninguno</strong> o <strong>None</strong></li>
                    <li>Escala = <strong>100 %</strong> (no "ajustar a página")</li>
                </ul>
                <span style="color:#888;">Si tu impresora no acepta el formato, prueba con <strong>PDF</strong> y abrirlo desde el visor de Windows.</span>
            </div>

            <button onclick="document.getElementById('modal-paper-select').remove();" style="margin-top:16px; background:none; border:1px solid #555; color:#888; padding:8px 30px; cursor:pointer; border-radius:6px; font-size:0.8rem;">Cancelar</button>
        </div>
    `;
    document.body.appendChild(modal);

    function pick(mode) {
        try { localStorage.setItem('paperLastChoice', mode); } catch(e) {}
        modal.remove();
        callback(mode);
    }
    document.getElementById('btn-paper-label').onclick = () => pick('label');
    document.getElementById('btn-paper-a4').onclick = () => pick('a4');
    document.getElementById('btn-paper-pdf').onclick = () => pick('pdf');
}

async function printLabel(t) {
    // Show paper type selection first
    showPaperSelectModal(async (paperMode) => {
        cleanPrintArea();
        const area = document.getElementById('print-area');

        if (paperMode === 'a4' || paperMode === 'pdf') {
            setPrintPageSize('A4 portrait');
        } else {
            setPrintPageSize('60mm 90mm');
        }

        const totalPkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : 1;
        let labelsHtml = [];
        const isA4 = (paperMode === 'a4' || paperMode === 'pdf');
        for (let i = 0; i < totalPkgs; i++) labelsHtml.push(generateLabelHTML(t, i, totalPkgs, null, isA4));

        renderLabelsInA4Grid(area, labelsHtml, isA4 ? 'a4' : 'label');

        document.body.classList.add('printing-labels');

        t.printed = true;
        renderTicketsList();

        try {
            const docId = t.docId || t.id;
            await db.collection('tickets').doc(docId).update({ printed: true });
            console.log("Label marked as printed in DB:", docId);
        } catch (e) {
            console.error("Error updating label print status:", e);
        }

        // Improved printing sequence for mobile
        const handleAfterPrint = () => {
            cleanPrintArea();
        };

        setTimeout(async () => {
            if (paperMode === 'pdf' && typeof html2pdf === 'function') {
                try {
                    await html2pdf().from(area).set({
                        margin: 0,
                        filename: 'Etiqueta_' + (t.id || t.docId || 'NP') + '.pdf',
                        image: { type: 'jpeg', quality: 0.95 },
                        html2canvas: { scale: 2, useCORS: true, allowTaint: true },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                    }).save();
                } catch(e) {
                    alert('Error generando PDF: ' + e.message + '\nUsando impresión normal como fallback.');
                    window.print();
                } finally {
                    cleanPrintArea();
                }
                return;
            }
            registerAfterPrint(handleAfterPrint);
            window.print();
            setTimeout(() => { if (area.innerHTML.length > 0) cleanPrintArea(); }, 60000);
        }, 800);
    });
}





async function setClientContext(idNum) {
    showLoading();
    try {
        const snap = await db.collection('users').where('idNum', '==', idNum).get();
        if (snap.empty) { alert("ID de cliente no encontrado."); return; }

        const userDoc = snap.docs[0];
        const uData = userDoc.data();

        const compSnap = await db.collection('users').doc(userDoc.id).collection('companies').get();
        if (compSnap.empty) { alert("El cliente no tiene empresas configuradas."); return; }

        const cDoc = compSnap.docs[0];
        const cData = cDoc.data();

        targetContext = {
            uid: userDoc.id,
            compId: cDoc.id,
            idNum: idNum,
            name: uData.name,
            address: cData.address,
            phone: cData.phone
        };

        // UI updates
        const userDisplay = document.getElementById('user-display-name');
        if (userDisplay) {
            userDisplay.textContent = `🚩[EXT: #${idNum}] ${uData.name} `;
            userDisplay.style.color = 'var(--brand-primary)';
        }

        // Auto-fill sender info
        document.getElementById('ticket-sender').value = uData.name;
        document.getElementById('ticket-sender-address').value = cData.address;
        document.getElementById('ticket-sender-phone').value = cData.phone;

        // Refresh with THIS client context
        initTicketListener();
        resetEditor();

    } catch (e) {
        console.error(e);
        alert("Error al cargar contexto de cliente.");
    } finally {
        hideLoading();
    }
}

// --- NAVIGATION & UI GLUE ---
function showView(viewId) {
    const views = ['dashboard-view', 'clients-view', 'reports-view', 'scanner-view', 'notifications-view'];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== viewId);
    });

    const sidebar = document.querySelector('.ticket-sidebar');
    if (sidebar) {
        sidebar.style.display = (viewId === 'dashboard-view') ? 'flex' : 'none';
        sidebar.classList.remove('mobile-active');
    }
}

// Global UI Buttons
const navHome = document.getElementById('nav-home');
if (navHome) {
    navHome.onclick = (e) => {
        if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) return;
        showView('dashboard-view');
    };
}

// Navigation: Clients
const navClientsBtn = document.getElementById('nav-clients');
if (navClientsBtn) {
    navClientsBtn.onclick = () => {
        showView('clients-view');
        renderClientsList();
    };
}

// Navigation: Reports
const navReportsBtn = document.getElementById('nav-reports');
if (navReportsBtn) {
    navReportsBtn.onclick = () => {
        showView('reports-view');
        const now = new Date();
        document.getElementById('report-date-start').valueAsDate = new Date(now.getFullYear(), now.getMonth(), 1);
        document.getElementById('report-date-end').valueAsDate = now;
        runReport();
    };
}

// Navigation: Scanner
const btnOpenScannerBtn = document.getElementById('btn-open-scanner');
if (btnOpenScannerBtn) {
    btnOpenScannerBtn.onclick = () => {
        showView('scanner-view');
        setTimeout(() => {
            startAppScanner();
        }, 200);
    };
}

const btnCloseScannerBtn = document.getElementById('btn-close-scanner');
if (btnCloseScannerBtn) {
    btnCloseScannerBtn.onclick = () => {
        stopAppScanner();
        showView('dashboard-view');
    };
}

const btnCloseClients = document.getElementById('btn-close-clients');
if (btnCloseClients) btnCloseClients.onclick = () => showView('dashboard-view');

const btnCloseReports = document.getElementById('btn-close-reports');
if (btnCloseReports) btnCloseReports.onclick = () => showView('dashboard-view');

// Navigation: Notifications Inbox
const navNotifBtn = document.getElementById('nav-notifications');
if (navNotifBtn) {
    navNotifBtn.onclick = () => {
        showView('notifications-view');
    };
}
const btnCloseNotifications = document.getElementById('btn-close-notifications');
if (btnCloseNotifications) btnCloseNotifications.onclick = () => showView('dashboard-view');


// Logout is handled by inline onclick in app.html for reliability

// Company Modal
const btnManageCompanies = document.getElementById('btn-manage-companies');
if (btnManageCompanies) {
    btnManageCompanies.onclick = async () => {
        const modal = document.getElementById('company-modal');
        if (modal) modal.classList.remove('hidden');
        renderCompanyList();
        await loadProvinces(); 
    };
}

const btnCloseCompanyModal = document.getElementById('btn-close-company-modal');
if (btnCloseCompanyModal) {
    btnCloseCompanyModal.onclick = () => {
        const modal = document.getElementById('company-modal');
        if (modal) modal.classList.add('hidden');
        resetCompanyForm();
    };
}

const companySelector = document.getElementById('company-selector');
if (companySelector) {
    companySelector.onchange = (e) => {
        currentCompanyId = e.target.value;
        localStorage.setItem('last_company_id', currentCompanyId);
        showLoading();
        Promise.all([loadProvinces(), resetEditor(), loadTickets()]).finally(hideLoading);
        initTicketListener();
    };
}

// Prevent Native Form Submissions from bypassing JS (Executed directly since script is defer)
const companyForm = document.getElementById('company-form');
if (companyForm) {
    companyForm.addEventListener('submit', handleCompanyFormSubmit);
    // Fallback por si hay otro event listener interfiriendo
    companyForm.onsubmit = handleCompanyFormSubmit;
}

const btnCancelCompEdit = document.getElementById('btn-cancel-comp-edit');
if (btnCancelCompEdit) btnCancelCompEdit.onclick = resetCompanyForm;

// Batch Print Listeners
const btnPrintMorning = document.getElementById('btn-print-morning');
if (btnPrintMorning) btnPrintMorning.onclick = () => printShiftBatch('MAÑANA', false);

const btnReprintMorning = document.getElementById('btn-reprint-morning');
if (btnReprintMorning) btnReprintMorning.onclick = () => printShiftBatch('MAÑANA', true);

const btnPrintAfternoon = document.getElementById('btn-print-afternoon');
if (btnPrintAfternoon) btnPrintAfternoon.onclick = () => printShiftBatch('TARDE', false);

const btnReprintAfternoon = document.getElementById('btn-reprint-afternoon');
if (btnReprintAfternoon) btnReprintAfternoon.onclick = () => printShiftBatch('TARDE', true);

const btnPrintLabelsMorning = document.getElementById('btn-print-labels-morning');
if (btnPrintLabelsMorning) btnPrintLabelsMorning.onclick = () => printLabelShiftBatch('MAÑANA');

const btnPrintLabelsAfternoon = document.getElementById('btn-print-labels-afternoon');
if (btnPrintLabelsAfternoon) btnPrintLabelsAfternoon.onclick = () => printLabelShiftBatch('TARDE');

// Manifest Listener (Dropdown version)
const btnManifestDropdown = document.getElementById('btn-print-manifest-dropdown');
if (btnManifestDropdown) {
    btnManifestDropdown.onclick = () => {
        const slotEl = document.getElementById('select-manifest-slot');
        const slot = slotEl ? slotEl.value : 'AMBOS';
        printManifestOnlyBatch(slot);
    };
}

// Sidebar Albarán
const btnSidebarNew = document.getElementById('btn-sidebar-new');
if (btnSidebarNew) {
    btnSidebarNew.onclick = () => {
        resetEditor();
        const sidebar = document.querySelector('.ticket-sidebar');
        if (sidebar) sidebar.classList.remove('mobile-active');
    };
}

// Mobile Toggle Logic
const btnMobileMenu = document.getElementById('btn-mobile-menu');
if (btnMobileMenu) {
    btnMobileMenu.onclick = () => {
        const sidebar = document.querySelector('.ticket-sidebar');
        if (sidebar) sidebar.classList.toggle('mobile-active');
    };
}

// --- UTILS ---
function showLoading() { document.getElementById('loading-overlay').style.display = 'flex'; }
function hideLoading() { document.getElementById('loading-overlay').style.display = 'none'; }
function showNotification(msg) { alert(msg); }

// --- APP QR SCANNER ENGINE ---
let appHtml5QrCode = null;

async function startAppScanner() {
    const container = document.getElementById('app-qr-reader');
    if (!container) return;

    if (typeof Html5Qrcode === 'undefined') {
        alert("Error: Biblioteca de escaneo no cargada.");
        return;
    }

    const scannerResult = document.getElementById('app-scanned-result');
    if (scannerResult) scannerResult.classList.add('hidden');

    if (appHtml5QrCode) {
        await stopAppScanner();
    }

    try {
        appHtml5QrCode = new Html5Qrcode("app-qr-reader");
        const config = { fps: 10, qrbox: { width: 250, height: 250 } };

        await appHtml5QrCode.start(
            { facingMode: "environment" },
            config,
            (decodedText) => {
                const cleanId = decodedText.trim(); // No .toUpperCase() to keep case sensitivity of UIDs/DocIDs
                if (cleanId) {
                    stopAppScanner();
                    showAppScannedTicket(cleanId);
                }
            }
        );
    } catch (err) {
        console.error("Scanner error:", err);
        alert("No se pudo iniciar la cámara en el panel operativo. Verifica los permisos.");
    }
}

async function stopAppScanner() {
    if (appHtml5QrCode) {
        try {
            await appHtml5QrCode.stop();
        } catch (e) {
            console.warn("Error stopping scanner app:", e);
        }
        appHtml5QrCode = null;
    }
}

async function showAppScannedTicket(id) {
    let searchId = id;
    let qrData = null;
    try {
        if (id.trim().startsWith('{')) {
            qrData = JSON.parse(id);
            searchId = qrData.docId || qrData.id || id;
        }
    } catch (e) { console.warn("Not a JSON QR", e); }

    // Pipe-separated QR format: ID:xxx|DEST:xxx|ADDR:xxx|...
    if (!qrData && id.includes('|') && id.toUpperCase().includes('ID:')) {
        const parts = id.split('|');
        const parsed = {};
        parts.forEach(p => {
            const idx = p.indexOf(':');
            if (idx > -1) {
                const key = p.substring(0, idx).trim().toUpperCase();
                const val = p.substring(idx + 1).trim();
                if (key === 'ID') parsed.id = val;
                if (key === 'DEST') parsed.r = val;
                if (key === 'ADDR') parsed.a = val;
                if (key === 'PROV') parsed.v = val;
                if (key === 'TEL') parsed.t = val;
                if (key === 'COD') parsed.c = val;
                if (key === 'BULTOS') parsed.k = val;
                if (key === 'CLI') parsed.senderIdNum = val;
            }
        });
        if (parsed.id || parsed.r) {
            qrData = parsed;
            searchId = parsed.id || id;
            console.log("App pipe-separated QR parsed:", qrData, "searchId:", searchId);
        }
    }

    // Pre-visualización rápida si tenemos datos en el QR
    if (qrData) {
        const area = document.getElementById('app-scanned-result');
        if (area) area.classList.remove('hidden');
        const idEl = document.getElementById('app-scanned-id');
        if (idEl) idEl.textContent = "ID: " + (qrData.id || searchId);
        const detailsEl = document.getElementById('app-scanned-details');
        if (detailsEl) {
            detailsEl.innerHTML = `
                <div style="margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:5px;">
                    <b>Destinatario:</b> ${escapeHtml(qrData.r || '---')}<br>
                    <b>Dirección:</b> ${escapeHtml(qrData.a || '---')}<br>
                    <b>Bultos:</b> ${escapeHtml(String(qrData.k || 1))}<br>
                    <i style="font-size:0.8rem; color: #AAA;">Cargando historial operativo...</i>
                </div>
            `;
        }
    }

    showLoading();
    try {
        // Inteligencia de búsqueda: Probar por DocID (completo) y luego por BusinessID (corto)
        let doc = await db.collection('tickets').doc(searchId).get();
        let t;
        if (doc.exists) {
            t = doc.data();
        } else {
            console.log("No DocID found in app, searching by Business ID:", searchId);
            const snap = await db.collection('tickets').where('id', '==', searchId).get();
            if (snap.empty) {
                // Fallback: try trimmed variant (remove leading zeroes)
                const trimId = searchId.replace(/^0+/, '');
                const snap2 = await db.collection('tickets').where('id', '==', trimId).get();
                if (snap2.empty) {
                    alert("No se encontró el albarán: " + searchId);
                    hideLoading();
                    return;
                }
                doc = snap2.docs[0];
                t = doc.data();
            } else {
                doc = snap.docs[0];
                t = doc.data();
            }
        }

        const area = document.getElementById('app-scanned-result');
        if (area) area.classList.remove('hidden');

        const idEl = document.getElementById('app-scanned-id');
        if (idEl) idEl.textContent = id;

        const detailsEl = document.getElementById('app-scanned-details');
        if (detailsEl) {
            detailsEl.innerHTML = `
            <div style="margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:5px;">
                <b>Cliente:</b> ${escapeHtml(t.clientName || 'Sin nombre')}<br>
                <b>Origen:</b> ${escapeHtml(t.sender || '---')}<br>
                <b>Destino:</b> ${escapeHtml(t.receiver || '---')}<br>
                <b>Estado:</b> <span class="badge ${t.status === 'Entregado' ? 'badge-success' : 'badge-pending'}">${escapeHtml(t.status || 'Pendiente')}</span>
            </div>
            <div>
                <b>Bultos:</b> ${escapeHtml(String(t.packages || 1))}<br>
                <b>Fecha:</b> ${escapeHtml(t.date || '---')}<br>
            </div>
        `;
        }

        const btnMark = document.getElementById('btn-mark-app-scanned');
        if (btnMark) {
            btnMark.onclick = async () => {
                if (t.status === 'Entregado') {
                    alert("Este albarán ya consta como ENTREGADO.");
                    return;
                }

                // Validate delivery confirmation
                const receiverName = (document.getElementById('delivery-receiver-name') || {}).value || '';
                if (!receiverName.trim()) {
                    alert("⚠️ Indica el nombre de la persona que recibe el paquete.");
                    document.getElementById('delivery-receiver-name').focus();
                    return;
                }
                if (typeof isSignatureEmpty === 'function' && isSignatureEmpty()) {
                    alert("⚠️ Se necesita la firma del receptor.");
                    return;
                }

                btnMark.disabled = true;
                btnMark.textContent = '⏳ Procesando...';

                try {
                    const docId = doc.id || doc.ref.id;
                    const storage = firebase.storage();
                    const deliveryData = {
                        status: 'Entregado',
                        delivered: true,
                        deliveredAt: firebase.firestore.FieldValue.serverTimestamp(),
                        distributedAt: firebase.firestore.FieldValue.serverTimestamp(),
                        deliveryReceiverName: receiverName.trim()
                    };

                    // Upload signature
                    const sigDataURL = typeof getSignatureDataURL === 'function' ? getSignatureDataURL() : null;
                    if (sigDataURL) {
                        const sigBlob = await (await fetch(sigDataURL)).blob();
                        const sigRef = storage.ref(`deliveries/${docId}/signature.png`);
                        await sigRef.put(sigBlob, { contentType: 'image/png' });
                        deliveryData.signatureURL = await sigRef.getDownloadURL();
                    }

                    // Upload photo if provided
                    const photoFile = document.getElementById('delivery-photo') ? document.getElementById('delivery-photo').files[0] : null;
                    if (photoFile) {
                        const ext = photoFile.name.split('.').pop() || 'jpg';
                        const photoRef = storage.ref(`deliveries/${docId}/photo.${ext}`);
                        await photoRef.put(photoFile, { contentType: photoFile.type });
                        deliveryData.photoURL = await photoRef.getDownloadURL();
                    }

                    await doc.ref.update(deliveryData);

                    // Success UI
                    detailsEl.innerHTML = `
                        <div style="text-align:center; padding:20px;">
                            <div style="font-size:3rem; margin-bottom:10px;">✅</div>
                            <div style="font-size:1.2rem; font-weight:900; color:var(--brand-primary); margin-bottom:5px;">¡ENTREGA REGISTRADA!</div>
                            <div style="color:#aaa; font-size:0.85rem;">Receptor: <b>${escapeHtml(receiverName.trim())}</b></div>
                            <div style="color:#888; font-size:0.75rem; margin-top:5px;">Firma y foto guardadas correctamente</div>
                        </div>
                    `;
                    btnMark.style.display = 'none';
                    const panel = document.getElementById('delivery-confirm-panel');
                    if (panel) panel.style.display = 'none';

                    if (typeof resetDeliveryConfirmation === 'function') resetDeliveryConfirmation();
                    if (typeof initTicketListener === 'function') initTicketListener();
                } catch (e) {
                    console.error("Error registering delivery:", e);
                    alert("Error: " + e.message);
                    btnMark.disabled = false;
                    btnMark.textContent = '✅ REGISTRAR ENTREGA';
                }
            };
        }
        hideLoading();
        hideLoading();
    } catch (e) {
        alert("Error al buscar albarán.");
    } finally {
        hideLoading();
    }
}

// --- AUTO-FILL SENDER FROM BARCODE ERP (Ej: |CLI:109) ---
document.addEventListener('input', (e) => {
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') {
        const val = e.target.value;
        const match = val.match(/\|CLI:(\d+)/i);
        if (match) {
            const cliId = parseInt(match[1]);
            // Remove the tag from the input
            e.target.value = val.replace(/\|CLI:\d+/i, '').trim();
            
            // Find company by idNum
            if (typeof companies !== 'undefined' && companies.length > 0) {
                const comp = companies.find(c => parseInt(c.idNum) === cliId);
                if (comp) {
                    // Change active company
                    if (typeof currentCompanyId !== 'undefined') currentCompanyId = comp.id;
                    
                    // Update dropdown visual
                    const sel = document.getElementById('company-selector');
                    if (sel) sel.value = comp.id;
                    
                    // Auto-fill sender info
                    const senderInp = document.getElementById('ticket-sender');
                    if (senderInp) senderInp.value = comp.name || (typeof userData !== 'undefined' && userData ? userData.name : '');
                    
                    const addrInp = document.getElementById('ticket-sender-address');
                    if (addrInp) addrInp.value = comp.address || (typeof userData !== 'undefined' && userData ? userData.senderAddress : '');
                    
                    const phoneInp = document.getElementById('ticket-sender-phone');
                    if (phoneInp) phoneInp.value = comp.phone || (typeof userData !== 'undefined' && userData ? userData.senderPhone : '');
                    
                    // Visual feedback
                    const originalBg = e.target.style.backgroundColor;
                    e.target.style.backgroundColor = 'rgba(76, 175, 80, 0.3)'; // Highlight
                    setTimeout(() => e.target.style.backgroundColor = originalBg, 400);
                }
            }
        }
    }
});

// --- EXCEL BULK IMPORT (SHEETJS) ---
const btnImportExcel = document.getElementById('btn-import-excel');
const inputExcelUpload = document.getElementById('input-excel-upload');

if (btnImportExcel && inputExcelUpload) {
    btnImportExcel.onclick = () => {
        const turnModal = document.getElementById('modal-excel-turn');
        if (turnModal) turnModal.style.display = 'flex';
        else inputExcelUpload.click();
    };
    inputExcelUpload.addEventListener('change', handleExcelUpload);
}

async function handleExcelUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!currentUser || !currentCompanyId) {
        alert("Error: Sesión no válida o empresa no seleccionada.");
        return;
    }

    if (typeof XLSX === 'undefined') {
        alert("La librería de importación (SheetJS) no se ha cargado. Por favor, refresca la página o comprueba tu conexión a internet.");
        return;
    }

    showLoading();
    try {
        // --- OBTENER RUTAS ACTIVAS PARA AUTO-ASIGNACIÓN ---
        let globalRoutes = [];
        try {
            const phonesSnap = await db.collection('config').doc('phones').collection('list').get();
            phonesSnap.forEach(doc => {
                const data = doc.data();
                if(data.label && data.number) {
                    globalRoutes.push({ label: data.label.toLowerCase(), phone: data.number, zones: data.coverageZones || '' });
                }
            });
        } catch(e) { console.error("Error fetching routes for Excel sync:", e); }

        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonA = XLSX.utils.sheet_to_json(worksheet, { header: "A", defval: "" });
        
        if (jsonA.length <= 1) {
            alert("El archivo está vacío o no tiene datos.");
            return;
        }

        // Escáner dinámico para encontrar la verdadera fila de cabeceras (superando Títulos de Archivos)
        let headerRowIndex = 0;
        let bestScore = 0;
        const kwds = ['nombre', 'destinatario', 'cliente', 'postal', 'cp', 'c.p.', 'c.p', 'direccion', 'provincia', 'localidad', 'poblacion', 'bulto', 'bultos', 'cantidad', 'cantidades', 'unidades', 'telefono', 'movil', 'municipio', 'destino'];
        
        for (let r = 0; r < Math.min(jsonA.length, 15); r++) {
            let score = 0;
            Object.values(jsonA[r]).forEach(val => {
                if (typeof val === 'string') {
                    const lVal = val.toLowerCase().trim().replace(/_/g, ' ');
                    // Solo sumar si coincide exactamente o la cabecera empieza por esa palabra (e.g. "nombre cliente")
                    if (kwds.some(k => lVal === k || lVal.startsWith(k + " "))) score++;
                }
            });
            
            if (score > bestScore) {
                bestScore = score;
                headerRowIndex = r;
            }
            if (score >= 3) {
                // If we found a row with 3+ matching strict headers, it's undeniably the header row. Break immediately.
                break;
            }
        }

        const headers = jsonA[headerRowIndex];
        
        let successCount = 0;
        let skipCount = 0;
        const groupedTickets = {};

        for (let i = headerRowIndex + 1; i < jsonA.length; i++) {
            const rawRow = jsonA[i];
            
            // Función auxiliar para leer tanto por letra de columna fija, como por nombre de cabecera dinámica
            const getVal = (...possibleHeaders) => {
                for (let h of possibleHeaders) {
                    if (h.length === 1 && rawRow[h]) return rawRow[h]; // Columna rígida (e.g., 'M')
                    // Búsqueda dinámica por nombre de cabecera
                    for (let col in headers) {
                        if (headers[col] && headers[col].toString().trim().toLowerCase() === h.toLowerCase().trim()) {
                            if (rawRow[col]) return rawRow[col];
                        }
                    }
                }
                return "";
            };

            const receiver = getVal('nombre_cliente', 'Nombre', 'Destinatario', 'Cliente', 'Nombre Cliente', 'Nombre_Cliente', 'Empresa', 'Destino');
            if (!receiver || receiver.toString().trim() === "") {
                skipCount++;
                continue;
            }

            const phone = getVal('telefono', 'Teléfono', 'Telefono', 'Telf', 'Tel', 'Movil', 'Móvil', 'Contacto');
            const address = getVal('via_publica', 'Direccion', 'Dirección', 'Domicilio', 'Calle', 'Dir', 'Direccion Entrega');
            const cp = getVal('cod_postal', 'CP', 'C.P.', 'Código Postal', 'Codigo Postal', 'Cod Postal', 'Codi Postal', 'Cod_Postal', 'Postal');
            const locality = getVal('municipio', 'Localidad', 'Población', 'Poblacion', 'Ciudad', 'Pueblo', 'Poblacio');
            const province = getVal('provincia', 'Provincia', 'Prov');
            
            let qtyStr = getVal('undes1', 'Bultos', 'Cantidades', 'Cantidad', 'Unidades', 'Cajas', 'Bulto', 'Total Bultos', 'Total_Bultos');
            let qty = parseInt(qtyStr || 1) || 1;
            
            let notes = (getVal('N', 'Observacion', 'Observaciones', 'descripcion', 'obs', 'detalle')).toString().trim() + " " + (getVal('codigo', 'cod')).toString().trim();
            notes = notes.trim();

            if (qty < 0) {
                qty = 1;
                notes = "ABONO / DEVOLUCION. " + notes;
            }

            // --- LECTURA CÓDIGOS DE BULTO EN COLUMNA M ---
            // Recuperamos el valor de la columna M o de la cabecera 'familia'
            let rawCode = (getVal('M', 'familia', 'tamaño', 'tipo')).toString().toLowerCase().trim();
            let sizeLabel = "Bulto";
            switch (rawCode) {
                case 's': sizeLabel = "Sobre"; break;
                case 'f': sizeLabel = "Furgoneta"; break;
                case 'c': sizeLabel = "Camion"; break;
                case 't': sizeLabel = "Termica"; break;
                case 'n': sizeLabel = "Turismo"; break;
                case 'cc': sizeLabel = "Camion en caja"; break;
                case 'fc': sizeLabel = "Furgon en caja"; break;
                case 'tc': sizeLabel = "Turismo en caja"; break;
                case 'peg': sizeLabel = "Caja Pegamento"; break;
                case 'g': sizeLabel = "Goma"; break;
                default: 
                    if (rawCode) sizeLabel = rawCode.charAt(0).toUpperCase() + rawCode.slice(1);
                    break;
            }

            const rowCod = parseFloat(getVal('Reembolso')) || 0;

            // Clave única de agrupación (Nombre + CP)
            const normName = receiver.toString().trim().toUpperCase();
            // EXCEL NUMBER FIX: Replace .0 at the end if SheetsJS parsed it as float, remove spaces.
            const normCP = cp.toString().trim().replace(/\.0$/, '').replace(/\D/g, '');
            const groupKey = `${normName}_${normCP}`;

            if (!groupedTickets[groupKey]) {
                const comp = companies.find(c => c.id === currentCompanyId) || companies[0];
                const myIdNum = userData ? (userData.idNum || "0").toString() : "0";

                // -- Auto-assign Driver based on coverage zones, CP, Locality --
                let assignedDriver = "";
                const routeLocality = locality.toString().trim().toLowerCase();
                const routeProv = province.toString().trim().toLowerCase();
                // Priority 1: coverage zones
                for (let r of globalRoutes) {
                    if (r.zones && !assignedDriver) {
                        var zl = r.zones.toLowerCase().split(',').map(z => z.trim());
                        if (normCP && zl.indexOf(normCP) !== -1) { assignedDriver = r.phone; break; }
                        if (routeLocality && zl.indexOf(routeLocality) !== -1) { assignedDriver = r.phone; break; }
                    }
                }
                // Priority 2: label matching
                if (!assignedDriver) {
                    for (let r of globalRoutes) {
                        if (normCP && r.label.includes(normCP)) { assignedDriver = r.phone; break; }
                        else if (routeLocality && routeLocality.length > 3 && r.label.includes(routeLocality)) { assignedDriver = r.phone; break; }
                        else if (routeProv && routeProv.length > 3 && r.label.includes(routeProv)) { assignedDriver = r.phone; break; }
                    }
                }
                // Priority 3: single route fallback
                if (!assignedDriver && globalRoutes.length === 1) assignedDriver = globalRoutes[0].phone;

                groupedTickets[groupKey] = {
                    sender: comp.name || 'NOVAPACK',
                    senderAddress: comp.address || '',
                    senderPhone: comp.phone || '',
                    receiver: normName,
                    address: address.toString().trim(),
                    number: '', 
                    province: province.toString().trim(),
                    shippingType: 'Pagados', // Default
                    packagesList: [{ qty: qty, size: sizeLabel, weight: 0 }],
                    cod: rowCod,
                    notes: notes,
                    uid: currentUser.uid,
                    storageUid: effectiveStorageUid || currentUser.uid,
                    clientIdNum: myIdNum,
                    compId: currentCompanyId,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    printed: false,
                    status: 'Pendiente',
                    timeSlot: window.pendingExcelTurn || 'MAÑANA',
                    phone: phone.toString().trim(),
                    cp: normCP,
                    localidad: locality.toString().trim(),
                    driverPhone: assignedDriver ? assignedDriver.toString().replace(/\D/g, '').replace(/^34/, '') : ""
                };
            } else {
                // Ya existe: añadir bultos y sumar reembolsos
                groupedTickets[groupKey].packagesList.push({ qty: qty, size: sizeLabel, weight: 0 });
                groupedTickets[groupKey].cod += rowCod;
                if (notes) {
                    groupedTickets[groupKey].notes += (groupedTickets[groupKey].notes ? " | " : "") + notes;
                }
            }
        }

        // 2. Subir albaranes agrupados a Firebase
        const uniqueTickets = Object.values(groupedTickets);
        let isFirstInSession = true;
        
        // Generate a unique batch ID for this import (allows undo)
        const importBatchId = 'EXCEL_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 4);
        
        for (let i = 0; i < uniqueTickets.length; i++) {
            const tData = uniqueTickets[i];
            
            let businessId = await getNextId();
            const docId = `${tData.clientIdNum}_${currentCompanyId}_${businessId}`;
            
            tData.id = businessId;
            tData.packages = tData.packagesList.reduce((sum, p) => sum + (parseInt(p.qty) || 1), 0);
            tData.importBatchId = importBatchId; // Tag for undo
            Object.assign(tData, getOperatorStamp());

            await db.collection('tickets').doc(docId).set(tData);

            if (isFirstInSession) {
                
                isFirstInSession = false;
            }
            
            // Registrar cliente en la agenda del usuario (Ignora fallos no críticos)
            if (tData.receiver && tData.address) {
                await saveClientToAgenda(tData).catch(e => console.error("Error importando destinatario a agenda:", e));
            }
            
            successCount++;
        }

        // Store batch ID for undo capability
        localStorage.setItem('lastExcelBatchId', importBatchId);
        localStorage.setItem('lastExcelBatchCount', successCount.toString());
        localStorage.setItem('lastExcelBatchTime', new Date().toLocaleString());
        
        // Show/update undo button
        updateUndoExcelButton();

        alert(`¡Importación completada con éxito!\n\nSe han importado ${successCount} envíos.\nFilas ignoradas (vacías): ${skipCount}\n\n💡 Si te has equivocado, pulsa "↩️ DESHACER" para eliminar este lote.`);
        inputExcelUpload.value = '';

    } catch (e) {
        console.error("Excel Import Error:", e);
        alert("Ocurrió un error leyendo el Excel: " + e.message);
    } finally {
        // Batch import complete (counter managed atomically by getNextId)
        hideLoading();
    }
}

// --- UNDO EXCEL IMPORT ---
function updateUndoExcelButton() {
    let btn = document.getElementById('btn-undo-excel');
    const batchId = localStorage.getItem('lastExcelBatchId');
    const batchCount = localStorage.getItem('lastExcelBatchCount') || '?';
    const batchTime = localStorage.getItem('lastExcelBatchTime') || '';
    
    if (!btn) {
        // Create the undo button dynamically
        const importBtn = document.getElementById('btn-import-excel');
        if (!importBtn) return;
        btn = document.createElement('button');
        btn.id = 'btn-undo-excel';
        btn.className = 'btn btn-sm';
        btn.style = 'background:#3d1111; color:#FF3B30; border:1px solid #FF3B30; font-weight:800; margin-left:5px;';
        btn.onclick = undoLastExcelImport;
        importBtn.parentNode.insertBefore(btn, importBtn.nextSibling);
    }
    
    if (batchId) {
        btn.style.display = 'inline-flex';
        btn.innerHTML = `↩️ DESHACER EXCEL (${batchCount})`;
        btn.title = `Eliminar ${batchCount} albaranes importados a las ${batchTime}`;
    } else {
        btn.style.display = 'none';
    }
}

async function undoLastExcelImport() {
    const batchId = localStorage.getItem('lastExcelBatchId');
    const batchCount = localStorage.getItem('lastExcelBatchCount') || '?';
    
    if (!batchId) {
        alert('No hay ninguna importación Excel reciente para deshacer.');
        return;
    }
    
    if (!confirm(`⚠️ ¿Estás seguro de que quieres ELIMINAR los ${batchCount} albaranes de la última carga Excel?\n\nSe borrarán incluso si ya están impresos.\nEsto es IRREVERSIBLE.`)) return;
    
    showLoading();
    try {
        // Find all tickets with this batch ID
        const snap = await db.collection('tickets').where('importBatchId', '==', batchId).get();
        
        if (snap.empty) {
            alert('No se encontraron albaranes de ese lote. Es posible que ya hayan sido eliminados.');
            localStorage.removeItem('lastExcelBatchId');
            localStorage.removeItem('lastExcelBatchCount');
            localStorage.removeItem('lastExcelBatchTime');
            updateUndoExcelButton();
            hideLoading();
            return;
        }
        
        // Delete in batches
        let deleted = 0;
        let skippedInvoiced = 0;
        const batchSize = 10;
        const docs = snap.docs;
        
        for (let i = 0; i < docs.length; i += batchSize) {
            const chunk = docs.slice(i, i + batchSize);
            const writeBatch = db.batch();
            chunk.forEach(doc => {
                const data = doc.data();
                if (data.invoiceId || data.invoiceNum) {
                    skippedInvoiced++;
                } else {
                    writeBatch.delete(doc.ref);
                    deleted++;
                }
            });
            await writeBatch.commit();
        }
        
        // Clean up
        localStorage.removeItem('lastExcelBatchId');
        localStorage.removeItem('lastExcelBatchCount');
        localStorage.removeItem('lastExcelBatchTime');
        updateUndoExcelButton();
        
        let msg = `✅ ${deleted} albaranes eliminados correctamente.`;
        if (skippedInvoiced > 0) msg += `\n⚠️ ${skippedInvoiced} albaranes facturados no se han borrado.`;
        msg += '\n\nAhora puedes cargar el Excel correcto.';
        alert(msg);
        
    } catch (err) {
        console.error('[UNDO-EXCEL] Error:', err);
        alert('Error al deshacer: ' + err.message);
    } finally {
        hideLoading();
    }
}

// Initialize undo button on load
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(updateUndoExcelButton, 2000);
});

// ═══════════════════════════════════════════════════
// GPS TRACKING — Client-side "Track my shipment" map
// ═══════════════════════════════════════════════════
let _trackingMap = null;
let _trackingMarker = null;
let _trackingUnsub = null;

function _renderTrackingBanner(t) {
    let banner = document.getElementById('gps-tracking-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'gps-tracking-banner';
        const anchor = document.getElementById('incident-info-banner');
        if (anchor) anchor.parentNode.insertBefore(banner, anchor.nextSibling);
        else {
            const editorEl = document.getElementById('editor-title');
            if (editorEl) editorEl.parentNode.parentNode.appendChild(banner);
        }
    }

    // Cleanup previous listener
    if (_trackingUnsub) { _trackingUnsub(); _trackingUnsub = null; }

    const isDelivered = t.delivered || t.status === 'Entregado';
    const hasDriver = !!(t.driverPhone);

    if (!hasDriver || isDelivered) {
        banner.innerHTML = '';
        banner.style.display = 'none';
        return;
    }

    banner.style.display = 'block';
    banner.innerHTML =
        '<div style="background:rgba(33,150,243,0.08); border:1px solid #2196F3; border-radius:10px; padding:12px 16px; margin:10px 0;">' +
            '<div style="display:flex; align-items:center; justify-content:space-between; cursor:pointer;" id="tracking-toggle">' +
                '<div style="display:flex; align-items:center; gap:8px;">' +
                    '<span style="font-size:1.1rem;">📍</span>' +
                    '<span style="color:#2196F3; font-weight:700; font-size:0.85rem;">Seguimiento en Vivo</span>' +
                    '<span id="tracking-status-dot" style="width:8px; height:8px; border-radius:50%; background:#666; display:inline-block;"></span>' +
                '</div>' +
                '<span style="color:#2196F3; font-size:0.75rem; font-weight:600;" id="tracking-toggle-label">▼ Mostrar</span>' +
            '</div>' +
            '<div id="tracking-map-container" style="height:0; overflow:hidden; transition:height 0.3s ease; border-radius:8px; margin-top:0;"></div>' +
            '<div id="tracking-info" style="display:none; font-size:0.72rem; color:#aaa; margin-top:6px; text-align:center;"></div>' +
        '</div>';

    document.getElementById('tracking-toggle').onclick = function() {
        var container = document.getElementById('tracking-map-container');
        var label = document.getElementById('tracking-toggle-label');
        if (container.style.height === '0px' || container.style.height === '0') {
            container.style.height = '250px';
            container.style.marginTop = '10px';
            label.textContent = '▲ Ocultar';
            setTimeout(function() { _initTrackingMap(t.driverPhone); }, 350);
        } else {
            container.style.height = '0';
            container.style.marginTop = '0';
            label.textContent = '▼ Mostrar';
            if (_trackingUnsub) { _trackingUnsub(); _trackingUnsub = null; }
        }
    };
}

function _initTrackingMap(driverPhone) {
    var mapEl = document.getElementById('tracking-map-container');
    if (!mapEl) return;

    if (!_trackingMap) {
        _trackingMap = new google.maps.Map(mapEl, {
            center: { lat: 40.4168, lng: -3.7038 },
            zoom: 12,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
            zoomControl: true
        });
    } else {
        google.maps.event.trigger(_trackingMap, 'resize');
    }

    var normalPhone = driverPhone.replace(/\D/g, '').replace(/^34/, '');
    var docId = normalPhone.replace(/[^a-zA-Z0-9]/g, '_');

    if (_trackingUnsub) _trackingUnsub();
    _trackingUnsub = db.collection('driver_locations').doc(docId).onSnapshot(function(snap) {
        var d = snap.data();
        var dot = document.getElementById('tracking-status-dot');
        var info = document.getElementById('tracking-info');

        if (!d || !d.lat || !d.lng) {
            if (dot) dot.style.background = '#666';
            if (info) { info.style.display = 'block'; info.textContent = 'El repartidor aún no ha activado el GPS.'; }
            return;
        }

        var updatedAt = d.updatedAt ? d.updatedAt.toDate() : null;
        var minutesAgo = updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 60000) : null;
        var isLive = d.online && minutesAgo !== null && minutesAgo < 5;

        if (dot) dot.style.background = isLive ? '#4CAF50' : '#FF9800';

        var speedText = d.speed !== null && d.speed > 0 ? d.speed + ' km/h' : 'Parado';
        var timeText = minutesAgo !== null ? (minutesAgo < 1 ? 'Ahora mismo' : 'Hace ' + minutesAgo + ' min') : '';
        if (info) {
            info.style.display = 'block';
            info.innerHTML = (isLive ? '🟢 ' : '🟡 ') + '<strong>' + escapeHtml(d.driverName || 'Repartidor') + '</strong> · ' + speedText + ' · ' + timeText;
        }

        var pos = { lat: d.lat, lng: d.lng };
        if (_trackingMarker) {
            _trackingMarker.setPosition(pos);
        } else {
            var truckSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="36" viewBox="0 0 48 36">' +
                '<defs><filter id="ds" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/></filter></defs>' +
                '<rect x="1" y="4" width="30" height="22" rx="3" fill="#2196F3" stroke="white" stroke-width="1.5" filter="url(%23ds)"/>' +
                '<path d="M31 12 L41 12 Q45 12 46 16 L47 22 Q47 26 44 26 L31 26 Z" fill="#2196F3" stroke="white" stroke-width="1.5" stroke-linejoin="round" filter="url(%23ds)"/>' +
                '<rect x="33" y="13" width="9" height="7" rx="1.5" fill="rgba(255,255,255,0.85)"/>' +
                '<circle cx="12" cy="28" r="5" fill="#333" stroke="white" stroke-width="1.5"/><circle cx="12" cy="28" r="2" fill="#999"/>' +
                '<circle cx="40" cy="28" r="5" fill="#333" stroke="white" stroke-width="1.5"/><circle cx="40" cy="28" r="2" fill="#999"/>' +
                '</svg>';
            _trackingMarker = new google.maps.Marker({
                position: pos,
                map: _trackingMap,
                icon: {
                    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(truckSvg),
                    scaledSize: new google.maps.Size(36, 27),
                    anchor: new google.maps.Point(18, 27)
                }
            });
        }
        _trackingMap.setCenter(pos);
        if (_trackingMap.getZoom() < 14) _trackingMap.setZoom(14);
    });
}

// --- GLOBAL EXPORTS FOR HTML BINDING ---
window.handleFormSubmit = handleFormSubmit;
window.handleCompanyFormSubmit = handleCompanyFormSubmit;
window.exportClientAgenda = exportClientAgenda;
window.importClientAgenda = importClientAgenda;
window.importClientAgendaFromExcel = importClientAgendaFromExcel;

// --- MIXED BACKGROUND SYNCHRONIZATION (CLIENT) ---
setInterval(() => {
    if (auth && auth.currentUser) {
        const viewDash = document.getElementById('view-dashboard');
        if (viewDash && viewDash.classList.contains('active') && typeof loadDashboard === 'function') {
            loadDashboard();
        }
    }
}, 180000); // 3 minutes heartbeat

// acceptTicketModification removed — admin changes now apply directly, client only receives notification

// --- PICKUP REQUEST (v2: third-party + auto-assign + cutoff) ---
var _pickupMode = 'self';
var _pickupThirdParty = null; // { name, address, phone, cp, localidad }
var _pickupSearchTimer = null;

window.openPickupModal = function() {
    const modal = document.getElementById('modal-pickup');
    if (!modal) return;

    // Auto-fill sender data from current company
    const comp = companies.find(c => c.id === currentCompanyId) || companies[0];
    if (comp) {
        document.getElementById('pickup-sender-name').textContent = comp.name || '\u2014';
        const addr = [comp.street, comp.number, comp.localidad, comp.cp].filter(Boolean).join(', ') || comp.address || '\u2014';
        document.getElementById('pickup-sender-address').textContent = addr;
        document.getElementById('pickup-sender-phone').textContent = comp.phone || '\u2014';
    }

    // Reset to self mode
    togglePickupMode('self');
    _pickupThirdParty = null;
    document.getElementById('pickup-destination').value = '';
    document.getElementById('pickup-packages').value = '1';
    document.getElementById('pickup-notes').value = '';
    var destOpts = document.getElementById('pickup-dest-options');
    if (destOpts) destOpts.style.display = 'none';

    modal.style.display = 'flex';
};

// --- Mode toggle ---
window.togglePickupMode = function(mode) {
    _pickupMode = mode;
    _pickupThirdParty = null;
    const btnSelf = document.getElementById('pickup-mode-self');
    const btnTP = document.getElementById('pickup-mode-thirdparty');
    const secSelf = document.getElementById('pickup-sender-section');
    const secTP = document.getElementById('pickup-thirdparty-section');

    if (mode === 'self') {
        btnSelf.style.background = '#4CAF50'; btnSelf.style.color = '#fff';
        btnTP.style.background = 'transparent'; btnTP.style.color = '#4CAF50';
        secSelf.style.display = 'block'; secTP.style.display = 'none';
    } else {
        btnTP.style.background = '#2196F3'; btnTP.style.color = '#fff';
        btnSelf.style.background = 'transparent'; btnSelf.style.color = '#4CAF50';
        secSelf.style.display = 'none'; secTP.style.display = 'block';
    }
    // Show/hide "Mis Instalaciones" button (only in third-party mode)
    var btnMyLoc = document.getElementById('btn-pickup-my-locations');
    if (btnMyLoc) btnMyLoc.style.display = (mode === 'thirdparty') ? 'inline-flex' : 'none';
    var destOpts = document.getElementById('pickup-dest-options');
    if (destOpts) destOpts.style.display = 'none';

    // Reset third-party fields
    var search = document.getElementById('pickup-tp-search');
    if (search) search.value = '';
    var results = document.getElementById('pickup-tp-results');
    if (results) { results.innerHTML = ''; results.style.display = 'none'; }
    var selected = document.getElementById('pickup-tp-selected');
    if (selected) selected.style.display = 'none';
    var manual = document.getElementById('pickup-tp-manual');
    if (manual) manual.style.display = 'none';
    var manualToggle = document.getElementById('pickup-tp-manual-toggle');
    if (manualToggle) manualToggle.style.display = 'block';
};

// --- Third-party search (agenda + PhantomDirectory) ---
(function() {
    document.addEventListener('input', function(e) {
        if (e.target.id !== 'pickup-tp-search') return;
        clearTimeout(_pickupSearchTimer);
        var q = e.target.value.trim();
        if (q.length < 2) {
            document.getElementById('pickup-tp-results').style.display = 'none';
            return;
        }
        _pickupSearchTimer = setTimeout(function() { _searchPickupContacts(q); }, 300);
    });
})();

async function _searchPickupContacts(query) {
    var results = [];
    var q = query.toLowerCase();

    // Search personal agenda
    try {
        var snap = await getCollection('destinations');
        if (snap && snap.length) {
            snap.forEach(function(d) {
                if ((d.name || '').toLowerCase().includes(q) || (d.addresses && d.addresses.some(function(a) { return (a.address || '').toLowerCase().includes(q) || (a.localidad || '').toLowerCase().includes(q); }))) {
                    var addr = d.addresses && d.addresses[0] ? d.addresses[0] : {};
                    results.push({
                        name: d.name || '', phone: d.phone || '',
                        address: addr.address || [addr.street, addr.number, addr.localidad, addr.cp].filter(Boolean).join(', '),
                        cp: addr.cp || '', localidad: addr.localidad || '',
                        source: 'agenda'
                    });
                }
            });
        }
    } catch(e) { console.warn('Agenda search error:', e); }

    // Search PhantomDirectory (global)
    if (window.searchPhantomDirectory) {
        try {
            var phantom = window.searchPhantomDirectory(query);
            phantom.forEach(function(p) {
                results.push({
                    name: p.name || '', phone: p.senderPhone || '',
                    address: [p.localidad, p.cp].filter(Boolean).join(', '),
                    cp: p.cp || '', localidad: p.localidad || '',
                    source: 'global'
                });
            });
        } catch(e) {}
    }

    // Render
    var container = document.getElementById('pickup-tp-results');
    if (results.length === 0) {
        container.innerHTML = '<div style="padding:10px; color:#888; font-size:0.8rem; text-align:center;">Sin resultados</div>';
        container.style.display = 'block';
        return;
    }
    container.innerHTML = results.slice(0, 8).map(function(r, i) {
        var badge = r.source === 'agenda'
            ? '<span style="background:#4CAF50; color:#fff; font-size:0.6rem; padding:1px 5px; border-radius:3px; font-weight:700;">MI AGENDA</span>'
            : '<span style="background:#2196F3; color:#fff; font-size:0.6rem; padding:1px 5px; border-radius:3px; font-weight:700;">GLOBAL</span>';
        return '<div onclick="selectThirdPartyContact(' + i + ')" style="padding:10px 12px; cursor:pointer; border-bottom:1px solid #333; transition:background 0.15s;" onmouseover="this.style.background=\'rgba(255,255,255,0.05)\'" onmouseout="this.style.background=\'transparent\'">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                '<strong style="color:#fff; font-size:0.85rem;">' + escapeHtml(r.name) + '</strong> ' + badge +
            '</div>' +
            '<div style="color:#aaa; font-size:0.75rem; margin-top:2px;">' + escapeHtml(r.address) + (r.phone ? ' | ' + escapeHtml(r.phone) : '') + '</div>' +
        '</div>';
    }).join('');
    container.style.display = 'block';

    // Store for selection
    window._pickupSearchResults = results.slice(0, 8);
}

window.selectThirdPartyContact = function(idx) {
    var r = window._pickupSearchResults && window._pickupSearchResults[idx];
    if (!r) return;
    _pickupThirdParty = r;
    document.getElementById('pickup-tp-name').textContent = r.name;
    document.getElementById('pickup-tp-address').textContent = r.address;
    document.getElementById('pickup-tp-phone').textContent = r.phone || '—';
    document.getElementById('pickup-tp-selected').style.display = 'block';
    document.getElementById('pickup-tp-results').style.display = 'none';
    document.getElementById('pickup-tp-search').value = '';
    document.getElementById('pickup-tp-manual').style.display = 'none';
    document.getElementById('pickup-tp-manual-toggle').style.display = 'none';
};

window.clearThirdPartySelection = function() {
    _pickupThirdParty = null;
    document.getElementById('pickup-tp-selected').style.display = 'none';
    document.getElementById('pickup-tp-manual').style.display = 'none';
    document.getElementById('pickup-tp-manual-toggle').style.display = 'block';
    document.getElementById('pickup-tp-search').value = '';
};

window.toggleManualPickupEntry = function() {
    document.getElementById('pickup-tp-manual').style.display = 'block';
    document.getElementById('pickup-tp-manual-toggle').style.display = 'none';
    document.getElementById('pickup-tp-selected').style.display = 'none';
    document.getElementById('pickup-tp-results').style.display = 'none';
    _pickupThirdParty = null;
    // Clear fields
    ['pickup-tp-manual-name','pickup-tp-manual-address','pickup-tp-manual-cp','pickup-tp-manual-phone'].forEach(function(id) {
        var el = document.getElementById(id); if (el) el.value = '';
    });
};

window.saveThirdPartyToAgenda = async function() {
    var name = (document.getElementById('pickup-tp-manual-name').value || '').trim().toUpperCase();
    var address = (document.getElementById('pickup-tp-manual-address').value || '').trim();
    var cp = (document.getElementById('pickup-tp-manual-cp').value || '').trim();
    var phone = (document.getElementById('pickup-tp-manual-phone').value || '').trim();
    if (!name) { alert('Introduce al menos el nombre.'); return; }
    try {
        var docId = name.replace(/[^a-z0-9\-_]/gi, '_').toLowerCase();
        await db.collection('users').doc(currentUser.uid).collection('destinations').doc(docId).set({
            name: name, phone: phone,
            addresses: [{ id: 'addr_' + Date.now(), address: address, cp: cp }]
        }, { merge: true });
        alert('Contacto guardado en tu agenda.');
    } catch(e) { alert('Error guardando: ' + e.message); }
};

// --- Route resolver (shared by tickets and pickups) ---
async function resolveDriverPhone(cp, localidad, province) {
    try {
        var routeCp = (cp || '').trim();
        var routeLocality = (localidad || '').toLowerCase().trim();
        var routeProvince = (province || '').toLowerCase().trim();
        var phonesSnap = await db.collection('config').doc('phones').collection('list').get();
        var routeList = [];
        phonesSnap.forEach(function(doc) {
            var d = doc.data();
            routeList.push({ label: (d.label || '').toLowerCase(), number: d.number, driverName: d.driverName || '', zones: d.coverageZones || '' });
        });
        var target = '';
        var targetLabel = '';
        // Priority 1: match coverage zones
        routeList.forEach(function(r) {
            if (r.zones && !target) {
                var zoneList = r.zones.toLowerCase().split(',').map(function(z) { return z.trim(); });
                if (routeCp && zoneList.indexOf(routeCp) !== -1) { target = r.number; targetLabel = r.label; }
                else if (routeLocality && zoneList.indexOf(routeLocality) !== -1) { target = r.number; targetLabel = r.label; }
            }
        });
        // Priority 2: match by label
        if (!target) {
            routeList.forEach(function(r) {
                if (target) return;
                if (routeCp && r.label.includes(routeCp)) { target = r.number; targetLabel = r.label; }
                else if (routeLocality && r.label === routeLocality) { target = r.number; targetLabel = r.label; }
                else if (routeLocality && routeLocality.length > 3 && r.label.includes(routeLocality)) { target = r.number; targetLabel = r.label; }
                else if (routeProvince && routeProvince.length > 3 && r.label.includes(routeProvince)) { target = r.number; targetLabel = r.label; }
            });
        }
        // Priority 3: single route default
        if (!target && routeList.length === 1) { target = routeList[0].number; targetLabel = routeList[0].label; }
        // Always return the canonical 9-digit form so all consumers compare equal.
        return { driverPhone: window.normalizePhone(target), routeLabel: targetLabel };
    } catch(e) {
        console.error('resolveDriverPhone error:', e);
        return { driverPhone: '', routeLabel: '' };
    }
}

// --- "Mis Instalaciones" destination auto-fill ---
window.fillDestinationFromCompany = function() {
    var destInput = document.getElementById('pickup-destination');
    var destOptions = document.getElementById('pickup-dest-options');
    if (!destInput || !destOptions) return;

    // If dropdown is already open, close it
    if (destOptions.style.display !== 'none') {
        destOptions.style.display = 'none';
        return;
    }

    if (companies.length === 0) return;

    // Single company: auto-fill directly
    if (companies.length === 1) {
        var c = companies[0];
        var addr = [c.street, c.number, c.localidad, c.cp, c.province].filter(Boolean).join(', ') || c.address || '';
        destInput.value = addr;
        destOptions.style.display = 'none';
        return;
    }

    // Multiple companies: show dropdown
    var html = '';
    companies.forEach(function(c, idx) {
        var addr = [c.street, c.number, c.localidad, c.cp].filter(Boolean).join(', ') || c.address || '';
        var prov = c.province ? ' (' + c.province + ')' : '';
        html += '<div onclick="selectDestinationCompany(' + idx + ')" style="padding:12px 14px; cursor:pointer; border-bottom:1px solid #333; transition:background 0.15s;" onmouseover="this.style.background=\'rgba(33,150,243,0.15)\'" onmouseout="this.style.background=\'transparent\'">' +
            '<div style="font-weight:700; font-size:0.85rem; color:#2196F3;">' +
                '<span class="material-symbols-outlined" style="font-size:0.85rem; vertical-align:middle;">business</span> ' +
                (c.name || 'Empresa ' + (idx + 1)) + prov +
            '</div>' +
            '<div style="font-size:0.78rem; color:#aaa; margin-top:3px;">' + addr + '</div>' +
        '</div>';
    });
    destOptions.innerHTML = html;
    destOptions.style.display = 'block';
};

window.selectDestinationCompany = function(idx) {
    var c = companies[idx];
    if (!c) return;
    var addr = [c.street, c.number, c.localidad, c.cp, c.province].filter(Boolean).join(', ') || c.address || '';
    document.getElementById('pickup-destination').value = addr;
    document.getElementById('pickup-dest-options').style.display = 'none';
};

// --- Submit pickup request ---
window.submitPickupRequest = async function() {
    if (!_rateLimiter.check('pickup_request', 10)) {
        alert('Has enviado demasiadas solicitudes de recogida. Espera un momento.');
        return;
    }
    const comp = companies.find(c => c.id === currentCompanyId) || companies[0];
    if (!comp) { alert('Error: no hay empresa seleccionada.'); return; }

    var pickupName, pickupAddress, pickupPhone, pickupCp, pickupLocalidad;

    if (_pickupMode === 'thirdparty') {
        // From selected contact or manual entry
        if (_pickupThirdParty) {
            pickupName = _pickupThirdParty.name;
            pickupAddress = _pickupThirdParty.address;
            pickupPhone = _pickupThirdParty.phone;
            pickupCp = _pickupThirdParty.cp;
            pickupLocalidad = _pickupThirdParty.localidad;
        } else if (document.getElementById('pickup-tp-manual').style.display !== 'none') {
            pickupName = (document.getElementById('pickup-tp-manual-name').value || '').trim();
            pickupAddress = (document.getElementById('pickup-tp-manual-address').value || '').trim();
            pickupCp = (document.getElementById('pickup-tp-manual-cp').value || '').trim();
            pickupPhone = (document.getElementById('pickup-tp-manual-phone').value || '').trim();
            pickupLocalidad = '';
        } else {
            alert('Selecciona un contacto o introduce la dirección de recogida.');
            return;
        }
        if (!pickupName && !pickupAddress) {
            alert('Introduce al menos el nombre o la dirección de recogida.');
            return;
        }
    } else {
        pickupName = comp.name || '';
        pickupAddress = [comp.street, comp.number, comp.localidad, comp.cp].filter(Boolean).join(', ') || comp.address || '';
        pickupPhone = comp.phone || '';
        pickupCp = comp.cp || '';
        pickupLocalidad = comp.localidad || '';
    }

    const destination = document.getElementById('pickup-destination').value.trim();
    const turn = document.getElementById('pickup-turn').value;
    const packages = parseInt(document.getElementById('pickup-packages').value) || 1;
    const notes = document.getElementById('pickup-notes').value.trim();
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(pickupAddress + ', Espa\u00f1a');

    showLoading();
    try {
        // Block 3: auto-assign driver by CP
        var resolved = await resolveDriverPhone(pickupCp, pickupLocalidad, '');

        // Block 2: cutoff time check (morning + afternoon slots)
        var outOfSchedule = false;
        var cutoffAM = userData ? (userData.pickupCutoffAM || '') : '';
        var cutoffPM = userData ? (userData.pickupCutoffPM || '') : '';
        var activeCutoff = '';
        if (cutoffAM || cutoffPM) {
            var now = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
            if (cutoffPM && now >= '14:00') {
                activeCutoff = cutoffPM;
                if (now > cutoffPM) outOfSchedule = true;
            } else if (cutoffAM) {
                activeCutoff = cutoffAM;
                if (now > cutoffAM) outOfSchedule = true;
            } else if (cutoffPM) {
                activeCutoff = cutoffPM;
                if (now > cutoffPM) outOfSchedule = true;
            }
        }

        var docData = {
            pickupType: _pickupMode === 'thirdparty' ? 'thirdparty' : 'self',
            senderName: pickupName,
            senderAddress: pickupAddress,
            senderPhone: pickupPhone,
            senderLocalidad: pickupLocalidad,
            senderCp: pickupCp,
            destination: destination,
            timeSlot: turn,
            packages: packages,
            notes: notes,
            mapsUrl: mapsUrl,
            uid: currentUser.uid,
            companyId: currentCompanyId,
            clientIdNum: userData ? userData.idNum : '',
            driverPhone: resolved.driverPhone,
            routeLabel: resolved.routeLabel,
            outOfSchedule: outOfSchedule,
            status: 'pending',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        // Track requester if third-party
        if (_pickupMode === 'thirdparty') {
            docData.requestedBy = comp.name || '';
            docData.requestedByCp = comp.cp || '';
        }

        await db.collection('pickupRequests').add(docData);
        document.getElementById('modal-pickup').style.display = 'none';

        // Block 2: show cutoff warning
        if (outOfSchedule) {
            var driverContact = resolved.driverPhone || (userData ? userData.defaultRoutePhone : '') || '';
            var franjaLabel = (activeCutoff === cutoffPM) ? 'tarde' : 'ma\u00f1ana';
            alert('AVISO: La solicitud se ha registrado pero est\u00e1 FUERA DE HORARIO.\n\nCorte de ' + franjaLabel + ': ' + activeCutoff + '.\n' +
                (driverContact ? 'Contacta directamente con el repartidor: ' + driverContact : 'Contacta con tu repartidor para confirmar.'));
        } else {
            alert('Solicitud de recogida enviada correctamente.\nEl repartidor recibir\u00e1 una notificaci\u00f3n.');
        }
    } catch (e) {
        console.error('Error enviando solicitud de recogida:', e);
        alert('Error al enviar la solicitud: ' + e.message);
    } finally {
        hideLoading();
    }
};
