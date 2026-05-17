// Modulo de Facturación Avanzada (Factucont Style)
// Este script asume que `admin.html` ya ha cargado firebase, variables globales (userMap, etc)

// Calcula fecha de vencimiento según condiciones de pago del cliente
function _calcDueDate(invoiceDate, paymentTerms) {
    const d = new Date(invoiceDate);
    const daysMap = {
        'contado': 0, 'giro_30': 30, 'giro_60': 60,
        'giro_90': 90, 'giro_120': 120, 'transferencia': 30, 'recibo_sepa': 30
    };
    const days = daysMap[paymentTerms] || 0;
    d.setDate(d.getDate() + days);
    return d;
}

let advCurrentClient = null;
let advCurrentInvoiceId = null; // Track loaded or just-saved invoice
let advUnbilledTicketsCache = [];
let advGridRows = []; 
// Row structure: { id, description, qty, price, discount, iva, total, ticketId }

function initAdvBillingObserver() {
    // Populate client picker when switching to view
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.target.id === 'view-adv-billing' && mutation.target.style.display !== 'none') {
                advPopulateClientPicker();
                if(typeof window.advPopulateCompanyPicker === 'function') window.advPopulateCompanyPicker();
            }
        });
    });
    
    const targetNode = document.getElementById('view-adv-billing');
    if(targetNode) {
        observer.observe(targetNode, { attributes: true, attributeFilter: ['style'] });
        // Si ya está visible al cargar, popular inmediatamente
        if (targetNode.style.display !== 'none') {
            advPopulateClientPicker();
            if(typeof window.advPopulateCompanyPicker === 'function') window.advPopulateCompanyPicker();
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener("DOMContentLoaded", initAdvBillingObserver);
} else {
    initAdvBillingObserver();
}

let advAllClients = []; // Cached client list for search

window.advPopulateClientPicker = async () => {
    const select = document.getElementById('adv-client-picker');
    const searchInput = document.getElementById('adv-client-search');
    const dropdown = document.getElementById('adv-client-dropdown');
    if(!select) return;
    try {
        if (!window.userMap || Object.keys(window.userMap).length < 2) {
            if (typeof window.loadUsers === 'function') {
                if(searchInput) searchInput.placeholder = 'Cargando clientes...';
                await window.loadUsers('first');
            } else {
                throw new Error("La función loadUsers no existe en esta página.");
            }
        }

        const uniqueEntries = [];
        const seenIds = new Set();

        Object.entries(window.userMap || {}).forEach(([uid, u]) => {
            if(u && u.role === 'admin') return; 
            const actualId = u.id || uid;
            if (!actualId || seenIds.has(actualId)) return;
            seenIds.add(actualId);
            uniqueEntries.push({ ...u, id: actualId });
        });

        uniqueEntries.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        advAllClients = uniqueEntries;

        // Populate hidden select for backward compat
        select.innerHTML = '<option value="">--</option>';
        uniqueEntries.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = `[#${u.idNum || '?'}] ${u.name || 'Sin Nombre'}`;
            select.appendChild(opt);
        });

        if(searchInput) {
            searchInput.placeholder = `Buscar entre ${uniqueEntries.length} clientes...`;
            
            // Live search on input
            var _advFilterClientsTimer;
            searchInput.addEventListener('input', function() {
                var val = this.value.trim();
                clearTimeout(_advFilterClientsTimer);
                _advFilterClientsTimer = setTimeout(function() { advFilterClients(val); }, 300);
            });
            
            // Show all on focus if empty
            searchInput.addEventListener('focus', function() {
                if (!this.value.trim()) advFilterClients('');
            });
            
            // Hide dropdown on outside click
            document.addEventListener('click', function(e) {
                if (dropdown && !dropdown.contains(e.target) && e.target !== searchInput) {
                    dropdown.style.display = 'none';
                }
            });
        }
    } catch(err) {
        if(searchInput) searchInput.placeholder = 'ERROR: ' + err.message;
    }
}

function advFilterClients(query) {
    const dropdown = document.getElementById('adv-client-dropdown');
    if (!dropdown) return;
    
    const q = query.toLowerCase();
    const filtered = q ? advAllClients.filter(u => {
        const name = (u.name || '').toLowerCase();
        const nif = (u.nif || '').toLowerCase();
        const idNum = String(u.idNum || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        const phone = (u.senderPhone || u.phone || '').toLowerCase();
        return name.includes(q) || nif.includes(q) || idNum.includes(q) || email.includes(q) || phone.includes(q);
    }) : advAllClients.slice(0, 50); // Show first 50 when empty
    
    if (filtered.length === 0) {
        dropdown.innerHTML = '<div style="padding:10px; color:#888; text-align:center; font-size:0.8rem;">Sin resultados para "' + query + '"</div>';
        dropdown.style.display = 'block';
        return;
    }
    
    dropdown.innerHTML = '';
    filtered.forEach(u => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:6px 10px; cursor:pointer; font-size:0.82rem; border-bottom:1px solid #3c3c3c; display:flex; justify-content:space-between; align-items:center;';
        item.innerHTML = `
            <span style="color:#fff; font-weight:600;">${u.name || 'Sin Nombre'}</span>
            <span style="color:#888; font-size:0.75rem;">#${u.idNum || '?'}${u.nif ? ' · ' + u.nif : ''}</span>
        `;
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(0,122,204,0.3)'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('click', () => {
            // Set hidden select
            const select = document.getElementById('adv-client-picker');
            select.value = u.id;
            // Set search input display
            const searchInput = document.getElementById('adv-client-search');
            searchInput.value = `[#${u.idNum || '?'}] ${u.name || 'Sin Nombre'}`;
            dropdown.style.display = 'none';
            // Trigger load
            advLoadClientDetails(u.id);
        });
        dropdown.appendChild(item);
    });
    
    if (!q && advAllClients.length > 50) {
        const more = document.createElement('div');
        more.style.cssText = 'padding:6px; text-align:center; color:#007acc; font-size:0.75rem;';
        more.textContent = '... escriba para filtrar los ' + advAllClients.length + ' clientes restantes';
        dropdown.appendChild(more);
    }
    
    dropdown.style.display = 'block';
}

window.advPopulateCompanyPicker = async () => {
    const picker = document.getElementById('adv-company-picker');
    if(!picker) return;
    try {
        const snap = await db.collection('billing_companies').get();
        window.advCompaniesMap = {};
        let html = '';
        if (snap.empty) {
            // No filiales exist — try to auto-migrate from config/fiscal
            try {
                const fiscalDoc = await db.collection('config').doc('fiscal').get();
                if (fiscalDoc.exists) {
                    const fd = fiscalDoc.data();
                    const migrated = { name: fd.name || 'Empresa Sin Nombre', nif: fd.cif || '', address: fd.address || '', email: fd.email || '', bank: fd.bank || '', sepaId: fd.sepaId || '', iva: fd.iva || 21, irpf: fd.irpf || 0 };
                    const newDoc = await db.collection('billing_companies').add(migrated);
                    window.advCompaniesMap[newDoc.id] = migrated;
                    html = `<option value="${newDoc.id}">${migrated.name}</option>`;
                    console.log('[ADV] Auto-migrated fiscal data to billing_companies:', newDoc.id);
                } else {
                    html = '<option value="">⚠️ Sin empresas — Crear filial en Configuración</option>';
                }
            } catch(mErr) {
                html = '<option value="">⚠️ Sin empresas</option>';
                console.error('[ADV] Migration error:', mErr);
            }
        } else {
            snap.forEach(doc => {
                const data = doc.data();
                window.advCompaniesMap[doc.id] = data;
                html += `<option value="${doc.id}">${data.name}</option>`;
            });
        }
        picker.innerHTML = html;
        // Select first company or previously selected
        const currentCompany = window.advCurrentCompany;
        if (currentCompany && picker.querySelector(`option[value="${currentCompany}"]`)) {
            picker.value = currentCompany;
        } else if (picker.options.length > 0) {
            picker.value = picker.options[0].value;
            window.advCurrentCompany = picker.value;
        }
    } catch(e) { console.error("Error loading adv companies:", e); }
};

