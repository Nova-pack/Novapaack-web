/**
 * CONTABILIDAD.JS — Motor Contable Automático (GCONTA-Style)
 * 
 * MÓDULO 100% ADITIVO — No modifica ningún archivo existente.
 * Se engancha a los eventos de facturación ya existentes mediante
 * un observer de Firestore sobre la colección `invoices`.
 * 
 * Colecciones Firestore nuevas creadas:
 *   - journal:    Asientos contables
 *   - accounts:   Plan General Contable simplificado
 * 
 * Dependencias: firebase, db (global desde admin.html)
 */

// ============================================================
//  PLAN GENERAL CONTABLE (PGC) SIMPLIFICADO PARA TRANSPORTE
// ============================================================
const PGC = {
    '430': { name: 'Clientes', type: 'activo', group: 'balance' },
    '700': { name: 'Prestación de Servicios', type: 'ingreso', group: 'pyg' },
    '477': { name: 'H.P. IVA Repercutido', type: 'pasivo', group: 'balance' },
    '473': { name: 'H.P. Retenciones y Pagos a Cuenta', type: 'activo', group: 'balance' },
    '572': { name: 'Bancos e Instituciones de Crédito', type: 'activo', group: 'balance' },
    '570': { name: 'Caja', type: 'activo', group: 'balance' },
    '400': { name: 'Proveedores', type: 'pasivo', group: 'balance' },
    '600': { name: 'Compras / Gastos Operativos', type: 'gasto', group: 'pyg' },
    '472': { name: 'H.P. IVA Soportado', type: 'activo', group: 'balance' },
    '129': { name: 'Resultado del Ejercicio', type: 'pasivo', group: 'balance' }
};

// ============================================================
//  GENERADOR DE ASIENTOS CONTABLES
// ============================================================

/**
 * Genera un asiento contable para una factura emitida.
 * DEBE: 430.ClienteX (Total con IVA)
 * HABER: 700 (Base imponible)
 * HABER: 477 (IVA Repercutido)
 * Si hay IRPF:
 * DEBE: 473 (Retención IRPF)  → reduce lo que cobra el cliente
 */
