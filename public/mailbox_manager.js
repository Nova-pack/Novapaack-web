/**
 * MAILBOX MANAGER V4.0
 * Motor del Buzón Inteligente (Gestión de incidencias y correos)
 * V4: Separación entrante/saliente, badge de nuevos, historial de estados,
 *     toggle de dirección, filtrado mejorado, UX pulida
 */

let _mailboxCache = [];
let _mailboxUnsubscribe = null;
let _mailboxDirection = 'incoming'; // 'incoming', 'outgoing', 'all'

// ============ CATEGORÍAS CENTRALIZADAS ============
const MAILBOX_CATEGORIES = {
    pod:              { emoji: '📄', label: 'Solicitud POD' },
    abono:            { emoji: '💰', label: 'Solicitud Abono' },
    rectificacion:    { emoji: '📑', label: 'Rectificación' },
    fiscal:           { emoji: '📊', label: 'Petición Fiscal' },
    consulta_albaran: { emoji: '📦', label: 'Consulta Albarán' },
    reclamacion:      { emoji: '⚠️', label: 'Reclamación' },
    facturacion:      { emoji: '🏢', label: 'Facturación' },
    otro:             { emoji: '📧', label: 'Otros' }
};

function getCategoryText(cat) {
    const c = MAILBOX_CATEGORIES[cat] || MAILBOX_CATEGORIES.otro;
    return `${c.emoji} ${c.label}`;
}

function _isOutgoing(item) {
    return item.type === 'outgoing_campaign' || item.status === 'outgoing';
}
// ==================================================