window.advLoadClientDetails = async (uid) => {
    if (!uid) {
        advCurrentClient = null;
        advGridRows = [];
        advRenderGrid();
        return;
    }
    advCurrentClient = window.userMap[uid];
    
    // Auto-generate invoice number placeholder — Format: FAC-YY-SEQ
    try {
        const currentYY = String(new Date().getFullYear()).slice(-2);
        const yearStart = new Date(new Date().getFullYear(), 0, 1);
        const yearEnd = new Date(new Date().getFullYear() + 1, 0, 1);
        const invSnap = await db.collection('invoices')
            .where('date', '>=', yearStart)
            .where('date', '<', yearEnd)
            .orderBy('date', 'desc')
            .limit(10000)
            .get();
        let nextNum = 0;
        invSnap.forEach(doc => {
            const iid = doc.data().invoiceId || '';
            const match = iid.match(/^FAC-\d{2}-(\d+)$/);
            if (match) {
                const seq = parseInt(match[1], 10);
                if (!isNaN(seq) && seq >= nextNum) nextNum = seq + 1;
            }
        });
        document.getElementById('adv-inv-number').value = `FAC-${currentYY}-${nextNum} (BORRADOR)`;
        document.getElementById('adv-inv-date').value = new Date().toISOString().split('T')[0];
    } catch(e) { console.error("Error auto-num:", e); }
    
    advGridRows = []; // Clear grid on new client
    advRenderGrid();
    
    // UI: Update Client Card
    const card = document.getElementById('adv-client-card');
    if(card) {
        if(!uid) {
            card.innerHTML = 'Seleccione un cliente para ver sus datos fiscales.';
            card.style.background = 'rgba(0,0,0,0.2)';
            card.style.borderColor = '#555';
            card.style.color = '#888';
        } else {
            const u = window.userMap[uid];
            const addr = u.senderAddress || [u.street, u.localidad, u.cp ? '(CP ' + u.cp + ')' : ''].filter(Boolean).join(', ') || 'Sin dirección';
            const phone = u.senderPhone || u.phone || '';
            const nif = u.nif || '';
            const email = u.email || '';
            card.innerHTML = `
                <div style="flex:1;">
                    <strong style="color:#FFF; font-size:0.95rem;">${u.name || 'Sin Nombre'}</strong><br>
                    <span style="font-size:0.8rem; color:#aaa;">ID: #${u.idNum || 'N/A'}${nif ? ' · NIF: ' + nif : ''}</span>
                </div>
                <div style="text-align:right; font-size:0.8rem; color:#ccc; line-height:1.5;">
                    <div>📍 ${addr}</div>
                    ${phone ? '<div>📞 ' + phone + '</div>' : ''}
                    ${email ? '<div>✉️ ' + email + '</div>' : ''}
                </div>
            `;
            card.style.background = 'rgba(76, 175, 80, 0.1)';
            card.style.borderColor = '#4CAF50';
            card.style.color = '#d4d4d4';
        }
    }

    // AUTO-IMPORT: Fetch and load pending tickets directly into grid
    if (uid && advCurrentClient) {
        try {
            const idNumStr = String(advCurrentClient.idNum || '').trim();
            const authUid = advCurrentClient.authUid || advCurrentClient.id;
            
            // Query 1: Creados por el cliente (ignoraremos en memoria los Debidos sin asignación a él)
            let q1 = db.collection('tickets');
            if (idNumStr) q1 = q1.where('clientIdNum', '==', idNumStr);
            else q1 = q1.where('uid', '==', authUid);
            const snap1 = await q1.limit(2000).get();

            // Query 2: Debidos explícitamente asignados a él (como receptor)
            let q2 = db.collection('tickets').where('shippingType', '==', 'Debidos');
            if (idNumStr) q2 = q2.where('billToClientIdNum', '==', idNumStr);
            else q2 = q2.where('billToUid', '==', authUid);
            const snap2 = await q2.limit(2000).get();

            const allDocs = [];
            snap1.forEach(doc => allDocs.push(doc));
            snap2.forEach(doc => allDocs.push(doc));

            // Eliminar duplicados si los hubiera
            const uniqueDocs = [];
            const seenSet = new Set();
            allDocs.forEach(doc => {
                if(!seenSet.has(doc.id)) {
                    seenSet.add(doc.id);
                    uniqueDocs.push(doc);
                }
            });
            
            let importCount = 0;
            
            uniqueDocs.forEach(doc => {
                const t = doc.data();
                // Skip already billed
                if (t.invoiceId && String(t.invoiceId).trim() !== "" && String(t.invoiceId).toLowerCase() !== "null") return;
                
                // Lógica Debidos: no facturar al creador si es debido, a menos que sea a la vez el receptor asignado
                if (t.shippingType === 'Debidos') {
                    const assignedToMe = (t.billToUid === authUid) || (idNumStr && t.billToClientIdNum === idNumStr);
                    if (!assignedToMe) return; // Salto: Limbo o asignado a otro
                } else {
                    // Lógica Pagados: verificar que sea el owner original
                    const isOwner = (t.uid === authUid) || (idNumStr && t.clientIdNum === idNumStr);
                    if (!isOwner) return;
                }
                
                // Calculate price
                let price = 0;
                if (typeof window.calculateTicketPriceSync === 'function') {
                    price = window.calculateTicketPriceSync(t, advCurrentClient.id, t.compId || 'comp_main');
                }
                
                const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages || 1);
                
                advGridRows.push({
                    id: 'row_' + Date.now() + Math.random(),
                    description: `Albarán ${t.id || '-'} - Destino: ${t.receiver}`,
                    qty: pkgs,
                    price: price,
                    discount: 0,
                    iva: window.invCompanyData ? window.invCompanyData.iva : 21,
                    ticketId: doc.id,
                    rawTicketData: { ...t, docId: doc.id, calculatedPrice: price }
                });
                importCount++;
            });
            
            if (importCount > 0) {
                advRenderGrid();
                console.log(`Auto-imported ${importCount} pending tickets for client ${advCurrentClient.name}`);
            }
        } catch(e) {
            console.error("Auto-import error:", e);
        }
    }
};

window.advOpenTicketImportModal = async () => {
    if (!advCurrentClient) {
        alert("Por favor, seleccione un cliente primero.");
        return;
    }
    
    document.getElementById('modal-adv-import-tickets').style.display = 'flex';
    const tbody = document.getElementById('adv-import-tickets-body');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Buscando albaranes pendientes en la nube...</td></tr>';
    
    try {
        const idNumStr = String(advCurrentClient.idNum || '').trim();
        const authUid = advCurrentClient.authUid || advCurrentClient.id;
        
        // Query 1: Creados por el cliente
        let q1 = db.collection('tickets');
        if (idNumStr) q1 = q1.where('clientIdNum', '==', idNumStr);
        else q1 = q1.where('uid', '==', authUid);
        const snap1 = await q1.limit(2000).get();

        // Query 2: Debidos asignados
        let q2 = db.collection('tickets').where('shippingType', '==', 'Debidos');
        if (idNumStr) q2 = q2.where('billToClientIdNum', '==', idNumStr);
        else q2 = q2.where('billToUid', '==', authUid);
        const snap2 = await q2.limit(2000).get();

        const allDocs = [];
        snap1.forEach(doc => allDocs.push(doc));
        snap2.forEach(doc => allDocs.push(doc));

        // Deduplicate
        const uniqueDocs = [];
        const seenSet = new Set();
        allDocs.forEach(doc => {
            if(!seenSet.has(doc.id)) {
                seenSet.add(doc.id);
                uniqueDocs.push(doc);
            }
        });
        
        advUnbilledTicketsCache = [];
        
        uniqueDocs.forEach(doc => {
            const t = doc.data();
            // Filter already billed
            if (t.invoiceId && String(t.invoiceId).trim() !== "" && String(t.invoiceId).toLowerCase() !== "null") return;
            
            // Lógica Debidos
            if (t.shippingType === 'Debidos') {
                const assignedToMe = (t.billToUid === authUid) || (idNumStr && t.billToClientIdNum === idNumStr);
                if (!assignedToMe) return; 
            } else {
                // Pagados
                const isOwner = (t.uid === authUid) || (idNumStr && t.clientIdNum === idNumStr);
                if (!isOwner) return; 
            }
            
            // Calc price using the window scope calculateTicketPriceSync
            let price = 0;
            if (typeof window.calculateTicketPriceSync === 'function') {
                price = window.calculateTicketPriceSync(t, advCurrentClient.id, t.compId || 'comp_main');
            }
            
            advUnbilledTicketsCache.push({
                ...t, docId: doc.id, calculatedPrice: price
            });
        });
        
        if (advUnbilledTicketsCache.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No hay albaranes pendientes para facturar.</td></tr>';
            return;
        }
        
        advRenderImportTable();
    } catch(e) {
        tbody.innerHTML = `<tr><td colspan="6" style="color:red; text-align:center;">Error: ${e.message}</td></tr>`;
    }
};

// --- FILTERED IMPORT FUNCTIONS ---
window.advImportByFilter = async (filterType) => {
    if (!advCurrentClient) {
        alert("Por favor, seleccione un cliente primero.");
        return;
    }
    
    let filterValue = '';
    if (filterType === 'date') {
        filterValue = prompt('📅 Introduce la fecha a buscar (DD/MM/AAAA):');
        if (!filterValue) return;
    } else if (filterType === 'name') {
        filterValue = prompt('👤 Introduce el nombre del destinatario:');
        if (!filterValue) return;
        filterValue = filterValue.toLowerCase().trim();
    } else if (filterType === 'number') {
        filterValue = prompt('🔢 Introduce el número de albarán (o parte del número):');
        if (!filterValue) return;
        filterValue = filterValue.trim();
    }
    
    // First load all tickets normally
    await advOpenTicketImportModal();
    
    // Now filter the cache
    if (advUnbilledTicketsCache.length === 0) return;
    
    const originalCache = [...advUnbilledTicketsCache];
    
    if (filterType === 'date') {
        // Parse DD/MM/YYYY
        const parts = filterValue.split(/[\/\-\.]/);
        let targetDate = null;
        if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            const year = parseInt(parts[2]);
            targetDate = new Date(year, month, day);
        }
        if (targetDate) {
            advUnbilledTicketsCache = originalCache.filter(t => {
                const d = (t.createdAt && t.createdAt.toDate) ? t.createdAt.toDate() : new Date(t.createdAt || 0);
                return d.getFullYear() === targetDate.getFullYear() && d.getMonth() === targetDate.getMonth() && d.getDate() === targetDate.getDate();
            });
        }
    } else if (filterType === 'name') {
        advUnbilledTicketsCache = originalCache.filter(t =>
            (t.receiver || '').toLowerCase().includes(filterValue) ||
            (t.receiverName || '').toLowerCase().includes(filterValue) ||
            (t.destName || '').toLowerCase().includes(filterValue)
        );
    } else if (filterType === 'number') {
        advUnbilledTicketsCache = originalCache.filter(t =>
            (t.id || '').toLowerCase().includes(filterValue.toLowerCase()) ||
            (t.docId || '').toLowerCase().includes(filterValue.toLowerCase())
        );
    }
    
    // Re-render filtered results
    if (advUnbilledTicketsCache.length === 0) {
        const tbody = document.getElementById('adv-import-tickets-body');
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#FFD700;">No se encontraron albaranes con ese filtro. Prueba con otro criterio.</td></tr>';
    } else {
        advRenderImportTable();
    }
    
    // Update modal title with filter info
    const modalTitle = document.querySelector('#modal-adv-import-tickets h2, #modal-adv-import-tickets .modal-title');
    if (modalTitle) {
        const labels = { date: '📅 Fecha: ' + filterValue, name: '👤 Nombre: ' + filterValue, number: '🔢 Nº: ' + filterValue };
        modalTitle.textContent = '📥 Albaranes — Filtro: ' + (labels[filterType] || '');
    }
};

