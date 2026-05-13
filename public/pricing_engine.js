/**
 * NOVAPACK CLOUD — Motor de cálculo de precios v1.0  (Fase 1)
 *
 * Módulo PURO, sin dependencias de Firestore. Toma datos en memoria y
 * devuelve un cálculo trazable. Diseñado para sustituir gradualmente al
 * sistema de tarifas legacy (`tariffs/{id}.items` como mapa nombre→precio).
 *
 * ═══════════════════════════════════════════════════════════════════
 *   MODELO DE DATOS — TARIFA NUEVA
 * ═══════════════════════════════════════════════════════════════════
 *
 *   Tarifa base (compartida):
 *   ─────────────────────────
 *     {
 *       id: 'GLOBAL_BASE_2026',
 *       name: 'Tarifa base 2026',
 *       version: 1,
 *       items: [Item, Item, ...]
 *     }
 *
 *   Item:
 *   ─────
 *     {
 *       id: 'pkg_small',                  // identificador estable
 *       name: 'Paquete pequeño',          // visible al cliente
 *       mode: 'per_package'               // ver MODES abajo
 *           | 'per_kg'
 *           | 'per_expedition'
 *           | 'per_expedition_unit'
 *           | 'flat_monthly',
 *       basePrice: 4.50,                  // EUR (referencia base)
 *       unit: 'paquete',                  // texto opcional para la factura
 *       conditions: { minKg, maxKg },     // opcional, no afecta cálculo
 *       pricingRule: null | RuleObject
 *     }
 *
 *   PricingRule (todos opcionales y combinables NO — uno solo por item):
 *   ──────────────────────────────────────────────────────────────────
 *     { type: 'bulk_discount', every: 4, charge: 3 }
 *         → cada N qty, se cobra M.
 *
 *     { type: 'tiered', tiers: [
 *           { minQty: 1, price: 50.00 },
 *           { minQty: 10, price: 37.50 }
 *       ]}
 *         → precio cambia según volumen del albarán
 *           (la tier máxima cuyo minQty <= qty gana).
 *
 *     { type: 'min_charge', amount: 15.00 }
 *         → si la línea sale por debajo de X €, se sube a X €.
 *
 *     { type: 'surcharge_over', threshold: 30, kind: 'flat' | 'per_unit',
 *       amount: 5.00, basis: 'qty' | 'kg' }
 *         → recargo si qty/kg supera umbral. flat = +X € fijo,
 *           per_unit = +X € por unidad excedida.
 *
 *   Override por cliente:
 *   ─────────────────────
 *     users/{uid}.tariffId        = 'GLOBAL_BASE_2026'
 *     users/{uid}.tariffOverrides = {
 *         'pkg_small': { basePrice: 3.50 },                  // override precio
 *         'bat_75ah':  { basePrice: 50, pricingRule: {       // promo cliente
 *             type:'bulk_discount', every:4, charge:3
 *         }},
 *         'pkg_urgent': null    // excluido para este cliente
 *     }
 *
 *     Items que están en la base pero no en overrides → se aplican tal cual.
 *     Items con value=null en overrides → se ocultan al cliente.
 *     Items con override parcial → se hace deep-merge con el de la base.
 *
 * ═══════════════════════════════════════════════════════════════════
 *   API PÚBLICA
 * ═══════════════════════════════════════════════════════════════════
 *
 *   pricingEngine.resolveTariff(baseTariff, overrides) → ResolvedTariff
 *       Mezcla base + overrides. Devuelve nueva tarifa lista para calcular.
 *
 *   pricingEngine.priceLine(itemRef, qty, weightKg, context) → LineResult
 *       Calcula UNA línea (una entrada de packagesList).
 *
 *   pricingEngine.priceTicket(packagesList, resolvedTariff, context) → TicketResult
 *       Recorre packagesList y devuelve breakdown completo + total.
 *
 *   pricingEngine.runSelfTests() → array de resultados PASS/FAIL
 *       Tests integrados, ejecutar desde consola.
 */