// ============ TOAST SYSTEM ============
function showMailboxToast(message, type) {
    let container = document.getElementById('mailbox-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'mailbox-toast-container';
        container.style.cssText = 'position:fixed; bottom:30px; right:30px; z-index:999999; display:flex; flex-direction:column; gap:10px;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    const colors = { success: '#4CAF50', error: '#f44336', info: '#2196F3', warning: '#FF9800' };
    const bg = colors[type] || colors.info;
    toast.style.cssText = `background:${bg}; color:white; padding:12px 24px; border-radius:8px; font-size:0.9rem; font-weight:bold; box-shadow:0 4px 20px rgba(0,0,0,0.4); opacity:0; transform:translateX(40px); transition:all 0.3s ease;`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
// ======================================

// ============ BADGE COUNTER ============
window.updateMailboxBadge = function() {
    const newCount = _mailboxCache.filter(i => !_isOutgoing(i) && (i.status || 'nueva') === 'nueva').length;
    const badgeEl = document.getElementById('mailbox-badge');
    if (badgeEl) {
        badgeEl.textContent = newCount;
        badgeEl.style.display = newCount > 0 ? 'inline-flex' : 'none';
    }
};
// =======================================

window.loadMailbox = function() {
    if (!window.db) {
        console.error("[MAILBOX] Firestore db not available");
        return;
    }

    const currentUser = window.auth ? window.auth.currentUser : (window.firebase && window.firebase.auth ? window.firebase.auth().currentUser : null);
    if (!currentUser) {
        console.warn("[MAILBOX] No authenticated user, waiting for auth state...");
        const tbody = document.getElementById('mailbox-list-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:#FF9800;">Esperando autenticación... Si persiste, recarga la página.</td></tr>';

        const authInstance = window.auth || (window.firebase && window.firebase.auth ? window.firebase.auth() : null);
        if (authInstance) {
            const unsubAuth = authInstance.onAuthStateChanged(function(user) {
                unsubAuth();
                if (user) {
                    console.log("[MAILBOX] Auth resolved, retrying loadMailbox...");
                    window.loadMailbox();
                } else {
                    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:#ff4444;">No hay sesión activa. Inicia sesión para ver el buzón.</td></tr>';
                }
            });
        }
        return;
    }

    console.log("[MAILBOX] Inicializando escucha de correos... (user: " + currentUser.uid + ")");
    const tbody = document.getElementById('mailbox-list-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:#aaa;">Rastreando buzón de entrada... <span class="material-symbols-outlined" style="animation: spin 1s linear infinite;">sync</span></td></tr>';

    if (_mailboxUnsubscribe) _mailboxUnsubscribe();

    _mailboxUnsubscribe = window.db.collection('mailbox')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .onSnapshot((snapshot) => {
            _mailboxCache = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                data.id = doc.id;
                _mailboxCache.push(data);
            });
            renderMailbox();
            updateMailboxBadge();
        }, (error) => {
            console.error("[MAILBOX] Error leyendo correos:", error);
            if (error.code === 'permission-denied' || error.code === 'failed-precondition' || error.message.includes('permissions') || error.message.includes('index')) {
                console.log("[MAILBOX] Retrying without orderBy...");
                // Tear down the failing primary listener BEFORE installing the
                // fallback, otherwise both run in parallel and we leak snapshots.
                if (_mailboxUnsubscribe) { try { _mailboxUnsubscribe(); } catch(e) {} _mailboxUnsubscribe = null; }
                _mailboxUnsubscribe = window.db.collection('mailbox')
                    .limit(200)
                    .onSnapshot((snapshot) => {
                        _mailboxCache = [];
                        snapshot.forEach(doc => {
                            const data = doc.data();
                            data.id = doc.id;
                            _mailboxCache.push(data);
                        });
                        _mailboxCache.sort((a, b) => {
                            const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
                            const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
                            return tb - ta;
                        });
                        renderMailbox();
                        updateMailboxBadge();
                    }, (error2) => {
                        console.error("[MAILBOX] Fallback also failed:", error2);
                        if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:#ff4444;">Error de permisos: ' + error2.message + '<br>Verifica que la colección "mailbox" existe en Firestore y las reglas permiten lectura.</td></tr>';
                    });
            } else {
                if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:#ff4444;">Error: ' + error.message + '</td></tr>';
            }
        });
};


// ============ DIRECTION TOGGLE ============
window.setMailboxDirection = function(dir) {
    _mailboxDirection = dir;
    document.querySelectorAll('.mailbox-dir-btn').forEach(b => {
        b.style.background = b.getAttribute('data-dir') === dir
            ? 'linear-gradient(135deg,#FF9800,#F57C00)' : 'transparent';
        b.style.color = b.getAttribute('data-dir') === dir ? '#fff' : '#aaa';
        b.style.borderColor = b.getAttribute('data-dir') === dir ? '#FF9800' : '#444';
    });
    renderMailbox();
};
// ==========================================


var _renderMailboxTimer;
window.renderMailbox = function() {
    clearTimeout(_renderMailboxTimer);
    _renderMailboxTimer = setTimeout(function() { _doRenderMailbox(); }, 300);
};
function _doRenderMailbox() {
    const tbody = document.getElementById('mailbox-list-body');
    if (!tbody) return;

    const statusFilter = document.getElementById('mailbox-filter-status')?.value || 'todas';
    const categoryFilter = document.getElementById('mailbox-filter-category')?.value || 'todas';
    const searchText = (document.getElementById('mailbox-search')?.value || '').toLowerCase();

    const filtered = _mailboxCache.filter(item => {
        // Direction filter
        const outgoing = _isOutgoing(item);
        if (_mailboxDirection === 'incoming' && outgoing) return false;
        if (_mailboxDirection === 'outgoing' && !outgoing) return false;

        const itemStatus = item.status || 'nueva';
        if (statusFilter === 'todas') {
            if (itemStatus === 'archivada') return false;
        } else if (statusFilter === 'outgoing') {
            if (itemStatus !== 'outgoing') return false;
        } else {
            if (itemStatus !== statusFilter) return false;
        }
        if (categoryFilter !== 'todas') {
            const itemCat = item.category || 'otro';
            if (itemCat !== categoryFilter) return false;
        }
        if (searchText) {
            const textToSearch = `${item.from || ''} ${item.to || ''} ${item.toName || ''} ${item.subject || ''} ${item.body || ''} ${item.ticketRef || ''}`.toLowerCase();
            if (!textToSearch.includes(searchText)) return false;
        }
        return true;
    });

    // Counters
    const incomingItems = _mailboxCache.filter(i => !_isOutgoing(i));
    const outgoingItems = _mailboxCache.filter(i => _isOutgoing(i));
    const newCount = incomingItems.filter(i => (i.status || 'nueva') === 'nueva').length;

    const counterEl = document.getElementById('mailbox-counter');
    if (counterEl) {
        counterEl.innerHTML = `Entrantes: <b>${incomingItems.length}</b> · Salientes: <b style="color:#2196F3;">${outgoingItems.length}</b> · Nuevas: <b style="color:#FF9800;">${newCount}</b> · Mostrando: <b>${filtered.length}</b>`;
    }

    if (filtered.length === 0) {
        const dirLabel = _mailboxDirection === 'outgoing' ? 'salientes' : _mailboxDirection === 'incoming' ? 'entrantes' : '';
        if (_mailboxCache.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:40px; color:#FF9800; font-style:italic;">
                <span class="material-symbols-outlined" style="font-size:3rem; display:block; margin-bottom:10px; opacity:0.5;">inbox</span>
                El buzón está vacío. No se han recibido correos aún.<br>
                <span style="font-size:0.8rem; color:#888;">Si esperabas correos, verifica que el servicio de importación sigue activo en Cloud Functions.</span>
            </td></tr>`;
        } else {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-dim); font-style:italic;">No hay correos ${dirLabel} que coincidan con el filtro actual.</td></tr>`;
        }
        return;
    }

    let html = '';
    filtered.forEach((item, idx) => {
        const outgoing = _isOutgoing(item);
        const est = item.status || 'nueva';
        let estIcon = '🔴';
        if (est === 'outgoing') estIcon = '📤';
        else if (est === 'en_curso') estIcon = '🟡';
        else if (est === 'resuelta') estIcon = '🟢';
        else if (est === 'archivada') estIcon = '⚫';
        else if (est === 'pod_lista') estIcon = '📄';
        else if (est === 'pod_autorizada') estIcon = '🚀';

        const catText = outgoing
            ? '<span style="color:#2196F3; font-size:0.8rem;">Campa\u00f1a</span>'
            : (item.categoryLabel ? ('\u{1f3f7}\ufe0f ' + item.categoryLabel) : getCategoryText(item.category || 'otro'));

        // Direction indicator
        const dirIcon = outgoing
            ? '<span style="color:#2196F3; font-size:1rem;" title="Saliente">arrow_upward</span>'
            : '<span style="color:#4CAF50; font-size:1rem;" title="Entrante">arrow_downward</span>';

        let dateStr = 'Sin fecha';
        if (item.createdAt && typeof item.createdAt.toDate === 'function') {
            dateStr = item.createdAt.toDate().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        } else if (item.date) {
            dateStr = item.date;
        }

        // For outgoing: show recipient. For incoming: show sender. Email headers
        // come from external IMAP and may contain HTML payloads — escape always.
        const _esc = (typeof escapeHtml === 'function')
            ? escapeHtml
            : (s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'));
        const contactDisplay = outgoing
            ? `<span style="color:#2196F3;">→</span> ${_esc(item.toName || item.to || 'Desconocido')}`
            : _esc(item.from || 'Desconocido');

        const ticketStr = item.ticketRef ? `<span style="background:rgba(255,152,0,0.2); color:#FF9800; padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.8rem;">${_esc(item.ticketRef)}</span>` : `<span style="color:#666;">-</span>`;

        // Preview: primeras 80 chars del body
        const bodyPreviewRaw = item.body ? item.body.replace(/[\r\n]+/g, ' ').substring(0, 80) + (item.body.length > 80 ? '...' : '') : '';
        const bodyPreview = _esc(bodyPreviewRaw);

        // Subject con title tooltip — escape both for attribute and content
        const subjectFull = _esc(item.subject || '(Sin Asunto)');
        const subjectText = _esc(item.subject || '(Sin Asunto)');

        // Row highlight for new incoming
        const rowBg = (!outgoing && est === 'nueva') ? 'background:rgba(255,152,0,0.04);' : '';

        html += `
        <tr style="border-bottom:1px solid #3c3c3c; cursor:pointer; ${rowBg}" class="mailbox-row hover-highlight" data-mail-idx="${idx}" data-mail-id="${item.id}">
            <td style="padding:12px; text-align:center;" onclick="event.stopPropagation()">
                <input type="checkbox" class="mailbox-chk" data-mail-id="${item.id}" onchange="mailboxUpdateBulkBar()" style="width:18px; height:18px; cursor:pointer; accent-color:#FF9800;">
            </td>
            <td style="padding:12px; text-align:center;"><span class="material-symbols-outlined" style="font-size:1.1rem; color:${outgoing ? '#2196F3' : '#4CAF50'};">${outgoing ? 'arrow_upward' : 'arrow_downward'}</span></td>
            <td style="padding:12px; text-align:center; font-size: 1.2rem;">${estIcon}</td>
            <td style="padding:12px; font-size:0.85rem; color:#aaa; font-weight: bold;">${catText}</td>
            <td style="padding:12px; font-weight:bold; color:#ddd;">${contactDisplay}</td>
            <td style="padding:12px; color:#fff; max-width:300px;" title="${subjectFull}">
                <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600;">${subjectText}</div>
                <div style="font-size:0.75rem; color:#888; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${bodyPreview}</div>
            </td>
            <td style="padding:12px; text-align:center;">${ticketStr}</td>
            <td style="padding:12px; font-size:0.8rem; color:#888; text-align:center;">${dateStr}</td>
            <td style="padding:12px; text-align:center; white-space:nowrap;">
                <button class="mailbox-open-btn" data-mail-idx="${idx}" style="background:linear-gradient(135deg,#2196F3,#1565C0); border:none; color:#fff; padding:4px 10px; font-size:0.8rem; border-radius:4px; cursor:pointer; font-weight:bold; margin-right:4px;" title="Ver Correo">👁 Ver</button>
                ${!outgoing ? `<button class="mailbox-resolve-btn" data-mail-idx="${idx}" style="background:#4CAF50; border:none; color:#fff; padding:4px 8px; font-size:0.8rem; border-radius:4px; cursor:pointer; font-weight:bold;" title="Marcar Resuelta">✓</button>` : ''}
            </td>
        </tr>`;
    });

    tbody.innerHTML = html;
    window._mailboxFiltered = filtered;

    // Reset bulk selection state
    const selectAllChk = document.getElementById('mailbox-select-all');
    if (selectAllChk) selectAllChk.checked = false;
    mailboxUpdateBulkBar();

    if (!tbody._mailboxListenerAttached) {
        tbody._mailboxListenerAttached = true;
    tbody.addEventListener('click', function(e) {
        const openBtn = e.target.closest('.mailbox-open-btn');
        if (openBtn) {
            e.stopPropagation();
            const idx = parseInt(openBtn.getAttribute('data-mail-idx'));
            const item = window._mailboxFiltered[idx];
            if (item) openMailboxModal(item.id);
            return;
        }

        const resolveBtn = e.target.closest('.mailbox-resolve-btn');
        if (resolveBtn) {
            e.stopPropagation();
            const idx = parseInt(resolveBtn.getAttribute('data-mail-idx'));
            const item = window._mailboxFiltered[idx];
            if (item) updateMailboxStatus(item.id, 'resuelta');
            return;
        }

        const row = e.target.closest('tr[data-mail-idx]');
        if (row) {
            const idx = parseInt(row.getAttribute('data-mail-idx'));
            const item = window._mailboxFiltered[idx];
            if (item) openMailboxModal(item.id);
        }
    });
    }
};

window.openMailboxModal = function(id) {
    const item = _mailboxCache.find(i => i.id === id);
    if (!item) return;

    const modalEl = document.getElementById('mailbox-modal');
    if (!modalEl) return;

    const outgoing = _isOutgoing(item);

    // Subject and Sender/Recipient
    const subjectEl = document.getElementById('mailbox-modal-subject');
    if (subjectEl) subjectEl.innerText = item.subject || '(Sin Asunto)';
    const fromEl = document.getElementById('mailbox-modal-from');
    if (fromEl) {
        if (outgoing) {
            const _esc = (typeof escapeHtml === 'function')
                ? escapeHtml
                : (s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'));
            fromEl.innerHTML = `<span style="color:#2196F3;">→ Enviado a:</span> ${_esc(item.toName || item.to || 'Desconocido')}`;
        } else {
            fromEl.innerText = item.from || 'Desconocido';
        }
    }

    // Direction label
    const dirLabelEl = document.getElementById('mailbox-modal-direction');
    if (dirLabelEl) {
        dirLabelEl.innerHTML = outgoing
            ? '<span style="background:rgba(33,150,243,0.2); color:#2196F3; padding:3px 10px; border-radius:12px; font-size:0.75rem; font-weight:bold;">📤 SALIENTE</span>'
            : '<span style="background:rgba(76,175,80,0.2); color:#4CAF50; padding:3px 10px; border-radius:12px; font-size:0.75rem; font-weight:bold;">📥 ENTRANTE</span>';
    }

    // Date
    let dateStr = 'Sin fecha';
    if (item.createdAt && typeof item.createdAt.toDate === 'function') {
        dateStr = item.createdAt.toDate().toLocaleString('es-ES');
    } else if (item.date) {
        dateStr = item.date;
    }
    const dateEl = document.getElementById('mailbox-modal-date');
    if (dateEl) dateEl.innerText = dateStr;

    // Body: prefer HTML, fallback to plain text
    const bodyEl = document.getElementById('mailbox-modal-body');
    if (bodyEl) {
        if (item.htmlBody) {
            bodyEl.innerHTML = '';
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'width:100%; border:none; background:#fff; border-radius:6px; min-height:200px;';
            iframe.sandbox = 'allow-same-origin';
            bodyEl.appendChild(iframe);
            iframe.addEventListener('load', function() {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    doc.open();
                    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,system-ui,sans-serif;font-size:14px;color:#222;padding:10px;margin:0;word-break:break-word;}img{max-width:100%;height:auto;}</style></head><body>' + item.htmlBody + '</body></html>');
                    doc.close();
                    setTimeout(function() {
                        try { iframe.style.height = (doc.body.scrollHeight + 20) + 'px'; } catch(e) {}
                    }, 200);
                } catch(e) { iframe.srcdoc = item.htmlBody; }
            });
            iframe.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,system-ui,sans-serif;font-size:14px;color:#222;padding:10px;margin:0;word-break:break-word;}img{max-width:100%;height:auto;}</style></head><body>' + item.htmlBody + '</body></html>';
        } else {
            bodyEl.innerText = item.body || '(Sin cuerpo de mensaje visible. Revisa el correo original.)';
        }
    }

    // Category dropdown
    const catSelect = document.getElementById('mailbox-modal-category-select');
    if (catSelect) {
        catSelect.value = item.category || 'otro';
        catSelect.style.display = outgoing ? 'none' : '';
    }

    // Ticket ref
    const tRef = document.getElementById('mailbox-modal-ticketref');
    const noTRef = document.getElementById('mailbox-no-ticket');
    const btnTRef = document.getElementById('mailbox-btn-ticket');

    if (item.ticketRef) {
        if (tRef) { tRef.innerText = item.ticketRef; tRef.style.display = 'block'; }
        if (btnTRef) btnTRef.style.display = 'block';
        if (noTRef) noTRef.style.display = 'none';

        window.openTicketFromMailbox = function() {
            modalEl.style.display = 'none';
            if (typeof erpOpenTab === 'function') erpOpenTab('inicio');
            setTimeout(() => {
                const searchBox = document.getElementById('adv-ticket-search-input');
                if (searchBox) {
                    searchBox.value = item.ticketRef;
                    if (typeof window.advQuickSearch === 'function') {
                        window.advQuickSearch(item.ticketRef);
                    } else {
                        showMailboxToast('Función de búsqueda no disponible', 'warning');
                    }
                }
            }, 300);
        };
    } else {
        if (tRef) tRef.style.display = 'none';
        if (btnTRef) btnTRef.style.display = 'none';
        if (noTRef) noTRef.style.display = 'block';
    }

    // ============ POD PANEL ============
    const podPanel = document.getElementById('mailbox-pod-panel');
    if (podPanel) {
        const _esc = (typeof escapeHtml === 'function')
            ? escapeHtml
            : (s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'));
        if (!outgoing && item.podInfo && item.podInfo.ready) {
            const reasonMap = { pod_disponible: 'POD disponible' };
            let deliveredAt = 'N/A';
            if (item.podInfo.deliveredAt) {
                if (item.podInfo.deliveredAt.toDate) deliveredAt = item.podInfo.deliveredAt.toDate().toLocaleString('es-ES');
                else if (item.podInfo.deliveredAt._seconds) deliveredAt = new Date(item.podInfo.deliveredAt._seconds * 1000).toLocaleString('es-ES');
            }

            podPanel.innerHTML = `
                <div style="background:rgba(76,175,80,0.1); border:1px solid rgba(76,175,80,0.3); border-radius:8px; padding:15px;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                        <span class="material-symbols-outlined" style="color:#4CAF50; font-size:1.3rem;">check_circle</span>
                        <strong style="color:#4CAF50; font-size:0.85rem; text-transform:uppercase; letter-spacing:1px;">Respuesta POD Preparada</strong>
                    </div>
                    <div style="font-size:0.8rem; color:#ccc; margin-bottom:8px;">
                        <div><strong>Estado:</strong> <span style="color:#4CAF50;">Entregado</span></div>
                        <div><strong>Fecha entrega:</strong> ${_esc(deliveredAt)}</div>
                        <div><strong>Recibido por:</strong> ${_esc(item.podInfo.receiverName || 'N/A')}</div>
                        <div><strong>Repartidor:</strong> ${_esc(item.podInfo.driverName || 'N/A')}</div>
                        <div style="margin-top:6px;">
                            ${item.podInfo.signatureURL ? '<span style="color:#2196F3;">📝 Firma</span> ' : ''}
                            ${item.podInfo.photoURL ? '<span style="color:#FF9800;">📷 Foto</span>' : ''}
                        </div>
                    </div>
                    ${item.status === 'pod_autorizada' ?
                        '<div style="background:rgba(255,152,0,0.15); padding:8px; border-radius:6px; text-align:center; color:#FF9800; font-weight:bold; font-size:0.8rem;">⏳ Envío autorizado — pendiente de procesamiento</div>' :
                    item.podSentAt ?
                        '<div style="background:rgba(76,175,80,0.15); padding:8px; border-radius:6px; text-align:center; color:#4CAF50; font-weight:bold; font-size:0.8rem;">✅ POD enviada por email</div>' :
                        `<button id="mailbox-btn-authorize-pod" class="btn btn-sm" style="width:100%; background:linear-gradient(135deg,#4CAF50,#2E7D32); color:white; font-weight:bold; padding:10px; font-size:0.85rem; border:none; border-radius:6px; cursor:pointer; letter-spacing:1px; margin-top:5px;" onclick="authorizePODSend()">
                            <span class="material-symbols-outlined" style="font-size:1.1rem; vertical-align:middle; margin-right:5px;">send</span> AUTORIZAR ENVÍO POD
                        </button>`
                    }
                </div>`;
            podPanel.style.display = 'block';
        } else if (!outgoing && item.podInfo && !item.podInfo.ready) {
            const reasons = {
                albaran_no_encontrado: 'Albarán no encontrado en el sistema',
                pendiente_entrega: 'Albarán pendiente de entrega',
                entregado_sin_pod: 'Entregado pero sin firma/foto POD',
                error_consulta: 'Error al consultar el albarán'
            };
            const reason = reasons[item.podInfo.reason] || item.podInfo.reason || 'Desconocido';
            podPanel.innerHTML = `
                <div style="background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.3); border-radius:8px; padding:15px;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                        <span class="material-symbols-outlined" style="color:#FF9800; font-size:1.1rem;">info</span>
                        <strong style="color:#FF9800; font-size:0.8rem; text-transform:uppercase;">POD No Disponible</strong>
                    </div>
                    <div style="font-size:0.8rem; color:#aaa;">${_esc(reason)}</div>
                </div>`;
            podPanel.style.display = 'block';
        } else if (!outgoing && item.category === 'pod') {
            podPanel.innerHTML = '<div style="font-size:0.8rem; color:#888; font-style:italic; text-align:center; padding:10px;">Categoría POD detectada. El motor aún no ha consultado el estado del albarán.</div>';
            podPanel.style.display = 'block';
        } else {
            podPanel.style.display = 'none';
        }
    }

    // ============ ATTACHMENTS INFO ============
    const attachPanel = document.getElementById('mailbox-modal-attachments');
    if (attachPanel) {
        if (item.attachments && item.attachments.length > 0) {
            const _esc = (typeof escapeHtml === 'function')
                ? escapeHtml
                : (s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'));
            // Only allow data: URLs for href/src — block javascript:, vbscript: etc.
            const _safeUrl = (u) => {
                if (typeof u !== 'string') return '';
                return /^data:/i.test(u) ? u : '';
            };
            let attHtml = '<div style="font-size:0.75rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">📎 Adjuntos (' + item.attachments.length + '):</div>';
            item.attachments.forEach(att => {
                const sizeKB = att.size ? (att.size / 1024).toFixed(1) + ' KB' : '';
                const isImage = (att.contentType || '').startsWith('image/');
                const safeName = _esc(att.filename || 'archivo');
                const safeUrl = _safeUrl(att.dataUrl);
                if (safeUrl) {
                    attHtml += `<div style="display:flex; align-items:center; gap:6px; padding:5px 0; font-size:0.8rem; color:#ccc; border-bottom:1px solid #222;">
                        <span class="material-symbols-outlined" style="font-size:1rem; color:#4CAF50;">attach_file</span>
                        <a href="${safeUrl}" download="${safeName}" style="flex:1; color:#4FC3F7; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="Descargar">${safeName}</a>
                        <span style="color:#666; font-size:0.7rem;">${sizeKB}</span>
                        <a href="${safeUrl}" download="${safeName}" style="color:#4CAF50; font-size:0.7rem; text-decoration:none; font-weight:bold; padding:2px 8px; border:1px solid #4CAF50; border-radius:4px;">⬇ Descargar</a>
                    </div>`;
                    if (isImage) {
                        attHtml += `<div style="padding:4px 0 8px;"><img src="${safeUrl}" style="max-width:100%; max-height:200px; border-radius:6px; border:1px solid #333;"></div>`;
                    }
                } else {
                    attHtml += `<div style="display:flex; align-items:center; gap:6px; padding:5px 0; font-size:0.8rem; color:#ccc; border-bottom:1px solid #222;">
                        <span class="material-symbols-outlined" style="font-size:1rem; color:#FF9800;">attach_file</span>
                        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${safeName}</span>
                        <span style="color:#666; font-size:0.7rem;">${sizeKB}</span>
                    </div>`;
                }
            });
            attachPanel.innerHTML = attHtml;
            attachPanel.style.display = 'block';
        } else {
            attachPanel.style.display = 'none';
        }
    }

    // Load saved notes
    const notesEl = document.getElementById('mailbox-modal-notes');
    if (notesEl) {
        notesEl.value = item.notes || '';
    }

    // Status history panel
    const historyPanel = document.getElementById('mailbox-modal-history');
    if (historyPanel) {
        if (item.statusHistory && item.statusHistory.length > 0) {
            let hHtml = '';
            item.statusHistory.slice(-8).forEach(h => {
                let hDate = '';
                if (h.at && h.at.toDate) hDate = h.at.toDate().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
                else if (h.at && h.at._seconds) hDate = new Date(h.at._seconds * 1000).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
                const _eh = (typeof escapeHtml === 'function') ? escapeHtml : (s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
                hHtml += `<div style="font-size:0.75rem; color:#888; padding:2px 0; border-left:2px solid #333; padding-left:8px; margin-left:4px;">${_eh(hDate)} → <span style="color:#ccc;">${_eh(h.status)}</span></div>`;
            });
            historyPanel.innerHTML = '<strong style="color:var(--text-dim); font-size:0.7rem; text-transform:uppercase; letter-spacing:1px; display:block; margin-bottom:6px;">Historial</strong>' + hHtml;
            historyPanel.style.display = 'block';
        } else {
            historyPanel.style.display = 'none';
        }
    }

    // Reply button — only for incoming
    const replySection = document.getElementById('mailbox-modal-reply-section');
    if (replySection) replySection.style.display = outgoing ? 'none' : '';

    // Action buttons — hide for outgoing
    const actionSection = document.getElementById('mailbox-modal-actions');
    if (actionSection) actionSection.style.display = outgoing ? 'none' : '';

    // Setup reply
    window.replyMailboxEmail = function() {
        if (!item.from) return;
        let emailAddress = item.from;
        const match = emailAddress.match(/<([^>]+)>/);
        if (match) emailAddress = match[1];

        const quotedBody = item.body ? item.body.substring(0, 2000).split('\n').map(l => '> ' + l).join('\n') : '';
        const sub = encodeURIComponent(`Re: ${item.subject || 'Tu consulta en Novapack'}`);
        const body = encodeURIComponent(
            `Estimado/a cliente,\n\n\n\nAtentamente,\nNOVAPACK - Departamento de Administración\n\n` +
            `--- Mensaje original ---\n` +
            `De: ${item.from}\n` +
            `Fecha: ${dateStr}\n` +
            `Asunto: ${item.subject || ''}\n\n` +
            quotedBody
        );
        window.open(`mailto:${emailAddress}?subject=${sub}&body=${body}`, '_blank');
    };

    // Store active ID and mark as read
    modalEl.setAttribute('data-active-id', id);
    modalEl.style.display = 'flex';

    // Auto-mark incoming 'nueva' as 'en_curso' when opened
    if (!outgoing && (item.status || 'nueva') === 'nueva') {
        window.db.collection('mailbox').doc(id).update({
            status: 'en_curso',
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
            statusHistory: window.firebase.firestore.FieldValue.arrayUnion({
                status: 'en_curso',
                at: new Date(),
                reason: 'auto_opened'
            })
        }).catch(() => {});
    }
};

/**
 * Save internal notes to Firestore
 */
window.saveMailboxNotes = async function() {
    const modalEl = document.getElementById('mailbox-modal');
    const id = modalEl?.getAttribute('data-active-id');
    if (!id) return;

    const notesEl = document.getElementById('mailbox-modal-notes');
    const notes = notesEl ? notesEl.value : '';

    try {
        await window.db.collection('mailbox').doc(id).update({
            notes: notes,
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
        const item = _mailboxCache.find(i => i.id === id);
        if (item) item.notes = notes;
        showMailboxToast('Notas guardadas', 'success');
    } catch (error) {
        console.error("[MAILBOX] Error saving notes:", error);
        showMailboxToast('Error al guardar notas: ' + error.message, 'error');
    }
};

/**
 * Authorize POD email send
 */
window.authorizePODSend = async function() {
    const modalEl = document.getElementById('mailbox-modal');
    const id = modalEl?.getAttribute('data-active-id');
    if (!id) return;

    const item = _mailboxCache.find(i => i.id === id);
    if (!item || !item.podInfo || !item.podInfo.ready) {
        showMailboxToast('No se puede autorizar: POD no disponible', 'error');
        return;
    }

    try {
        await window.db.collection('mailbox').doc(id).update({
            status: 'pod_autorizada',
            podAuthorizedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
            statusHistory: window.firebase.firestore.FieldValue.arrayUnion({
                status: 'pod_autorizada',
                at: new Date(),
                reason: 'manual_authorize'
            })
        });

        item.status = 'pod_autorizada';
        showMailboxToast('Envío POD autorizado. Se procesará en breve.', 'success');

        const btn = document.getElementById('mailbox-btn-authorize-pod');
        if (btn) {
            btn.outerHTML = '<div style="background:rgba(255,152,0,0.15); padding:8px; border-radius:6px; text-align:center; color:#FF9800; font-weight:bold; font-size:0.8rem;">⏳ Envío autorizado — pendiente de procesamiento</div>';
        }
    } catch(error) {
        console.error("[MAILBOX] Error authorizing POD:", error);
        showMailboxToast('Error al autorizar: ' + error.message, 'error');
    }
};

/**
 * Update Mailbox Status — with history tracking
 */
window.updateMailboxStatus = async function(id, newStatus) {
    if (!id) {
        id = document.getElementById('mailbox-modal')?.getAttribute('data-active-id');
    }
    if (!id) return;

    const notesEl = document.getElementById('mailbox-modal-notes');
    const notes = notesEl ? notesEl.value : undefined;

    const finalStatus = (newStatus === 'resuelta') ? 'archivada' : newStatus;

    const updateData = {
        status: finalStatus,
        updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        statusHistory: window.firebase.firestore.FieldValue.arrayUnion({
            status: finalStatus,
            at: new Date(),
            reason: 'manual'
        })
    };
    if (newStatus === 'resuelta') {
        updateData.resolvedAt = window.firebase.firestore.FieldValue.serverTimestamp();
    }
    if (notes !== undefined) {
        updateData.notes = notes;
    }

    try {
        await window.db.collection('mailbox').doc(id).update(updateData);

        console.log(`[MAILBOX] Ref ${id} estado cambiado a ${finalStatus}`);

        const item = _mailboxCache.find(i => i.id === id);
        if (item) {
            item.status = finalStatus;
            if (newStatus === 'resuelta') item.resolvedAt = new Date();
            if (notes !== undefined) item.notes = notes;
        }

        const cat = item ? getCategoryText(item.category || 'otro') : '';
        const toastMsg = newStatus === 'resuelta'
            ? `Resuelta y archivada en ${cat}`
            : `Estado actualizado: ${{en_curso:'En Curso', archivada:'Archivada'}[finalStatus] || finalStatus}`;
        showMailboxToast(toastMsg, 'success');

        renderMailbox();
        updateMailboxBadge();

        setTimeout(() => {
            const modalEl = document.getElementById('mailbox-modal');
            if (modalEl && modalEl.style.display === 'flex') {
                modalEl.style.display = 'none';
            }
        }, 600);

    } catch (error) {
        console.error("Error updating mailbox status:", error);

        if (error.code === 'not-found') {
            showMailboxToast('El correo ya no existe en el buzón central', 'error');
            const idx = _mailboxCache.findIndex(i => i.id === id);
            if (idx > -1) _mailboxCache.splice(idx, 1);
        } else {
            showMailboxToast('Error al actualizar: ' + error.message, 'error');
        }
    }
};

/**
 * Update Mailbox Category
 */
window.updateMailboxCategory = async function(newCategory) {
    const id = document.getElementById('mailbox-modal')?.getAttribute('data-active-id');
    if (!id || !newCategory) return;

    try {
        await window.db.collection('mailbox').doc(id).update({
            category: newCategory,
            categoryManual: true,
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });

        const item = _mailboxCache.find(i => i.id === id);
        if (item) {
            item.category = newCategory;
            item.categoryManual = true;
        }

        showMailboxToast('Categoría cambiada a: ' + getCategoryText(newCategory), 'success');
        renderMailbox();
    } catch (error) {
        console.error("Error updating category:", error);
        showMailboxToast('Error al cambiar categoría: ' + error.message, 'error');
    }
};

// ============ BULK SELECTION & ACTIONS ============

window.mailboxToggleAll = function(checked) {
    document.querySelectorAll('.mailbox-chk').forEach(chk => { chk.checked = checked; });
    mailboxUpdateBulkBar();
};

window.mailboxUpdateBulkBar = function() {
    const checks = document.querySelectorAll('.mailbox-chk:checked');
    const bar = document.getElementById('mailbox-bulk-bar');
    const countEl = document.getElementById('mailbox-bulk-count');
    if (!bar) return;
    if (checks.length > 0) {
        bar.style.display = 'flex';
        if (countEl) countEl.textContent = checks.length + ' seleccionado' + (checks.length > 1 ? 's' : '');
    } else {
        bar.style.display = 'none';
    }
};

window.mailboxBulkClearSelection = function() {
    document.querySelectorAll('.mailbox-chk').forEach(chk => { chk.checked = false; });
    const selectAll = document.getElementById('mailbox-select-all');
    if (selectAll) selectAll.checked = false;
    mailboxUpdateBulkBar();
};

window.mailboxBulkArchive = async function() {
    const ids = Array.from(document.querySelectorAll('.mailbox-chk:checked')).map(c => c.getAttribute('data-mail-id'));
    if (ids.length === 0) return;

    const countEl = document.getElementById('mailbox-bulk-count');
    if (countEl) countEl.textContent = `Archivando ${ids.length}...`;

    let ok = 0, fail = 0;
    for (const id of ids) {
        try {
            await window.db.collection('mailbox').doc(id).update({
                status: 'archivada',
                updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
                statusHistory: window.firebase.firestore.FieldValue.arrayUnion({
                    status: 'archivada', at: new Date(), reason: 'bulk_archive'
                })
            });
            const item = _mailboxCache.find(i => i.id === id);
            if (item) item.status = 'archivada';
            ok++;
        } catch (e) {
            console.error('[MAILBOX] Bulk archive error:', id, e);
            fail++;
        }
    }

    showMailboxToast(`${ok} correo${ok > 1 ? 's' : ''} archivado${ok > 1 ? 's' : ''}` + (fail ? ` (${fail} error${fail > 1 ? 'es' : ''})` : ''), 'success');
    mailboxBulkClearSelection();
    renderMailbox();
    updateMailboxBadge();
};

window.mailboxBulkResolve = async function() {
    const ids = Array.from(document.querySelectorAll('.mailbox-chk:checked')).map(c => c.getAttribute('data-mail-id'));
    if (ids.length === 0) return;

    const countEl = document.getElementById('mailbox-bulk-count');
    if (countEl) countEl.textContent = `Resolviendo ${ids.length}...`;

    let ok = 0, fail = 0;
    for (const id of ids) {
        try {
            await window.db.collection('mailbox').doc(id).update({
                status: 'archivada',
                resolvedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
                statusHistory: window.firebase.firestore.FieldValue.arrayUnion({
                    status: 'archivada', at: new Date(), reason: 'bulk_resolve'
                })
            });
            const item = _mailboxCache.find(i => i.id === id);
            if (item) {
                item.status = 'archivada';
                item.resolvedAt = new Date();
            }
            ok++;
        } catch (e) {
            console.error('[MAILBOX] Bulk resolve error:', id, e);
            fail++;
        }
    }

    showMailboxToast(`${ok} correo${ok > 1 ? 's' : ''} resuelto${ok > 1 ? 's' : ''} y archivado${ok > 1 ? 's' : ''}` + (fail ? ` (${fail} error${fail > 1 ? 'es' : ''})` : ''), 'success');
    mailboxBulkClearSelection();
    renderMailbox();
    updateMailboxBadge();
};

// =================================================

// ============ CREAR ASUNTO MANUAL ============
window.openCreateMailboxEntry = function() {
    let modal = document.getElementById('modal-create-mailbox');
    if (modal) modal.remove();

    const catOptions = Object.entries(MAILBOX_CATEGORIES).map(([k, v]) =>
        `<option value="${k}">${v.emoji} ${v.label}</option>`
    ).join('');

    modal = document.createElement('div');
    modal.id = 'modal-create-mailbox';
    modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:50000; display:flex; align-items:center; justify-content:center;';
    modal.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #3c3c3c; border-radius:12px; width:95%; max-width:520px; padding:25px; color:#d4d4d4;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #3c3c3c; padding-bottom:12px; margin-bottom:18px;">
                <h2 style="margin:0; color:#4CAF50; font-size:1.1rem;"><span class="material-symbols-outlined" style="vertical-align:middle; margin-right:5px;">note_add</span>Crear Asunto</h2>
                <button onclick="document.getElementById('modal-create-mailbox').remove()" style="background:none; border:none; color:#aaa; font-size:1.5rem; cursor:pointer;">&times;</button>
            </div>

            <div style="margin-bottom:14px;">
                <label style="font-size:0.75rem; color:#888; text-transform:uppercase; letter-spacing:1px;">Asunto</label>
                <input id="create-mail-subject" placeholder="Descripci\u00f3n del asunto..." style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.9rem; margin-top:4px; box-sizing:border-box;">
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px;">
                <div>
                    <label style="font-size:0.75rem; color:#888; text-transform:uppercase; letter-spacing:1px;">Categor\u00eda</label>
                    <select id="create-mail-category" onchange="document.getElementById('create-mail-custom-cat').style.display = this.value === '_custom' ? 'block' : 'none'" style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.85rem; margin-top:4px;">
                        ${catOptions}
                        <option value="_custom">\u270f\ufe0f Categor\u00eda libre...</option>
                    </select>
                    <input id="create-mail-custom-cat" placeholder="Escribe la categor\u00eda..." style="display:none; width:100%; background:#2d2d30; border:1px solid #4CAF50; color:white; padding:8px; border-radius:4px; font-size:0.85rem; margin-top:4px; box-sizing:border-box;">
                </div>
                <div>
                    <label style="font-size:0.75rem; color:#888; text-transform:uppercase; letter-spacing:1px;">Referencia Albar\u00e1n</label>
                    <input id="create-mail-ref" placeholder="Opcional" style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.85rem; margin-top:4px; box-sizing:border-box;">
                </div>
            </div>

            <div style="margin-bottom:14px;">
                <label style="font-size:0.75rem; color:#888; text-transform:uppercase; letter-spacing:1px;">Notas / Descripci\u00f3n</label>
                <textarea id="create-mail-body" rows="4" placeholder="Detalles del asunto..." style="width:100%; background:#2d2d30; border:1px solid #3c3c3c; color:white; padding:8px; border-radius:4px; font-size:0.85rem; margin-top:4px; resize:vertical; box-sizing:border-box;"></textarea>
            </div>

            <div style="display:flex; gap:10px; justify-content:flex-end; border-top:1px solid #3c3c3c; padding-top:15px;">
                <button onclick="document.getElementById('modal-create-mailbox').remove()" style="background:#333; border:1px solid #555; color:#ccc; padding:8px 20px; font-size:0.85rem; cursor:pointer; border-radius:4px;">Cancelar</button>
                <button onclick="saveCreateMailboxEntry()" style="background:#4CAF50; border:none; color:#fff; padding:8px 20px; font-size:0.85rem; cursor:pointer; border-radius:4px; font-weight:bold; display:flex; align-items:center; gap:5px;">
                    <span class="material-symbols-outlined" style="font-size:16px;">save</span> Crear
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('create-mail-subject').focus();
};

window.saveCreateMailboxEntry = async function() {
    const subject = (document.getElementById('create-mail-subject')?.value || '').trim();
    if (!subject) { alert('El asunto es obligatorio'); return; }

    const catSelect = document.getElementById('create-mail-category')?.value || 'otro';
    const customCat = (document.getElementById('create-mail-custom-cat')?.value || '').trim();
    const category = (catSelect === '_custom' && customCat) ? 'otro' : catSelect;
    const categoryLabel = (catSelect === '_custom' && customCat) ? customCat : '';
    const ticketRef = (document.getElementById('create-mail-ref')?.value || '').trim();
    const body = (document.getElementById('create-mail-body')?.value || '').trim();

    try {
        const docData = {
            subject: categoryLabel ? ('[' + categoryLabel + '] ' + subject) : subject,
            category: category,
            ticketRef: ticketRef,
            body: body,
            from: 'Admin',
            status: 'nueva',
            source: 'manual',
            createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
            statusHistory: [{
                status: 'nueva',
                at: new Date(),
                reason: 'creado manualmente'
            }]
        };
        if (categoryLabel) docData.categoryLabel = categoryLabel;

        await window.db.collection('mailbox').add(docData);

        document.getElementById('modal-create-mailbox').remove();
        showMailboxToast('Asunto creado correctamente', 'success');
    } catch(e) {
        console.error('[MAILBOX] Error creando asunto:', e);
        alert('Error: ' + e.message);
    }
};

// Auto-trigger styles
document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.innerHTML = `
    .mailbox-row { transition: all 0.2s; }
    .mailbox-row:hover { background: rgba(0, 206, 209, 0.1) !important; cursor: pointer; }
    .mailbox-chk:checked ~ td { background: rgba(255,152,0,0.05); }
    tr:has(.mailbox-chk:checked) { background: rgba(255,152,0,0.08) !important; }
    .mailbox-dir-btn { transition: all 0.2s; cursor: pointer; }
    .mailbox-dir-btn:hover { opacity: 0.85; }
    `;
    document.head.appendChild(style);
});