window.advImportSelected = () => {
    // Check if there are checked items in the import modal
    const checks = document.querySelectorAll('.adv-import-check:checked');
    if (checks.length > 0) {
        // If modal is open and has selections, just confirm import
        advConfirmTicketImport();
    } else {
        // Open modal first so user can select
        advOpenTicketImportModal();
        alert('Selecciona los albaranes que quieras importar y pulsa "Aceptar Seleccionados".');
    }
};

function advRenderImportTable() {
    const tbody = document.getElementById('adv-import-tickets-body');
    tbody.innerHTML = '';
    
    // Sort array by date asc
    advUnbilledTicketsCache.sort((a,b) => {
        const da = (a.createdAt && a.createdAt.toDate) ? a.createdAt.toDate() : new Date(a.createdAt||0);
        const db = (b.createdAt && b.createdAt.toDate) ? b.createdAt.toDate() : new Date(b.createdAt||0);
        return da - db;
    });

    advUnbilledTicketsCache.forEach((t, i) => {
        // Skip if already in grid
        if (advGridRows.find(r => r.ticketId === t.docId)) return;
        
        const date = (t.createdAt && t.createdAt.toDate) ? t.createdAt.toDate().toLocaleDateString() : 'N/A';
        const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages||1);
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="text-align:center;"><input type="checkbox" class="adv-import-check" value="${i}" style="width:18px; height:18px;"></td>
            <td>${date}</td>
            <td style="font-weight:bold;">${t.id}</td>
            <td>${t.receiver || ''}</td>
            <td style="text-align:center;">${pkgs}</td>
            <td style="text-align:right; color:#4CAF50; font-weight:bold;">${(t.calculatedPrice||0).toFixed(2)}€</td>
        `;
        tbody.appendChild(tr);
    });
}

window.advToggleAllImportTickets = (checked) => {
    document.querySelectorAll('.adv-import-check').forEach(cb => cb.checked = checked);
};

window.advConfirmTicketImport = () => {
    const checks = document.querySelectorAll('.adv-import-check:checked');
    if(checks.length === 0) { alert("Seleccione al menos un albarán."); return; }
    
    checks.forEach(c => {
        const idx = parseInt(c.value);
        const t = advUnbilledTicketsCache[idx];
        const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages||1);
        
        // Push into Grid Rows
        advGridRows.push({
            id: 'row_' + Date.now() + Math.random(),
            description: `Albarán ${t.id || '-'} - Destino: ${t.receiver}`,
            qty: pkgs,
            price: t.calculatedPrice || 0,
            discount: 0,
            iva: window.invCompanyData ? window.invCompanyData.iva : 21,
            ticketId: t.docId,
            rawTicketData: t
        });
    });
    
    document.getElementById('modal-adv-import-tickets').style.display = 'none';
    advRenderGrid();
};

window.advAddEmptyRow = () => {
    advGridRows.push({
        id: 'row_' + Date.now(),
        description: '',
        qty: 1,
        price: 0,
        discount: 0,
        iva: window.invCompanyData ? window.invCompanyData.iva : 21,
        ticketId: null
    });
    advRenderGrid();
};

window.advRemoveRow = (id) => {
    advGridRows = advGridRows.filter(r => r.id !== id);
    advRenderGrid();
};

window.advUpdateRow = (id, field, value) => {
    const row = advGridRows.find(r => r.id === id);
    if (!row) return;
    
    if (field === 'description') row.description = value;
    else row[field] = parseFloat(value) || 0;
    
    advCalculateTotals(); // Only calculate totals, don't re-render entire grid to not lose input focus
};

function advRenderGrid() {
    const tbody = document.getElementById('adv-grid-body');
    tbody.innerHTML = '';
    
    if (advGridRows.length === 0) {
        tbody.innerHTML = '<tr id="adv-grid-empty"><td colspan="7" style="text-align:center; color:#666; padding:30px;">Comience importando albaranes o añadiendo líneas libres.</td></tr>';
        advCalculateTotals();
        return;
    }
    
    advGridRows.forEach(r => {
        const isLocked = r.ticketId ? 'readonly style="background:#222; opacity:0.8;"' : '';
        const lockedDesc = r.ticketId ? 'readonly style="background:#222; border-color:transparent;"' : '';
        
        // Safe line total calculation
        const gross = r.qty * r.price;
        const totalLine = gross - (gross * (r.discount / 100));
        r.total = totalLine;
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="text" value="${r.description}" ${lockedDesc} onchange="advUpdateRow('${r.id}', 'description', this.value)"></td>
            <td><input type="number" class="num-input" value="${r.qty}" min="1" step="1" onchange="advUpdateRow('${r.id}', 'qty', this.value)" oninput="advUpdateRow('${r.id}', 'qty', this.value)"></td>
            <td><input type="number" class="num-input" value="${r.price.toFixed(2)}" step="0.01" onchange="advUpdateRow('${r.id}', 'price', this.value)" oninput="advUpdateRow('${r.id}', 'price', this.value)"></td>
            <td><input type="number" class="num-input" value="${r.discount}" min="0" max="100" step="1" onchange="advUpdateRow('${r.id}', 'discount', this.value)" oninput="advUpdateRow('${r.id}', 'discount', this.value)"></td>
            <td><input type="number" class="num-input" value="${r.iva}" step="1" onchange="advUpdateRow('${r.id}', 'iva', this.value)" oninput="advUpdateRow('${r.id}', 'iva', this.value)"></td>
            <td style="text-align:right; font-weight:bold; vertical-align:middle; padding-right:15px;" id="adv-line-total-${r.id}">${totalLine.toFixed(2)}€</td>
            <td style="text-align:center; vertical-align:middle;"><button style="background:transparent; border:none; color:#FF3B30; cursor:pointer;" onclick="advRemoveRow('${r.id}')">🗑️</button></td>
        `;
        tbody.appendChild(tr);
    });
    
    advCalculateTotals();
}

window.advCurrentCalculations = { subtotal:0, iva:0, total:0 };

function advCalculateTotals() {
    let subtotal = 0;
    let totalIva = 0;
    
    // Aggregate by row to update individual row totals visually without losing focus
    advGridRows.forEach(r => {
        const gross = r.qty * r.price;
        const lineTotal = gross - (gross * (r.discount / 100));
        r.total = lineTotal;
        const lineIva = lineTotal * (r.iva / 100);
        
        subtotal += lineTotal;
        totalIva += lineIva;
        
        const lineTotalElem = document.getElementById(`adv-line-total-${r.id}`);
        if(lineTotalElem) lineTotalElem.textContent = lineTotal.toFixed(2) + '€';
    });
    
    const irpfElem = document.getElementById('fiscal-irpf');
    const irpfRate = parseFloat((irpfElem && irpfElem.value) ? irpfElem.value : 0);
    const irpf = subtotal * (irpfRate / 100);
    const total = subtotal + totalIva - irpf;
    
    document.getElementById('adv-base').textContent = subtotal.toFixed(2) + '€';
    document.getElementById('adv-iva').textContent = totalIva.toFixed(2) + '€';
    
    if (irpfRate > 0) {
        document.getElementById('adv-irpf-box').style.display = 'flex';
        document.getElementById('adv-irpf').textContent = '- ' + irpf.toFixed(2) + '€';
    } else {
        document.getElementById('adv-irpf-box').style.display = 'none';
    }
    
    document.getElementById('adv-total').textContent = total.toFixed(2) + '€';
    
    window.advCurrentCalculations = { subtotal, iva: totalIva, irpf, irpfRate, total };
}

