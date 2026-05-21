/**
 * NOVAPACK CLOUD — Editor de Tarifas v2  (Fase 2 + 3)
 *
 * UI completa de tarifas v2 con artículos estructurados (modo + reglas)
 * y overrides por cliente. Integra con el motor pricingEngine.
 *
 * Estructura Firestore que usa este editor:
 *   tariffs/{tariffId}                          ← tarifas v2 globales
 *      { id, name, version: 2, items: [...] }
 *
 *   users/{uid}.tariffId                        ← tarifa base asignada
 *   users/{uid}.tariffOverrides                 ← overrides por item
 *
 * Entry points:
 *   openTariffManager(clientId)         ← gestor completo del cliente
 *   openTariffBuilder(tariffId, mode)   ← editar la tarifa global asignada
 *   openItemEditor(item, onSave)        ← formulario de un artículo
 */
(function() {
    'use strict';

    if (typeof db === 'undefined' || typeof pricingEngine === 'undefined') return;

    function _esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }
    function _money(n) { return (Number(n) || 0).toFixed(2).replace('.', ',') + ' €'; }

    const MODE_LABELS = {
        'per_package': 'Por bulto (qty × precio)',
        'per_kg': 'Por kilo (kg × precio)',
        'per_expedition': 'Por expedición (1 cobro por línea)',
        'per_expedition_unit': 'Por expedición × bulto (qty × precio)',
        'flat_monthly': 'Cuota mensual fija (no factura albarán)'
    };

    // ============ FIRESTORE IO ============

    async function _loadTariff(tariffId) {
        const id = tariffId.startsWith('GLOBAL_') || tariffId.includes('CUSTOM_') ? tariffId : 'GLOBAL_' + tariffId;
        const candidates = [id, tariffId, 'GLOBAL_' + tariffId];
        for (const c of candidates) {
            try {
                const d = await db.collection('tariffs').doc(c).get();
                if (d.exists) return { id: c, ...d.data() };
            } catch(e) {}
        }
        return null;
    }

    async function _listV2Tariffs() {
        const out = [];
        try {
            const snap = await db.collection('tariffs').get();
            snap.forEach(doc => {
                const d = doc.data();
                if (d.version === 2) out.push({ id: doc.id, ...d });
            });
        } catch(e) { console.warn('list tarifas v2:', e); }
        return out;
    }

    async function _saveTariff(tariff) {
        const id = tariff.id || ('GLOBAL_' + (tariff.name || 'sin_nombre').toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 30) + '_v2');
        const payload = {
            ...tariff,
            id: id,
            version: 2,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || 'admin'
        };
        delete payload.id; // no guardar id como field
        await db.collection('tariffs').doc(id).set(payload, { merge: true });
        // Invalidar cache global de tarifas para forzar refresh en Reports / facturación
        if (window.tariffsCache) {
            try { window.tariffsCache = {}; } catch(_) {}
        }
        return id;
    }

    async function _saveClientOverrides(clientId, tariffId, overrides) {
        const upd = {
            tariffId: tariffId,
            tariffOverrides: overrides || {},
            tariffUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('users').doc(clientId).update(upd);
        if (window.userMap && window.userMap[clientId]) {
            window.userMap[clientId].tariffId = tariffId;
            window.userMap[clientId].tariffOverrides = overrides;
        }
    }

    // ============ ITEM EDITOR (modal por artículo) ============

    function openItemEditor(item, onSave, zonesContext) {
        const isNew = !item || !item.id;
        const it = item ? { ...item } : {
            id: 'item_' + Date.now().toString(36),
            name: '',
            mode: 'per_package',
            basePrice: 0,
            unit: '',
            pricingRule: null,
            pricesByZone: {}
        };
        // zonesContext: array de zonas de la tarifa contenedora (puede venir vacío).
        const zones = Array.isArray(zonesContext) ? zonesContext : [];

        const old = document.getElementById('item-editor-modal');
        if (old) old.remove();
        const modal = document.createElement('div');
        modal.id = 'item-editor-modal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100002; display:flex; align-items:center; justify-content:center; padding:20px;';

        function modeOptions(selected) {
            return Object.keys(MODE_LABELS).map(k =>
                '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + MODE_LABELS[k] + '</option>'
            ).join('');
        }
        function ruleEditorHTML(rule) {
            rule = rule || { type: '' };
            return ''
                + '<select id="ie-rule-type" style="width:100%; padding:7px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:4px;">'
                + '  <option value="">— Sin regla especial —</option>'
                + '  <option value="bulk_discount"' + (rule.type === 'bulk_discount' ? ' selected' : '') + '>Descuento por volumen (cada N → factura M)</option>'
                + '  <option value="tiered"' + (rule.type === 'tiered' ? ' selected' : '') + '>Precio por tramos</option>'
                + '  <option value="min_charge"' + (rule.type === 'min_charge' ? ' selected' : '') + '>Mínimo facturable</option>'
                + '  <option value="surcharge_over"' + (rule.type === 'surcharge_over' ? ' selected' : '') + '>Recargo sobre umbral</option>'
                + '</select>'
                + '<div id="ie-rule-fields" style="margin-top:8px;"></div>';
        }
        function renderRuleFields(type, current) {
            current = current || {};
            const c = document.getElementById('ie-rule-fields');
            if (!c) return;
            if (type === 'bulk_discount') {
                c.innerHTML = ''
                    + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">'
                    + '  <label>Cada N qty<input type="number" id="ie-r-every" value="' + (current.every || 4) + '" min="2" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"></label>'
                    + '  <label>Factura solo M<input type="number" id="ie-r-charge" value="' + (current.charge != null ? current.charge : 3) + '" min="1" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"></label>'
                    + '</div>'
                    + '<p style="font-size:0.7rem; color:#888; margin:6px 0 0;">Ej: every=4, charge=3 → "4 baterías por el precio de 3"</p>';
            } else if (type === 'tiered') {
                const tiers = current.tiers || [{minQty:1, price:0}];
                c.innerHTML = '<div id="ie-tiers"></div>'
                    + '<button type="button" id="ie-add-tier" style="margin-top:6px; background:#5DADE2; border:0; color:#000; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:0.75rem;">+ Tramo</button>';
                const tEl = document.getElementById('ie-tiers');
                tiers.forEach((t, idx) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:grid; grid-template-columns:1fr 1fr auto; gap:6px; margin-bottom:4px; align-items:center;';
                    row.innerHTML = ''
                        + '<input type="number" placeholder="qty mín" data-tier-min value="' + (t.minQty || 0) + '" min="1" style="width:100%; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;">'
                        + '<input type="number" placeholder="precio" data-tier-price value="' + (t.price || 0) + '" step="0.01" style="width:100%; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;">'
                        + '<button type="button" style="background:transparent; border:1px solid #f44; color:#f44; padding:3px 7px; border-radius:3px; cursor:pointer; font-size:0.7rem;">−</button>';
                    row.querySelector('button').onclick = () => row.remove();
                    tEl.appendChild(row);
                });
                document.getElementById('ie-add-tier').onclick = () => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:grid; grid-template-columns:1fr 1fr auto; gap:6px; margin-bottom:4px; align-items:center;';
                    row.innerHTML = '<input type="number" placeholder="qty mín" data-tier-min min="1" style="width:100%; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"><input type="number" placeholder="precio" data-tier-price step="0.01" style="width:100%; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"><button type="button" style="background:transparent; border:1px solid #f44; color:#f44; padding:3px 7px; border-radius:3px; cursor:pointer; font-size:0.7rem;">−</button>';
                    row.querySelector('button').onclick = () => row.remove();
                    tEl.appendChild(row);
                };
            } else if (type === 'min_charge') {
                c.innerHTML = '<label>Importe mínimo €<input type="number" id="ie-r-min" value="' + (current.amount || 0) + '" step="0.01" min="0" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"></label>'
                    + '<p style="font-size:0.7rem; color:#888; margin:6px 0 0;">Si la línea sale por debajo, se sube a ese importe.</p>';
            } else if (type === 'surcharge_over') {
                c.innerHTML = ''
                    + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">'
                    + '  <label>Sobre qty/kg<input type="number" id="ie-r-thr" value="' + (current.threshold || 0) + '" step="0.01" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"></label>'
                    + '  <label>Base <select id="ie-r-basis" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"><option value="qty"' + (current.basis === 'qty' ? ' selected' : '') + '>qty</option><option value="kg"' + (current.basis === 'kg' ? ' selected' : '') + '>kg</option></select></label>'
                    + '  <label>Tipo <select id="ie-r-kind" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"><option value="flat"' + (current.kind === 'flat' ? ' selected' : '') + '>+ € fijo</option><option value="per_unit"' + (current.kind === 'per_unit' ? ' selected' : '') + '>+ € por unidad excedida</option></select></label>'
                    + '  <label>Importe €<input type="number" id="ie-r-amount" value="' + (current.amount || 0) + '" step="0.01" min="0" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px;"></label>'
                    + '</div>';
            } else {
                c.innerHTML = '';
            }
        }
        function readRule() {
            const type = document.getElementById('ie-rule-type').value;
            if (!type) return null;
            if (type === 'bulk_discount') {
                return { type, every: parseInt(document.getElementById('ie-r-every').value, 10) || 4,
                         charge: parseInt(document.getElementById('ie-r-charge').value, 10) || 3 };
            }
            if (type === 'tiered') {
                const tiers = [];
                document.querySelectorAll('#ie-tiers > div').forEach(row => {
                    const minQty = parseInt(row.querySelector('[data-tier-min]').value, 10);
                    const price = parseFloat(row.querySelector('[data-tier-price]').value);
                    if (!isNaN(minQty) && !isNaN(price)) tiers.push({ minQty, price });
                });
                tiers.sort((a, b) => a.minQty - b.minQty);
                return { type, tiers };
            }
            if (type === 'min_charge') {
                return { type, amount: parseFloat(document.getElementById('ie-r-min').value) || 0 };
            }
            if (type === 'surcharge_over') {
                return {
                    type,
                    threshold: parseFloat(document.getElementById('ie-r-thr').value) || 0,
                    basis: document.getElementById('ie-r-basis').value,
                    kind: document.getElementById('ie-r-kind').value,
                    amount: parseFloat(document.getElementById('ie-r-amount').value) || 0
                };
            }
            return null;
        }

        modal.innerHTML = ''
            + '<div style="background:#1e1e1e; border:1px solid #444; border-radius:12px; padding:24px; max-width:600px; width:100%; color:#d4d4d4; max-height:90vh; overflow-y:auto;">'
            + '<h3 style="margin:0 0 16px; color:#FF6600;">' + (isNew ? '+ Nuevo artículo' : '✏️ Editar artículo') + '</h3>'
            + '<div style="display:grid; gap:10px;">'
            + '  <label>ID <small style="color:#666;">(identificador estable, no se debe cambiar después)</small><input type="text" id="ie-id" value="' + _esc(it.id) + '" ' + (isNew ? '' : 'readonly') + ' style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:' + (isNew ? '#fff' : '#888') + '; border-radius:5px; font-family:monospace;"></label>'
            + '  <label>Nombre visible<input type="text" id="ie-name" value="' + _esc(it.name) + '" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;"></label>'
            + '  <div style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:8px;">'
            + '    <label>Modo<select id="ie-mode" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;">' + modeOptions(it.mode) + '</select></label>'
            + '    <label>Precio base €<input type="number" id="ie-price" value="' + (it.basePrice || 0) + '" step="0.01" min="0" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;"></label>'
            + '    <label>Unidad<input type="text" id="ie-unit" value="' + _esc(it.unit || '') + '" placeholder="paquete, kg…" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;"></label>'
            + '  </div>'
            // ─── Auto-detección Provincial / Interprovincial por CP ──
            + '  <div style="background:rgba(255,215,0,0.04); border:1px solid rgba(255,215,0,0.25); border-radius:6px; padding:10px;">'
            + '    <label style="display:flex; align-items:center; gap:8px; font-weight:600; color:#FFD700; cursor:pointer;">'
            + '      <input type="checkbox" id="ie-prov-detect"' + (it.provincialDetect ? ' checked' : '') + ' style="scale:1.2;">'
            + '      <span>📍 Distinguir precio según provincia (auto-detección por CP)</span>'
            + '    </label>'
            + '    <div style="font-size:0.7rem; color:#888; margin-top:4px;">El sistema compara el CP del CLIENTE (origen) con el CP del DESTINATARIO. Si los 2 primeros dígitos coinciden = PROVINCIAL. Si no = INTERPROVINCIAL.</div>'
            + '    <div id="ie-prov-fields" style="display:' + (it.provincialDetect ? 'grid' : 'none') + '; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">'
            + '      <label>Precio PROVINCIAL (mismo origen-destino) €<input type="number" id="ie-prov-price" step="0.01" min="0" value="' + ((it.pricesByProvince && it.pricesByProvince.provincial != null) ? it.pricesByProvince.provincial : '') + '" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px; font-family:monospace; margin-top:3px;"></label>'
            + '      <label>Precio INTERPROVINCIAL (provincias distintas) €<input type="number" id="ie-interprov-price" step="0.01" min="0" value="' + ((it.pricesByProvince && it.pricesByProvince.interprovincial != null) ? it.pricesByProvince.interprovincial : '') + '" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px; font-family:monospace; margin-top:3px;"></label>'
            + '    </div>'
            + '  </div>'
            + (zones.length ? (''
                + '  <div style="background:rgba(94,160,255,0.04); border:1px solid rgba(94,160,255,0.25); border-radius:6px; padding:10px;">'
                + '    <label style="font-weight:600; color:#5DADE2; display:block; margin-bottom:6px;">📍 Precios por zona (opcional — si vacío usa precio base)</label>'
                + '    <table style="width:100%; border-collapse:collapse; font-size:0.78rem;">'
                + '      <thead><tr style="background:rgba(255,255,255,0.03);"><th style="padding:5px 8px; text-align:left; color:#888; font-size:0.7rem;">Zona</th><th style="padding:5px 8px; text-align:left; color:#888; font-size:0.7rem; width:60%;">Rangos CP</th><th style="padding:5px 8px; text-align:right; color:#888; font-size:0.7rem; width:120px;">Precio €</th></tr></thead>'
                + '      <tbody>'
                + zones.map(z => {
                    const v = (it.pricesByZone && it.pricesByZone[z.id] !== undefined && it.pricesByZone[z.id] !== null) ? it.pricesByZone[z.id] : '';
                    return '<tr style="border-bottom:1px solid #2d2d30;">'
                        + '  <td style="padding:5px 8px; color:#fff; font-weight:600;">' + _esc(z.name) + '</td>'
                        + '  <td style="padding:5px 8px; color:#888; font-family:monospace; font-size:0.72rem;">' + _esc((z.cpRanges || []).join(', ')) + '</td>'
                        + '  <td style="padding:5px 8px;"><input type="number" step="0.01" min="0" data-zone-price="' + _esc(z.id) + '" value="' + _esc(v) + '" placeholder="(usa base)" style="width:100%; padding:5px 7px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px; text-align:right; font-family:monospace;"></td>'
                        + '</tr>';
                }).join('')
                + '      </tbody>'
                + '    </table>'
                + '    <div style="font-size:0.7rem; color:#888; margin-top:6px;">Deja vacío para usar el precio base. Si rellenas, ese precio gana cuando el CP del destinatario cae en esa zona.</div>'
                + '  </div>'
            ) : '')
            + '  <div style="background:rgba(255,102,0,0.04); border:1px solid rgba(255,102,0,0.2); border-radius:6px; padding:10px;">'
            + '    <label style="font-weight:600; color:#FF8A50; display:block; margin-bottom:6px;">Regla especial (opcional)</label>'
            + ruleEditorHTML(it.pricingRule)
            + '  </div>'
            + '</div>'
            + '<div style="display:flex; gap:10px; justify-content:flex-end; margin-top:18px;">'
            + '  <button type="button" id="ie-cancel" style="background:#333; border:1px solid #555; color:#fff; padding:8px 16px; border-radius:5px; cursor:pointer;">Cancelar</button>'
            + '  <button type="button" id="ie-save" style="background:#FF6600; border:0; color:#fff; padding:8px 22px; border-radius:5px; font-weight:700; cursor:pointer;">Guardar</button>'
            + '</div>'
            + '</div>';
        document.body.appendChild(modal);

        renderRuleFields(it.pricingRule ? it.pricingRule.type : '', it.pricingRule || {});
        document.getElementById('ie-rule-type').addEventListener('change', function() {
            renderRuleFields(this.value, {});
        });
        // Toggle de auto-detección provincial
        const provDetect = document.getElementById('ie-prov-detect');
        if (provDetect) provDetect.addEventListener('change', function() {
            const fields = document.getElementById('ie-prov-fields');
            if (fields) fields.style.display = this.checked ? 'grid' : 'none';
        });
        document.getElementById('ie-cancel').onclick = () => modal.remove();
        document.getElementById('ie-save').onclick = () => {
            const itemOut = {
                id: document.getElementById('ie-id').value.trim() || it.id,
                name: document.getElementById('ie-name').value.trim(),
                mode: document.getElementById('ie-mode').value,
                basePrice: parseFloat(document.getElementById('ie-price').value) || 0,
                unit: document.getElementById('ie-unit').value.trim(),
                pricingRule: readRule()
            };
            if (!itemOut.name) { alert('Pon un nombre al artículo.'); return; }
            // Auto-detección provincial/interprovincial
            const provDet = document.getElementById('ie-prov-detect');
            if (provDet && provDet.checked) {
                const provP = document.getElementById('ie-prov-price').value;
                const interP = document.getElementById('ie-interprov-price').value;
                itemOut.provincialDetect = true;
                itemOut.pricesByProvince = {};
                if (provP !== '' && !isNaN(parseFloat(provP))) itemOut.pricesByProvince.provincial = parseFloat(provP);
                if (interP !== '' && !isNaN(parseFloat(interP))) itemOut.pricesByProvince.interprovincial = parseFloat(interP);
            } else {
                itemOut.provincialDetect = false;
                itemOut.pricesByProvince = null;
            }
            // Recoger precios por zona si hay
            if (zones.length) {
                const pbz = {};
                modal.querySelectorAll('[data-zone-price]').forEach(inp => {
                    const zid = inp.getAttribute('data-zone-price');
                    const raw = inp.value.trim();
                    if (raw !== '' && !isNaN(parseFloat(raw))) {
                        pbz[zid] = parseFloat(raw);
                    }
                });
                if (Object.keys(pbz).length > 0) itemOut.pricesByZone = pbz;
                else itemOut.pricesByZone = {}; // limpiar si todos vacíos
            }
            modal.remove();
            if (typeof onSave === 'function') onSave(itemOut);
        };
    }

    // ============ TARIFA EDITOR (constructor de tarifa global) ============

    // Plantillas de arranque según tipo de tarifa elegido en el picker
    const TARIFF_TEMPLATES = {
        plana: {
            label: 'Tarifa plana mensual',
            description: 'Una cuota fija al mes que cubre el flujo habitual. Los albaranes normales no facturan individualmente.',
            icon: '📊',
            items: [
                { id: 'cuota_mensual', name: 'Cuota mensual', mode: 'flat_monthly', basePrice: 500.00, unit: 'mes', pricingRule: null }
            ]
        },
        plana_extras: {
            label: 'Plana + servicios sueltos',
            description: 'Cuota mensual fija + artículos que SE FACTURAN APARTE (paletizados, urgentes, especiales). Lo más común en clientes con plana.',
            icon: '📊➕',
            items: [
                { id: 'cuota_mensual', name: 'Cuota mensual', mode: 'flat_monthly', basePrice: 500.00, unit: 'mes', pricingRule: null },
                { id: 'palet_estandar', name: 'Paletizado estándar', mode: 'per_package', basePrice: 35.00, unit: 'palet', pricingRule: null },
                { id: 'palet_europeo', name: 'Paletizado europeo (120×80)', mode: 'per_package', basePrice: 40.00, unit: 'palet', pricingRule: null },
                { id: 'envio_urgente', name: 'Envío urgente fuera horario', mode: 'per_expedition', basePrice: 60.00, unit: 'expedición', pricingRule: null }
            ]
        },
        bulto: {
            label: 'Por bulto',
            description: 'Precio según número de paquetes. Habitual en paquetería estándar.',
            icon: '📦',
            items: [
                { id: 'pkg_pequeno', name: 'Paquete pequeño', mode: 'per_package', basePrice: 4.50, unit: 'paquete', conditions: { maxKg: 5 }, pricingRule: null },
                { id: 'pkg_mediano', name: 'Paquete mediano', mode: 'per_package', basePrice: 7.00, unit: 'paquete', conditions: { minKg: 5, maxKg: 15 }, pricingRule: null },
                { id: 'pkg_grande', name: 'Paquete grande', mode: 'per_package', basePrice: 12.00, unit: 'paquete', conditions: { minKg: 15, maxKg: 30 }, pricingRule: null }
            ]
        },
        kilo: {
            label: 'Por kilo',
            description: 'Precio según peso real del envío. Ideal para mercancía variable.',
            icon: '⚖️',
            items: [
                { id: 'kg_estandar', name: 'Transporte por peso', mode: 'per_kg', basePrice: 0.80, unit: 'kg', pricingRule: { type: 'min_charge', amount: 6.00 } }
            ]
        },
        expedicion: {
            label: 'Por expedición',
            description: 'Un cobro fijo por albarán, sin importar cuántos paquetes lleve.',
            icon: '🚚',
            items: [
                { id: 'exp_estandar', name: 'Expedición estándar', mode: 'per_expedition', basePrice: 25.00, unit: 'expedición', pricingRule: null }
            ]
        },
        expedicion_unit: {
            label: 'Por expedición × bulto',
            description: 'Cuota fija de expedición multiplicada por bultos. (Caso descrito como "carga 4" en albarán de 4 bultos).',
            icon: '🚛',
            items: [
                { id: 'exp_x_bulto', name: 'Expedición por bulto', mode: 'per_expedition_unit', basePrice: 6.00, unit: 'bulto', pricingRule: null }
            ]
        },
        mixta: {
            label: 'Mixta / libre',
            description: 'Tarifa vacía. Construye los artículos que quieras combinando todos los modos. Recomendado si tu caso es complejo.',
            icon: '🧩',
            items: []
        }
    };

    function _openTariffTypePicker(onPicked) {
        const old = document.getElementById('tariff-type-picker');
        if (old) old.remove();
        const modal = document.createElement('div');
        modal.id = 'tariff-type-picker';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:100002; display:flex; align-items:center; justify-content:center; padding:20px;';
        const keys = Object.keys(TARIFF_TEMPLATES);
        const cards = keys.map(k => {
            const t = TARIFF_TEMPLATES[k];
            return ''
                + '<div data-pick="' + k + '" style="background:#1a1a1a; border:2px solid #444; border-radius:10px; padding:14px; cursor:pointer; transition:all 0.15s;" onmouseover="this.style.borderColor=\'#FF6600\'; this.style.background=\'rgba(255,102,0,0.04)\'" onmouseout="this.style.borderColor=\'#444\'; this.style.background=\'#1a1a1a\'">'
                + '  <div style="font-size:1.8rem; margin-bottom:6px;">' + t.icon + '</div>'
                + '  <div style="font-weight:700; color:#FF8A50; font-size:0.95rem; margin-bottom:4px;">' + _esc(t.label) + '</div>'
                + '  <div style="font-size:0.72rem; color:#aaa; line-height:1.4; min-height:42px;">' + _esc(t.description) + '</div>'
                + '  <div style="font-size:0.62rem; color:#666; margin-top:8px; letter-spacing:0.5px; text-transform:uppercase;">' + (t.items.length === 0 ? 'Sin plantilla — empieza vacío' : 'Plantilla: ' + t.items.length + ' artículo' + (t.items.length === 1 ? '' : 's')) + '</div>'
                + '</div>';
        }).join('');
        modal.innerHTML = ''
            + '<div style="background:#1e1e1e; border:1px solid #444; border-radius:12px; padding:24px; max-width:880px; width:100%; max-height:92vh; overflow-y:auto; color:#d4d4d4;">'
            + '<h2 style="margin:0 0 6px; color:#FF6600;">🧮 ¿Qué tipo de tarifa quieres crear?</h2>'
            + '<p style="margin:0 0 18px; font-size:0.82rem; color:#aaa;">Elige el modelo base. Cada opción te crea una plantilla con artículos típicos que luego puedes editar, añadir o quitar libremente. Si tu caso es muy específico, elige "Mixta / libre".</p>'
            + '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px,1fr)); gap:12px;">' + cards + '</div>'
            + '<div style="margin-top:20px; text-align:right;">'
            + '  <button id="ttp-cancel" style="background:#333; border:1px solid #555; color:#fff; padding:8px 18px; border-radius:5px; cursor:pointer;">Cancelar</button>'
            + '</div>'
            + '</div>';
        document.body.appendChild(modal);
        document.getElementById('ttp-cancel').onclick = () => modal.remove();
        modal.querySelectorAll('[data-pick]').forEach(card => card.addEventListener('click', function() {
            const key = this.getAttribute('data-pick');
            const tpl = TARIFF_TEMPLATES[key];
            const name = prompt('Nombre para la tarifa "' + tpl.label + '":', tpl.label + ' ' + new Date().getFullYear());
            if (!name) return;
            modal.remove();
            // Deep clone items para que ediciones futuras no muten la plantilla
            const items = JSON.parse(JSON.stringify(tpl.items));
            onPicked({ name: name.trim(), version: 2, items: items, _typePreset: key });
        }));
    }

    // openTariffBuilder(tariffId, assignToClientId)
    //   tariffId         → tarifa existente a editar (null = nueva)
    //   assignToClientId → si viene, tras guardar se asigna la tarifa a ese
    //                      cliente automáticamente (lo usa "+ Crear nueva"
    //                      desde el gestor de tarifa del cliente).
    window.openTariffBuilder = async function openTariffBuilder(tariffId, assignToClientId) {
        let tariff;
        if (tariffId) {
            tariff = await _loadTariff(tariffId);
            if (tariff && tariff.version !== 2) tariff = null;
        }
        if (!tariff) {
            // Pasa por el picker de tipo antes de entrar al editor
            return _openTariffTypePicker(function(preset) {
                _renderTariffBuilder(preset, assignToClientId);
            });
        }
        _renderTariffBuilder(tariff, assignToClientId);
    };

    function _renderTariffBuilder(tariff, assignToClientId) {
        // Modal overlay simple (revertido del experimento ERP por bug
        // "pantalla negra" reportado por user 2026-05-14).
        const existing = document.getElementById('tariff-builder-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'tariff-builder-modal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:100001; display:flex; flex-direction:column; padding:20px; overflow-y:auto;';
        document.body.appendChild(modal);

        modal.innerHTML = ''
            + '<div style="max-width:980px; width:100%; margin:0 auto; background:#1e1e1e; border-radius:12px; padding:24px; color:#d4d4d4;">'
            + '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">'
            + '  <div><h2 style="margin:0; color:#FF6600;">🧮 Constructor de tarifa' + (tariff._typePreset ? ' <span style="font-size:0.7rem; color:#FF8A50; background:rgba(255,102,0,0.10); padding:3px 9px; border-radius:8px; vertical-align:middle; margin-left:8px;">tipo: ' + _esc(TARIFF_TEMPLATES[tariff._typePreset] ? TARIFF_TEMPLATES[tariff._typePreset].label : tariff._typePreset) + '</span>' : '') + '</h2><div id="tb-name" style="font-size:0.85rem; color:#aaa; margin-top:3px;">' + (tariff._typePreset ? 'Plantilla cargada — puedes editar, añadir o quitar artículos libremente.' : 'Edición de tarifa existente') + '</div></div>'
            + '  <div style="display:flex; gap:8px;">'
            + '    <button id="tb-save" style="background:#FF6600; border:0; color:#fff; padding:8px 18px; border-radius:5px; font-weight:700; cursor:pointer;">💾 Guardar tarifa</button>'
            + (tariff.id ? '    <button id="tb-delete" style="background:transparent; border:1px solid #FF3B30; color:#FF3B30; padding:8px 14px; border-radius:5px; cursor:pointer; font-weight:600;" title="Eliminar esta tarifa del sistema">🗑️ Eliminar</button>' : '')
            + '    <button id="tb-close" style="background:#333; border:1px solid #555; color:#fff; padding:8px 18px; border-radius:5px; cursor:pointer;">Cerrar</button>'
            + '  </div>'
            + '</div>'
            + '<div style="margin-bottom:12px;"><label style="font-size:0.78rem; color:#aaa;">Nombre tarifa</label><input type="text" id="tb-tariff-name" value="' + _esc(tariff.name || '') + '" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:5px;"></div>'
            + '<div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center;">'
            + '  <button id="tb-import-base" type="button" style="background:#4CAF50; border:0; color:#fff; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:700; font-size:0.85rem;" title="Importa los 19 artículos base (S, PI, PP, BI, BP, V, GV, PLT-1..7, LN, LS, LF, LC, PA, AB) con sus precios. Edita libremente después.">📥 Importar catálogo base (19 artículos)</button>'
            + '  <span style="font-size:0.72rem; color:#888;">Trae los códigos típicos (PP, PI, BP, BI, PLT-1..7, etc.) con precios del Excel. Luego edita lo que necesites o añade códigos custom (pms, psg, bms…) manualmente.</span>'
            + '</div>'
            + '<div id="tb-add-bar" style="margin-bottom:14px; display:flex; gap:8px; flex-wrap:wrap;"></div>'
            + '<div id="tb-sections"></div>'
            + '</div>';
        document.body.appendChild(modal);

        // ─── ZONAS POR CÓDIGO POSTAL ────────────────────────────
        // Garantizamos id único y formato consistente para cada zona.
        if (!Array.isArray(tariff.zones)) tariff.zones = [];

        function renderZonesSection() {
            const wrap = document.getElementById('tb-zones-section');
            if (!wrap) return;
            const hasZones = tariff.zones && tariff.zones.length > 0;
            // ─── Sección AVANZADA, colapsada por defecto ───────────
            // La auto-detección provincial/interprovincial (en cada artículo)
            // cubre el 95% de los casos. Las zonas manuales solo hacen falta
            // para destinos especiales (Baleares, Canarias, Internacional).
            let bodyHtml = '';
            if (!hasZones) {
                bodyHtml = '<div style="background:rgba(94,160,255,0.04); border:1px dashed rgba(94,160,255,0.30); border-radius:8px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">'
                    + '  <div style="font-size:0.78rem; color:#aaa;">📍 <strong style="color:#5DADE2;">Zonas avanzadas por CP</strong> — solo úsalo si necesitas precios distintos para Baleares (07), Canarias (35,38) o internacional. Para el caso normal provincial/interprovincial, usa la opción del propio artículo.</div>'
                    + '  <button id="tb-zones-init" style="background:#5DADE2; border:0; color:#000; padding:6px 14px; border-radius:6px; cursor:pointer; font-weight:700; font-size:0.78rem; white-space:nowrap;">+ Definir zonas</button>'
                    + '</div>';
            } else {
                let rowsHtml = '';
                tariff.zones.forEach((z, idx) => {
                    const rangesStr = (z.cpRanges || []).join(', ');
                    rowsHtml += '<tr data-zone-idx="' + idx + '" style="border-bottom:1px solid #2d2d30;">'
                        + '  <td style="padding:6px; color:#666; font-size:0.7rem; text-align:center;">' + (idx + 1) + '</td>'
                        + '  <td style="padding:6px;"><input type="text" data-zone-name value="' + _esc(z.name || '') + '" placeholder="Ej: Málaga capital" style="width:100%; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px; font-size:0.78rem;"></td>'
                        + '  <td style="padding:6px;"><input type="text" data-zone-ranges value="' + _esc(rangesStr) + '" placeholder="29001-29099, 29, *" style="width:100%; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px; font-size:0.78rem; font-family:monospace;"></td>'
                        + '  <td style="padding:6px; text-align:right; white-space:nowrap;">'
                        + '    <button data-zone-up style="background:transparent; border:1px solid #555; color:#aaa; padding:3px 7px; border-radius:3px; cursor:pointer; font-size:0.7rem;" title="Subir (mayor prioridad)">▲</button>'
                        + '    <button data-zone-down style="background:transparent; border:1px solid #555; color:#aaa; padding:3px 7px; border-radius:3px; cursor:pointer; font-size:0.7rem;" title="Bajar">▼</button>'
                        + '    <button data-zone-del style="background:transparent; border:1px solid #f44; color:#f44; padding:3px 7px; border-radius:3px; cursor:pointer; font-size:0.7rem;" title="Eliminar zona">🗑️</button>'
                        + '  </td>'
                        + '</tr>';
                });
                bodyHtml = '<div style="background:rgba(94,160,255,0.04); border:1px solid rgba(94,160,255,0.30); border-radius:8px; padding:12px 14px;">'
                    + '  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">'
                    + '    <strong style="color:#5DADE2; font-size:0.88rem;">📍 Zonas por código postal</strong>'
                    + '    <div style="display:flex; gap:6px;"><button id="tb-zone-add" style="background:#5DADE2; border:0; color:#000; padding:5px 12px; border-radius:5px; cursor:pointer; font-weight:700; font-size:0.78rem;">+ Zona</button><button id="tb-zones-help" style="background:transparent; border:1px solid #555; color:#aaa; padding:5px 10px; border-radius:5px; cursor:pointer; font-size:0.75rem;">❓ Ayuda</button></div>'
                    + '  </div>'
                    + '  <div style="font-size:0.7rem; color:#888; margin-bottom:8px;">El orden importa — primera zona cuyo rango matchea gana. Pon las MÁS específicas arriba (Málaga capital antes que Provincia Málaga).</div>'
                    + '  <table style="width:100%; border-collapse:collapse; font-size:0.78rem;">'
                    + '    <thead><tr style="background:rgba(255,255,255,0.03);"><th style="padding:5px; text-align:center; color:#888; font-size:0.7rem; width:30px;">#</th><th style="padding:5px; text-align:left; color:#888; font-size:0.7rem;">Nombre</th><th style="padding:5px; text-align:left; color:#888; font-size:0.7rem;">Rangos CP (coma-separados)</th><th style="width:130px;"></th></tr></thead>'
                    + '    <tbody>' + rowsHtml + '</tbody>'
                    + '  </table>'
                    + '</div>';
            }
            // Envolver en <details> (avanzado, colapsado por defecto)
            const isOpen = hasZones; // si ya hay zonas configuradas, abrir el accordion
            wrap.innerHTML = '<details' + (isOpen ? ' open' : '') + ' style="background:rgba(255,255,255,0.02); border:1px solid #2d2d30; border-radius:8px;">'
                + '<summary style="cursor:pointer; padding:8px 14px; font-size:0.78rem; color:#888; user-select:none;">⚙️ Avanzado · Zonas manuales por CP (Baleares, Canarias, internacional…)</summary>'
                + '<div style="padding:10px 14px; border-top:1px solid #2d2d30;">' + bodyHtml + '</div>'
                + '</details>';

            // Wire
            const initBtn = document.getElementById('tb-zones-init');
            if (initBtn) initBtn.onclick = function() {
                tariff.zones = [
                    { id: 'z' + Date.now().toString(36) + '_1', name: 'Málaga capital', cpRanges: ['29001-29099'] },
                    { id: 'z' + Date.now().toString(36) + '_2', name: 'Provincia Málaga', cpRanges: ['29'] },
                    { id: 'z' + Date.now().toString(36) + '_3', name: 'Resto Andalucía', cpRanges: ['11','14','18','21','23','41'] },
                    { id: 'z' + Date.now().toString(36) + '_4', name: 'Resto España', cpRanges: ['*'] }
                ];
                renderZonesSection();
                renderRows();
            };
            const addBtn = document.getElementById('tb-zone-add');
            if (addBtn) addBtn.onclick = function() {
                tariff.zones.push({ id: 'z' + Date.now().toString(36) + '_' + tariff.zones.length, name: 'Zona ' + (tariff.zones.length + 1), cpRanges: [] });
                _commitZoneInputs();
                renderZonesSection();
                renderRows();
            };
            const helpBtn = document.getElementById('tb-zones-help');
            if (helpBtn) helpBtn.onclick = function() {
                alert('Cómo definir rangos de CP:\n\n'
                    + '• "29001-29099" → CP entre 29001 y 29099 (Málaga capital)\n'
                    + '• "29" → cualquier CP que empiece por 29 (provincia Málaga)\n'
                    + '• "29,11,14" → varios rangos (separa con comas)\n'
                    + '• "*" → catch-all (resto, cualquier CP no matcheado antes)\n\n'
                    + 'Orden: la PRIMERA zona cuyo rango matchea gana. Pon las más específicas arriba (Málaga capital antes que Provincia Málaga, Provincia antes que Andalucía, Andalucía antes que Resto).');
            };
            wrap.querySelectorAll('[data-zone-idx]').forEach(row => {
                const idx = parseInt(row.getAttribute('data-zone-idx'), 10);
                row.querySelector('[data-zone-name]').oninput = function() {
                    tariff.zones[idx].name = this.value;
                };
                row.querySelector('[data-zone-ranges]').oninput = function() {
                    tariff.zones[idx].cpRanges = this.value.split(',').map(s => s.trim()).filter(s => s);
                };
                row.querySelector('[data-zone-up]').onclick = function() {
                    if (idx <= 0) return;
                    _commitZoneInputs();
                    const tmp = tariff.zones[idx - 1];
                    tariff.zones[idx - 1] = tariff.zones[idx];
                    tariff.zones[idx] = tmp;
                    renderZonesSection();
                };
                row.querySelector('[data-zone-down]').onclick = function() {
                    if (idx >= tariff.zones.length - 1) return;
                    _commitZoneInputs();
                    const tmp = tariff.zones[idx + 1];
                    tariff.zones[idx + 1] = tariff.zones[idx];
                    tariff.zones[idx] = tmp;
                    renderZonesSection();
                };
                row.querySelector('[data-zone-del]').onclick = function() {
                    if (!confirm('¿Eliminar la zona "' + (tariff.zones[idx].name || '') + '"?\n\nLos precios por zona en cada artículo asociados a esta zona se conservan en los items por si la vuelves a añadir, pero no se usarán mientras la zona no exista.')) return;
                    tariff.zones.splice(idx, 1);
                    renderZonesSection();
                    renderRows();
                };
            });
        }

        function _commitZoneInputs() {
            // Lee los inputs actuales y los persiste a tariff.zones antes de re-renderizar
            const wrap = document.getElementById('tb-zones-section');
            if (!wrap) return;
            wrap.querySelectorAll('[data-zone-idx]').forEach(row => {
                const idx = parseInt(row.getAttribute('data-zone-idx'), 10);
                if (!tariff.zones[idx]) return;
                const nameEl = row.querySelector('[data-zone-name]');
                const rangesEl = row.querySelector('[data-zone-ranges]');
                if (nameEl) tariff.zones[idx].name = nameEl.value;
                if (rangesEl) tariff.zones[idx].cpRanges = rangesEl.value.split(',').map(s => s.trim()).filter(s => s);
            });
        }

        renderZonesSection();

        function _rowHTML(it, idx) {
            const ruleSummary = it.pricingRule ? it.pricingRule.type.replace('_', ' ') : '—';
            return '<tr style="border-bottom:1px solid #2d2d30;">'
                + '<td style="padding:8px;"><strong>' + _esc(it.name) + '</strong><br><small style="color:#666; font-family:monospace;">' + _esc(it.id) + '</small></td>'
                + '<td style="padding:8px; color:#aaa; font-size:0.78rem;">' + (MODE_LABELS[it.mode] || it.mode) + '</td>'
                + '<td style="padding:8px; font-family:monospace; color:#fff;">' + _money(it.basePrice) + (it.unit ? ' / ' + _esc(it.unit) : '') + '</td>'
                + '<td style="padding:8px; font-size:0.75rem; color:#FF8A50;">' + ruleSummary + '</td>'
                + '<td style="padding:8px; text-align:right;"><button data-edit="' + idx + '" style="background:transparent; border:1px solid #5DADE2; color:#5DADE2; padding:3px 9px; border-radius:4px; cursor:pointer; font-size:0.72rem; margin-right:4px;">✏️</button><button data-del="' + idx + '" style="background:transparent; border:1px solid #f44; color:#f44; padding:3px 9px; border-radius:4px; cursor:pointer; font-size:0.72rem;">🗑️</button></td>'
                + '</tr>';
        }

        function _tableHTML(rowsHtml, headerExtra) {
            return '<table style="width:100%; border-collapse:collapse; font-size:0.85rem;">'
                + '<thead><tr style="border-bottom:1px solid #444;"><th style="text-align:left; padding:8px;">Artículo</th><th style="text-align:left;">Modo</th><th style="text-align:left;">Precio</th><th style="text-align:left;">Regla</th><th></th></tr></thead>'
                + '<tbody>' + rowsHtml + '</tbody></table>';
        }

        function renderRows() {
            const sec = document.getElementById('tb-sections');
            const addBar = document.getElementById('tb-add-bar');

            if (!tariff.items.length) {
                sec.innerHTML = '<div style="padding:24px; text-align:center; color:#666; border:1px dashed #333; border-radius:8px;">Sin artículos todavía. Añade el primero.</div>';
                addBar.innerHTML = '<button id="tb-add" style="background:#5DADE2; border:0; color:#000; padding:7px 14px; border-radius:5px; cursor:pointer; font-weight:700;">+ Añadir artículo</button>';
                _wireAdds();
                return;
            }

            // Separamos: cuotas planas (flat_monthly) vs. servicios facturables (resto)
            const flatItems = [];
            const billableItems = [];
            tariff.items.forEach((it, idx) => {
                if (it.mode === 'flat_monthly') flatItems.push({ it, idx });
                else billableItems.push({ it, idx });
            });

            let html = '';

            if (flatItems.length) {
                html += '<div style="background:rgba(76,175,80,0.04); border:1px solid rgba(76,175,80,0.25); border-radius:8px; padding:12px; margin-bottom:14px;">'
                    + '<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;"><span style="font-size:1.1rem;">📊</span><strong style="color:#4CAF50;">Cuota plana mensual</strong><span style="font-size:0.7rem; color:#aaa; background:rgba(76,175,80,0.10); padding:2px 7px; border-radius:8px;">se factura automáticamente al cerrar mes — los albaranes normales NO suman</span></div>'
                    + _tableHTML(flatItems.map(x => _rowHTML(x.it, x.idx)).join(''))
                    + '</div>';
            }

            if (billableItems.length || flatItems.length) {
                const titleExtra = flatItems.length
                    ? '<strong style="color:#FF8A50;">Servicios facturados aparte</strong><span style="font-size:0.7rem; color:#aaa; background:rgba(255,138,80,0.10); padding:2px 7px; border-radius:8px;">SE FACTURAN POR ALBARÁN además de la cuota plana (paletizados, urgentes, especiales…)</span>'
                    : '<strong style="color:#FF8A50;">Artículos facturables</strong><span style="font-size:0.7rem; color:#aaa;">se cobran según el modo configurado en cada línea de albarán</span>';
                html += '<div style="background:rgba(255,138,80,0.04); border:1px solid rgba(255,138,80,0.25); border-radius:8px; padding:12px;">'
                    + '<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;"><span style="font-size:1.1rem;">📦</span>' + titleExtra + '</div>'
                    + (billableItems.length
                        ? _tableHTML(billableItems.map(x => _rowHTML(x.it, x.idx)).join(''))
                        : '<div style="padding:12px; text-align:center; color:#888; font-size:0.82rem;">Sin servicios extras todavía. Pulsa «+ Añadir servicio extra» abajo si el cliente tiene paletizados, urgentes u otros servicios que NO entran en la cuota plana.</div>')
                    + '</div>';
            }

            sec.innerHTML = html;

            // Botones de añadir según contexto
            if (flatItems.length) {
                addBar.innerHTML = ''
                    + '<button id="tb-add-extra" style="background:#FF8A50; border:0; color:#fff; padding:8px 16px; border-radius:5px; cursor:pointer; font-weight:700;">+ Añadir servicio extra (fuera de la cuota plana)</button>'
                    + '<button id="tb-add" style="background:#5DADE2; border:0; color:#000; padding:8px 14px; border-radius:5px; cursor:pointer; font-weight:700;">+ Añadir cuota o artículo libre</button>';
            } else {
                addBar.innerHTML = '<button id="tb-add" style="background:#5DADE2; border:0; color:#000; padding:7px 14px; border-radius:5px; cursor:pointer; font-weight:700;">+ Añadir artículo</button>';
            }

            // Wire row buttons — pasamos las zonas de la tarifa al editor del item
            sec.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
                const i = parseInt(b.getAttribute('data-edit'), 10);
                openItemEditor(tariff.items[i], (updated) => { tariff.items[i] = updated; renderRows(); }, tariff.zones || []);
            });
            sec.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
                const i = parseInt(b.getAttribute('data-del'), 10);
                if (confirm('¿Eliminar "' + tariff.items[i].name + '"?')) { tariff.items.splice(i, 1); renderRows(); }
            });

            _wireAdds();
        }

        function _wireAdds() {
            const addBtn = document.getElementById('tb-add');
            if (addBtn) addBtn.onclick = () => openItemEditor(null, (it) => { tariff.items.push(it); renderRows(); }, tariff.zones || []);
            const addExtra = document.getElementById('tb-add-extra');
            if (addExtra) addExtra.onclick = () => {
                openItemEditor({
                    id: 'extra_' + Date.now().toString(36),
                    name: '',
                    mode: 'per_package',
                    basePrice: 35.00,
                    unit: 'palet',
                    pricingRule: null
                }, (it) => {
                    if (it.mode === 'flat_monthly') {
                        if (!confirm('Has marcado este artículo como cuota plana mensual, no como servicio extra facturable. ¿Guardar igualmente?')) return;
                    }
                    tariff.items.push(it);
                    renderRows();
                }, tariff.zones || []);
            };
        }

        renderRows();
        document.getElementById('tb-close').onclick = () => modal.remove();

        // ─── BOTÓN IMPORTAR CATÁLOGO BASE ─────────────────────────
        const importBtn = document.getElementById('tb-import-base');
        if (importBtn) importBtn.onclick = async () => {
            try {
                importBtn.disabled = true;
                importBtn.textContent = 'Cargando…';
                const resp = await fetch('/novapack_articles_base.json?v=' + Date.now());
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const catalog = await resp.json();
                const articles = (catalog && catalog.articles) || [];
                if (!articles.length) throw new Error('Catálogo vacío');

                const existingIds = new Set((tariff.items || []).map(it => it.id));
                const newItems = [];
                const skippedItems = [];
                articles.forEach(a => {
                    if (existingIds.has(a.code)) {
                        skippedItems.push(a.code);
                        return;
                    }
                    const newIt = {
                        id: a.code,
                        name: a.name,
                        mode: a.mode,
                        basePrice: Number(a.basePrice) || 0,
                        unit: a.unit || '',
                        category: a.category || '',
                        conditions: a.conditions || null,
                        pricingRule: null,
                        pricesByZone: {}
                    };
                    // ─── Heurística: si el código es PP o PI, BP o BI → activar
                    // auto-detección provincial/interprovincial y mapear precios.
                    // PP=Paquete Provincial, PI=Paquete Interprovincial. Mismo
                    // par para BP/BI. El admin podrá editarlo después.
                    if (a.code === 'PP' || a.code === 'BP') {
                        newIt.provincialDetect = true;
                        newIt.pricesByProvince = { provincial: Number(a.basePrice) || 0 };
                    } else if (a.code === 'PI' || a.code === 'BI') {
                        newIt.provincialDetect = true;
                        newIt.pricesByProvince = { interprovincial: Number(a.basePrice) || 0 };
                    }
                    newItems.push(newIt);
                });

                if (newItems.length === 0) {
                    alert('Esta tarifa ya tiene los 18 códigos base (' + skippedItems.join(', ') + ').');
                    return;
                }

                let msg = 'Se van a AÑADIR ' + newItems.length + ' artículo(s) del catálogo base a esta tarifa:\n\n';
                msg += newItems.map(it => '  ' + it.id + ' — ' + it.name + ' — ' + (it.basePrice || 0) + ' €').join('\n');
                if (skippedItems.length) msg += '\n\nYa existían (no se duplican): ' + skippedItems.join(', ');
                msg += '\n\nDespués podrás editar precios, eliminar o añadir más libremente. ¿Continuar?';
                if (!confirm(msg)) return;

                tariff.items = (tariff.items || []).concat(newItems);
                renderRows();
                alert('✅ Añadidos ' + newItems.length + ' artículos. Recuerda pulsar 💾 Guardar tarifa para persistir.');
            } catch(e) {
                console.error('[import base]', e);
                alert('Error importando catálogo: ' + e.message);
            } finally {
                importBtn.disabled = false;
                importBtn.textContent = '📥 Importar catálogo base (19 artículos)';
            }
        };

        document.getElementById('tb-save').onclick = async () => {
            tariff.name = document.getElementById('tb-tariff-name').value.trim();
            if (!tariff.name) { alert('La tarifa necesita un nombre.'); return; }
            if (!tariff.items.length) { if (!confirm('No tiene artículos. ¿Guardar de todos modos?')) return; }
            // Persistir cualquier edición pendiente de zonas (los inputs son live)
            try { _commitZoneInputs(); } catch(_) {}
            // Validar zonas si las hay: nombre + al menos un rango
            if (tariff.zones && tariff.zones.length) {
                for (const z of tariff.zones) {
                    if (!z.name || !z.name.trim()) { alert('Una de las zonas no tiene nombre.'); return; }
                    if (!z.cpRanges || !z.cpRanges.length) { alert('La zona "' + z.name + '" no tiene rangos de CP definidos.'); return; }
                }
            }
            try {
                const id = await _saveTariff(tariff);

                // ─── Si se creó/editó desde el gestor de un cliente, asignársela ──
                let assignedMsg = '';
                if (assignToClientId) {
                    try {
                        await db.collection('users').doc(assignToClientId).update({
                            tariffId: id,
                            tariffUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
                        });
                        if (window.userMap && window.userMap[assignToClientId]) {
                            window.userMap[assignToClientId].tariffId = id;
                        }
                        assignedMsg = '\n\n👉 Asignada automáticamente al cliente.';
                    } catch(e) {
                        console.warn('[tariff] no pude auto-asignar al cliente:', e.message);
                        assignedMsg = '\n\n⚠️ No se pudo auto-asignar al cliente: ' + e.message;
                    }
                }

                alert('✅ Tarifa guardada: ' + id + assignedMsg);
                modal.remove();

                // ─── SINCRONIZACIÓN GLOBAL ───────────────────────────
                // Refrescar TODO lo que muestre tarifas para que el cambio
                // se vea sin tener que recargar la página.
                if (typeof window.renderTariffCards === 'function') {
                    try { window.renderTariffCards(); } catch(_) {}
                }
                if (typeof populateGlobalTariffsDatalist === 'function') {
                    try { populateGlobalTariffsDatalist(); } catch(_) {}
                }
                // Si hay una ficha de cliente abierta: recargar su desplegable
                // de tarifas y refrescar el bloque de cuota mensual.
                if (typeof window._fichaReloadTariffs === 'function') {
                    try { window._fichaReloadTariffs(); } catch(_) {}
                }
                if (typeof window._fichaWireFlatRateBlock === 'function') {
                    try { window._fichaWireFlatRateBlock(); } catch(_) {}
                }
            } catch(e) { alert('Error: ' + e.message); }
        };

        // ─── Botón Eliminar (solo aparece si la tarifa ya está guardada) ───
        const delBtn = document.getElementById('tb-delete');
        if (delBtn) {
            delBtn.onclick = async () => {
                if (!tariff.id) { alert('Esta tarifa todavía no está guardada — pulsa Cerrar para descartar.'); return; }
                // Contar cuántos clientes la tienen asignada
                let usingCount = 0;
                let usingList = [];
                try {
                    if (window.userMap) {
                        Object.values(window.userMap).forEach(u => {
                            if (u.tariffId && (u.tariffId === tariff.id || ('GLOBAL_' + u.tariffId) === tariff.id)) {
                                usingCount++;
                                if (usingList.length < 5) usingList.push((u.name || ('#' + (u.idNum || u.id))));
                            }
                        });
                    }
                } catch(_) {}

                let msg = '¿Eliminar la tarifa "' + (tariff.name || tariff.id) + '"?\n\n';
                msg += 'ID: ' + tariff.id + '\n\n';
                if (usingCount > 0) {
                    msg += '⚠️ ATENCIÓN: ' + usingCount + ' cliente' + (usingCount === 1 ? '' : 's') + ' tiene' + (usingCount === 1 ? '' : 'n') + ' esta tarifa asignada:\n';
                    msg += '  ' + usingList.join('\n  ');
                    if (usingCount > usingList.length) msg += '\n  ... y ' + (usingCount - usingList.length) + ' más';
                    msg += '\n\nTras eliminar quedarán SIN tarifa asignada y los nuevos albaranes facturarán a 0 € hasta que les asignes otra.\n\n';
                }
                msg += 'Esta acción NO se puede deshacer. ¿Continuar?';

                if (!confirm(msg)) return;

                // Segunda confirmación si hay clientes usándola
                if (usingCount > 0) {
                    const confirmText = prompt('Para confirmar, escribe exactamente: ELIMINAR');
                    if (confirmText !== 'ELIMINAR') {
                        alert('Cancelado — la palabra de confirmación no coincide.');
                        return;
                    }
                }

                try {
                    await db.collection('tariffs').doc(tariff.id).delete();
                    alert('✅ Tarifa eliminada: ' + tariff.id);
                    modal.remove();
                    if (typeof window.renderTariffCards === 'function') window.renderTariffCards();
                } catch(e) {
                    alert('Error al eliminar: ' + e.message);
                }
            };
        }
    };

    // ============ TARIFA MANAGER (vista cliente) ============

    window.openTariffManager = async function openTariffManager(clientId) {
        const client = (window.userMap && window.userMap[clientId])
                    || (window._advClientsCache && window._advClientsCache.find(c => c.id === clientId))
                    || null;
        if (!client) { alert('Cliente no encontrado.'); return; }
        const tariffs = await _listV2Tariffs();
        let baseTariff = null;
        if (client.tariffId) baseTariff = tariffs.find(t => t.id === client.tariffId) || await _loadTariff(client.tariffId);
        const overrides = { ...(client.tariffOverrides || {}) };

        // Modal overlay simple (revertido del experimento ERP)
        const existing = document.getElementById('tariff-mgr-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'tariff-mgr-modal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:100000; display:flex; flex-direction:column; padding:18px; overflow-y:auto;';
        document.body.appendChild(modal);

        modal.innerHTML = ''
            + '<div style="max-width:1000px; width:100%; margin:0 auto; background:#1e1e1e; border-radius:12px; padding:22px; color:#d4d4d4;">'
            + '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px; gap:12px; flex-wrap:wrap;">'
            + '  <div><h2 style="margin:0; color:#FF6600;">🧮 Tarifa & Precios — ' + _esc(client.name || clientId) + '</h2><div style="font-size:0.8rem; color:#aaa; margin-top:3px;">Asigna una tarifa base global y personaliza precios o reglas por artículo.</div></div>'
            + '  <div style="display:flex; gap:6px; flex-wrap:wrap;"><button id="tm-save" style="background:#FF6600; border:0; color:#fff; padding:8px 16px; border-radius:5px; font-weight:700; cursor:pointer;">💾 Guardar</button><button id="tm-close" style="background:#333; border:1px solid #555; color:#fff; padding:8px 16px; border-radius:5px; cursor:pointer;">Cerrar</button></div>'
            + '</div>'

            // Selector tarifa base
            + '<div style="background:#0a0a0a; border:1px solid #444; border-radius:8px; padding:12px; margin-bottom:14px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">'
            + '  <label style="font-size:0.8rem; color:#aaa;">Tarifa base:</label>'
            + '  <select id="tm-base" style="flex:1; min-width:200px; padding:7px; background:#1a1a1a; border:1px solid #444; color:#fff; border-radius:4px;">'
            + '    <option value="">— Sin tarifa asignada —</option>'
            + tariffs.map(t => '<option value="' + t.id + '"' + (t.id === client.tariffId ? ' selected' : '') + '>' + _esc(t.name || t.id) + ' (' + (t.items || []).length + ' artículos)</option>').join('')
            + '  </select>'
            + '  <button id="tm-new" style="background:#5DADE2; border:0; color:#000; padding:7px 12px; border-radius:4px; cursor:pointer; font-weight:700; font-size:0.78rem;">+ Crear nueva</button>'
            + '  <button id="tm-edit-base" style="background:transparent; border:1px solid #FF8A50; color:#FF8A50; padding:7px 12px; border-radius:4px; cursor:pointer; font-size:0.78rem;">✏️ Editar base</button>'
            + '</div>'

            // Items table
            + '<div id="tm-items-wrap"></div>'

            // Live calc
            + '<details style="margin-top:18px; background:rgba(76,175,80,0.04); border:1px solid rgba(76,175,80,0.25); border-radius:8px; padding:10px 14px;">'
            + '  <summary style="cursor:pointer; font-weight:600; color:#4CAF50;">🧪 Probar cálculo con un albarán de ejemplo</summary>'
            + '  <div style="margin-top:10px; font-size:0.78rem;">Pega un JSON con packagesList tipo <code>[{"qty":4,"size":"Batería 75AH"}]</code>:</div>'
            + '  <textarea id="tm-test-json" rows="4" style="width:100%; margin-top:6px; padding:6px; background:#0a0a0a; border:1px solid #444; color:#fff; font-family:monospace; font-size:0.75rem; border-radius:4px;">[{"qty":4,"size":"Batería 75AH","weight":25}]</textarea>'
            + '  <button id="tm-test-run" style="margin-top:6px; background:#4CAF50; border:0; color:#000; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:700; font-size:0.75rem;">Calcular</button>'
            + '  <pre id="tm-test-out" style="margin-top:8px; background:#0a0a0a; padding:10px; border-radius:4px; font-size:0.72rem; color:#4CAF50; max-height:200px; overflow:auto;"></pre>'
            + '</details>'

            + '</div>';
        document.body.appendChild(modal);

        function renderItems() {
            const wrap = document.getElementById('tm-items-wrap');
            if (!baseTariff || !baseTariff.items || !baseTariff.items.length) {
                wrap.innerHTML = '<div style="background:rgba(255,159,10,0.06); border:1px solid rgba(255,159,10,0.25); border-radius:6px; padding:14px; color:#FF9F0A; text-align:center;">Esta tarifa base no tiene artículos. Edítala o crea una nueva.</div>';
                return;
            }
            const resolved = pricingEngine.resolveTariff(baseTariff, overrides);
            const customs = Object.keys(overrides).filter(k => !baseTariff.items.find(i => i.id === k) && overrides[k] && overrides[k].name);
            let rows = baseTariff.items.map(it => {
                const ov = overrides[it.id];
                const isExcluded = ov === null;
                const isOverridden = ov && ov !== null;
                const merged = isExcluded ? null : (isOverridden ? { ...it, ...ov } : it);
                const stateChip = isExcluded
                    ? '<span style="background:rgba(255,59,48,0.15); color:#FF3B30; padding:2px 7px; border-radius:8px; font-size:0.65rem;">EXCLUIDO</span>'
                    : isOverridden
                        ? '<span style="background:rgba(255,179,0,0.15); color:#FFB300; padding:2px 7px; border-radius:8px; font-size:0.65rem;">PERSONALIZADO</span>'
                        : '<span style="background:rgba(120,120,120,0.15); color:#aaa; padding:2px 7px; border-radius:8px; font-size:0.65rem;">HEREDADO</span>';
                return '<tr data-item-id="' + _esc(it.id) + '" style="border-bottom:1px solid #2d2d30;' + (isExcluded ? ' opacity:0.5;' : '') + '">'
                    + '<td style="padding:8px; vertical-align:top;"><input type="checkbox" data-toggle ' + (isExcluded ? '' : 'checked') + ' style="scale:1.3;"></td>'
                    + '<td style="padding:8px;"><strong>' + _esc(merged ? merged.name : it.name) + '</strong> ' + stateChip + '<br><small style="color:#666; font-family:monospace;">' + _esc(it.id) + '</small></td>'
                    + '<td style="padding:8px; font-size:0.78rem; color:#aaa;">' + (MODE_LABELS[(merged && merged.mode) || it.mode] || '') + '</td>'
                    + '<td style="padding:8px;">'
                    + '  <input type="number" data-price step="0.01" min="0" value="' + ((merged ? merged.basePrice : it.basePrice) || 0) + '" style="width:90px; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px; font-family:monospace; ' + (isExcluded ? 'pointer-events:none;' : '') + '">'
                    + '</td>'
                    + '<td style="padding:8px; font-size:0.72rem; color:#FF8A50;">' + ((merged && merged.pricingRule) ? merged.pricingRule.type : (it.pricingRule ? it.pricingRule.type : '—')) + '</td>'
                    + '<td style="padding:8px; text-align:right;">'
                    + '  <button data-edit-rule style="background:transparent; border:1px solid #FF8A50; color:#FF8A50; padding:3px 9px; border-radius:4px; cursor:pointer; font-size:0.7rem;">Regla</button>'
                    + '  <button data-reset style="background:transparent; border:1px solid #888; color:#888; padding:3px 9px; border-radius:4px; cursor:pointer; font-size:0.7rem; margin-left:3px;" title="Volver al precio base">↺</button>'
                    + '</td>'
                    + '</tr>';
            }).join('');
            // Custom items del cliente
            customs.forEach(k => {
                const it = overrides[k];
                rows += '<tr data-item-id="' + _esc(k) + '" data-custom="1" style="border-bottom:1px solid #2d2d30; background:rgba(93,173,226,0.04);">'
                    + '<td style="padding:8px;"><input type="checkbox" checked disabled style="scale:1.3;"></td>'
                    + '<td style="padding:8px;"><strong>' + _esc(it.name) + '</strong> <span style="background:rgba(93,173,226,0.20); color:#5DADE2; padding:2px 7px; border-radius:8px; font-size:0.65rem;">CUSTOM CLIENTE</span><br><small style="color:#666; font-family:monospace;">' + _esc(k) + '</small></td>'
                    + '<td style="padding:8px; font-size:0.78rem; color:#aaa;">' + (MODE_LABELS[it.mode] || it.mode) + '</td>'
                    + '<td style="padding:8px;"><input type="number" data-price step="0.01" min="0" value="' + (it.basePrice || 0) + '" style="width:90px; padding:5px; background:#0a0a0a; border:1px solid #444; color:#fff; border-radius:3px; font-family:monospace;"></td>'
                    + '<td style="padding:8px; font-size:0.72rem; color:#FF8A50;">' + (it.pricingRule ? it.pricingRule.type : '—') + '</td>'
                    + '<td style="padding:8px; text-align:right;"><button data-edit-rule style="background:transparent; border:1px solid #FF8A50; color:#FF8A50; padding:3px 9px; border-radius:4px; cursor:pointer; font-size:0.7rem;">Regla</button><button data-del-custom style="background:transparent; border:1px solid #f44; color:#f44; padding:3px 9px; border-radius:4px; cursor:pointer; font-size:0.7rem; margin-left:3px;">🗑️</button></td>'
                    + '</tr>';
            });
            wrap.innerHTML = '<table style="width:100%; border-collapse:collapse; font-size:0.85rem;"><thead><tr style="border-bottom:1px solid #444;"><th style="padding:8px; text-align:left; width:50px;">Activo</th><th style="text-align:left;">Artículo</th><th style="text-align:left;">Modo</th><th style="text-align:left; width:110px;">Precio (cliente)</th><th style="text-align:left;">Regla</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
                + '<button id="tm-add-custom" title="Añade un precio personalizado SOLO para este cliente. No crea tarifa global — solo override en su ficha." style="margin-top:12px; background:#5DADE2; border:0; color:#000; padding:7px 14px; border-radius:5px; cursor:pointer; font-weight:700;">+ Precio personalizado (solo este cliente)</button>'
                + '<div style="margin-top:6px; font-size:0.7rem; color:#888;">ℹ️ Este botón añade un override en la ficha del cliente — no crea una tarifa nueva en globales. Si quieres crear una tarifa reusable usa <strong>+ Crear nueva</strong> de arriba.</div>';

            // Wire events
            wrap.querySelectorAll('tr[data-item-id]').forEach(row => {
                const id = row.getAttribute('data-item-id');
                const isCustom = row.getAttribute('data-custom') === '1';
                row.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('change', function() {
                    if (this.checked) { delete overrides[id]; } else { overrides[id] = null; }
                    renderItems();
                }));
                row.querySelectorAll('[data-price]').forEach(inp => inp.addEventListener('change', function() {
                    const v = parseFloat(this.value) || 0;
                    if (isCustom) overrides[id].basePrice = v;
                    else {
                        const orig = baseTariff.items.find(i => i.id === id);
                        if (orig && v === orig.basePrice) {
                            // mismo precio → quitar override de precio
                            if (overrides[id]) {
                                delete overrides[id].basePrice;
                                if (Object.keys(overrides[id]).length === 0) delete overrides[id];
                            }
                        } else {
                            overrides[id] = overrides[id] || {};
                            overrides[id].basePrice = v;
                        }
                    }
                    renderItems();
                }));
                row.querySelectorAll('[data-edit-rule]').forEach(b => b.addEventListener('click', function() {
                    const current = isCustom ? overrides[id] : { ...baseTariff.items.find(i => i.id === id), ...(overrides[id] || {}) };
                    openItemEditor(current, (updated) => {
                        if (isCustom) {
                            overrides[id] = updated;
                        } else {
                            const baseIt = baseTariff.items.find(i => i.id === id);
                            const diff = {};
                            ['name','mode','basePrice','unit'].forEach(k => { if (updated[k] !== baseIt[k]) diff[k] = updated[k]; });
                            const ruleJson = JSON.stringify(updated.pricingRule || null);
                            const baseRuleJson = JSON.stringify(baseIt.pricingRule || null);
                            if (ruleJson !== baseRuleJson) diff.pricingRule = updated.pricingRule;
                            if (Object.keys(diff).length === 0) delete overrides[id];
                            else overrides[id] = diff;
                        }
                        renderItems();
                    });
                }));
                row.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', function() {
                    delete overrides[id];
                    renderItems();
                }));
                row.querySelectorAll('[data-del-custom]').forEach(b => b.addEventListener('click', function() {
                    if (confirm('¿Borrar artículo custom?')) { delete overrides[id]; renderItems(); }
                }));
            });

            document.getElementById('tm-add-custom').onclick = () => {
                openItemEditor(null, (it) => { overrides[it.id] = it; renderItems(); });
            };
        }
        renderItems();

        // Cambiar base
        document.getElementById('tm-base').addEventListener('change', async function() {
            const v = this.value;
            if (!v) { baseTariff = null; renderItems(); return; }
            baseTariff = tariffs.find(t => t.id === v) || await _loadTariff(v);
            renderItems();
        });
        // "+ Crear nueva": abre el constructor y, al guardar, asigna
        // automáticamente la tarifa nueva a ESTE cliente.
        document.getElementById('tm-new').onclick = () => { modal.remove(); window.openTariffBuilder(null, clientId); };
        document.getElementById('tm-edit-base').onclick = () => {
            if (!baseTariff) { alert('Primero selecciona una tarifa base.'); return; }
            modal.remove();
            // Editar la base — también la mantenemos asignada a este cliente.
            window.openTariffBuilder(baseTariff.id, clientId);
        };
        document.getElementById('tm-close').onclick = () => modal.remove();
        document.getElementById('tm-save').onclick = async () => {
            const selBase = document.getElementById('tm-base').value;
            try {
                await _saveClientOverrides(clientId, selBase, overrides);
                alert('✅ Tarifa del cliente guardada.');
                modal.remove();
            } catch(e) { alert('Error: ' + e.message); }
        };

        // Cálculo de prueba
        document.getElementById('tm-test-run').onclick = () => {
            const out = document.getElementById('tm-test-out');
            try {
                const pkg = JSON.parse(document.getElementById('tm-test-json').value);
                const resolved = pricingEngine.resolveTariff(baseTariff || { items: [] }, overrides);
                const r = pricingEngine.priceTicket(pkg, resolved);
                out.textContent = JSON.stringify(r, null, 2);
            } catch(e) {
                out.textContent = 'Error: ' + e.message;
            }
        };
    };
})();