(function() {
    'use strict';

    const MODES = ['per_package', 'per_kg', 'per_expedition', 'per_expedition_unit', 'flat_monthly'];
    const RULE_TYPES = ['bulk_discount', 'tiered', 'min_charge', 'surcharge_over'];

    function _round(n) { return Math.round(n * 100) / 100; }
    function _num(n) { const x = Number(n); return isNaN(x) ? 0 : x; }

    // ===== Resolución de zona por CP =====
    // Cada tarifa puede definir zonas:
    //   zones: [
    //     { id:'z1', name:'Málaga capital', cpRanges:['29001-29099'] },
    //     { id:'z2', name:'Provincia Málaga', cpRanges:['29'] },
    //     { id:'z3', name:'Resto Andalucía', cpRanges:['11','14','18','21','23','41'] },
    //     { id:'z4', name:'Resto España', cpRanges:['*'] }
    //   ]
    // El admin define el ORDEN — primera zona cuyo rango matchea gana.
    // Soporta:
    //   - "29001-29099"  → rango numérico
    //   - "29"           → prefijo (cualquier CP empezando por 29)
    //   - "*"            → catch-all (todo lo demás)
    function resolveZone(cp, zones) {
        if (!cp || !Array.isArray(zones) || !zones.length) return null;
        const cpStr = String(cp).trim().replace(/\s/g, '');
        if (!cpStr) return null;
        for (const z of zones) {
            const ranges = z.cpRanges || z.cpPrefixes || [];
            for (const r of ranges) {
                const rStr = String(r).trim();
                if (!rStr) continue;
                if (rStr === '*' || rStr.toLowerCase() === 'resto' || rStr.toLowerCase() === 'cualquier') return z;
                if (rStr.includes('-')) {
                    const parts = rStr.split('-').map(s => s.trim());
                    if (parts.length === 2 && parts[0] && parts[1]) {
                        if (cpStr >= parts[0] && cpStr <= parts[1]) return z;
                    }
                    continue;
                }
                if (cpStr.startsWith(rStr)) return z;
            }
        }
        return null;
    }

    // Comparación de provincia por CP (2 primeros dígitos en España)
    function _samProvince(cpA, cpB) {
        if (!cpA || !cpB) return false;
        const a = String(cpA).trim().replace(/\s/g, '').slice(0, 2);
        const b = String(cpB).trim().replace(/\s/g, '').slice(0, 2);
        if (!a || !b) return false;
        return a === b;
    }

    // Calcula el precio efectivo de un item para un context dado (CP, etc.)
    // Prioridad:
    //   1. pricesByProvince (si item.provincialDetect=true y hay originCp+destCp)
    //   2. pricesByZone (si hay zona resuelta)
    //   3. basePrice (fallback)
    function _itemPriceForContext(item, context) {
        let price = _num(item.basePrice);
        // Auto-detección provincial / interprovincial
        if (item.provincialDetect && item.pricesByProvince && context && context.cp && context.originCp) {
            const sameProv = _samProvince(context.originCp, context.cp);
            const key = sameProv ? 'provincial' : 'interprovincial';
            const v = item.pricesByProvince[key];
            if (v !== undefined && v !== null && v !== '') {
                return _num(v);
            }
        }
        // Zonas CP (sistema anterior, se queda como alternativa)
        if (item.pricesByZone && context && context._resolvedZone) {
            const zp = item.pricesByZone[context._resolvedZone.id];
            if (zp !== undefined && zp !== null && zp !== '') {
                price = _num(zp);
            }
        }
        return price;
    }

    // ===== Resolver: base + overrides =====
    function resolveTariff(baseTariff, overrides) {
        if (!baseTariff || !Array.isArray(baseTariff.items)) {
            return { id: 'EMPTY', name: 'Tarifa vacía', items: [], zones: [] };
        }
        const ov = overrides || {};
        const items = [];
        baseTariff.items.forEach(it => {
            const o = ov[it.id];
            if (o === null) return; // excluido para este cliente
            if (!o) { items.push({ ...it, _source: 'base' }); return; }
            // Para pricesByZone hacemos merge: override puede añadir/sobrescribir
            // precios por zona específicos sin perder los de la base.
            let mergedPricesByZone = it.pricesByZone ? { ...it.pricesByZone } : undefined;
            if (o.pricesByZone) {
                mergedPricesByZone = { ...(mergedPricesByZone || {}), ...o.pricesByZone };
            }
            items.push({
                ...it,
                ...o,
                pricingRule: (o.pricingRule !== undefined) ? o.pricingRule : it.pricingRule,
                pricesByZone: mergedPricesByZone,
                _source: 'override',
                _baseRef: it.id
            });
        });
        // Items que existen SOLO en overrides (custom de cliente)
        Object.keys(ov).forEach(k => {
            if (!baseTariff.items.find(b => b.id === k) && ov[k] && ov[k].name) {
                items.push({ ...ov[k], id: k, _source: 'custom' });
            }
        });
        return {
            id: baseTariff.id + '_resolved',
            baseId: baseTariff.id,
            name: baseTariff.name + ' (resuelta)',
            items: items,
            zones: baseTariff.zones || []
        };
    }

    // ===== Cálculo base por modo =====
    // basePrice ya viene resuelto con la zona aplicada si procede
    // (ver _itemPriceForContext).
    function _modeBaseSubtotal(mode, basePrice, qty, weightKg) {
        switch (mode) {
            case 'per_package':           return _num(basePrice) * _num(qty);
            case 'per_kg':                return _num(basePrice) * _num(weightKg);
            case 'per_expedition':        return _num(basePrice);              // 1 sola vez por línea
            case 'per_expedition_unit':   return _num(basePrice) * _num(qty);  // multiplica por bultos
            case 'flat_monthly':          return 0;                            // no factura per-ticket
            default:                      return _num(basePrice) * _num(qty);
        }
    }

    // ===== Aplicador de reglas =====
    function _applyPricingRule(rule, baseSubtotal, basePrice, qty, weightKg, mode) {
        if (!rule || !rule.type) return { subtotal: baseSubtotal, applied: null };

        if (rule.type === 'bulk_discount') {
            // Solo tiene sentido en modos que dependen de qty
            const everyN = Math.max(1, parseInt(rule.every, 10));
            const chargeN = Math.max(0, parseInt(rule.charge, 10));
            const chargeable = Math.floor(qty / everyN) * chargeN + (qty % everyN);
            const subtotal = chargeable * _num(basePrice);
            return {
                subtotal: subtotal,
                applied: {
                    type: 'bulk_discount',
                    every: everyN, charge: chargeN,
                    rawQty: qty, billableQty: chargeable,
                    savings: _round((qty - chargeable) * _num(basePrice))
                }
            };
        }

        if (rule.type === 'tiered') {
            const tiers = (rule.tiers || []).slice().sort((a, b) => _num(a.minQty) - _num(b.minQty));
            let tierPrice = _num(basePrice);
            let appliedTier = null;
            for (let i = tiers.length - 1; i >= 0; i--) {
                if (qty >= _num(tiers[i].minQty)) {
                    tierPrice = _num(tiers[i].price);
                    appliedTier = tiers[i];
                    break;
                }
            }
            const subtotal = tierPrice * _num(qty);
            return {
                subtotal: subtotal,
                applied: {
                    type: 'tiered',
                    chosenTier: appliedTier,
                    effectivePrice: tierPrice
                }
            };
        }

        if (rule.type === 'min_charge') {
            const min = _num(rule.amount);
            if (baseSubtotal < min) {
                return {
                    subtotal: min,
                    applied: { type: 'min_charge', minimum: min, originalSubtotal: _round(baseSubtotal) }
                };
            }
            return { subtotal: baseSubtotal, applied: null };
        }

        if (rule.type === 'surcharge_over') {
            const threshold = _num(rule.threshold);
            const basis = rule.basis === 'kg' ? _num(weightKg) : _num(qty);
            if (basis <= threshold) return { subtotal: baseSubtotal, applied: null };
            const excess = basis - threshold;
            const amount = _num(rule.amount);
            const extra = rule.kind === 'per_unit' ? excess * amount : amount;
            return {
                subtotal: baseSubtotal + extra,
                applied: { type: 'surcharge_over', excess: excess, kind: rule.kind, extra: _round(extra) }
            };
        }

        return { subtotal: baseSubtotal, applied: null };
    }

    // ===== priceLine =====
    function priceLine(itemRef, qty, weightKg, context) {
        context = context || {};
        if (!itemRef) {
            return { error: 'item_missing', subtotal: 0, qty: qty, weightKg: weightKg };
        }
        if (MODES.indexOf(itemRef.mode) === -1) {
            return { error: 'invalid_mode:' + itemRef.mode, subtotal: 0 };
        }
        // Precio efectivo: provincialDetect > zona > basePrice.
        const effectivePrice = _itemPriceForContext(itemRef, context);
        // Detectar si fue por provincia para mostrar info en el resultado
        let provincialApplied = null;
        if (itemRef.provincialDetect && context && context.cp && context.originCp) {
            const sameProv = _samProvince(context.originCp, context.cp);
            provincialApplied = sameProv ? 'provincial' : 'interprovincial';
        }
        const baseSubtotal = _modeBaseSubtotal(itemRef.mode, effectivePrice, qty, weightKg);
        const ruleResult = _applyPricingRule(itemRef.pricingRule, baseSubtotal, effectivePrice, qty, weightKg, itemRef.mode);
        return {
            itemId: itemRef.id,
            itemName: itemRef.name,
            mode: itemRef.mode,
            qty: _num(qty),
            weightKg: _num(weightKg),
            basePrice: _num(itemRef.basePrice),
            effectivePrice: _num(effectivePrice),
            zoneApplied: (context && context._resolvedZone) ? { id: context._resolvedZone.id, name: context._resolvedZone.name } : null,
            provincialApplied: provincialApplied,
            baseSubtotal: _round(baseSubtotal),
            ruleApplied: ruleResult.applied,
            subtotal: _round(ruleResult.subtotal)
        };
    }

    // ===== priceTicket =====
    // packagesList = [{ qty, size, weight }, ...]
    // context puede traer { cp: '29100' } para resolución de zona.
    function priceTicket(packagesList, resolvedTariff, context) {
        context = context || {};
        const out = { lines: [], errors: [], total: 0, monthlyFlatCovered: false, zone: null };
        if (!resolvedTariff || !Array.isArray(resolvedTariff.items)) {
            out.errors.push('resolved_tariff_invalid');
            return out;
        }
        // Resolver zona UNA VEZ por ticket (todos los packages del ticket comparten destino)
        if (resolvedTariff.zones && resolvedTariff.zones.length && context.cp) {
            const z = resolveZone(context.cp, resolvedTariff.zones);
            if (z) {
                context._resolvedZone = z;
                out.zone = { id: z.id, name: z.name };
            }
        }
        const byName = {};
        const byId = {};
        resolvedTariff.items.forEach(it => {
            byName[(it.name || '').toLowerCase()] = it;
            byId[it.id] = it;
        });

        (packagesList || []).forEach((p, idx) => {
            const key = (p.size || p.itemId || '').toString().toLowerCase();
            const item = byId[p.itemId] || byName[key];
            if (!item) {
                out.errors.push({ idx: idx, reason: 'item_not_in_tariff', requested: p.size || p.itemId });
                return;
            }
            if (item.mode === 'flat_monthly') {
                out.monthlyFlatCovered = true;
                out.lines.push({
                    itemId: item.id, itemName: item.name, mode: 'flat_monthly',
                    qty: _num(p.qty), weightKg: _num(p.weight),
                    note: 'cubierto por cuota plana — no factura este albarán',
                    subtotal: 0
                });
                return;
            }
            const lr = priceLine(item, p.qty, p.weight, context);
            out.lines.push(lr);
            out.total += lr.subtotal || 0;
        });
        out.total = _round(out.total);
        return out;
    }

    // ===== SELF TESTS =====
    function _assertEq(label, actual, expected, tol) {
        tol = tol || 0.01;
        const ok = Math.abs(actual - expected) < tol;
        return { label: label, pass: ok, actual: actual, expected: expected };
    }

    function runSelfTests() {
        const results = [];

        // Tarifa de prueba
        const base = {
            id: 'GLOBAL_TEST', name: 'Test 2026', version: 1,
            items: [
                { id: 'pkg_small', name: 'Paquete pequeño', mode: 'per_package', basePrice: 4.50 },
                { id: 'pkg_kg',    name: 'Paquete por kg',  mode: 'per_kg',      basePrice: 0.80 },
                { id: 'exp_full',  name: 'Expedición',      mode: 'per_expedition',       basePrice: 25.00 },
                { id: 'exp_unit',  name: 'Expedición×bulto', mode: 'per_expedition_unit', basePrice: 6.00 },
                { id: 'bat_75ah',  name: 'Batería 75AH',    mode: 'per_package', basePrice: 50.00,
                  pricingRule: { type: 'bulk_discount', every: 4, charge: 3 } },
                { id: 'pkg_tier',  name: 'Paquete tier',    mode: 'per_package', basePrice: 4.00,
                  pricingRule: { type: 'tiered', tiers: [{ minQty: 1, price: 4.00 }, { minQty: 11, price: 3.00 }] } },
                { id: 'pkg_min',   name: 'Paquete mínimo',  mode: 'per_package', basePrice: 2.00,
                  pricingRule: { type: 'min_charge', amount: 15.00 } },
                { id: 'pkg_surch', name: 'Paquete recargo', mode: 'per_kg',      basePrice: 0.80,
                  pricingRule: { type: 'surcharge_over', threshold: 30, kind: 'flat', amount: 5.00, basis: 'kg' } },
                { id: 'cuota',     name: 'Cuota mensual',   mode: 'flat_monthly', basePrice: 500.00 }
            ]
        };

        // Test 1: per_package simple
        let t = priceTicket([{ qty: 3, size: 'Paquete pequeño', weight: 2 }], resolveTariff(base, {}));
        results.push(_assertEq('per_package 3×4,50', t.total, 13.50));

        // Test 2: per_kg
        t = priceTicket([{ qty: 1, size: 'Paquete por kg', weight: 12 }], resolveTariff(base, {}));
        results.push(_assertEq('per_kg 12×0,80', t.total, 9.60));

        // Test 3: per_expedition (qty no cuenta)
        t = priceTicket([{ qty: 4, size: 'Expedición', weight: 0 }], resolveTariff(base, {}));
        results.push(_assertEq('per_expedition 1×25', t.total, 25.00));

        // Test 4: per_expedition_unit (qty multiplica)
        t = priceTicket([{ qty: 4, size: 'Expedición×bulto', weight: 0 }], resolveTariff(base, {}));
        results.push(_assertEq('per_expedition_unit 4×6', t.total, 24.00));

        // Test 5: bulk_discount baterías (caso del usuario)
        t = priceTicket([{ qty: 4, size: 'Batería 75AH', weight: 25 }], resolveTariff(base, {}));
        results.push(_assertEq('bulk_discount 4 baterías → 3', t.total, 150.00));
        t = priceTicket([{ qty: 8, size: 'Batería 75AH', weight: 25 }], resolveTariff(base, {}));
        results.push(_assertEq('bulk_discount 8 baterías → 6', t.total, 300.00));
        t = priceTicket([{ qty: 5, size: 'Batería 75AH', weight: 25 }], resolveTariff(base, {}));
        results.push(_assertEq('bulk_discount 5 baterías → 4', t.total, 200.00));
        t = priceTicket([{ qty: 3, size: 'Batería 75AH', weight: 25 }], resolveTariff(base, {}));
        results.push(_assertEq('bulk_discount 3 baterías → 3 (sin descuento)', t.total, 150.00));

        // Test 6: tiered
        t = priceTicket([{ qty: 5, size: 'Paquete tier' }], resolveTariff(base, {}));
        results.push(_assertEq('tiered 5×4 (tier 1)', t.total, 20.00));
        t = priceTicket([{ qty: 15, size: 'Paquete tier' }], resolveTariff(base, {}));
        results.push(_assertEq('tiered 15×3 (tier 2)', t.total, 45.00));

        // Test 7: min_charge
        t = priceTicket([{ qty: 2, size: 'Paquete mínimo' }], resolveTariff(base, {}));
        results.push(_assertEq('min_charge 2×2 → 15 (mínimo)', t.total, 15.00));
        t = priceTicket([{ qty: 10, size: 'Paquete mínimo' }], resolveTariff(base, {}));
        results.push(_assertEq('min_charge 10×2 → 20 (sin mínimo)', t.total, 20.00));

        // Test 8: surcharge_over
        t = priceTicket([{ qty: 1, size: 'Paquete recargo', weight: 40 }], resolveTariff(base, {}));
        // 40×0,80 = 32; supera 30kg → +5 flat = 37
        results.push(_assertEq('surcharge_over 40kg → 32 + 5', t.total, 37.00));
        t = priceTicket([{ qty: 1, size: 'Paquete recargo', weight: 20 }], resolveTariff(base, {}));
        results.push(_assertEq('surcharge_over 20kg → 16 (sin recargo)', t.total, 16.00));

        // Test 9: flat_monthly no factura
        t = priceTicket([{ qty: 1, size: 'Cuota mensual' }], resolveTariff(base, {}));
        results.push(_assertEq('flat_monthly → 0 en albarán', t.total, 0.00));
        results.push({ label: 'flat_monthly marca monthlyFlatCovered', pass: t.monthlyFlatCovered === true, actual: t.monthlyFlatCovered, expected: true });

        // Test 10: Override de precio
        const resolved = resolveTariff(base, { 'pkg_small': { basePrice: 3.50 } });
        t = priceTicket([{ qty: 4, size: 'Paquete pequeño' }], resolved);
        results.push(_assertEq('override precio 4×3,50 (no 4,50)', t.total, 14.00));

        // Test 11: Override que añade pricingRule donde antes no había
        const resolved2 = resolveTariff(base, { 'pkg_small': { pricingRule: { type: 'bulk_discount', every: 5, charge: 4 } } });
        t = priceTicket([{ qty: 5, size: 'Paquete pequeño' }], resolved2);
        results.push(_assertEq('override añade promo 5→4 a 4,50', t.total, 18.00));

        // Test 12: Override null = item excluido
        const resolved3 = resolveTariff(base, { 'pkg_small': null });
        t = priceTicket([{ qty: 3, size: 'Paquete pequeño' }], resolved3);
        results.push({ label: 'override null excluye item', pass: t.errors.length > 0, actual: t.errors.length, expected: '>0' });

        // Test 13: Item custom solo para cliente
        const resolved4 = resolveTariff(base, {
            'svc_premium': { id: 'svc_premium', name: 'Servicio premium', mode: 'per_expedition', basePrice: 18.00 }
        });
        t = priceTicket([{ qty: 1, size: 'Servicio premium' }], resolved4);
        results.push(_assertEq('item custom cliente', t.total, 18.00));

        // Test 14: Albarán mixto
        const mixed = priceTicket([
            { qty: 2, size: 'Paquete pequeño', weight: 3 },         // 2×4,50 = 9
            { qty: 1, size: 'Paquete por kg', weight: 15 },          // 15×0,80 = 12
            { qty: 4, size: 'Batería 75AH', weight: 25 },            // promo 4→3 ×50 = 150
            { qty: 1, size: 'Expedición' }                            // 25
        ], resolveTariff(base, {}));
        results.push(_assertEq('albarán mixto: 9 + 12 + 150 + 25', mixed.total, 196.00));

        return results;
    }

    // Auto-ejecutar tests cuando se carga el módulo en admin (DEBUG_MODE)
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
        try {
            const r = runSelfTests();
            const failed = r.filter(x => !x.pass);
            if (failed.length === 0) {
                console.log('[PRICING] ✅ ' + r.length + '/' + r.length + ' tests pasados');
            } else {
                console.error('[PRICING] ❌ ' + failed.length + '/' + r.length + ' tests fallidos:', failed);
            }
        } catch(e) { console.error('[PRICING] Error ejecutando tests:', e); }
    }

    // Exportar API
    window.pricingEngine = {
        resolveTariff: resolveTariff,
        resolveZone: resolveZone,
        priceLine: priceLine,
        priceTicket: priceTicket,
        runSelfTests: runSelfTests,
        MODES: MODES,
        RULE_TYPES: RULE_TYPES,
        version: '1.1'
    };
})();