window.generateInvoiceJournalEntry = async function(invoiceData, invoiceDocId) {
    if (!invoiceData || !invoiceDocId) return;
    
    // Evitar duplicados: comprobar si ya existe un asiento para esta factura
    try {
        const existing = await db.collection('journal')
            .where('invoiceRef', '==', invoiceDocId)
            .where('type', '==', 'invoice')
            .limit(1).get();
        
        if (!existing.empty) {
            console.log('[CONTA] Asiento ya existe para factura ' + invoiceDocId);
            return;
        }
    } catch(e) {
        console.warn('[CONTA] Error checking existing entry:', e);
    }
    
    // Atomic sequential journal number — prevents collisions when two admins
    // post entries concurrently. Falls back to last-row scan only on first run.
    let asientoNum = 1;
    if (typeof window.allocSequentialNumber === 'function') {
        try {
            asientoNum = await window.allocSequentialNumber('sequence_counters/journal', async () => {
                const lastSnap = await db.collection('journal').orderBy('number', 'desc').limit(1).get();
                return lastSnap.empty ? 0 : (lastSnap.docs[0].data().number || 0);
            });
        } catch(e) { console.warn('[CONTA] allocSequentialNumber failed, falling back:', e); }
    } else {
        try {
            const lastSnap = await db.collection('journal').orderBy('number', 'desc').limit(1).get();
            if (!lastSnap.empty) asientoNum = (lastSnap.docs[0].data().number || 0) + 1;
        } catch(e) { /* first entry */ }
    }

    const subtotal = invoiceData.subtotal || 0;
    const ivaAmount = invoiceData.iva || 0;
    const irpfAmount = invoiceData.irpf || 0;
    const total = invoiceData.total || 0;
    const clientName = invoiceData.clientName || 'Cliente';
    const clientId = invoiceData.clientId || '';
    const invoiceId = invoiceData.invoiceId || '';

    // Construir las partidas del asiento
    const entries = [];

    // DEBE: 430.ClienteX → Total factura (lo que nos debe el cliente)
    entries.push({
        account: '430',
        subAccount: clientId,
        subAccountName: clientName,
        description: `Factura ${invoiceId} - ${clientName}`,
        debit: total,
        credit: 0
    });

    // HABER: 700 → Base imponible (ingresos por servicios)
    entries.push({
        account: '700',
        subAccount: '',
        subAccountName: 'Prestación de Servicios',
        description: `Factura ${invoiceId} - Servicios de transporte`,
        debit: 0,
        credit: subtotal
    });

    // HABER: 477 → IVA Repercutido
    if (ivaAmount > 0) {
        entries.push({
            account: '477',
            subAccount: '',
            subAccountName: 'H.P. IVA Repercutido',
            description: `IVA Factura ${invoiceId} (${invoiceData.ivaRate || 21}%)`,
            debit: 0,
            credit: ivaAmount
        });
    }

    // DEBE: 473 → Retención IRPF (si aplica)
    if (irpfAmount > 0) {
        entries.push({
            account: '473',
            subAccount: '',
            subAccountName: 'H.P. Retenciones',
            description: `IRPF Factura ${invoiceId} (${invoiceData.irpfRate || 0}%)`,
            debit: irpfAmount,
            credit: 0
        });
        // Ajustar el DEBE de 430 → El cliente paga menos (Total - IRPF)
        entries[0].debit = total; // total ya lleva la resta del IRPF
    }

    const journalEntry = {
        number: asientoNum,
        date: invoiceData.date || new Date(),
        description: `Factura emitida ${invoiceId} a ${clientName}`,
        entries: entries,
        invoiceRef: invoiceDocId,
        invoiceId: invoiceId,
        clientId: clientId,
        clientName: clientName,
        type: 'invoice', // invoice | payment | credit_note | manual
        subtotal: subtotal,
        ivaAmount: ivaAmount,
        irpfAmount: irpfAmount,
        total: total,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (typeof getOperatorStamp === 'function') Object.assign(journalEntry, getOperatorStamp());

    try {
        await db.collection('journal').add(journalEntry);
        console.log(`[CONTA] ✅ Asiento #${asientoNum} generado para factura ${invoiceId}`);
    } catch(e) {
        console.error('[CONTA] Error generando asiento:', e);
    }
};

/**
 * Genera un asiento de cobro cuando una factura se marca como pagada.
 * DEBE: 572 (Bancos) → Entra dinero
 * HABER: 430.ClienteX → El cliente ya no debe
 */
window.generatePaymentJournalEntry = async function(invoiceData, invoiceDocId) {
    if (!invoiceData || !invoiceDocId) return;

    // Evitar duplicados
    try {
        const existing = await db.collection('journal')
            .where('invoiceRef', '==', invoiceDocId)
            .where('type', '==', 'payment')
            .limit(1).get();
        if (!existing.empty) return;
    } catch(e) { /* proceed */ }

    let asientoNum = 1;
    if (typeof window.allocSequentialNumber === 'function') {
        try {
            asientoNum = await window.allocSequentialNumber('sequence_counters/journal', async () => {
                const lastSnap = await db.collection('journal').orderBy('number', 'desc').limit(1).get();
                return lastSnap.empty ? 0 : (lastSnap.docs[0].data().number || 0);
            });
        } catch(e) { console.warn('[CONTA] allocSequentialNumber failed:', e); }
    } else {
        try {
            const lastSnap = await db.collection('journal').orderBy('number', 'desc').limit(1).get();
            if (!lastSnap.empty) asientoNum = (lastSnap.docs[0].data().number || 0) + 1;
        } catch(e) { /* first entry */ }
    }

    const total = invoiceData.total || 0;
    const clientName = invoiceData.clientName || 'Cliente';
    const clientId = invoiceData.clientId || '';
    const invoiceId = invoiceData.invoiceId || '';

    const entries = [
        {
            account: '572',
            subAccount: '',
            subAccountName: 'Bancos',
            description: `Cobro Factura ${invoiceId}`,
            debit: total,
            credit: 0
        },
        {
            account: '430',
            subAccount: clientId,
            subAccountName: clientName,
            description: `Cobro Factura ${invoiceId} - ${clientName}`,
            debit: 0,
            credit: total
        }
    ];

    try {
        const paymentEntry = {
            number: asientoNum,
            date: new Date(),
            description: `Cobro factura ${invoiceId} de ${clientName}`,
            entries: entries,
            invoiceRef: invoiceDocId,
            invoiceId: invoiceId,
            clientId: clientId,
            clientName: clientName,
            type: 'payment',
            total: total,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (typeof getOperatorStamp === 'function') Object.assign(paymentEntry, getOperatorStamp());
        await db.collection('journal').add(paymentEntry);
        console.log(`[CONTA] ✅ Asiento cobro #${asientoNum} para factura ${invoiceId}`);
    } catch(e) {
        console.error('[CONTA] Error generando asiento de cobro:', e);
    }
};


// ============================================================
//  VISTA DE CONTABILIDAD (Panel Admin)
// ============================================================

let contaJournalCache = [];
let contaCurrentView = 'diario'; // diario | mayor | balance | iva

window.toggleContabilidad = function() {
    const ws = document.getElementById('conta-workspace');
    if (!ws) return;
    
    // Toggle visibility
    const isVisible = ws.style.display !== 'none';
    
    // Hide other workspaces
    ['adv-billing-workspace', 'adv-history-workspace', 'adv-reports-workspace', 'adv-tariffs-workspace', 'adv-clients-workspace', 'adv-providers-workspace', 'adv-manual-tickets-workspace', 'adv-scanner-workspace'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    
    if (isVisible) {
        ws.style.display = 'none';
        const mainWs = document.getElementById('adv-billing-workspace');
        if (mainWs) mainWs.style.display = 'flex';
    } else {
        ws.style.display = 'flex';
        contaLoadDashboard();
    }
};

// --- DIARIO CONTABLE ---
async function contaLoadDiario(filterYear) {
    contaCurrentView = 'diario';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Cargando diario contable...</div>';
    
    try {
        const year = filterYear || new Date().getFullYear();
        const startDate = new Date(year, 0, 1);
        const endDate = new Date(year, 11, 31, 23, 59, 59);
        
        const snap = await db.collection('journal')
            .where('date', '>=', startDate)
            .where('date', '<=', endDate)
            .orderBy('date', 'desc')
            .limit(500)
            .get();
        
        contaJournalCache = [];
        snap.forEach(doc => contaJournalCache.push({ id: doc.id, ...doc.data() }));
        
        if (contaJournalCache.length === 0) {
            container.innerHTML = `
                <div style="text-align:center; padding:60px; color:#888;">
                    <div style="font-size:3rem; margin-bottom:15px;">📭</div>
                    <div style="font-size:1rem;">No hay asientos contables para ${year}</div>
                    <div style="font-size:0.8rem; margin-top:8px; color:#555;">Los asientos se generan automáticamente al emitir facturas.</div>
                </div>`;
            return;
        }

        let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <div style="color:#9cdcfe; font-size:0.85rem; font-weight:bold;">📖 DIARIO CONTABLE — ${year} (${contaJournalCache.length} asientos)</div>
            <div style="display:flex; gap:5px;">
                <button onclick="contaExportCSV()" style="background:#333; border:1px solid #555; color:#ccc; padding:4px 10px; font-size:0.75rem; cursor:pointer; border-radius:3px;">📥 Exportar CSV</button>
            </div>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
            <thead>
                <tr style="background:#2d2d30; color:#9cdcfe; text-transform:uppercase; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:left; width:50px;">Nº</th>
                    <th style="padding:8px 6px; text-align:left; width:90px;">Fecha</th>
                    <th style="padding:8px 6px; text-align:left;">Descripción</th>
                    <th style="padding:8px 6px; text-align:center; width:60px;">Tipo</th>
                    <th style="padding:8px 6px; text-align:left; width:60px;">Cuenta</th>
                    <th style="padding:8px 6px; text-align:right; width:100px;">Debe</th>
                    <th style="padding:8px 6px; text-align:right; width:100px;">Haber</th>
                </tr>
            </thead>
            <tbody>`;

        let totalDebe = 0, totalHaber = 0;

        contaJournalCache.forEach(j => {
            const date = j.date && j.date.toDate ? j.date.toDate() : new Date(j.date);
            const dateStr = date.toLocaleDateString('es-ES');
            const typeIcon = j.type === 'invoice' ? '📄' : j.type === 'payment' ? '💰' : j.type === 'credit_note' ? '🔄' : '✏️';
            const typeBg = j.type === 'invoice' ? 'rgba(0,122,204,0.1)' : j.type === 'payment' ? 'rgba(76,175,80,0.1)' : 'transparent';
            
            // Header row for this journal entry
            html += `
                <tr style="background:${typeBg}; border-top:2px solid #444;">
                    <td style="padding:6px; font-weight:bold; color:#FFD700;">${j.number || '-'}</td>
                    <td style="padding:6px; color:#ccc;">${dateStr}</td>
                    <td style="padding:6px; color:#fff; font-weight:600;" colspan="3">${j.description}</td>
                    <td style="padding:6px; text-align:center;">${typeIcon}</td>
                    <td></td>
                </tr>`;
            
            // Detail rows for each entry
            (j.entries || []).forEach(e => {
                totalDebe += e.debit || 0;
                totalHaber += e.credit || 0;
                html += `
                <tr style="background:transparent; border-bottom:1px solid #2d2d30;">
                    <td></td>
                    <td></td>
                    <td style="padding:4px 6px; color:#aaa; font-size:0.75rem; padding-left:20px;">↳ ${e.description}</td>
                    <td></td>
                    <td style="padding:4px 6px; color:#9cdcfe; font-weight:bold;">${e.account}${e.subAccount ? '.' : ''}</td>
                    <td style="padding:4px 6px; text-align:right; color:${e.debit > 0 ? '#4FC3F7' : '#555'};">${e.debit > 0 ? e.debit.toFixed(2) + '€' : ''}</td>
                    <td style="padding:4px 6px; text-align:right; color:${e.credit > 0 ? '#81C784' : '#555'};">${e.credit > 0 ? e.credit.toFixed(2) + '€' : ''}</td>
                </tr>`;
            });
        });

        html += `
            <tr style="background:#1a1a2e; border-top:3px solid #FFD700; font-weight:bold;">
                <td colspan="5" style="padding:10px 6px; color:#FFD700; text-align:right;">TOTALES</td>
                <td style="padding:10px 6px; text-align:right; color:#4FC3F7; font-size:0.95rem;">${totalDebe.toFixed(2)}€</td>
                <td style="padding:10px 6px; text-align:right; color:#81C784; font-size:0.95rem;">${totalHaber.toFixed(2)}€</td>
            </tr>
            </tbody></table>`;
        
        // Cuadre check
        const diff = Math.abs(totalDebe - totalHaber);
        if (diff > 0.01) {
            html += `<div style="background:rgba(255,0,0,0.1); border:1px solid #f44; padding:8px; margin-top:10px; border-radius:4px; color:#f88; font-size:0.8rem;">⚠️ DESCUADRE detectado: ${diff.toFixed(2)}€ de diferencia entre Debe y Haber.</div>`;
        } else {
            html += `<div style="background:rgba(76,175,80,0.1); border:1px solid #4CAF50; padding:8px; margin-top:10px; border-radius:4px; color:#81C784; font-size:0.8rem;">✅ Contabilidad cuadrada: Debe = Haber (${totalDebe.toFixed(2)}€)</div>`;
        }

        container.innerHTML = html;
    } catch(e) {
        console.error('[CONTA] Error loading diario:', e);
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error cargando diario: ${e.message}</div>`;
    }
}

// --- BALANCE DE SUMAS Y SALDOS ---
window.contaLoadBalance = async function() {
    contaCurrentView = 'balance';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Calculando balance...</div>';
    
    try {
        const snap = await db.collection('journal').orderBy('date', 'desc').limit(2000).get();
        
        // Acumular por cuenta
        const balances = {};
        snap.forEach(doc => {
            const j = doc.data();
            (j.entries || []).forEach(e => {
                const acc = e.account;
                if (!balances[acc]) balances[acc] = { name: (PGC[acc] || {}).name || acc, debit: 0, credit: 0 };
                balances[acc].debit += (e.debit || 0);
                balances[acc].credit += (e.credit || 0);
            });
        });

        const accounts = Object.keys(balances).sort();
        
        if (accounts.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:60px; color:#888;">No hay datos contables aún.</div>';
            return;
        }

        let html = `
        <div style="color:#9cdcfe; font-size:0.85rem; font-weight:bold; margin-bottom:15px;">⚖️ BALANCE DE SUMAS Y SALDOS</div>
        <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
            <thead>
                <tr style="background:#2d2d30; color:#9cdcfe; text-transform:uppercase; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:left;">Cuenta</th>
                    <th style="padding:8px 6px; text-align:left;">Nombre</th>
                    <th style="padding:8px 6px; text-align:right;">Total Debe</th>
                    <th style="padding:8px 6px; text-align:right;">Total Haber</th>
                    <th style="padding:8px 6px; text-align:right;">Saldo</th>
                </tr>
            </thead>
            <tbody>`;

        let grandDebit = 0, grandCredit = 0;

        accounts.forEach(acc => {
            const b = balances[acc];
            const saldo = b.debit - b.credit;
            grandDebit += b.debit;
            grandCredit += b.credit;
            const saldoColor = saldo > 0 ? '#4FC3F7' : saldo < 0 ? '#f88' : '#888';
            
            html += `
            <tr style="border-bottom:1px solid #2d2d30; cursor:pointer;" onmouseover="this.style.background='rgba(0,122,204,0.08)'" onmouseout="this.style.background='transparent'" onclick="contaLoadMayor('${acc}')">
                <td style="padding:8px 6px; font-weight:bold; color:#FFD700;">${acc}</td>
                <td style="padding:8px 6px; color:#ccc;">${b.name}</td>
                <td style="padding:8px 6px; text-align:right; color:#4FC3F7;">${b.debit.toFixed(2)}€</td>
                <td style="padding:8px 6px; text-align:right; color:#81C784;">${b.credit.toFixed(2)}€</td>
                <td style="padding:8px 6px; text-align:right; color:${saldoColor}; font-weight:bold;">${saldo.toFixed(2)}€</td>
            </tr>`;
        });

        html += `
            <tr style="background:#1a1a2e; border-top:3px solid #FFD700; font-weight:bold;">
                <td colspan="2" style="padding:10px 6px; color:#FFD700; text-align:right;">TOTALES</td>
                <td style="padding:10px 6px; text-align:right; color:#4FC3F7;">${grandDebit.toFixed(2)}€</td>
                <td style="padding:10px 6px; text-align:right; color:#81C784;">${grandCredit.toFixed(2)}€</td>
                <td style="padding:10px 6px; text-align:right; color:#FFD700;">${(grandDebit - grandCredit).toFixed(2)}€</td>
            </tr>
        </tbody></table>
        <div style="margin-top:8px; font-size:0.7rem; color:#666;">💡 Haz clic en una cuenta para ver su Libro Mayor</div>`;

        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// --- LIBRO MAYOR (por cuenta) ---
window.contaLoadMayor = async function(account) {
    contaCurrentView = 'mayor';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Cargando libro mayor...</div>';
    
    try {
        const snap = await db.collection('journal').orderBy('date', 'asc').limit(2000).get();
        
        const movements = [];
        snap.forEach(doc => {
            const j = doc.data();
            (j.entries || []).forEach(e => {
                if (e.account === account) {
                    movements.push({
                        date: j.date,
                        number: j.number,
                        description: e.description || j.description,
                        debit: e.debit || 0,
                        credit: e.credit || 0
                    });
                }
            });
        });
        
        const accName = (PGC[account] || {}).name || account;
        
        let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <div style="color:#FFD700; font-size:0.85rem; font-weight:bold;">📒 LIBRO MAYOR — Cuenta ${account}: ${accName}</div>
            <button onclick="contaLoadBalance()" style="background:#333; border:1px solid #555; color:#ccc; padding:4px 10px; font-size:0.75rem; cursor:pointer; border-radius:3px;">◀ Volver al Balance</button>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
            <thead>
                <tr style="background:#2d2d30; color:#9cdcfe; text-transform:uppercase; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:left; width:50px;">Nº</th>
                    <th style="padding:8px 6px; text-align:left; width:90px;">Fecha</th>
                    <th style="padding:8px 6px; text-align:left;">Concepto</th>
                    <th style="padding:8px 6px; text-align:right; width:100px;">Debe</th>
                    <th style="padding:8px 6px; text-align:right; width:100px;">Haber</th>
                    <th style="padding:8px 6px; text-align:right; width:100px;">Saldo</th>
                </tr>
            </thead>
            <tbody>`;

        let running = 0;
        movements.forEach(m => {
            running += m.debit - m.credit;
            const date = m.date && m.date.toDate ? m.date.toDate() : new Date(m.date);
            html += `
            <tr style="border-bottom:1px solid #2d2d30;">
                <td style="padding:6px; color:#888;">${m.number || '-'}</td>
                <td style="padding:6px; color:#ccc;">${date.toLocaleDateString('es-ES')}</td>
                <td style="padding:6px; color:#ddd;">${m.description}</td>
                <td style="padding:6px; text-align:right; color:#4FC3F7;">${m.debit > 0 ? m.debit.toFixed(2) + '€' : ''}</td>
                <td style="padding:6px; text-align:right; color:#81C784;">${m.credit > 0 ? m.credit.toFixed(2) + '€' : ''}</td>
                <td style="padding:6px; text-align:right; font-weight:bold; color:${running >= 0 ? '#4FC3F7' : '#f88'};">${running.toFixed(2)}€</td>
            </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// --- REGISTRO DE IVA ---
window.contaLoadIVA = async function() {
    contaCurrentView = 'iva';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Cargando registro de IVA...</div>';
    
    try {
        const year = new Date().getFullYear();
        const snap = await db.collection('journal')
            .where('type', '==', 'invoice')
            .orderBy('date', 'desc')
            .limit(1000)
            .get();
        
        let totalBase = 0, totalIVA = 0, totalTotal = 0;
        let html = `
        <div style="color:#9cdcfe; font-size:0.85rem; font-weight:bold; margin-bottom:15px;">🧾 REGISTRO DE IVA REPERCUTIDO — ${year}</div>
        <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
            <thead>
                <tr style="background:#2d2d30; color:#9cdcfe; text-transform:uppercase; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:left;">Fecha</th>
                    <th style="padding:8px 6px; text-align:left;">Factura</th>
                    <th style="padding:8px 6px; text-align:left;">Cliente</th>
                    <th style="padding:8px 6px; text-align:right;">Base</th>
                    <th style="padding:8px 6px; text-align:right;">IVA</th>
                    <th style="padding:8px 6px; text-align:right;">Total</th>
                </tr>
            </thead>
            <tbody>`;

        snap.forEach(doc => {
            const j = doc.data();
            const date = j.date && j.date.toDate ? j.date.toDate() : new Date(j.date);
            totalBase += j.subtotal || 0;
            totalIVA += j.ivaAmount || 0;
            totalTotal += j.total || 0;
            
            html += `
            <tr style="border-bottom:1px solid #2d2d30;">
                <td style="padding:6px; color:#ccc;">${date.toLocaleDateString('es-ES')}</td>
                <td style="padding:6px; color:#FFD700; font-weight:bold;">${j.invoiceId || '-'}</td>
                <td style="padding:6px; color:#ddd;">${j.clientName || '-'}</td>
                <td style="padding:6px; text-align:right; color:#ccc;">${(j.subtotal || 0).toFixed(2)}€</td>
                <td style="padding:6px; text-align:right; color:#81C784;">${(j.ivaAmount || 0).toFixed(2)}€</td>
                <td style="padding:6px; text-align:right; color:#fff; font-weight:bold;">${(j.total || 0).toFixed(2)}€</td>
            </tr>`;
        });

        html += `
            <tr style="background:#1a1a2e; border-top:3px solid #FFD700; font-weight:bold;">
                <td colspan="3" style="padding:10px 6px; color:#FFD700; text-align:right;">TOTALES</td>
                <td style="padding:10px 6px; text-align:right; color:#ccc;">${totalBase.toFixed(2)}€</td>
                <td style="padding:10px 6px; text-align:right; color:#81C784;">${totalIVA.toFixed(2)}€</td>
                <td style="padding:10px 6px; text-align:right; color:#fff;">${totalTotal.toFixed(2)}€</td>
            </tr>
        </tbody></table>`;

        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// ============================================================
//  DASHBOARD DE TESORERÍA (con Gastos e Ingresos)
// ============================================================
window.contaLoadDashboard = async function() {
    contaCurrentView = 'dashboard';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Calculando tesorería...</div>';
    
    try {
        const year = new Date().getFullYear();
        const startOfYear = new Date(year, 0, 1);
        
        // Get all invoices for this year
        const invSnap = await db.collection('invoices')
            .where('date', '>=', startOfYear)
            .orderBy('date', 'desc')
            .limit(5000)
            .get();
        
        // Get all expenses for this year
        const expSnap = await db.collection('expenses')
            .where('date', '>=', startOfYear)
            .orderBy('date', 'desc')
            .limit(5000)
            .get();
        
        let totalFacturado = 0, totalCobrado = 0, totalPendiente = 0;
        let numFacturas = 0, numCobradas = 0, numPendientes = 0;
        let totalGastos = 0, numGastos = 0;
        const clientTotals = {};
        
        invSnap.forEach(doc => {
            const inv = doc.data();
            const total = inv.total || 0;
            totalFacturado += total;
            numFacturas++;
            const cid = inv.clientName || inv.clientId || 'Desconocido';
            if (!clientTotals[cid]) clientTotals[cid] = { facturado: 0, cobrado: 0, pendiente: 0 };
            clientTotals[cid].facturado += total;
            if (inv.paid) { totalCobrado += total; numCobradas++; clientTotals[cid].cobrado += total; }
            else { totalPendiente += total; numPendientes++; clientTotals[cid].pendiente += total; }
        });
        
        expSnap.forEach(doc => {
            const exp = doc.data();
            totalGastos += exp.total || 0;
            numGastos++;
        });
        
        const pctCobrado = totalFacturado > 0 ? Math.round((totalCobrado / totalFacturado) * 100) : 0;
        const beneficio = totalFacturado - totalGastos;
        const margen = totalFacturado > 0 ? Math.round((beneficio / totalFacturado) * 100) : 0;
        
        let html = `
        <div style="color:#E040FB; font-size:0.85rem; font-weight:bold; margin-bottom:20px;">📊 DASHBOARD DE TESORERÍA — ${year}</div>
        
        <!-- Row 1: Revenue KPIs -->
        <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-bottom:12px;">
            <div style="background:linear-gradient(135deg, #1a237e, #283593); border-radius:12px; padding:18px; text-align:center;">
                <div style="font-size:0.65rem; color:#9fa8da; text-transform:uppercase; letter-spacing:1px;">Facturado</div>
                <div style="font-size:1.6rem; font-weight:bold; color:#fff; margin:6px 0;">${totalFacturado.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#7986cb;">${numFacturas} facturas</div>
            </div>
            <div style="background:linear-gradient(135deg, #1b5e20, #2e7d32); border-radius:12px; padding:18px; text-align:center;">
                <div style="font-size:0.65rem; color:#a5d6a7; text-transform:uppercase; letter-spacing:1px;">Cobrado</div>
                <div style="font-size:1.6rem; font-weight:bold; color:#fff; margin:6px 0;">${totalCobrado.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#81c784;">${numCobradas} (${pctCobrado}%)</div>
            </div>
            <div style="background:linear-gradient(135deg, #b71c1c, #c62828); border-radius:12px; padding:18px; text-align:center;">
                <div style="font-size:0.65rem; color:#ef9a9a; text-transform:uppercase; letter-spacing:1px;">Pendiente</div>
                <div style="font-size:1.6rem; font-weight:bold; color:#fff; margin:6px 0;">${totalPendiente.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#ef5350;">${numPendientes} facturas</div>
            </div>
            <div style="background:linear-gradient(135deg, #4a148c, #6a1b9a); border-radius:12px; padding:18px; text-align:center;">
                <div style="font-size:0.65rem; color:#ce93d8; text-transform:uppercase; letter-spacing:1px;">Ratio Cobro</div>
                <div style="font-size:1.6rem; font-weight:bold; color:#fff; margin:6px 0;">${pctCobrado}%</div>
                <div style="font-size:0.7rem; color:#ba68c8;">eficiencia</div>
            </div>
        </div>
        
        <!-- Row 2: Gastos & Beneficio -->
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:20px;">
            <div style="background:linear-gradient(135deg, #e65100, #bf360c); border-radius:12px; padding:18px; text-align:center;">
                <div style="font-size:0.65rem; color:#ffcc80; text-transform:uppercase; letter-spacing:1px;">Total Gastos</div>
                <div style="font-size:1.6rem; font-weight:bold; color:#fff; margin:6px 0;">${totalGastos.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#ffab91;">${numGastos} gastos registrados</div>
            </div>
            <div style="background:linear-gradient(135deg, ${beneficio >= 0 ? '#00695c, #00897b' : '#880e4f, #ad1457'}); border-radius:12px; padding:18px; text-align:center;">
                <div style="font-size:0.65rem; color:${beneficio >= 0 ? '#80cbc4' : '#f48fb1'}; text-transform:uppercase; letter-spacing:1px;">Beneficio Bruto</div>
                <div style="font-size:1.6rem; font-weight:bold; color:#fff; margin:6px 0;">${beneficio.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:${beneficio >= 0 ? '#4db6ac' : '#ec407a'};">${beneficio >= 0 ? '▲' : '▼'} Margen ${margen}%</div>
            </div>
            <div style="background:linear-gradient(135deg, #263238, #37474f); border-radius:12px; padding:18px; text-align:center;">
                <div style="font-size:0.65rem; color:#90a4ae; text-transform:uppercase; letter-spacing:1px;">Ingresos vs Gastos</div>
                <div style="font-size:1.6rem; font-weight:bold; color:#fff; margin:6px 0;">${totalFacturado > 0 ? Math.round((totalGastos / totalFacturado) * 100) : 0}%</div>
                <div style="font-size:0.7rem; color:#78909c;">gastos / ingresos</div>
            </div>
        </div>
        
        <!-- Progress bar -->
        <div style="background:#2d2d30; border-radius:8px; height:14px; margin-bottom:25px; overflow:hidden; position:relative;">
            <div style="background:linear-gradient(90deg, #4CAF50, #81C784); height:100%; width:${pctCobrado}%; border-radius:8px; transition:width 0.5s;"></div>
            <div style="position:absolute; top:0; left:50%; transform:translateX(-50%); font-size:0.65rem; color:#fff; line-height:14px; font-weight:bold;">${pctCobrado}% cobrado</div>
        </div>`;
        
        // Top debtors
        const clientsSorted = Object.entries(clientTotals)
            .filter(([_, v]) => v.pendiente > 0)
            .sort((a, b) => b[1].pendiente - a[1].pendiente)
            .slice(0, 10);
        
        if (clientsSorted.length > 0) {
            html += `
            <div style="color:#FFD700; font-size:0.82rem; font-weight:bold; margin-bottom:10px;">🏆 TOP DEUDORES</div>
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem; margin-bottom:25px;">
                <thead><tr style="background:#2d2d30; color:#9cdcfe; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:left;">Cliente</th>
                    <th style="padding:8px 6px; text-align:right;">Facturado</th>
                    <th style="padding:8px 6px; text-align:right;">Cobrado</th>
                    <th style="padding:8px 6px; text-align:right;">Pendiente</th>
                </tr></thead><tbody>`;
            clientsSorted.forEach(([name, data]) => {
                html += `<tr style="border-bottom:1px solid #2d2d30;">
                    <td style="padding:6px; color:#fff; font-weight:600;">${name}</td>
                    <td style="padding:6px; text-align:right; color:#9cdcfe;">${data.facturado.toFixed(2)}€</td>
                    <td style="padding:6px; text-align:right; color:#81C784;">${data.cobrado.toFixed(2)}€</td>
                    <td style="padding:6px; text-align:right; color:#ff6b6b; font-weight:bold;">${data.pendiente.toFixed(2)}€</td>
                </tr>`;
            });
            html += '</tbody></table>';
        }
        
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// ============================================================
//  CARTERA DE COBROS / AGING REPORT
// ============================================================
window.contaLoadCartera = async function() {
    contaCurrentView = 'cartera';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Analizando antigüedad de deuda...</div>';
    
    try {
        const invSnap = await db.collection('invoices')
            .orderBy('date', 'desc')
            .limit(5000)
            .get();
        
        const now = Date.now();
        const DAY_MS = 86400000;
        const buckets = { d30: [], d60: [], d90: [], d120: [], older: [] };
        let total30 = 0, total60 = 0, total90 = 0, total120 = 0, totalOlder = 0;
        
        invSnap.forEach(doc => {
            const inv = doc.data();
            if (inv.paid) return; // Skip paid invoices
            
            const invDate = inv.date && inv.date.toDate ? inv.date.toDate() : new Date(inv.date);
            const ageDays = Math.floor((now - invDate.getTime()) / DAY_MS);
            const entry = { id: doc.id, ...inv, ageDays, invDate };
            
            if (ageDays <= 30) { buckets.d30.push(entry); total30 += inv.total || 0; }
            else if (ageDays <= 60) { buckets.d60.push(entry); total60 += inv.total || 0; }
            else if (ageDays <= 90) { buckets.d90.push(entry); total90 += inv.total || 0; }
            else if (ageDays <= 120) { buckets.d120.push(entry); total120 += inv.total || 0; }
            else { buckets.older.push(entry); totalOlder += inv.total || 0; }
        });
        
        const grandTotal = total30 + total60 + total90 + total120 + totalOlder;
        
        let html = `
        <div style="color:#ff6b6b; font-size:0.85rem; font-weight:bold; margin-bottom:20px;">📋 CARTERA DE COBROS — Antigüedad de Deuda</div>
        
        <!-- Aging summary bars -->
        <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:10px; margin-bottom:25px;">
            <div style="background:rgba(76,175,80,0.15); border:1px solid #4CAF50; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#81C784; text-transform:uppercase;">0-30 días</div>
                <div style="font-size:1.2rem; font-weight:bold; color:#4CAF50; margin:4px 0;">${total30.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#888;">${buckets.d30.length} facturas</div>
            </div>
            <div style="background:rgba(255,193,7,0.15); border:1px solid #FFC107; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#FFD54F; text-transform:uppercase;">31-60 días</div>
                <div style="font-size:1.2rem; font-weight:bold; color:#FFC107; margin:4px 0;">${total60.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#888;">${buckets.d60.length} facturas</div>
            </div>
            <div style="background:rgba(255,152,0,0.15); border:1px solid #FF9800; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#FFB74D; text-transform:uppercase;">61-90 días</div>
                <div style="font-size:1.2rem; font-weight:bold; color:#FF9800; margin:4px 0;">${total90.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#888;">${buckets.d90.length} facturas</div>
            </div>
            <div style="background:rgba(244,67,54,0.15); border:1px solid #f44336; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#ef5350; text-transform:uppercase;">91-120 días</div>
                <div style="font-size:1.2rem; font-weight:bold; color:#f44336; margin:4px 0;">${total120.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#888;">${buckets.d120.length} facturas</div>
            </div>
            <div style="background:rgba(183,28,28,0.15); border:1px solid #b71c1c; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#e57373; text-transform:uppercase;">+120 días</div>
                <div style="font-size:1.2rem; font-weight:bold; color:#b71c1c; margin:4px 0;">${totalOlder.toFixed(2)}€</div>
                <div style="font-size:0.7rem; color:#888;">${buckets.older.length} facturas</div>
            </div>
        </div>
        
        <div style="background:#1a1a2e; padding:12px; border-radius:8px; margin-bottom:20px; text-align:center;">
            <span style="color:#888; font-size:0.8rem;">DEUDA TOTAL PENDIENTE: </span>
            <span style="color:#fff; font-size:1.3rem; font-weight:bold;">${grandTotal.toFixed(2)}€</span>
        </div>`;
        
        // Detail list of all unpaid invoices
        const allUnpaid = [...buckets.older, ...buckets.d120, ...buckets.d90, ...buckets.d60, ...buckets.d30];
        
        if (allUnpaid.length > 0) {
            html += `
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                <thead>
                    <tr style="background:#2d2d30; color:#9cdcfe; font-size:0.7rem;">
                        <th style="padding:8px 6px; text-align:left;">Factura</th>
                        <th style="padding:8px 6px; text-align:left;">Cliente</th>
                        <th style="padding:8px 6px; text-align:left;">Fecha</th>
                        <th style="padding:8px 6px; text-align:center;">Días</th>
                        <th style="padding:8px 6px; text-align:right;">Importe</th>
                        <th style="padding:8px 6px; text-align:center;">Acción</th>
                    </tr>
                </thead>
                <tbody>`;
            
            allUnpaid.forEach(inv => {
                const dateStr = inv.invDate ? inv.invDate.toLocaleDateString('es-ES') : '-';
                const ageColor = inv.ageDays <= 30 ? '#4CAF50' : inv.ageDays <= 60 ? '#FFC107' : inv.ageDays <= 90 ? '#FF9800' : '#f44';
                html += `
                <tr style="border-bottom:1px solid #2d2d30;">
                    <td style="padding:6px; color:#FFD700; font-weight:bold;">${inv.invoiceId || '-'}</td>
                    <td style="padding:6px; color:#ccc;">${inv.clientName || '-'}</td>
                    <td style="padding:6px; color:#888;">${dateStr}</td>
                    <td style="padding:6px; text-align:center; color:${ageColor}; font-weight:bold;">${inv.ageDays}d</td>
                    <td style="padding:6px; text-align:right; color:#fff; font-weight:bold;">${(inv.total || 0).toFixed(2)}€</td>
                    <td style="padding:6px; text-align:center;">
                        <button onclick="contaMarkPaid('${inv.id}')" style="background:#4CAF50; border:none; color:#fff; padding:3px 8px; font-size:0.7rem; cursor:pointer; border-radius:3px;">✅ Cobrar</button>
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
        }
        
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// Quick-pay from cartera view
window.contaMarkPaid = async function(invoiceDocId) {
    if (!confirm('¿Marcar esta factura como COBRADA?')) return;
    try {
        await db.collection('invoices').doc(invoiceDocId).update({ paid: true, paidDate: new Date() });
        alert('✅ Factura marcada como cobrada.');
        contaLoadCartera(); // Refresh
    } catch(e) {
        alert('Error: ' + e.message);
    }
};

// ============================================================
//  MODELO 303 — AUTOLIQUIDACIÓN IVA TRIMESTRAL
// ============================================================
window.contaLoadModelo303 = async function() {
    contaCurrentView = 'modelo303';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Calculando Modelo 303...</div>';
    
    try {
        const year = new Date().getFullYear();
        const quarters = [
            { name: '1T (Ene-Mar)', start: new Date(year, 0, 1), end: new Date(year, 2, 31, 23, 59, 59) },
            { name: '2T (Abr-Jun)', start: new Date(year, 3, 1), end: new Date(year, 5, 30, 23, 59, 59) },
            { name: '3T (Jul-Sep)', start: new Date(year, 6, 1), end: new Date(year, 8, 30, 23, 59, 59) },
            { name: '4T (Oct-Dic)', start: new Date(year, 9, 1), end: new Date(year, 11, 31, 23, 59, 59) }
        ];
        
        // Get all journal entries for invoices this year
        const snap = await db.collection('journal')
            .where('type', '==', 'invoice')
            .orderBy('date', 'asc')
            .limit(5000)
            .get();
        
        // Get expense journal entries for IVA Soportado
        const expSnap = await db.collection('journal')
            .where('type', '==', 'expense')
            .orderBy('date', 'asc')
            .limit(5000)
            .get();
        
        const quarterData = quarters.map(q => ({ ...q, baseImponible: 0, ivaRepercutido: 0, baseGastos: 0, ivaSoportado: 0, countInv: 0, countExp: 0 }));
        
        snap.forEach(doc => {
            const j = doc.data();
            const date = j.date && j.date.toDate ? j.date.toDate() : new Date(j.date);
            for (let qi = 0; qi < 4; qi++) {
                if (date >= quarters[qi].start && date <= quarters[qi].end) {
                    quarterData[qi].baseImponible += j.subtotal || 0;
                    quarterData[qi].ivaRepercutido += j.ivaAmount || 0;
                    quarterData[qi].countInv++;
                    break;
                }
            }
        });
        
        expSnap.forEach(doc => {
            const j = doc.data();
            const date = j.date && j.date.toDate ? j.date.toDate() : new Date(j.date);
            for (let qi = 0; qi < 4; qi++) {
                if (date >= quarters[qi].start && date <= quarters[qi].end) {
                    quarterData[qi].baseGastos += j.subtotal || 0;
                    quarterData[qi].ivaSoportado += j.ivaAmount || 0;
                    quarterData[qi].countExp++;
                    break;
                }
            }
        });
        
        let html = `
        <div style="color:#00BCD4; font-size:0.85rem; font-weight:bold; margin-bottom:20px;">🏛️ MODELO 303 — Autoliquidación IVA Trimestral — ${year}</div>
        
        <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:15px; margin-bottom:25px;">`;
        
        let yearBaseVentas = 0, yearIVARep = 0, yearBaseGastos = 0, yearIVASop = 0;
        
        quarterData.forEach((q, idx) => {
            const currentQuarter = Math.floor(new Date().getMonth() / 3);
            const isActive = idx === currentQuarter;
            const borderColor = isActive ? '#00BCD4' : '#3c3c3c';
            const resultado = q.ivaRepercutido - q.ivaSoportado;
            yearBaseVentas += q.baseImponible;
            yearIVARep += q.ivaRepercutido;
            yearBaseGastos += q.baseGastos;
            yearIVASop += q.ivaSoportado;
            
            html += `
            <div style="background:#1e1e2e; border:2px solid ${borderColor}; border-radius:10px; padding:18px; ${isActive ? 'box-shadow: 0 0 15px rgba(0,188,212,0.3);' : ''}">
                <div style="font-size:0.75rem; color:${isActive ? '#00BCD4' : '#888'}; font-weight:bold; margin-bottom:12px; text-transform:uppercase;">${q.name} ${isActive ? '⬅ ACTUAL' : ''}</div>
                <div style="margin-bottom:6px;">
                    <span style="color:#888; font-size:0.65rem;">Base ventas:</span>
                    <span style="color:#fff; font-weight:bold; float:right; font-size:0.8rem;">${q.baseImponible.toFixed(2)}€</span>
                </div>
                <div style="margin-bottom:6px;">
                    <span style="color:#888; font-size:0.65rem;">IVA repercutido:</span>
                    <span style="color:#81C784; font-weight:bold; float:right; font-size:0.8rem;">${q.ivaRepercutido.toFixed(2)}€</span>
                </div>
                <div style="margin-bottom:6px;">
                    <span style="color:#888; font-size:0.65rem;">Base gastos:</span>
                    <span style="color:#ffab91; float:right; font-size:0.8rem;">${q.baseGastos.toFixed(2)}€</span>
                </div>
                <div style="margin-bottom:6px;">
                    <span style="color:#888; font-size:0.65rem;">IVA soportado:</span>
                    <span style="color:#ef5350; float:right; font-size:0.8rem;">-${q.ivaSoportado.toFixed(2)}€</span>
                </div>
                <div style="border-top:1px solid #333; padding-top:8px; margin-top:8px;">
                    <span style="color:#888; font-size:0.7rem;">${resultado >= 0 ? 'A ingresar:' : 'A compensar:'}</span>
                    <span style="color:${resultado >= 0 ? '#FFD700' : '#4FC3F7'}; font-weight:bold; float:right; font-size:1rem;">${resultado.toFixed(2)}€</span>
                </div>
                <div style="color:#555; font-size:0.6rem; margin-top:6px;">${q.countInv} fact · ${q.countExp} gastos</div>
            </div>`;
        });
        
        const yearNeto = yearIVARep - yearIVASop;
        html += `</div>
        
        <div style="background:#1a1a2e; border:1px solid #333; border-radius:8px; padding:15px; display:grid; grid-template-columns: repeat(5, 1fr); gap:10px;">
            <div style="text-align:center;">
                <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">Base Ventas</div>
                <div style="font-size:1rem; font-weight:bold; color:#fff;">${yearBaseVentas.toFixed(2)}€</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">IVA Repercut.</div>
                <div style="font-size:1rem; font-weight:bold; color:#81C784;">${yearIVARep.toFixed(2)}€</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">Base Gastos</div>
                <div style="font-size:1rem; font-weight:bold; color:#ffab91;">${yearBaseGastos.toFixed(2)}€</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">IVA Soportado</div>
                <div style="font-size:1rem; font-weight:bold; color:#ef5350;">-${yearIVASop.toFixed(2)}€</div>
            </div>
            <div style="text-align:center; border-left:2px solid #FFD700; padding-left:10px;">
                <div style="font-size:0.65rem; color:#FFD700; text-transform:uppercase; font-weight:bold;">${yearNeto >= 0 ? 'A Ingresar' : 'A Compensar'}</div>
                <div style="font-size:1.2rem; font-weight:bold; color:#FFD700;">${yearNeto.toFixed(2)}€</div>
            </div>
        </div>`;
        
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// ============================================================
//  MODELO 347 — OPERACIONES CON TERCEROS >3.005,06€
// ============================================================
window.contaLoadModelo347 = async function() {
    contaCurrentView = 'modelo347';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Calculando Modelo 347...</div>';
    
    try {
        const year = new Date().getFullYear();
        const UMBRAL = 3005.06;
        
        const invSnap = await db.collection('invoices')
            .where('date', '>=', new Date(year, 0, 1))
            .where('date', '<=', new Date(year, 11, 31, 23, 59, 59))
            .orderBy('date', 'asc')
            .limit(5000)
            .get();
        
        // Aggregate by client + quarter
        const clientOps = {};
        
        invSnap.forEach(doc => {
            const inv = doc.data();
            const cName = inv.clientName || 'Desconocido';
            const cNIF = inv.clientCIF || '-';
            const date = inv.date && inv.date.toDate ? inv.date.toDate() : new Date(inv.date);
            const quarter = Math.floor(date.getMonth() / 3) + 1;
            
            if (!clientOps[cName]) clientOps[cName] = { nif: cNIF, total: 0, q1: 0, q2: 0, q3: 0, q4: 0 };
            clientOps[cName].total += inv.total || 0;
            clientOps[cName]['q' + quarter] += inv.total || 0;
        });
        
        // Filter only those >3.005,06€
        const declarables = Object.entries(clientOps)
            .filter(([_, data]) => data.total >= UMBRAL)
            .sort((a, b) => b[1].total - a[1].total);
        
        let html = `
        <div style="color:#FF9800; font-size:0.85rem; font-weight:bold; margin-bottom:5px;">📄 MODELO 347 — Operaciones con Terceros — ${year}</div>
        <div style="color:#888; font-size:0.75rem; margin-bottom:20px;">Clientes con operaciones anuales ≥ ${UMBRAL.toFixed(2)}€ (IVA incluido)</div>`;
        
        if (declarables.length === 0) {
            html += '<div style="text-align:center; padding:40px; color:#888; font-size:0.9rem;">No hay clientes que superen el umbral de 3.005,06€ este año.</div>';
        } else {
            html += `
            <div style="background:rgba(255,152,0,0.1); border:1px solid #FF9800; border-radius:8px; padding:10px; margin-bottom:15px; text-align:center;">
                <span style="color:#FFB74D; font-weight:bold;">${declarables.length}</span>
                <span style="color:#888;"> clientes declarables</span>
            </div>
            
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                <thead>
                    <tr style="background:#2d2d30; color:#9cdcfe; font-size:0.7rem;">
                        <th style="padding:8px 6px; text-align:left;">Cliente</th>
                        <th style="padding:8px 6px; text-align:left;">NIF/ID</th>
                        <th style="padding:8px 6px; text-align:right;">1T</th>
                        <th style="padding:8px 6px; text-align:right;">2T</th>
                        <th style="padding:8px 6px; text-align:right;">3T</th>
                        <th style="padding:8px 6px; text-align:right;">4T</th>
                        <th style="padding:8px 6px; text-align:right;">TOTAL ANUAL</th>
                    </tr>
                </thead>
                <tbody>`;
            
            declarables.forEach(([name, data]) => {
                html += `
                <tr style="border-bottom:1px solid #2d2d30;">
                    <td style="padding:6px; color:#fff; font-weight:600;">${name}</td>
                    <td style="padding:6px; color:#888;">${data.nif}</td>
                    <td style="padding:6px; text-align:right; color:#ccc;">${data.q1 > 0 ? data.q1.toFixed(2) + '€' : '-'}</td>
                    <td style="padding:6px; text-align:right; color:#ccc;">${data.q2 > 0 ? data.q2.toFixed(2) + '€' : '-'}</td>
                    <td style="padding:6px; text-align:right; color:#ccc;">${data.q3 > 0 ? data.q3.toFixed(2) + '€' : '-'}</td>
                    <td style="padding:6px; text-align:right; color:#ccc;">${data.q4 > 0 ? data.q4.toFixed(2) + '€' : '-'}</td>
                    <td style="padding:6px; text-align:right; color:#FFD700; font-weight:bold;">${data.total.toFixed(2)}€</td>
                </tr>`;
            });
            
            html += '</tbody></table>';
        }
        
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// ============================================================
//  MÓDULO DE GASTOS / EXPENSES
// ============================================================

window.contaLoadGastos = async function() {
    contaCurrentView = 'gastos';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Cargando gastos...</div>';
    
    try {
        const year = new Date().getFullYear();
        const startOfYear = new Date(year, 0, 1);
        
        const snap = await db.collection('expenses')
            .where('date', '>=', startOfYear)
            .orderBy('date', 'desc')
            .limit(1000)
            .get();
        
        const expenses = [];
        let totalBase = 0, totalIVA = 0, totalGross = 0;
        snap.forEach(doc => {
            const data = doc.data();
            expenses.push({ id: doc.id, ...data });
            totalBase += data.base || 0;
            totalIVA += data.ivaAmount || 0;
            totalGross += data.total || 0;
        });
        
        // Categories for the form
        const categories = [
            'Combustible', 'Mantenimiento Vehículos', 'Seguros', 'Peajes y Autopistas',
            'Material Embalaje', 'Alquiler Local/Nave', 'Suministros (Luz, Agua, Internet)',
            'Teléfono/Comunicaciones', 'Material Oficina', 'Asesoría/Gestoría',
            'Reparaciones', 'Publicidad', 'Dietas y Desplazamientos', 'Otros'
        ];
        
        let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <div style="color:#FF9800; font-size:0.85rem; font-weight:bold;">💸 REGISTRO DE GASTOS — ${year}</div>
        </div>
        
        <!-- Quick add form -->
        <div style="background:#252526; border:1px solid #3c3c3c; border-radius:10px; padding:18px; margin-bottom:20px;">
            <div style="color:#FFD700; font-size:0.78rem; font-weight:bold; margin-bottom:12px;">➕ REGISTRAR NUEVO GASTO</div>
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr auto; gap:10px; align-items:end;">
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">FECHA</label>
                    <input type="date" id="gasto-date" value="${new Date().toISOString().split('T')[0]}" style="background:#3c3c3c; border:1px solid #555; color:#fff; padding:6px 8px; font-size:0.8rem; width:100%; box-sizing:border-box; outline:none;">
                </div>
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">CATEGORÍA</label>
                    <select id="gasto-category" style="background:#3c3c3c; border:1px solid #555; color:#fff; padding:6px 8px; font-size:0.8rem; width:100%; box-sizing:border-box; outline:none;">
                        ${categories.map(c => '<option value="' + c + '">' + c + '</option>').join('')}
                    </select>
                </div>
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">PROVEEDOR</label>
                    <input type="text" id="gasto-provider" placeholder="Nombre del proveedor" style="background:#3c3c3c; border:1px solid #555; color:#fff; padding:6px 8px; font-size:0.8rem; width:100%; box-sizing:border-box; outline:none;">
                </div>
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">Nº FACTURA</label>
                    <input type="text" id="gasto-ref" placeholder="Ref. proveedor" style="background:#3c3c3c; border:1px solid #555; color:#fff; padding:6px 8px; font-size:0.8rem; width:100%; box-sizing:border-box; outline:none;">
                </div>
                <div></div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr auto; gap:10px; align-items:end; margin-top:10px;">
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">BASE IMPONIBLE €</label>
                    <input type="number" id="gasto-base" step="0.01" min="0" placeholder="0.00" oninput="contaCalcGastoTotal()" style="background:#3c3c3c; border:1px solid #555; color:#fff; padding:6px 8px; font-size:0.8rem; width:100%; box-sizing:border-box; outline:none;">
                </div>
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">IVA %</label>
                    <input type="number" id="gasto-iva-rate" value="21" step="1" min="0" max="100" oninput="contaCalcGastoTotal()" style="background:#3c3c3c; border:1px solid #555; color:#fff; padding:6px 8px; font-size:0.8rem; width:100%; box-sizing:border-box; outline:none;">
                </div>
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">TOTAL</label>
                    <input type="text" id="gasto-total" readonly style="background:#2d2d30; border:1px solid #555; color:#FFD700; padding:6px 8px; font-size:0.8rem; font-weight:bold; width:100%; box-sizing:border-box; outline:none;">
                </div>
                <div>
                    <label style="color:#888; font-size:0.65rem; display:block; margin-bottom:4px;">CONCEPTO</label>
                    <input type="text" id="gasto-concept" placeholder="Descripción" style="background:#3c3c3c; border:1px solid #555; color:#fff; padding:6px 8px; font-size:0.8rem; width:100%; box-sizing:border-box; outline:none;">
                </div>
                <div>
                    <button onclick="contaSaveGasto()" style="background:#FF9800; border:none; color:#fff; padding:8px 18px; font-size:0.8rem; cursor:pointer; border-radius:4px; font-weight:bold; white-space:nowrap;">💾 Guardar</button>
                </div>
            </div>
        </div>
        
        <!-- Summary cards -->
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:20px;">
            <div style="background:rgba(255,152,0,0.1); border:1px solid #FF9800; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#FFB74D; text-transform:uppercase;">Base Total</div>
                <div style="font-size:1.1rem; font-weight:bold; color:#fff;">${totalBase.toFixed(2)}€</div>
            </div>
            <div style="background:rgba(244,67,54,0.1); border:1px solid #f44; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#ef5350; text-transform:uppercase;">IVA Soportado</div>
                <div style="font-size:1.1rem; font-weight:bold; color:#ef5350;">${totalIVA.toFixed(2)}€</div>
            </div>
            <div style="background:rgba(255,255,255,0.05); border:1px solid #555; border-radius:8px; padding:12px; text-align:center;">
                <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">Total Gastos</div>
                <div style="font-size:1.1rem; font-weight:bold; color:#fff;">${totalGross.toFixed(2)}€</div>
            </div>
        </div>`;
        
        // Expense list
        if (expenses.length > 0) {
            html += `
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                <thead><tr style="background:#2d2d30; color:#9cdcfe; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:left;">Fecha</th>
                    <th style="padding:8px 6px; text-align:left;">Categoría</th>
                    <th style="padding:8px 6px; text-align:left;">Proveedor</th>
                    <th style="padding:8px 6px; text-align:left;">Concepto</th>
                    <th style="padding:8px 6px; text-align:right;">Base</th>
                    <th style="padding:8px 6px; text-align:right;">IVA</th>
                    <th style="padding:8px 6px; text-align:right;">Total</th>
                    <th style="padding:8px 6px; text-align:center;">⚙</th>
                </tr></thead><tbody>`;
            
            expenses.forEach(exp => {
                const date = exp.date && exp.date.toDate ? exp.date.toDate() : new Date(exp.date);
                html += `
                <tr style="border-bottom:1px solid #2d2d30;">
                    <td style="padding:6px; color:#ccc;">${date.toLocaleDateString('es-ES')}</td>
                    <td style="padding:6px; color:#FFB74D;">${exp.category || '-'}</td>
                    <td style="padding:6px; color:#fff;">${exp.provider || '-'}</td>
                    <td style="padding:6px; color:#aaa;">${exp.concept || exp.description || '-'}</td>
                    <td style="padding:6px; text-align:right; color:#ccc;">${(exp.base || 0).toFixed(2)}€</td>
                    <td style="padding:6px; text-align:right; color:#ef5350;">${(exp.ivaAmount || 0).toFixed(2)}€</td>
                    <td style="padding:6px; text-align:right; color:#fff; font-weight:bold;">${(exp.total || 0).toFixed(2)}€</td>
                    <td style="padding:6px; text-align:center;"><button onclick="contaDeleteGasto('${exp.id}')" style="background:transparent; border:none; color:#f44; cursor:pointer; font-size:0.85rem;">🗑️</button></td>
                </tr>`;
            });
            html += '</tbody></table>';
        } else {
            html += '<div style="text-align:center; padding:40px; color:#888;">No hay gastos registrados este año. Usa el formulario de arriba para añadir uno.</div>';
        }
        
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// Calculate gasto total in real-time
window.contaCalcGastoTotal = function() {
    const base = parseFloat(document.getElementById('gasto-base').value) || 0;
    const ivaRate = parseFloat(document.getElementById('gasto-iva-rate').value) || 0;
    const total = base + (base * ivaRate / 100);
    document.getElementById('gasto-total').value = total.toFixed(2) + '€';
};

// Save expense + auto-generate journal entry
window.contaSaveGasto = async function() {
    const base = parseFloat(document.getElementById('gasto-base').value) || 0;
    if (base <= 0) { alert('Introduce una base imponible válida.'); return; }
    
    const ivaRate = parseFloat(document.getElementById('gasto-iva-rate').value) || 0;
    const ivaAmount = base * (ivaRate / 100);
    const total = base + ivaAmount;
    const dateStr = document.getElementById('gasto-date').value;
    const date = dateStr ? new Date(dateStr) : new Date();
    const category = document.getElementById('gasto-category').value;
    const provider = document.getElementById('gasto-provider').value.trim();
    const reference = document.getElementById('gasto-ref').value.trim();
    const concept = document.getElementById('gasto-concept').value.trim() || category;
    
    if (!provider) { alert('Introduce el nombre del proveedor.'); return; }
    
    try {
        // 1. Save expense document
        const expData = {
            date: date,
            category: category,
            provider: provider,
            reference: reference,
            concept: concept,
            base: base,
            ivaRate: ivaRate,
            ivaAmount: ivaAmount,
            total: total,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (typeof getOperatorStamp === 'function') Object.assign(expData, getOperatorStamp());
        const expDoc = await db.collection('expenses').add(expData);
        
        // 2. Auto-generate journal entry for this expense
        // DEBE: 600 Gastos (Base) + 472 IVA Soportado (IVA)
        // HABER: 400 Proveedores (Total)
        let asientoNum = 1;
        if (typeof window.allocSequentialNumber === 'function') {
            try {
                asientoNum = await window.allocSequentialNumber('sequence_counters/journal', async () => {
                    const lastSnap = await db.collection('journal').orderBy('number', 'desc').limit(1).get();
                    return lastSnap.empty ? 0 : (lastSnap.docs[0].data().number || 0);
                });
            } catch(e) { console.warn('[CONTA] allocSequentialNumber failed:', e); }
        } else {
            try {
                const lastSnap = await db.collection('journal').orderBy('number', 'desc').limit(1).get();
                if (!lastSnap.empty) asientoNum = (lastSnap.docs[0].data().number || 0) + 1;
            } catch(e) { /* first */ }
        }

        const entries = [
            {
                account: '600',
                subAccount: '',
                subAccountName: category,
                description: `${concept} - ${provider}`,
                debit: base,
                credit: 0
            }
        ];
        
        if (ivaAmount > 0) {
            entries.push({
                account: '472',
                subAccount: '',
                subAccountName: 'H.P. IVA Soportado',
                description: `IVA Soportado ${ivaRate}% - ${provider}`,
                debit: ivaAmount,
                credit: 0
            });
        }
        
        entries.push({
            account: '400',
            subAccount: provider,
            subAccountName: provider,
            description: `Factura proveedor ${reference || ''} - ${provider}`,
            debit: 0,
            credit: total
        });
        
        await db.collection('journal').add({
            number: asientoNum,
            date: date,
            description: `Gasto: ${concept} (${provider})`,
            entries: entries,
            expenseRef: expDoc.id,
            type: 'expense',
            subtotal: base,
            ivaAmount: ivaAmount,
            total: total,
            provider: provider,
            category: category,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`[CONTA] ✅ Gasto registrado y asiento #${asientoNum} generado`);
        alert(`✅ Gasto de ${total.toFixed(2)}€ registrado con asiento contable.`);
        contaLoadGastos(); // Refresh
    } catch(e) {
        alert('Error guardando gasto: ' + e.message);
        console.error(e);
    }
};

// Delete expense and its journal entry
window.contaDeleteGasto = async function(expId) {
    if (!confirm('¿Eliminar este gasto y su asiento contable?')) return;
    try {
        // Delete the expense
        await db.collection('expenses').doc(expId).delete();
        // Delete associated journal entry
        const jSnap = await db.collection('journal').where('expenseRef', '==', expId).limit(1).get();
        if (!jSnap.empty) await db.collection('journal').doc(jSnap.docs[0].id).delete();
        alert('✅ Gasto eliminado.');
        contaLoadGastos();
    } catch(e) {
        alert('Error: ' + e.message);
    }
};

// ============================================================
//  CUENTA DE PERDIDAS Y GANANCIAS (P&L)
// ============================================================
window.contaLoadPyG = async function() {
    contaCurrentView = 'pyg';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Calculando Cuenta de Resultados...</div>';
    
    try {
        const year = new Date().getFullYear();
        const startOfYear = new Date(year, 0, 1);
        const endOfYear = new Date(year, 11, 31, 23, 59, 59);
        
        // Get all journal entries this year
        const snap = await db.collection('journal')
            .where('date', '>=', startOfYear)
            .where('date', '<=', endOfYear)
            .orderBy('date', 'asc')
            .limit(5000)
            .get();
        
        // Aggregate by account
        const accountTotals = {};
        const categoryTotals = {};
        let totalIngresos = 0, totalGastos = 0;
        
        snap.forEach(doc => {
            const j = doc.data();
            (j.entries || []).forEach(e => {
                const acc = e.account;
                if (!accountTotals[acc]) accountTotals[acc] = { debit: 0, credit: 0 };
                accountTotals[acc].debit += e.debit || 0;
                accountTotals[acc].credit += e.credit || 0;
            });
            
            // Aggregate gastos by category
            if (j.type === 'expense' && j.category) {
                if (!categoryTotals[j.category]) categoryTotals[j.category] = 0;
                categoryTotals[j.category] += j.subtotal || 0;
                totalGastos += j.subtotal || 0;
            }
            if (j.type === 'invoice') {
                totalIngresos += j.subtotal || 0;
            }
        });
        
        const beneficioNeto = totalIngresos - totalGastos;
        const margen = totalIngresos > 0 ? ((beneficioNeto / totalIngresos) * 100).toFixed(1) : 0;
        const ivaRep = (accountTotals['477'] || {}).credit || 0;
        const ivaSop = (accountTotals['472'] || {}).debit || 0;
        const ivaNeto = ivaRep - ivaSop;
        
        let html = `
        <div style="color:#00E5FF; font-size:0.85rem; font-weight:bold; margin-bottom:20px;">📈 CUENTA DE PÉRDIDAS Y GANANCIAS — ${year}</div>
        
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:25px;">
            <!-- INGRESOS -->
            <div style="background:#1e1e2e; border:2px solid #4CAF50; border-radius:12px; padding:20px;">
                <div style="color:#81C784; font-size:0.78rem; font-weight:bold; margin-bottom:15px; text-transform:uppercase; letter-spacing:1px;">▲ INGRESOS</div>
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #2d2d30;">
                    <span style="color:#ccc;">700 — Prestación de Servicios</span>
                    <span style="color:#81C784; font-weight:bold;">${totalIngresos.toFixed(2)}€</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:12px 0; margin-top:8px; border-top:2px solid #4CAF50;">
                    <span style="color:#fff; font-weight:bold;">TOTAL INGRESOS</span>
                    <span style="color:#4CAF50; font-weight:bold; font-size:1.1rem;">${totalIngresos.toFixed(2)}€</span>
                </div>
            </div>
            
            <!-- GASTOS -->
            <div style="background:#1e1e2e; border:2px solid #ef5350; border-radius:12px; padding:20px;">
                <div style="color:#ef5350; font-size:0.78rem; font-weight:bold; margin-bottom:15px; text-transform:uppercase; letter-spacing:1px;">▼ GASTOS</div>`;
        
        // Desglose por categoría
        const catEntries = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
        if (catEntries.length > 0) {
            catEntries.forEach(([cat, amount]) => {
                const pct = totalGastos > 0 ? Math.round((amount / totalGastos) * 100) : 0;
                html += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #2d2d30;">
                    <span style="color:#ccc; font-size:0.8rem;">${cat}</span>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div style="background:#2d2d30; border-radius:4px; width:60px; height:6px; overflow:hidden;">
                            <div style="background:#ef5350; height:100%; width:${pct}%;"></div>
                        </div>
                        <span style="color:#ef5350; font-weight:bold; font-size:0.8rem;">${amount.toFixed(2)}€</span>
                    </div>
                </div>`;
            });
        } else {
            html += '<div style="color:#555; padding:10px 0; font-size:0.8rem;">Sin gastos registrados</div>';
        }
        
        html += `
                <div style="display:flex; justify-content:space-between; padding:12px 0; margin-top:8px; border-top:2px solid #ef5350;">
                    <span style="color:#fff; font-weight:bold;">TOTAL GASTOS</span>
                    <span style="color:#ef5350; font-weight:bold; font-size:1.1rem;">${totalGastos.toFixed(2)}€</span>
                </div>
            </div>
        </div>
        
        <!-- RESULTADO -->
        <div style="background:linear-gradient(135deg, ${beneficioNeto >= 0 ? '#1b5e20, #2e7d32' : '#b71c1c, #c62828'}); border-radius:12px; padding:25px; text-align:center; margin-bottom:20px;">
            <div style="font-size:0.75rem; color:rgba(255,255,255,0.7); text-transform:uppercase; letter-spacing:2px;">RESULTADO DEL EJERCICIO</div>
            <div style="font-size:2.5rem; font-weight:bold; color:#fff; margin:10px 0;">${beneficioNeto.toFixed(2)}€</div>
            <div style="font-size:0.85rem; color:rgba(255,255,255,0.8);">${beneficioNeto >= 0 ? '✅ BENEFICIO' : '⚠️ PÉRDIDA'} · Margen ${margen}%</div>
        </div>
        
        <!-- IVA Summary -->
        <div style="background:#1e1e2e; border:1px solid #333; border-radius:8px; padding:15px; display:grid; grid-template-columns: 1fr 1fr 1fr; gap:15px;">
            <div style="text-align:center;">
                <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">IVA Repercutido</div>
                <div style="font-size:1rem; font-weight:bold; color:#81C784;">${ivaRep.toFixed(2)}€</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">IVA Soportado</div>
                <div style="font-size:1rem; font-weight:bold; color:#ef5350;">${ivaSop.toFixed(2)}€</div>
            </div>
            <div style="text-align:center; border-left:2px solid #FFD700; padding-left:10px;">
                <div style="font-size:0.65rem; color:#FFD700; text-transform:uppercase;">IVA Neto</div>
                <div style="font-size:1rem; font-weight:bold; color:#FFD700;">${ivaNeto.toFixed(2)}€</div>
            </div>
        </div>`;
        
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

// ============================================================
//  SEPA XML REMITTANCE GENERATOR (CORE19 Direct Debit)
// ============================================================
window.contaLoadSEPA = async function() {
    contaCurrentView = 'sepa';
    const container = document.getElementById('conta-content');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">Cargando facturas pendientes para remesa...</div>';
    
    try {
        // Load unpaid invoices
        const invSnap = await db.collection('invoices')
            .orderBy('date', 'desc')
            .limit(2000)
            .get();
        
        const unpaid = [];
        invSnap.forEach(doc => {
            const inv = doc.data();
            if (!inv.paid) {
                unpaid.push({ id: doc.id, ...inv });
            }
        });
        
        let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <div>
                <div style="color:#2196F3; font-size:0.85rem; font-weight:bold;">🏦 REMESA SEPA — Generador XML19.14</div>
                <div style="color:#888; font-size:0.72rem; margin-top:4px;">Selecciona facturas pendientes para generar el fichero de cobro bancario</div>
            </div>
            <div style="display:flex; gap:8px;">
                <button onclick="contaSelectAllSEPA()" style="background:#333; border:1px solid #555; color:#ccc; padding:5px 12px; font-size:0.75rem; cursor:pointer; border-radius:3px;">☑ Seleccionar Todo</button>
                <button onclick="contaGenerateSEPA()" style="background:#2196F3; border:none; color:#fff; padding:5px 15px; font-size:0.78rem; cursor:pointer; border-radius:4px; font-weight:bold;">🏦 Generar XML SEPA</button>
            </div>
        </div>`;
        
        if (unpaid.length === 0) {
            html += '<div style="text-align:center; padding:60px; color:#888;">No hay facturas pendientes de cobro para incluir en una remesa.</div>';
        } else {
            html += `
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem;">
                <thead><tr style="background:#2d2d30; color:#9cdcfe; font-size:0.7rem;">
                    <th style="padding:8px 6px; text-align:center; width:40px;">☑</th>
                    <th style="padding:8px 6px; text-align:left;">Factura</th>
                    <th style="padding:8px 6px; text-align:left;">Cliente</th>
                    <th style="padding:8px 6px; text-align:left;">NIF</th>
                    <th style="padding:8px 6px; text-align:left;">Fecha</th>
                    <th style="padding:8px 6px; text-align:right;">Importe</th>
                </tr></thead><tbody>`;
            
            let totalSeleccionable = 0;
            unpaid.forEach((inv, idx) => {
                const date = inv.date && inv.date.toDate ? inv.date.toDate() : new Date(inv.date);
                totalSeleccionable += inv.total || 0;
                html += `
                <tr style="border-bottom:1px solid #2d2d30;">
                    <td style="padding:6px; text-align:center;"><input type="checkbox" class="sepa-check" data-idx="${idx}" data-id="${inv.id}" data-amount="${inv.total || 0}" data-client="${(inv.clientName || '').replace(/"/g, '')}" data-cif="${inv.clientCIF || ''}" data-invoice="${inv.invoiceId || ''}" checked></td>
                    <td style="padding:6px; color:#FFD700; font-weight:bold;">${inv.invoiceId || inv.id}</td>
                    <td style="padding:6px; color:#fff;">${inv.clientName || '-'}</td>
                    <td style="padding:6px; color:#888;">${inv.clientCIF || '-'}</td>
                    <td style="padding:6px; color:#ccc;">${date.toLocaleDateString('es-ES')}</td>
                    <td style="padding:6px; text-align:right; color:#fff; font-weight:bold;">${(inv.total || 0).toFixed(2)}€</td>
                </tr>`;
            });
            
            html += `</tbody>
                <tfoot><tr style="background:#1a1a2e; border-top:3px solid #2196F3;">
                    <td colspan="5" style="padding:10px 6px; color:#2196F3; text-align:right; font-weight:bold;">TOTAL REMESA</td>
                    <td style="padding:10px 6px; text-align:right; color:#fff; font-weight:bold; font-size:1rem;">${totalSeleccionable.toFixed(2)}€</td>
                </tr></tfoot>
            </table>`;
        }
        
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `<div style="color:#f44; padding:20px;">Error: ${e.message}</div>`;
    }
};

window.contaSelectAllSEPA = function() {
    const checks = document.querySelectorAll('.sepa-check');
    const allChecked = Array.from(checks).every(c => c.checked);
    checks.forEach(c => c.checked = !allChecked);
};

window.contaGenerateSEPA = async function() {
    const checks = document.querySelectorAll('.sepa-check:checked');
    if (checks.length === 0) { alert('Selecciona al menos una factura.'); return; }
    
    // Get company data for creditor info
    let company = window.invCompanyData || {};
    if (!company.bank && !company.iban) {
        try {
            const cSnap = await db.collection('config').doc('company').get();
            if (cSnap.exists) company = cSnap.data();
        } catch(e) { /* use what we have */ }
    }
    
    const creditorName = company.name || company.companyName || 'NOVAPACK';
    const creditorCIF = (company.cif || company.nif || '').replace(/[\s-]/g, '');
    const creditorIBAN = (company.bank || company.iban || '').replace(/\s/g, '');
    
    if (!creditorIBAN || creditorIBAN.length < 20) {
        alert('⚠️ Configura primero el IBAN de la empresa en los datos fiscales.'); return;
    }
    
    // Build payment info
    const payments = [];
    let totalAmount = 0;
    
    // Collect client IBANs from userMap
    checks.forEach(chk => {
        const clientName = chk.dataset.client;
        const clientCIF = chk.dataset.cif || '';
        const amount = parseFloat(chk.dataset.amount) || 0;
        const invoiceId = chk.dataset.invoice;
        const invDocId = chk.dataset.id;
        
        // Look up client IBAN from userMap
        let clientIBAN = '';
        if (window.userMap) {
            const user = Object.values(window.userMap).find(u => 
                (u.name || '').toLowerCase() === clientName.toLowerCase() || 
                (u.idNum || '') === clientCIF
            );
            if (user) clientIBAN = (user.iban || '').replace(/\s/g, '');
        }
        
        payments.push({ clientName, clientCIF, clientIBAN, amount, invoiceId, invDocId });
        totalAmount += amount;
    });
    
    // Check for missing IBANs
    const missingIBAN = payments.filter(p => !p.clientIBAN || p.clientIBAN.length < 20);
    if (missingIBAN.length > 0) {
        const names = missingIBAN.map(p => p.clientName).join(', ');
        if (!confirm(`⚠️ ${missingIBAN.length} clientes sin IBAN configurado: ${names}\n\nSe excluirán de la remesa. ¿Continuar?`)) return;
    }
    
    const validPayments = payments.filter(p => p.clientIBAN && p.clientIBAN.length >= 20);
    if (validPayments.length === 0) { alert('No hay clientes con IBAN válido para la remesa.'); return; }
    
    const now = new Date();
    const msgId = `NOVAPACK-${now.toISOString().replace(/[-:T.Z]/g, '').substring(0, 14)}`;
    const collectionDate = new Date(now.getTime() + 5 * 86400000).toISOString().split('T')[0]; // D+5
    const validTotal = validPayments.reduce((s, p) => s + p.amount, 0);
    
    // Generate SEPA XML (pain.008.001.02 — Direct Debit)
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${msgId}</MsgId>
      <CreDtTm>${now.toISOString()}</CreDtTm>
      <NbOfTxs>${validPayments.length}</NbOfTxs>
      <CtrlSum>${validTotal.toFixed(2)}</CtrlSum>
      <InitgPty><Nm>${creditorName}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${msgId}-001</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <NbOfTxs>${validPayments.length}</NbOfTxs>
      <CtrlSum>${validTotal.toFixed(2)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl><Cd>SEPA</Cd></SvcLvl>
        <LclInstrm><Cd>CORE</Cd></LclInstrm>
        <SeqTp>RCUR</SeqTp>
      </PmtTpInf>
      <ReqdColltnDt>${collectionDate}</ReqdColltnDt>
      <Cdtr><Nm>${creditorName}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${creditorIBAN}</IBAN></Id></CdtrAcct>
      <CdtrAgt><FinInstnId><BIC>NOTPROVIDED</BIC></FinInstnId></CdtrAgt>
      <CdtrSchmeId>
        <Id><PrvtId><Othr>
          <Id>ES${creditorCIF}</Id>
          <SchmeNm><Prtry>SEPA</Prtry></SchmeNm>
        </Othr></PrvtId></Id>
      </CdtrSchmeId>`;
    
    validPayments.forEach(p => {
        xml += `
      <DrctDbtTxInf>
        <PmtId>
          <EndToEndId>${p.invoiceId || p.invDocId}</EndToEndId>
        </PmtId>
        <InstdAmt Ccy="EUR">${p.amount.toFixed(2)}</InstdAmt>
        <DrctDbtTx>
          <MndtRltdInf>
            <MndtId>${p.clientCIF || 'MANDATE-' + p.clientName.substring(0, 10)}</MndtId>
            <DtOfSgntr>${new Date().toISOString().split('T')[0]}</DtOfSgntr>
          </MndtRltdInf>
        </DrctDbtTx>
        <DbtrAgt><FinInstnId><BIC>NOTPROVIDED</BIC></FinInstnId></DbtrAgt>
        <Dbtr><Nm>${p.clientName}</Nm></Dbtr>
        <DbtrAcct><Id><IBAN>${p.clientIBAN}</IBAN></Id></DbtrAcct>
        <RmtInf><Ustrd>Cobro ${p.invoiceId}</Ustrd></RmtInf>
      </DrctDbtTxInf>`;
    });
    
    xml += `
    </PmtInf>
  </CstmrDrctDbtInitn>
</Document>`;
    
    // Download
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `REMESA_SEPA_${now.toISOString().split('T')[0]}.xml`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    alert(`✅ Fichero SEPA generado con ${validPayments.length} cobros por ${validTotal.toFixed(2)}€.\nFecha de cobro: ${collectionDate}\n\nSube este fichero a tu banca online para ejecutar la remesa.`);
};

// --- EXPORTAR CSV ---
window.contaExportCSV = function() {
    if (contaJournalCache.length === 0) { alert('No hay datos para exportar.'); return; }
    
    let csv = 'Asiento;Fecha;Descripción;Cuenta;Concepto;Debe;Haber\n';
    contaJournalCache.forEach(j => {
        const date = j.date && j.date.toDate ? j.date.toDate() : new Date(j.date);
        const dateStr = date.toLocaleDateString('es-ES');
        (j.entries || []).forEach(e => {
            csv += `${j.number};${dateStr};${(j.description || '').replace(/;/g, ',')};${e.account};${(e.description || '').replace(/;/g, ',')};${(e.debit || 0).toFixed(2)};${(e.credit || 0).toFixed(2)}\n`;
        });
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `DIARIO_CONTABLE_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

console.log('[CONTA] ✅ Módulo de contabilidad cargado correctamente.');