// SAVE INVOICE LOGIC (Critical DB cross-check)
document.getElementById('btn-adv-save').onclick = async () => {
    if (!advCurrentClient) { alert("Seleccione un cliente."); return; }
    if (advGridRows.length === 0) { alert("La factura está vacía."); return; }
    if (advCurrentCalculations.total <= 0 && !confirm("El total es 0 o negativo. ¿Guardar de todos modos?")) return;
    
    if (typeof showLoading === 'function') showLoading();
    try {
        const dateStr = document.getElementById('adv-inv-date').value;
        const finalDate = dateStr ? new Date(dateStr) : new Date();
        const invYear = finalDate.getFullYear();
        const invYY = String(invYear).slice(-2);

        // Atomic invoice number: prevents collisions when two admins emit at once.
        const _seedInvFromHistory = async () => {
            const yearStart = new Date(invYear, 0, 1);
            const yearEnd = new Date(invYear + 1, 0, 1);
            const invSnap = await db.collection('invoices')
                .where('date', '>=', yearStart)
                .where('date', '<', yearEnd)
                .orderBy('date', 'desc')
                .limit(10000)
                .get();
            let max = 0;
            invSnap.forEach(doc => {
                const d = doc.data();
                const iid = d.invoiceId || '';
                const m = iid.match(/^FAC-\d{2}-(\d+)$/);
                if (m) {
                    const seq = parseInt(m[1], 10);
                    if (!isNaN(seq) && seq > max) max = seq;
                }
                const n = d.number || 0;
                if (n > max) max = n;
            });
            return max;
        };
        let nextNum;
        if (typeof window.allocSequentialNumber === 'function') {
            nextNum = await window.allocSequentialNumber('sequence_counters/invoices_' + invYear, _seedInvFromHistory);
        } else {
            nextNum = (await _seedInvFromHistory()) + 1;
        }

        // Extraer tickets afectados
        const ticketsIdArray = advGridRows.filter(r => r.ticketId).map(r => r.rawTicketData.id);
        const ticketsDetailArray = advGridRows.filter(r => r.ticketId).map(r => ({
            id: r.rawTicketData.id,
            compName: r.rawTicketData.compName || "",
            price: r.price
        }));

        // Construir datos del emisor basados en filial seleccionada
        const compPicker = document.getElementById('adv-company-picker');
        const compId = compPicker ? compPicker.value : '';
        let finalSenderData = {};
        if (compId && window.advCompaniesMap && window.advCompaniesMap[compId]) {
            const filial = window.advCompaniesMap[compId];
            finalSenderData = {
                name: filial.name || '',
                cif: filial.nif || filial.cif || '',
                address: filial.address || '',
                bank: filial.bank || '',
                email: filial.email || '',
                sepaId: filial.sepaId || '',
                iva: filial.iva || 21,
                irpf: filial.irpf || 0
            };
            if (filial.legal) finalSenderData.legal = filial.legal;
        } else if (window.invCompanyData) {
            // Fallback to legacy config/fiscal if no filial selected
            finalSenderData = Object.assign({}, window.invCompanyData);
        }

        // VALIDACIÓN NIF (Sprint 2 §2.3) — sin NIF la factura es legalmente nula
        const _clientFiscalId = ((advCurrentClient.cif || advCurrentClient.nif || '') + '').trim().toUpperCase();
        if (!_clientFiscalId || _clientFiscalId === 'N/A' || _clientFiscalId === '-') {
            alert('🔒 NO PERMITIDO\n\nEl cliente "' + (advCurrentClient.name || advCurrentClient.id) + '" no tiene NIF/CIF en su ficha.\n\nUna factura sin NIF es FORMALMENTE NULA (RD 1619/2012 art. 6.1.d) y no deducible para el receptor.\n\nCompleta el NIF en su ficha de cliente y vuelve a intentarlo.');
            if (typeof hideLoading === 'function') hideLoading();
            return;
        }

        // fechaDevengo (Sprint 2 §2.3): cuándo se devenga el IVA. Para facturas
        // manuales, asumimos que se devenga el día de emisión salvo que advCurrentTickets
        // exista — en cuyo caso es la fecha del último ticket incluido.
        let _fechaDevengo = finalDate;
        try {
            if (Array.isArray(window.advCurrentTickets) && window.advCurrentTickets.length > 0) {
                let maxTs = 0;
                window.advCurrentTickets.forEach(t => {
                    const d = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate() : (t.date ? new Date(t.date) : null);
                    if (d && !isNaN(d.getTime()) && d.getTime() > maxTs) maxTs = d.getTime();
                });
                if (maxTs > 0) _fechaDevengo = new Date(maxTs);
            }
        } catch(_) {}

        const invoiceData = {
            number: nextNum,
            invoiceId: `FAC-${invYY}-${nextNum}`,
            date: finalDate,           // fecha EXPEDICIÓN
            fechaDevengo: _fechaDevengo, // fecha OPERACIÓN (devengo IVA)
            clientId: advCurrentClient.id,
            clientName: advCurrentClient.name,
            clientCIF: _clientFiscalId,
            subtotal: advCurrentCalculations.subtotal,
            iva: advCurrentCalculations.iva,
            ivaRate: advGridRows.length > 0 ? advGridRows[0].iva : 21, // Simplified avg if mixed
            irpf: advCurrentCalculations.irpf,
            irpfRate: advCurrentCalculations.irpfRate,
            total: advCurrentCalculations.total,
            paid: false,
            paymentTerms: advCurrentClient.paymentTerms || 'contado',
            dueDate: _calcDueDate(finalDate, advCurrentClient.paymentTerms || 'contado'),
            tickets: ticketsIdArray, // Old array style for compatibility
            ticketsDetail: ticketsDetailArray,
            senderData: finalSenderData,
            // Advanced specific fields (to recreate grids if needed later)
            advancedGrid: advGridRows.map(r => ({description: r.description, qty: r.qty, price: r.price, discount: r.discount, iva: r.iva, total: r.total, ticketId: r.ticketId}))
        };
        if (typeof getOperatorStamp === 'function') Object.assign(invoiceData, getOperatorStamp());

        const invDoc = await db.collection('invoices').add(invoiceData);

        // Batch update all tickets
        if (ticketsIdArray.length > 0) {
            const batch = db.batch();
            advGridRows.filter(r=>r.ticketId).forEach(r => {
                const tRef = db.collection('tickets').doc(r.ticketId);
                batch.update(tRef, { invoiceId: invDoc.id, invoiceNum: invoiceData.invoiceId });
            });
            await batch.commit();
        }

        alert(`✅ Factura ${invoiceData.invoiceId} generada y registrada con éxito.\nImporte: ${invoiceData.total.toFixed(2)}€`);
        
        // Transition to Saved State
        advCurrentInvoiceId = invDoc.id;
        document.getElementById('adv-inv-number').value = invoiceData.invoiceId;
        
        // Update Buttons
        document.getElementById('btn-adv-save').style.display = 'none';
        const payBtn = document.getElementById('btn-adv-pay');
        const creditBtn = document.getElementById('btn-adv-credit');
        const printBtn = document.getElementById('btn-adv-print');
        const emailBtn = document.getElementById('btn-adv-email');
        if(payBtn) payBtn.style.display = 'block';
        if(creditBtn) creditBtn.style.display = 'block';
        if(printBtn) printBtn.style.display = 'block';
        if(emailBtn) emailBtn.style.display = 'block';
        
        // Refresh classic billing list just in case
        if (typeof window.loadInvoices === 'function') window.loadInvoices();

    } catch (e) {
        alert("Error crítico guardando factura: " + e.message);
        console.error(e);
    } finally {
        if (typeof hideLoading === 'function') hideLoading();
    }
};

const btnPrint = document.getElementById('btn-adv-print');
if(btnPrint) {
    btnPrint.addEventListener('click', () => {
        if(!advCurrentInvoiceId) { alert("Primero debes guardar la factura."); return; }
        if(typeof window.printInvoice === 'function') window.printInvoice(advCurrentInvoiceId);
    });
}

const btnEmail = document.getElementById('btn-adv-email');
if(btnEmail) {
    btnEmail.addEventListener('click', () => {
        if(!advCurrentInvoiceId) { alert("Primero debes guardar la factura."); return; }
        if(typeof window.emailInvoice === 'function') window.emailInvoice(advCurrentInvoiceId);
    });
}

const btnPay = document.getElementById('btn-adv-pay');
if(btnPay) {
    btnPay.addEventListener('click', async () => {
        if(!advCurrentInvoiceId) { alert("Primero debes guardar la factura."); return; }
        if(confirm("¿Marcar esta factura como COBRADA?")) {
            try {
                await db.collection('invoices').doc(advCurrentInvoiceId).update({ paid: true, paidDate: new Date(), ...(typeof getOperatorStamp === 'function' ? getOperatorStamp() : {}) });
                alert("✅ Factura marcada como cobrada exitosamente.");
                document.getElementById('btn-adv-pay').style.display = 'none';
            } catch(e) {
                alert("Error: " + e.message);
            }
        }
    });
}

const btnClose = document.getElementById('btn-adv-close');
if(btnClose) {
    btnClose.addEventListener('click', () => {
        if(typeof window.showView === 'function') window.showView('billing');
    });
}

window.advResetForm = () => {
    if(advGridRows.length > 0 && !confirm('¿Borrador en curso. Seguro que quieres limpiar y empezar una nueva factura?')) return;
    advCurrentClient = null;
    advCurrentInvoiceId = null;
    document.getElementById('adv-client-picker').value = '';
    const searchEl = document.getElementById('adv-client-search');
    if(searchEl) searchEl.value = '';
    document.getElementById('adv-inv-number').value = '';
    document.getElementById('adv-inv-date').value = '';
    advGridRows = [];
    advRenderGrid();
    
    // Show all buttons by default as requested by user
    document.getElementById('btn-adv-save').style.display = 'block';
    const payBtn = document.getElementById('btn-adv-pay');
    const creditBtn = document.getElementById('btn-adv-credit');
    const printBtn = document.getElementById('btn-adv-print');
    const emailBtn = document.getElementById('btn-adv-email');
    if(payBtn) payBtn.style.display = 'block';
    if(creditBtn) creditBtn.style.display = 'block';
    if(printBtn) printBtn.style.display = 'block';
    if(emailBtn) emailBtn.style.display = 'block';
};

