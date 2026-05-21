
// FACTURACIÓN MASIVA AUTOMÁTICA
window.advInvoiceAllPending = async () => {
    // 1. Obtener parámetros (Fecha de corte y Empresa Emisora)
    const cutoffDateStr = prompt("Introduce la FECHA LÍMITE (YYYY-MM-DD) para facturar albaranes.\nPor defecto se facturará todo lo pendiente hasta el día de hoy:", new Date().toISOString().split('T')[0]);
    if(cutoffDateStr === null) return; // Cancelado
    const cutoffDate = cutoffDateStr ? new Date(cutoffDateStr + 'T23:59:59') : new Date();

    let compId = 'main';
    const comps = [];
    if(window.advCompaniesMap) {
        for(let key in window.advCompaniesMap) {
            comps.push({id: key, name: window.advCompaniesMap[key].name});
        }
    }
    if(comps.length > 0) {
        let compPrompt = "Selecciona el NÚMERO de la EMPRESA/FILIAL que emitirá las facturas:\n0: Sede Principal (NOVAPACK) [POR DEFECTO]\n";
        comps.forEach((c, idx) => compPrompt += `${idx+1}: ${c.name}\n`);
        const numSeleccionado = prompt(compPrompt, "0");
        if(numSeleccionado === null) return; // Cancelado
        const parsed = parseInt(numSeleccionado);
        if(!isNaN(parsed) && parsed > 0 && parsed <= comps.length) {
            compId = comps[parsed-1].id;
        }
    }

    if(!confirm(`⚠️ ATENCIÓN: Se van a generar facturas automáticamente para TODOS los clientes con albaranes pendientes hasta el ${cutoffDate.toLocaleDateString()}, emitidas por ${compId === 'main' ? 'Sede Principal' : window.advCompaniesMap[compId].name}.\n\n¿ESTÁS SEGURO DE CONTINUAR?`)) return;

    if (typeof showLoading === 'function') showLoading("Procesando facturación masiva...");

    try {
        // 2. Obtener todos los clientes válidos
        if (!window.userMap || Object.keys(window.userMap).length < 2) {
            if (typeof window.loadUsers === 'function') await window.loadUsers('first');
        }
        
        // 3. Obtener todos los albaranes (Limitamos a 10000 para evitar bloqueos)
        const ticketsSnap = await db.collection('tickets')
            .where('createdAt', '<=', cutoffDate)
            .orderBy('createdAt', 'desc')
            .limit(10000)
            .get();

        // 4. Agrupar por Cliente
        const groupedTickets = {};
        let facturables = 0;
        
        ticketsSnap.forEach(doc => {
            const t = doc.data();
            // Filtrar ya facturados
            if (t.invoiceId && String(t.invoiceId).trim() !== "" && String(t.invoiceId).toLowerCase() !== "null") return;
            // Filtrar si es un estado que no se debe facturar (ej. anulados)
            if (t.deleteRequested || t.status === 'Pendiente Anulación') return;

            let clientId, clientIdNum;
            
            if (t.shippingType === 'Debidos') {
                // Si es debido y no tiene un destinatario asignado explícitamente, se ignora (Limbo)
                if (!t.billToUid) return; 
                clientId = t.billToUid;
                clientIdNum = t.billToClientIdNum || '';
            } else {
                // Si es Pagado, se le cobra al remitente (creador)
                clientId = t.uid;
                clientIdNum = t.clientIdNum || ''; 
            }
            
            // Buscar el userObject correspondiente
            let userObj = window.userMap[clientId];
            if(!userObj && clientIdNum) {
                userObj = Object.values(window.userMap).find(u => u.idNum == clientIdNum);
            }
            if(!userObj) return; // Si no hay usuario, saltarlo (huérfano)

            const finalUserId = userObj.id;
            
            if(!groupedTickets[finalUserId]) {
                groupedTickets[finalUserId] = {
                    clientInfo: userObj,
                    tickets: []
                };
            }
            
            groupedTickets[finalUserId].tickets.push({...t, docId: doc.id});
            facturables++;
        });

        const clientIds = Object.keys(groupedTickets);
        if(clientIds.length === 0 || facturables === 0) {
            alert("No se encontraron albaranes pendientes para facturar en esa fecha.");
            if (typeof hideLoading === 'function') hideLoading();
            return;
        }

        let facturasGeneradas = 0;
        let importeTotalGenerado = 0;

        // 5. Preparar datos del Emisor Central/Filial
        let finalSenderData = Object.assign({}, window.invCompanyData || {});
        if (compId !== 'main' && window.advCompaniesMap && window.advCompaniesMap[compId]) {
            const filial = window.advCompaniesMap[compId];
            finalSenderData.name = filial.name;
            finalSenderData.cif = filial.nif || filial.cif;
            finalSenderData.address = filial.address;
            if(filial.bank) finalSenderData.bank = filial.bank;
            if(filial.email) finalSenderData.email = filial.email;
            if(filial.legal) finalSenderData.legal = filial.legal;
        }

        // Atomic per-year invoice numbering. Each invoice in the loop reserves
        // its own number transactionally so concurrent admin runs cannot collide.
        const currentYear = new Date().getFullYear();
        const currentYY = String(currentYear).slice(-2);
        const _invCounterPath = 'sequence_counters/invoices_' + currentYear;
        const _seedInvFromHistory = async () => {
            const yearStart = new Date(currentYear, 0, 1);
            const yearEnd = new Date(currentYear + 1, 0, 1);
            const invSnap = await db.collection('invoices')
                .where('date', '>=', yearStart)
                .where('date', '<', yearEnd)
                .orderBy('date', 'desc')
                .limit(10000)
                .get();
            let max = 0;
            invSnap.forEach(doc => {
                const iid = doc.data().invoiceId || '';
                const m = iid.match(/^FAC-\d{2}-(\d+)$/);
                if (m) {
                    const seq = parseInt(m[1], 10);
                    if (!isNaN(seq) && seq > max) max = seq;
                }
                const n = doc.data().number || 0;
                if (n > max) max = n;
            });
            return max;
        };
        const invoiceDate = new Date(); // Fecha de emisión

        // 6. Generar facturas en lote
        for(let i=0; i<clientIds.length; i++) {
            const cid = clientIds[i];
            const group = groupedTickets[cid];
            const client = group.clientInfo;
            const tkts = group.tickets;

            if(tkts.length === 0) continue;

            const ticketsIdArray = [];
            const ticketsDetailArray = [];
            let subtotal = 0;
            const ivaRate = window.invCompanyData ? window.invCompanyData.iva : 21;
            
            const advancedGrid = [];

            // Calcular líneas de esta factura
            for(let j=0; j<tkts.length; j++) {
                const t = tkts[j];
                ticketsIdArray.push(t.docId);
                
                let price = 0;
                if (typeof window.calculateTicketPriceSync === 'function') {
                    price = window.calculateTicketPriceSync(t, client.id, t.compId || 'comp_main');
                }
                
                ticketsDetailArray.push({
                    id: t.id || t.docId,
                    compName: t.compName || "",
                    price: price
                });

                const pkgs = t.packagesList ? t.packagesList.reduce((s, p) => s + (parseInt(p.qty) || 1), 0) : (t.packages||1);

                advancedGrid.push({
                    description: `Albarán ${t.id || t.docId} - Destino: ${t.receiver}`,
                    qty: 1, // El precio ya representa el total del albarán por norma general, qty=1
                    price: price,
                    discount: 0,
                    iva: ivaRate,
                    total: price,
                    ticketId: t.docId
                });

                subtotal += price;
            }

            if(subtotal <= 0) continue; // No facturar clientes a 0€

            const ivaAmount = subtotal * (ivaRate / 100);
            
            // IRPF del cliente si lo tiene
            let irpfRate = 0;
            if(client.irpf) {
                irpfRate = parseFloat(client.irpf) || 0;
            }
            const irpfAmount = subtotal * (irpfRate / 100);
            
            const totalAmount = subtotal + ivaAmount - irpfAmount;

            // Reserve next number atomically for THIS invoice only.
            let nextInvNumber;
            if (typeof window.allocSequentialNumber === 'function') {
                nextInvNumber = await window.allocSequentialNumber(_invCounterPath, _seedInvFromHistory);
            } else {
                nextInvNumber = (await _seedInvFromHistory()) + 1;
            }
            const invoiceIdStr = `FAC-${currentYY}-${nextInvNumber}`;

            const invoiceData = {
                number: nextInvNumber,
                invoiceId: invoiceIdStr,
                date: invoiceDate,
                clientId: client.id,
                clientName: client.name || 'Sin nombre',
                clientCIF: client.idNum || client.nif || 'N/A',
                subtotal: subtotal,
                iva: ivaAmount,
                ivaRate: ivaRate,
                irpf: irpfAmount,
                irpfRate: irpfRate,
                total: totalAmount,
                tickets: ticketsIdArray,
                ticketsDetail: ticketsDetailArray,
                senderData: finalSenderData,
                advancedGrid: advancedGrid
            };

            // Crear Factura
            const invDoc = await db.collection('invoices').add(invoiceData);

            // Actualizar Albaranes (Batch)
            // Firebase limits batch writes to 500, but one client rarely has > 500 unbilled tickets
            let batch = db.batch();
            let opCount = 0;
            for (const t of tkts) {
                const tRef = db.collection('tickets').doc(t.docId);
                batch.update(tRef, { invoiceId: invDoc.id, invoiceNum: invoiceIdStr });
                opCount++;
                if (opCount === 490) {
                    await batch.commit();
                    batch = db.batch();
                    opCount = 0;
                }
            }
            if (opCount > 0) {
                await batch.commit();
            }

            facturasGeneradas++;
            importeTotalGenerado += totalAmount;
            // (No manual increment: each iteration calls allocSequentialNumber.)
        }

        alert(`✅ PROCESO MASIVO COMPLETADO.\n\n• Facturas Generadas: ${facturasGeneradas}\n• Importe Total Billed: ${importeTotalGenerado.toFixed(2)}€`);
        
        if (typeof window.loadInvoices === 'function') window.loadInvoices();

    } catch(e) {
        console.error("Error masivo:", e);
        alert("Error durante la facturación masiva: " + e.message);
    } finally {
        if (typeof hideLoading === 'function') hideLoading();
    }
};