const btnCredit = document.getElementById('btn-adv-credit');
if(btnCredit) {
    btnCredit.addEventListener('click', async () => {
        if(!advCurrentInvoiceId) { alert("Debes guardar o cargar una factura primero."); return; }
        if(!confirm("¿Deseas generar una FACTURA RECTIFICATIVA (Abono) idéntica pero en negativo para esta factura?")) return;

        // LEGAL: capturar motivo de rectificación (RD 1619/2012 art. 15)
        const _causas = [
            { codigo: 'R1', texto: 'Error fundado en derecho (datos identificativos, importes, tipo IVA, etc.)' },
            { codigo: 'R2', texto: 'Modificación BI: descuento/bonificación posterior a la emisión' },
            { codigo: 'R3', texto: 'Anulación total de la operación' },
            { codigo: 'R4', texto: 'Devolución de mercancías o envases' },
            { codigo: 'R5', texto: 'Impago judicialmente declarado (concurso, art. 80.3 LIVA)' },
            { codigo: 'R6', texto: 'Modificación BI por sentencia firme o resolución administrativa' },
            { codigo: 'R7', texto: 'Otro motivo legal (especificar)' }
        ];
        const _listaCausas = _causas.map((c, i) => `  ${i+1}. ${c.codigo} — ${c.texto}`).join('\n');
        const _sel = prompt('MOTIVO DE LA RECTIFICACIÓN (obligatorio - RD 1619/2012 art. 15)\n\n' + _listaCausas + '\n\nEscribe el número (1-7):');
        if (_sel === null) return;
        const _idx = parseInt(_sel, 10) - 1;
        if (isNaN(_idx) || _idx < 0 || _idx >= _causas.length) { alert('Causa no válida.'); return; }
        let _causa = _causas[_idx];
        if (_causa.codigo === 'R7') {
            const _t = prompt('Especifica el motivo:');
            if (!_t || !_t.trim()) return;
            _causa = { codigo: 'R7', texto: _t.trim() };
        }

        if(typeof showLoading === 'function') showLoading();
        try {
            const doc = await db.collection('invoices').doc(advCurrentInvoiceId).get();
            if(!doc.exists) throw new Error("La factura original ya no existe.");
            const orig = doc.data();

            // Numeración atómica con serie R independiente (Fix legal-sprint1 #2)
            const aboYear = new Date().getFullYear();
            const aboYY = String(aboYear).slice(-2);
            const counterPath = 'sequence_counters/credits_' + aboYear;

            const nextNum = await window.allocSequentialNumber(counterPath, async () => {
                const yrStart = new Date(aboYear, 0, 1);
                const yrEnd = new Date(aboYear + 1, 0, 1);
                const snap = await db.collection('invoices')
                    .where('date', '>=', yrStart).where('date', '<', yrEnd)
                    .limit(20000).get();
                let max = 0;
                snap.forEach(d => {
                    const iid = d.data().invoiceId || '';
                    const m = iid.match(/^R-\d{2}-(\d+)$/);
                    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
                });
                return max;
            });

            const abonoData = {
                ...orig,
                number: nextNum,
                invoiceId: `R-${aboYY}-${nextNum}`,
                serie: 'R',
                date: new Date(),
                subtotal: -orig.subtotal,
                iva: -orig.iva,
                irpf: -orig.irpf,
                total: -orig.total,
                isAbono: true,
                rectificaA: orig.invoiceId,
                rectificaDocId: advCurrentInvoiceId,
                rectificaDate: orig.date || null,
                motivoRectificacion: _causa.codigo,
                motivoRectificacionTexto: _causa.texto,
                paid: false,  // pendiente devolver/compensar
                advancedGrid: (orig.advancedGrid || []).map(r => ({...r, qty: -r.qty, total: -r.total})),
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            
            if (abonoData.ticketsDetail) {
                abonoData.ticketsDetail = abonoData.ticketsDetail.map(t => ({...t, price: -t.price}));
            }
            if (typeof getOperatorStamp === 'function') Object.assign(abonoData, getOperatorStamp());

            const abonoDoc = await db.collection('invoices').add(abonoData);
            alert(`✅ Abono ${abonoData.invoiceId} generado exitosamente.`);
            
            // Auto-load the new abono
            advLoadInvoice(abonoDoc.id);
            
            // Reload classic list
            if (typeof window.loadInvoices === 'function') window.loadInvoices();
            
        } catch(e) {
            alert("Error generando abono: " + e.message);
        } finally {
            if(typeof hideLoading === 'function') hideLoading();
        }
    });
}

window.advLoadInvoice = async (invoiceId) => {
    if(!invoiceId) return;
    if(typeof showLoading === 'function') showLoading();
    try {
        const doc = await db.collection('invoices').doc(invoiceId).get();
        if(!doc.exists) throw new Error("Factura no encontrada.");
        const inv = doc.data();
        
        advCurrentClient = (window.userMap && window.userMap[inv.clientId]) ? window.userMap[inv.clientId] : { name: inv.clientName, nif: inv.clientCIF, idNum: inv.clientCIF, id: inv.clientId };
        advCurrentInvoiceId = doc.id;
        
        // Set header
        document.getElementById('adv-inv-number').value = inv.invoiceId;
        const dateObj = (inv.date && inv.date.toDate) ? inv.date.toDate() : new Date(inv.date);
        document.getElementById('adv-inv-date').value = dateObj.toISOString().split('T')[0];
        
        // Populate Grid
        advGridRows = [];
        if (inv.advancedGrid && inv.advancedGrid.length > 0) {
            inv.advancedGrid.forEach((r, i) => {
                advGridRows.push({
                    id: 'row_loaded_' + i,
                    description: r.description,
                    qty: r.qty,
                    price: r.price,
                    discount: r.discount || 0,
                    iva: r.iva || inv.ivaRate || 21,
                    total: r.total,
                    ticketId: r.ticketId
                });
            });
        } else if (inv.ticketsDetail && inv.ticketsDetail.length > 0) {
             inv.ticketsDetail.forEach((t, i) => {
                 advGridRows.push({
                     id: 'row_loaded_' + i,
                     description: `Albarán ${t.id || '-'} - ${t.compName || ''}`,
                     qty: 1,
                     price: t.price,
                     discount: 0,
                     iva: inv.ivaRate || 21,
                     total: t.price,
                     ticketId: t.id
                 });
             });
        }
        
        // We override the client picker to show the current client's name without needing full reload of dropdown if not found
        const picker = document.getElementById('adv-client-picker');
        let optionExists = Array.from(picker.options).some(o => o.value === inv.clientId);
        if(!optionExists) {
            const opt = document.createElement('option');
            opt.value = inv.clientId;
            opt.textContent = `[${inv.clientCIF}] ${inv.clientName}`;
            picker.appendChild(opt);
        }
        picker.value = inv.clientId;
        const searchEl = document.getElementById('adv-client-search');
        if(searchEl) searchEl.value = `[${inv.clientCIF}] ${inv.clientName}`;
        
        advRenderGrid();
        
        // UI State
        document.getElementById('btn-adv-save').style.display = 'none';
        const payBtn = document.getElementById('btn-adv-pay');
        const creditBtn = document.getElementById('btn-adv-credit');
        const printBtn = document.getElementById('btn-adv-print');
        const emailBtn = document.getElementById('btn-adv-email');
        if(payBtn) payBtn.style.display = inv.paid ? 'none' : 'block';
        if(creditBtn) creditBtn.style.display = 'block';
        if(printBtn) printBtn.style.display = 'block';
        if(emailBtn) emailBtn.style.display = 'block';
        
        const viewDiv = document.getElementById('view-adv-billing');
        if(viewDiv) viewDiv.style.display = 'flex';
        
    } catch(e) {
        alert("Error cargando factura: " + e.message);
    } finally {
        if(typeof hideLoading === 'function') hideLoading();
    }
};

window.toggleAdvTariffs = () => {
    const isShowingTariffs = document.getElementById('adv-tariffs-workspace').style.display !== 'none';
    if(isShowingTariffs) {
        document.getElementById('adv-tariffs-workspace').style.display = 'none';
        document.getElementById('adv-billing-workspace').style.display = 'flex';
        document.getElementById('btn-adv-tariffs-toggle').innerHTML = '💰 Gestión de Tarifas';
        document.getElementById('btn-adv-tariffs-toggle').style.color = '#FFD700';
    } else {
        document.getElementById('adv-billing-workspace').style.display = 'none';
        document.getElementById('adv-tariffs-workspace').style.display = 'flex';
        document.getElementById('btn-adv-tariffs-toggle').innerHTML = '◀ Volver a Factura';
        document.getElementById('btn-adv-tariffs-toggle').style.color = 'white';
        if(typeof window.loadTariffClients === 'function') window.loadTariffClients();
        if(typeof window.loadArticlesCount === 'function') window.loadArticlesCount();
    }
};

// Toggle between main billing workspace and sub-workspaces
window.toggleAdvWorkspace = (workspace) => {
    // All possible workspace IDs
    const wsIds = ['adv-billing-workspace','adv-history-workspace','adv-tariffs-workspace','adv-reports-workspace','conta-workspace','adv-clients-workspace','adv-providers-workspace','adv-manual-tickets-workspace','adv-scanner-workspace'];
    wsIds.forEach(id => {
        const el = document.getElementById(id);
        if(el) {
            el.style.display = 'none';
            // Reset any positioning we may have applied
            el.style.position = '';
            el.style.top = '';
            el.style.left = '';
            el.style.width = '';
            el.style.height = '';
            el.style.zIndex = '';
        }
    });
    // Stop scanner if leaving scanner workspace
    if (workspace !== 'scanner' && typeof window.advStopScanner === 'function') window.advStopScanner();

    // Toggle main toolbar visibility: hide when entering a sub-workspace, show when returning to main
    const mainToolbar = document.getElementById('adv-main-toolbar');
    const isMainWorkspace = (!workspace || workspace === 'main');
    if (mainToolbar) mainToolbar.style.display = isMainWorkspace ? 'flex' : 'none';

    // Helper: activate a sub-workspace as a FIXED overlay covering the entire billing area
    const activateWS = (el) => {
        if (!el) return;
        const isMobile = window.innerWidth <= 992;
        const isCollapsed = document.body.classList.contains('sidebar-collapsed');
        const leftOffset = isMobile ? '0' : (isCollapsed ? '8px' : (getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim() || '0px'));
        const widthCalc = isMobile ? '100%' : ('calc(100% - ' + leftOffset + ')');
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
        el.style.position = 'fixed';
        el.style.top = '0';
        el.style.left = leftOffset;
        el.style.width = widthCalc;
        el.style.height = '100vh';
        el.style.zIndex = '100000';
        el.style.background = '#1e1e1e';
        el.style.overflow = 'auto';
    };

    // Show the requested workspace
    switch(workspace) {
        case 'reports':
            activateWS(document.getElementById('adv-reports-workspace')); break;
        case 'history':
            activateWS(document.getElementById('adv-history-workspace')); break;
        case 'clients':
            const c = document.getElementById('adv-clients-workspace');
            activateWS(c);
            if(typeof window.advLoadClients==='function') window.advLoadClients();
            break;
        case 'providers':
            const p = document.getElementById('adv-providers-workspace');
            activateWS(p);
            if(typeof window.advLoadProviders==='function') window.advLoadProviders();
            break;
        case 'manual-tickets':
            const mt = document.getElementById('adv-manual-tickets-workspace');
            activateWS(mt);
            if(typeof window.advInitManualTickets==='function') window.advInitManualTickets();
            break;
        case 'scanner':
            const s = document.getElementById('adv-scanner-workspace');
            activateWS(s);
            setTimeout(()=>{ if(typeof window.advStartScanner==='function') window.advStartScanner(); }, 500);
            break;
        default:
            const m = document.getElementById('adv-billing-workspace');
            if(m) { m.style.display = 'flex'; }
            break;
    }
};


// --- DRAWER LOGIC FOR CATALOG AND TARIFFS ---
window.advCurrentDrawerType = null;
window.advDrawerItemsCache = [];

window.advOpenDrawer = async (type) => {
    window.advCurrentDrawerType = type;
    const drawer = document.getElementById('adv-catalog-drawer');
    const title = document.getElementById('adv-drawer-title');
    const list = document.getElementById('adv-drawer-list');
    const search = document.getElementById('adv-drawer-search');
    
    if(!drawer) return;
    drawer.classList.add('open');
    if(search) search.value = '';
    list.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa;">Cargando catálogo interactivamente...</div>';
    window.advDrawerItemsCache = [];

    try {
        if (type === 'articles') {
            title.textContent = '📦 Catálogo Maestro de Artículos';
            const snap = await db.collection('articles').orderBy('name').get();
            if(!snap.empty) {
                snap.forEach(doc => {
                    const d = doc.data();
                    window.advDrawerItemsCache.push({ id: doc.id, name: d.name, price: d.price || 0, type: 'article' });
                });
            } else {
                list.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa;">No hay artículos en el maestro. Crealos en la sección Artículos.</div>';
                return;
            }
        } else if (type === 'tariffs') {
            title.textContent = '💰 Tarifas y Acuerdos de Cliente';
            if (!advCurrentClient) {
                list.innerHTML = '<div style="text-align:center; padding:20px; color:#ff4444; font-weight:bold;">⚠️ Seleccione primero un CLIENTE en la cabecera de la factura.</div>';
                return;
            }
            
            // Check global / client tariffs from global window.tariffsCache or fetch
            let tariffsArray = [];
            if(window.tariffsCache && Object.keys(window.tariffsCache).length > 0) {
                 tariffsArray = Object.values(window.tariffsCache);
            } else {
                 const tSnap = await db.collection('tariffs').get();
                 tSnap.forEach(tDoc => tariffsArray.push({id: tDoc.id, ...tDoc.data()}));
            }

            let foundAny = false;
            tariffsArray.forEach(t => {
                // Filter if it's assigned to this client or is a general one
                if(t.assignedClient === advCurrentClient.id || t.assignedClient === advCurrentClient.idNum || !t.assignedClient || t.assignedClient === 'GLOBAL') {
                    foundAny = true;
                    if(t.subTariff && t.subTariff.length > 0) {
                        t.subTariff.forEach(st => {
                            window.advDrawerItemsCache.push({
                                id: t.id + '_' + st.id,
                                name: `${t.name} - ${st.name} (${st.origin || '*'} ➔ ${st.destination || '*'})`,
                                price: st.price || 0,
                                type: 'tariff'
                            });
                        });
                    } else if (t.basePrice) {
                        window.advDrawerItemsCache.push({
                            id: t.id,
                            name: t.name,
                            price: t.basePrice || 0,
                            type: 'tariff'
                        });
                    }
                }
            });

            if(!foundAny || window.advDrawerItemsCache.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:20px; color:#ff4444;">No se encontraron tarifas genéricas ni asociadas a este cliente.</div>';
                return;
            }
        }
        
        advRenderDrawerList();
    } catch(e) {
        list.innerHTML = `<div style="text-align:center; padding:20px; color:#ff4444;">Error de lectura: ${e.message}</div>`;
    }
};

window.advRenderDrawerList = (filter = '') => {
    const list = document.getElementById('adv-drawer-list');
    if(!list) return;
    list.innerHTML = '';
    const term = filter.toLowerCase();
    
    let count = 0;
    window.advDrawerItemsCache.forEach(item => {
        if(term && !item.name.toLowerCase().includes(term)) return;
        count++;
        
        const div = document.createElement('div');
        div.className = 'adv-drawer-item';
        // HTML Injection safe string escaping for item.name
        const safeName = item.name.replace(/'/g, "\\'");
        div.innerHTML = `
            <div style="flex:1; padding-right:10px;">
                <div style="color:#d4d4d4; font-weight:bold; font-size:0.9rem; line-height:1.2; margin-bottom:4px;">${item.name}</div>
                <div style="color:#4CAF50; font-size:0.85rem; font-weight:900;">${parseFloat(item.price).toFixed(2)} €</div>
            </div>
            <button style="background:#007acc; border:none; color:white; padding:8px 15px; border-radius:4px; font-weight:bold; cursor:pointer;" onmouseover="this.style.background='#0098ff'" onmouseout="this.style.background='#007acc'" onclick="advAddRowFromDrawer('${safeName}', ${item.price})">+ AÑADIR</button>
        `;
        list.appendChild(div);
    });
    
    if(count === 0) {
        list.innerHTML = '<div style="text-align:center; padding:20px; color:#666;">No hay coincidencias con tu búsqueda.</div>';
    }
};

var _advFilterDrawerTimer;
window.advFilterDrawer = (val) => {
    clearTimeout(_advFilterDrawerTimer);
    _advFilterDrawerTimer = setTimeout(() => { advRenderDrawerList(val); }, 300);
};

window.advAddRowFromDrawer = (desc, price) => {
    advGridRows.push({
        id: 'row_' + Date.now() + Math.floor(Math.random()*1000),
        description: desc,
        qty: 1,
        price: parseFloat(price) || 0,
        discount: 0,
        iva: window.invCompanyData ? window.invCompanyData.iva : 21,
        ticketId: null
    });
    advRenderGrid();
};

// --- TAB SWITCHING FOR TARIFFS WORKSPACE ---
window.showTariffTab = (tab) => {
    const tabs = ['global', 'client', 'articles', 'exclusive'];
    tabs.forEach(t => {
        const el = document.getElementById('tariff-tab-' + t);
        if(el) el.style.display = (t === tab) ? 'block' : 'none';
    });
    // Load data when switching
    if(tab === 'global') {
        // Cards-based view (rediseño 2026-05-14)
        if (typeof window.renderTariffCards === 'function') window.renderTariffCards();
        if (typeof populateGlobalTariffsDatalist === 'function') populateGlobalTariffsDatalist();
    }
    if(tab === 'articles') {
        loadArticlesPRO();
        loadArticlesCount();
    }
    if(tab === 'client' && typeof window.loadTariffClients === 'function') {
        window.loadTariffClients();
        loadImportGlobalSelect();
    }
    if(tab === 'exclusive') {
        loadExclusiveTariffs();
    }
};

// --- IMPORT GLOBAL TARIFF TO CLIENT ---
window._globalTariffCache = {};

async function loadImportGlobalSelect() {
    const sel = document.getElementById('import-global-tariff-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Seleccionar tarifa global...</option>';
    window._globalTariffCache = {};
    try {
        const snap = await db.collection('tariffs').get();
        snap.forEach(doc => {
            if (doc.id.startsWith('GLOBAL_')) {
                const id = doc.id.replace('GLOBAL_', '');
                const data = doc.data();
                const itemCount = data.items ? Object.keys(data.items).length : 0;
                window._globalTariffCache[doc.id] = data;
                const opt = document.createElement('option');
                opt.value = doc.id;
                const mode = data.tariffMode || 'size';
                opt.textContent = 'Tarifa #' + id + (mode === 'weight' ? ' (PESO — ' + ((data.weightTariff && data.weightTariff.brackets) ? data.weightTariff.brackets.length : 0) + ' tramos)' : ' (' + itemCount + ' artículos)');
                sel.appendChild(opt);
            }
        });
        // Preview on change
        sel.onchange = () => {
            const preview = document.getElementById('tariff-preview-count');
            if (!preview) return;
            const cached = window._globalTariffCache[sel.value];
            if (cached) {
                const mode = cached.tariffMode || 'size';
                if (mode === 'weight' && cached.weightTariff) {
                    const bc = cached.weightTariff.brackets ? cached.weightTariff.brackets.length : 0;
                    preview.textContent = '→ PESO: ' + bc + ' tramos se copiarán';
                    preview.style.color = '#4CAF50';
                } else if (cached.items) {
                    preview.textContent = '→ ' + Object.keys(cached.items).length + ' artículos se copiarán';
                    preview.style.color = '#4CAF50';
                } else {
                    preview.textContent = '';
                }
            } else {
                preview.textContent = '';
            }
        };
    } catch(e) { console.error(e); }
}

window.importGlobalToClient = async () => {
    const clientUid = document.getElementById('tariff-client-select').value;
    const globalId = document.getElementById('import-global-tariff-select').value;
    if (!clientUid) { alert('❌ Selecciona un cliente primero (paso 1)'); return; }
    if (!globalId) { alert('❌ Selecciona una tarifa global (paso 2)'); return; }
    
    const clientName = window.userMap[clientUid] ? window.userMap[clientUid].name : clientUid;
    const tariffName = globalId.replace('GLOBAL_', '#');
    
    try {
        // Get global tariff (from cache or fetch)
        let globalData;
        if (window._globalTariffCache[globalId]) {
            globalData = window._globalTariffCache[globalId];
        } else {
            const globalDoc = await db.collection('tariffs').doc(globalId).get();
            if (!globalDoc.exists) { alert('Tarifa global no encontrada'); return; }
            globalData = globalDoc.data();
        }

        const globalItems = globalData.items || {};
        const tariffMode = globalData.tariffMode || 'size';
        const weightTariff = globalData.weightTariff || null;
        const weightSurcharge = globalData.weightSurcharge || null;

        // Validation depending on mode
        if (tariffMode === 'weight') {
            if (!weightTariff || !weightTariff.brackets || weightTariff.brackets.length === 0) {
                alert('⚠️ La tarifa ' + tariffName + ' no tiene tramos de peso configurados.'); return;
            }
        } else {
            const itemCount = Object.keys(globalItems).length;
            if (itemCount === 0) { alert('⚠️ La tarifa ' + tariffName + ' no tiene artículos.'); return; }
        }

        // Copy all global data to client tariff
        const clientTariffData = {
            items: globalItems,
            tariffMode: tariffMode,
            subTariff: {},
            basedOn: globalId,
            assignedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (weightTariff) clientTariffData.weightTariff = weightTariff;
        if (weightSurcharge) clientTariffData.weightSurcharge = weightSurcharge;

        await db.collection('tariffs').doc(clientUid).set(clientTariffData, { merge: true });

        // Show success
        const modeLabel = tariffMode === 'weight'
            ? (weightTariff.brackets.length + ' tramos de peso copiados')
            : (Object.keys(globalItems).length + ' artículos copiados correctamente');
        const content = document.getElementById('tariff-client-content');
        if (content) {
            content.innerHTML = `
                <div style="background:rgba(76,175,80,0.1); border:1px solid #4CAF50; border-radius:8px; padding:20px; text-align:center;">
                    <div style="font-size:1.5rem; margin-bottom:10px;">✅ Tarifa Adjudicada</div>
                    <div style="font-size:0.95rem; color:#d4d4d4; margin-bottom:5px;">
                        <b style="color:#FFD700;">${clientName}</b> → Tarifa <b style="color:#4CAF50;">${tariffName}</b>
                        ${tariffMode === 'weight' ? '<span style="background:#4CAF50; color:white; padding:2px 8px; border-radius:10px; font-size:0.7rem; margin-left:8px;">PESO</span>' : ''}
                    </div>
                    <div style="font-size:0.85rem; color:#aaa;">${modeLabel}</div>
                    <button onclick="document.getElementById('btn-load-tariff').click()" style="background:#007acc; border:none; color:white; padding:8px 20px; margin-top:15px; cursor:pointer; border-radius:4px; font-size:0.85rem;">✏️ Ver/Editar Precios del Cliente</button>
                </div>
            `;
        }

        console.log('✅ Tarifa', tariffName, '(' + tariffMode + ') adjudicada a', clientName);
    } catch(e) {
        alert('❌ Error: ' + e.message);
        console.error(e);
    }
};

// --- GLOBAL TARIFF CRUD ---
window.promptCreateGlobalTariff = async () => {
    const tid = prompt('ID para la nueva tarifa global (ej: 50, ZONA1, PREMIUM):');
    if (!tid || !tid.trim()) return;
    const docId = 'GLOBAL_' + tid.trim();
    try {
        await db.collection('tariffs').doc(docId).set({ items: {}, subTariff: {}, tariffMode: 'size' }, { merge: true });
        document.getElementById('tariff-global-id').value = tid.trim();
        document.getElementById('btn-load-global-tariff').click();
        if (typeof populateGlobalTariffsDatalist === 'function') populateGlobalTariffsDatalist();
        console.log('Tarifa global creada:', docId);
    } catch(e) { console.error('Error creando tarifa:', e); }
};

window.deleteCurrentGlobalTariff = async () => {
    if (!window.currentTariffUID) {
        alert('No hay tarifa cargada para eliminar.\n\nCarga primero una tarifa con el botón "Cargar" y luego pulsa Eliminar.');
        return;
    }
    if (!window.currentTariffUID.startsWith('GLOBAL_')) {
        alert('Solo se pueden eliminar tarifas globales desde aquí (la actual: ' + window.currentTariffUID + ').');
        return;
    }
    return window.deleteTariffById(window.currentTariffUID);
};

// Borrado directo de una tarifa por su docId (lo usan las cards v1 y v2).
window.deleteTariffById = async (tariffDocId) => {
    if (!tariffDocId) { alert('ID de tarifa vacío.'); return; }

    // Contar clientes que la usan
    let usingCount = 0;
    let usingList = [];
    try {
        if (window.userMap) {
            Object.values(window.userMap).forEach(u => {
                if (!u.tariffId) return;
                const tid = String(u.tariffId);
                if (tid === tariffDocId || ('GLOBAL_' + tid) === tariffDocId || tariffDocId === ('GLOBAL_' + tid)) {
                    usingCount++;
                    if (usingList.length < 5) usingList.push((u.name || ('#' + (u.idNum || u.id))));
                }
            });
        }
    } catch(_) {}

    let msg = '¿Eliminar la tarifa "' + tariffDocId + '"?\n\n';
    if (usingCount > 0) {
        msg += '⚠️ ATENCIÓN: ' + usingCount + ' cliente' + (usingCount === 1 ? '' : 's') + ' la tiene' + (usingCount === 1 ? '' : 'n') + ' asignada:\n';
        msg += '  ' + usingList.join('\n  ');
        if (usingCount > usingList.length) msg += '\n  ... y ' + (usingCount - usingList.length) + ' más';
        msg += '\n\nTras eliminar quedarán SIN tarifa asignada.\n\n';
    }
    msg += 'Esta acción NO se puede deshacer. ¿Continuar?';

    if (!confirm(msg)) return;

    if (usingCount > 0) {
        const confirmText = prompt('Para confirmar, escribe exactamente: ELIMINAR');
        if (confirmText !== 'ELIMINAR') {
            alert('Cancelado.');
            return;
        }
    }

    try {
        await db.collection('tariffs').doc(tariffDocId).delete();
        // Limpiar UI legacy si estaba abierta
        const editorArea = document.getElementById('tariff-editor-area');
        if (editorArea) editorArea.style.display = 'none';
        const delBtn = document.getElementById('btn-delete-global-tariff');
        if (delBtn) delBtn.style.display = 'none';
        const inp = document.getElementById('tariff-global-id');
        if (inp) inp.value = '';
        window.currentTariffUID = null;
        // Refrescar listados
        if (typeof populateGlobalTariffsDatalist === 'function') populateGlobalTariffsDatalist();
        if (typeof window.renderTariffCards === 'function') window.renderTariffCards();
        alert('✅ Tarifa eliminada: ' + tariffDocId);
    } catch(e) {
        console.error('Error eliminando tarifa:', e);
        alert('Error al eliminar: ' + e.message);
    }
};

window.promptNewArticlePRO = () => {
    // Switch to articles tab and show the form
    showTariffTab('articles');
    resetArticleForm();
    const panel = document.getElementById('articles-crud-panel');
    if(panel) panel.style.display = 'block';
    const nameField = document.getElementById('art-name');
    if(nameField) nameField.focus();
};

// --- ARTICLES CRUD FOR PRO TARIFFS WORKSPACE ---
window.toggleArticlesPanel = () => {
    const panel = document.getElementById('articles-crud-panel');
    if(!panel) return;
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
    if(!isVisible) loadArticlesPRO();
};

window.loadArticlesCount = async () => {
    try {
        const snap = await db.collection('articles').get();
        const counter = document.getElementById('articles-quick-count');
        if(counter) counter.textContent = snap.size + ' artículos en catálogo';
    } catch(e) {
        const counter = document.getElementById('articles-quick-count');
        if(counter) counter.textContent = 'Error cargando';
    }
};

window.loadArticlesPRO = async () => {
    const tbody = document.getElementById('articles-pro-body');
    if(!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:15px; color:#888;">Cargando artículos...</td></tr>';
    
    try {
        const snap = await db.collection('articles').limit(2000).get();
        console.log('Articles loaded:', snap.size);
        tbody.innerHTML = '';
        
        if(snap.empty) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#888;">No hay artículos. Crea el primero usando el formulario.</td></tr>';
            loadArticlesCount();

            return;
        }
        
        snap.forEach(doc => {
            const d = doc.data();
            const tr = document.createElement('tr');
            tr.style.cssText = 'border-bottom:1px solid #333;';
            tr.innerHTML = `
                <td style="padding:8px 10px; font-weight:bold;">${d.name || ''}</td>
                <td style="padding:8px 10px; color:#aaa;">${d.description || '-'}</td>
                <td style="padding:8px 10px; text-align:right; color:#4CAF50; font-weight:bold;">${(d.price || 0).toFixed(2)} €</td>
                <td style="padding:8px 10px; text-align:right;">${(d.weight || 0).toFixed(2)} kg</td>
                <td style="padding:8px 10px; text-align:center;">
                    <button class="art-edit-btn" style="background:transparent; border:1px solid #555; color:#2196F3; padding:4px 10px; cursor:pointer; border-radius:4px; margin-right:4px;">✏️</button>
                    <button class="art-del-btn" style="background:transparent; border:1px solid #555; color:#FF3B30; padding:4px 10px; cursor:pointer; border-radius:4px;">🗑️</button>
                </td>
            `;
            tr.querySelector('.art-edit-btn').addEventListener('click', () => {
                editArticlePRO(doc.id);
                const panel = document.getElementById('articles-crud-panel');
                if(panel) panel.style.display = 'block';
            });
            tr.querySelector('.art-del-btn').addEventListener('click', () => deleteArticlePRO(doc.id, d.name || ''));
            tbody.appendChild(tr);
        });
        
        loadArticlesCount();
    } catch(e) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:15px; color:#FF3B30;">Error: ${e.message}</td></tr>`;
    }
};

window.saveArticlePRO = async () => {
    const name = document.getElementById('art-name').value.trim();
    if(!name) { alert('El nombre del artículo es obligatorio.'); return; }
    
    const data = {
        name: name,
        description: document.getElementById('art-description').value.trim(),
        price: parseFloat(document.getElementById('art-price').value) || 0,
        weight: parseFloat(document.getElementById('art-weight').value) || 0,
        category: document.getElementById('art-category').value.trim(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    const editId = document.getElementById('art-edit-id').value;
    
    try {
        if(editId) {
            await db.collection('articles').doc(editId).update(data);
            alert('Artículo actualizado correctamente.');
        } else {
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            await db.collection('articles').add(data);
            alert('Artículo creado correctamente.');
        }
        resetArticleForm();
        loadArticlesPRO();
    } catch(e) {
        alert('Error guardando artículo: ' + e.message);
    }
};

window.editArticlePRO = async (id) => {
    try {
        const doc = await db.collection('articles').doc(id).get();
        if(!doc.exists) { alert('Artículo no encontrado.'); return; }
        const d = doc.data();
        document.getElementById('art-edit-id').value = id;
        document.getElementById('art-name').value = d.name || '';
        document.getElementById('art-description').value = d.description || '';
        document.getElementById('art-price').value = d.price || '';
        document.getElementById('art-weight').value = d.weight || '';
        document.getElementById('art-category').value = d.category || '';
    } catch(e) {
        alert('Error cargando artículo: ' + e.message);
    }
};

window.deleteArticlePRO = async (id, name) => {
    if(!confirm(`¿Eliminar el artículo "${name}"?`)) return;
    try {
        await db.collection('articles').doc(id).delete();
        loadArticlesPRO();
    } catch(e) {
        alert('Error eliminando: ' + e.message);
    }
};

window.resetArticleForm = () => {
    document.getElementById('art-edit-id').value = '';
    document.getElementById('art-name').value = '';
    document.getElementById('art-description').value = '';
    document.getElementById('art-price').value = '';
    document.getElementById('art-weight').value = '';
    document.getElementById('art-category').value = '';
};

// ============================================================
//  EXCLUSIVE TARIFFS TAB — List all clients with customPrices
// ============================================================
window.loadExclusiveTariffs = async () => {
    const body = document.getElementById('exclusive-tariff-body');
    const countEl = document.getElementById('exclusive-tariff-count');
    if (!body) return;
    body.innerHTML = '<div style="text-align:center; padding:30px; color:#aaa;">Buscando tarifas exclusivas...</div>';

    try {
        const snap = await db.collection('tariffs').get();
        const exclusiveClients = [];

        snap.forEach(doc => {
            if (doc.id.startsWith('GLOBAL_')) return;
            const data = doc.data();
            if (!data.customPrices || Object.keys(data.customPrices).length === 0) return;

            const clientId = doc.id;
            const uData = window.userMap ? (window.userMap[clientId] || {}) : {};
            exclusiveClients.push({
                docId: clientId,
                clientName: uData.name || uData.email || clientId,
                clientIdNum: uData.idNum || '-',
                customPrices: data.customPrices,
                basedOn: data.basedOn || '-',
                updatedAt: data.customPricesUpdatedAt
            });
        });

        if (countEl) countEl.textContent = exclusiveClients.length + ' cliente' + (exclusiveClients.length !== 1 ? 's' : '') + ' con tarifa exclusiva';

        if (exclusiveClients.length === 0) {
            body.innerHTML = '<div style="text-align:center; padding:40px; color:#888;"><span class="material-symbols-outlined" style="font-size:2rem; display:block; margin-bottom:10px;">info</span>No hay clientes con tarifas exclusivas.<br><span style="font-size:0.8rem;">Puedes crear subtarifas desde la Ficha de Cliente &gt; Datos Economicos.</span></div>';
            return;
        }

        exclusiveClients.sort((a, b) => a.clientName.localeCompare(b.clientName));

        let html = '';
        exclusiveClients.forEach(c => {
            const priceKeys = Object.keys(c.customPrices).sort();
            const count = priceKeys.length;

            let pricesHtml = '<table style="width:100%; border-collapse:collapse; margin-top:8px;">';
            pricesHtml += '<tr style="border-bottom:1px solid #444;"><th style="padding:4px 8px; text-align:left; color:#E040FB; font-size:0.7rem;">ARTICULO</th><th style="padding:4px 8px; text-align:right; color:#E040FB; font-size:0.7rem;">PRECIO</th></tr>';
            priceKeys.forEach(k => {
                pricesHtml += '<tr style="border-bottom:1px solid #333;"><td style="padding:4px 8px; color:#ddd; font-size:0.8rem;">' + k + '</td><td style="padding:4px 8px; text-align:right; color:#4CAF50; font-weight:bold; font-size:0.8rem;">' + parseFloat(c.customPrices[k]).toFixed(2) + ' &euro;</td></tr>';
            });
            pricesHtml += '</table>';

            html += '<div style="background:#252526; border:1px solid #3c3c3c; border-radius:8px; padding:14px; margin-bottom:10px;">';
            html += '<div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === \'none\' ? \'block\' : \'none\'">';
            html += '<div style="display:flex; align-items:center; gap:10px;">';
            html += '<span class="material-symbols-outlined" style="color:#E040FB;">star</span>';
            html += '<span style="color:#fff; font-weight:bold; font-size:0.9rem;">' + c.clientName + '</span>';
            html += '<span style="color:#888; font-size:0.8rem;">#' + c.clientIdNum + '</span>';
            html += '</div>';
            html += '<div style="display:flex; align-items:center; gap:10px;">';
            html += '<span style="color:#E040FB; font-size:0.8rem; font-weight:bold;">' + count + ' precio' + (count > 1 ? 's' : '') + ' exclusivo' + (count > 1 ? 's' : '') + '</span>';
            html += '<span style="color:#888; font-size:0.8rem;">Base: ' + c.basedOn + '</span>';
            html += '<button onclick="event.stopPropagation(); if(typeof window.openFichaCliente === \'function\') window.openFichaCliente(\'' + c.docId + '\')" style="background:transparent; border:1px solid #555; color:#2196F3; padding:3px 10px; font-size:0.75rem; cursor:pointer; border-radius:4px;"><span class="material-symbols-outlined" style="font-size:0.9rem; vertical-align:middle;">open_in_new</span> Ficha</button>';
            html += '<span class="material-symbols-outlined" style="color:#666; font-size:1rem;">expand_more</span>';
            html += '</div></div>';
            html += '<div style="display:none;">' + pricesHtml + '</div>';
            html += '</div>';
        });

        body.innerHTML = html;
    } catch (e) {
        console.error('[Tariffs] Error loading exclusive:', e);
        body.innerHTML = '<div style="text-align:center; padding:20px; color:#FF3B30;">Error: ' + e.message + '</div>';
    }
};

