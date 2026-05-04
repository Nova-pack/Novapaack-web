// =============================================
// NOVAPACK — NIF/CIF Enrichment v3.0
// =============================================
// Browse Global Directory (Cooper destinations)
// + local users. Search/auto-fill CIF/NIF using
// APIEmpresas.es or DatosCif.es
// =============================================

(function() {
    'use strict';

    var _globalClients = [];   // Cooper destinations [{docId, name, nif, phone, ...}]
    var _localClients = [];    // Firestore users [{uid, name, nif, ...}]
    var _filtered = [];
    var _activeTab = 'global'; // 'global' | 'local'
    var _currentFilter = 'all';
    var _searchText = '';
    var _currentPage = 1;
    var _pageSize = 50;
    var _loading = false;
    var _globalUserUid = null; // Cooper user UID

    // --- ENTRY POINT ---
    window.loadNifEnrichment = function() {
        _renderShell();
        _findGlobalUserAndLoad();
    };

    // --- RENDER SHELL ---
    function _renderShell() {
        var container = document.querySelector('#erp-tab-nif-enrichment .erp-workspace-content');
        if (!container) return;

        container.innerHTML =
            // Header
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:25px; flex-wrap:wrap; gap:15px;">' +
                '<div>' +
                    '<h1 style="color:var(--brand-primary); margin:0; display:flex; align-items:center; gap:10px;">' +
                        '<span class="material-symbols-outlined" style="font-size:2rem;">badge</span> Enriquecimiento CIF/NIF' +
                    '</h1>' +
                    '<p style="color:var(--text-dim); margin-top:5px; margin-bottom:0; font-size:0.9rem;">Base de datos Global + Clientes locales — Buscar y completar NIF/CIF</p>' +
                '</div>' +
                '<div id="nif-stats" style="display:flex; gap:12px; flex-wrap:wrap;"></div>' +
            '</div>' +

            // Global user selector + Auto-match
            '<div id="nif-global-user-container" style="background:var(--bg-dark); border:1px solid var(--border-glass); border-radius:12px; padding:14px 20px; margin-bottom:20px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">' +
                '<label style="font-size:0.8rem; color:#FF9800; font-weight:bold; white-space:nowrap;">Usuario Global:</label>' +
                '<span style="color:#666; font-size:0.8rem;">Detectando...</span>' +
            '</div>' +

            // Auto-match bar
            '<div style="background:rgba(76,175,80,0.1); border:1px solid rgba(76,175,80,0.3); border-radius:12px; padding:14px 20px; margin-bottom:20px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">' +
                '<span class="material-symbols-outlined" style="color:#4CAF50;">auto_fix_high</span>' +
                '<span style="color:#4CAF50; font-weight:bold; font-size:0.85rem;">Auto-rellenar NIF:</span>' +
                '<span style="color:#aaa; font-size:0.8rem;">Cruza los nombres con la base Gesco (1142 clientes con NIF)</span>' +
                '<button onclick="nifAutoMatch()" style="background:linear-gradient(135deg,#4CAF50,#2E7D32); border:none; color:#fff; padding:10px 20px; border-radius:8px; font-weight:bold; font-size:0.85rem; cursor:pointer; display:flex; align-items:center; gap:6px; margin-left:auto;">' +
                    '<span class="material-symbols-outlined" style="font-size:1rem;">auto_fix_high</span> Auto-Match Gesco' +
                '</button>' +
                '<div id="nif-automatch-status" style="width:100%; font-size:0.8rem; color:#aaa; display:none;"></div>' +
            '</div>' +

            // Tab selector: Global vs Local
            '<div style="display:flex; gap:0; margin-bottom:20px; border-radius:10px; overflow:hidden; border:1px solid #333;">' +
                '<button id="nif-tab-global" onclick="nifSwitchTab(\'global\')" style="flex:1; padding:14px 20px; border:none; font-size:0.9rem; cursor:pointer; font-weight:bold; display:flex; align-items:center; justify-content:center; gap:8px; background:linear-gradient(135deg,#FF9800,#E65100); color:white;">' +
                    '<span class="material-symbols-outlined" style="font-size:1.2rem;">cloud</span> Base de Datos Global' +
                    '<span id="nif-tab-global-count" style="background:rgba(0,0,0,0.3); padding:2px 8px; border-radius:10px; font-size:0.75rem;"></span>' +
                '</button>' +
                '<button id="nif-tab-local" onclick="nifSwitchTab(\'local\')" style="flex:1; padding:14px 20px; border:none; font-size:0.9rem; cursor:pointer; font-weight:bold; display:flex; align-items:center; justify-content:center; gap:8px; background:#1a1a2e; color:#888;">' +
                    '<span class="material-symbols-outlined" style="font-size:1.2rem;">people</span> Clientes Locales (Firestore)' +
                    '<span id="nif-tab-local-count" style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:10px; font-size:0.75rem;"></span>' +
                '</button>' +
            '</div>' +

            // Search + Filters
            '<div style="background:var(--bg-dark); border:1px solid var(--border-glass); border-radius:12px; padding:16px 20px; margin-bottom:20px;">' +
                '<div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">' +
                    '<div style="flex:1; min-width:250px; position:relative;">' +
                        '<span class="material-symbols-outlined" style="position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#666; font-size:1.1rem;">search</span>' +
                        '<input type="text" id="nif-client-search" placeholder="Buscar por nombre, NIF, tel\u00e9fono, localidad..." ' +
                            'style="width:100%; background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:10px 14px 10px 36px; border-radius:8px; font-size:0.85rem; box-sizing:border-box;" ' +
                            'oninput="nifFilterClients()">' +
                    '</div>' +
                    '<div style="display:flex; gap:4px; background:#1a1a2e; border-radius:8px; padding:3px;">' +
                        '<button id="nif-filter-all" onclick="nifSetFilter(\'all\')" style="padding:8px 16px; border:none; border-radius:6px; font-size:0.8rem; cursor:pointer; font-weight:bold; background:#4CAF50; color:white;">Todos</button>' +
                        '<button id="nif-filter-missing" onclick="nifSetFilter(\'missing\')" style="padding:8px 16px; border:none; border-radius:6px; font-size:0.8rem; cursor:pointer; font-weight:bold; background:transparent; color:#aaa;">Sin NIF</button>' +
                        '<button id="nif-filter-complete" onclick="nifSetFilter(\'complete\')" style="padding:8px 16px; border:none; border-radius:6px; font-size:0.8rem; cursor:pointer; font-weight:bold; background:transparent; color:#aaa;">Con NIF</button>' +
                    '</div>' +
                    '<button onclick="nifReload()" style="background:linear-gradient(135deg,#4CAF50,#2E7D32); border:none; color:#fff; padding:10px 20px; border-radius:8px; font-weight:bold; font-size:0.85rem; cursor:pointer; display:flex; align-items:center; gap:6px;">' +
                        '<span class="material-symbols-outlined" style="font-size:1rem;">refresh</span> Recargar' +
                    '</button>' +
                '</div>' +
            '</div>' +

            // API Search (collapsible)
            '<div style="background:var(--bg-dark); border:1px solid var(--border-glass); border-radius:12px; margin-bottom:20px;">' +
                '<div onclick="document.getElementById(\'nif-api-panel\').style.display=document.getElementById(\'nif-api-panel\').style.display===\'none\'?\'\':\'none\'" ' +
                    'style="padding:14px 20px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;">' +
                    '<h3 style="margin:0; color:#2196F3; font-size:0.9rem; display:flex; align-items:center; gap:6px;">' +
                        '<span class="material-symbols-outlined" style="font-size:1rem;">manage_search</span> B\u00fasqueda Online y Configuraci\u00f3n API' +
                    '</h3>' +
                    '<span class="material-symbols-outlined" style="color:#666;">expand_more</span>' +
                '</div>' +
                '<div id="nif-api-panel" style="display:none; padding:0 20px 16px;">' +
                    '<div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:12px;">' +
                        '<label style="font-size:0.75rem; color:#aaa; text-transform:uppercase;">Fuente:</label>' +
                        '<select id="nif-source" style="background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:8px 12px; border-radius:6px; font-size:0.85rem;">' +
                            '<option value="apiempresas">APIEmpresas.es (API)</option>' +
                            '<option value="datoscif">DatosCif.es (Web)</option>' +
                        '</select>' +
                        '<input type="text" id="nif-api-key" placeholder="API Key (opcional)" style="flex:1; min-width:200px; background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:8px 12px; border-radius:6px; font-size:0.85rem;">' +
                    '</div>' +
                    '<div style="display:flex; gap:10px; flex-wrap:wrap;">' +
                        '<input type="text" id="nif-manual-search" placeholder="Buscar empresa en API..." style="flex:1; min-width:250px; background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:10px 14px; border-radius:6px; font-size:0.9rem;" onkeypress="if(event.key===\'Enter\') nifManualSearch()">' +
                        '<button onclick="nifManualSearch()" style="background:linear-gradient(135deg,#2196F3,#1565C0); border:none; color:#fff; padding:10px 20px; border-radius:8px; font-weight:bold; font-size:0.85rem; cursor:pointer;">Buscar Online</button>' +
                    '</div>' +
                    '<div id="nif-manual-results" style="margin-top:12px;"></div>' +
                '</div>' +
            '</div>' +

            // Client Table
            '<div style="background:var(--bg-dark); border:1px solid var(--border-glass); border-radius:12px; padding:20px;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; flex-wrap:wrap; gap:10px;">' +
                    '<h3 id="nif-table-title" style="margin:0; color:#FF9800; font-size:1rem; display:flex; align-items:center; gap:8px;">' +
                        '<span class="material-symbols-outlined">group</span> Cargando...' +
                    '</h3>' +
                    '<div id="nif-pagination" style="display:flex; gap:8px; align-items:center; font-size:0.8rem; color:#aaa;"></div>' +
                '</div>' +
                '<div id="nif-client-list" style="max-height:600px; overflow-y:auto; color:#888; font-size:0.85rem;">' +
                    '<div style="padding:30px; text-align:center; color:#aaa;"><span class="material-symbols-outlined" style="font-size:2rem; display:block; margin-bottom:8px;">hourglass_top</span>Cargando base de datos...</div>' +
                '</div>' +
            '</div>';
    }

    // --- FIND GLOBAL USER + LOAD ---
    async function _findGlobalUserAndLoad() {
        _loading = true;
        _showLoading('Cargando usuarios...');

        try {
            // 1. Ensure userMap is loaded
            if (typeof userMap === 'undefined' || Object.keys(userMap).length < 2) {
                var allSnap = await db.collection('users').get();
                if (typeof userMap === 'undefined') window.userMap = {};
                allSnap.forEach(function(doc) {
                    var d = doc.data();
                    d.id = doc.id;
                    userMap[doc.id] = d;
                });
            }

            // 2. Build user selector for global directory
            _buildUserSelector();

            // 3. Auto-detect: find user with destinations by checking common patterns
            var candidates = [];
            var keywords = ['cooper', 'global', 'directorio', 'base', 'nube'];
            Object.entries(userMap).forEach(function(entry) {
                var uid = entry[0];
                var u = entry[1];
                var name = (u.name || '').toLowerCase();
                var email = (u.email || '').toLowerCase();
                var score = 0;
                keywords.forEach(function(kw) {
                    if (name.indexOf(kw) !== -1) score += 2;
                    if (email.indexOf(kw) !== -1) score += 2;
                });
                if (score > 0) candidates.push({ uid: uid, score: score, name: u.name, email: u.email });
            });
            candidates.sort(function(a, b) { return b.score - a.score; });

            // Try top candidate
            if (candidates.length > 0) {
                _globalUserUid = candidates[0].uid;
                if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log('[NIF] Auto-detected global user: ' + candidates[0].name + ' (' + _globalUserUid + ')');
            }

            // 4. If auto-detect found something, try loading its destinations
            if (_globalUserUid) {
                await _loadGlobalDestinations();
            }

            // 5. If no destinations found, scan ALL users for one with destinations
            if (_globalClients.length === 0) {
                _showLoading('Escaneando usuarios con destinos...');
                var allUsers = Object.keys(userMap);
                for (var i = 0; i < allUsers.length; i++) {
                    var uid = allUsers[i];
                    if (uid === _globalUserUid) continue; // already tried
                    try {
                        var testSnap = await db.collection('users').doc(uid)
                            .collection('destinations').limit(5).get();
                        if (testSnap.size >= 5) {
                            _globalUserUid = uid;
                            if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log('[NIF] Found user with destinations: ' + (userMap[uid].name || uid) + ' (' + uid + ')');
                            await _loadGlobalDestinations();
                            break;
                        }
                    } catch(e) { /* skip */ }
                }
            }

            // Update selector to show current selection
            var sel = document.getElementById('nif-global-user-select');
            if (sel && _globalUserUid) sel.value = _globalUserUid;

            // Load local clients in parallel
            await _loadLocalClients();

            _loading = false;
            _updateTabCounts();
            _applyFilters();

        } catch(err) {
            _loading = false;
            _showError('Error: ' + err.message);
            console.error('[NIF]', err);
        }
    }

    // --- BUILD USER SELECTOR DROPDOWN ---
    function _buildUserSelector() {
        var container = document.getElementById('nif-global-user-container');
        if (!container) return;

        var users = [];
        Object.entries(userMap).forEach(function(entry) {
            users.push({ uid: entry[0], name: entry[1].name || '', email: entry[1].email || '', idNum: entry[1].idNum || '' });
        });
        // Deduplicate by uid
        var seen = {};
        users = users.filter(function(u) {
            if (seen[u.uid]) return false;
            seen[u.uid] = true;
            return true;
        });
        users.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });

        var html = '<select id="nif-global-user-select" onchange="nifSelectGlobalUser(this.value)" ' +
            'style="background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:8px 12px; border-radius:6px; font-size:0.82rem; max-width:350px;">';
        html += '<option value="">-- Seleccionar usuario con destinos globales --</option>';
        users.forEach(function(u) {
            var label = (u.idNum ? '#' + u.idNum + ' ' : '') + u.name + (u.email ? ' (' + u.email + ')' : '');
            html += '<option value="' + u.uid + '">' + _esc(label) + '</option>';
        });
        html += '</select>';
        container.innerHTML = html;
    }

    // --- MANUAL USER SELECTION ---
    window.nifSelectGlobalUser = async function(uid) {
        if (!uid) return;
        _globalUserUid = uid;
        _globalClients = [];
        _showLoading('Cargando destinos de ' + _esc((userMap[uid] || {}).name || uid) + '...');
        await _loadGlobalDestinations();
        _updateTabCounts();
        _applyFilters();
    };

    // --- LOAD GLOBAL DESTINATIONS ---
    async function _loadGlobalDestinations() {
        _globalClients = [];

        if (!_globalUserUid) {
            console.warn('[NIF] No se encontr\u00f3 el usuario global (Cooper).');
            return;
        }

        _showLoading('Cargando directorio global (' + _globalUserUid + ')...');

        var snap = await db.collection('users').doc(_globalUserUid)
            .collection('destinations').get();

        snap.forEach(function(doc) {
            var d = doc.data();
            var addr = (d.addresses && d.addresses[0]) || {};
            _globalClients.push({
                docId: doc.id,
                name: d.name || '',
                nif: d.nif || '',
                phone: d.phone || '',
                email: d.email || '',
                localidad: addr.localidad || d.localidad || '',
                cp: addr.cp || d.cp || '',
                street: addr.address || addr.street || d.street || '',
                province: addr.province || ''
            });
        });

        // Sort by name
        _globalClients.sort(function(a, b) {
            return (a.name || '').localeCompare(b.name || '');
        });

        console.log('[NIF] Directorio global cargado: ' + _globalClients.length + ' destinos');
    }

    // --- LOAD LOCAL CLIENTS (Firestore users) ---
    async function _loadLocalClients() {
        _localClients = [];

        var snap = await db.collection('users').get();
        snap.forEach(function(doc) {
            var d = doc.data();
            if (d.isGlobal) return;
            _localClients.push({
                uid: doc.id,
                name: d.name || '',
                nif: d.nif || '',
                email: d.email || '',
                idNum: d.idNum || d.clientNumber || '',
                city: d.city || '',
                senderPhone: d.senderPhone || ''
            });
        });

        _localClients.sort(function(a, b) {
            var numA = parseInt(a.idNum) || 99999;
            var numB = parseInt(b.idNum) || 99999;
            if (numA !== numB) return numA - numB;
            return (a.name || '').localeCompare(b.name || '');
        });
    }

    // --- TAB SWITCHING ---
    window.nifSwitchTab = function(tab) {
        _activeTab = tab;
        _currentPage = 1;
        _currentFilter = 'all';
        _searchText = '';
        var searchInput = document.getElementById('nif-client-search');
        if (searchInput) searchInput.value = '';

        // Reset filter buttons
        nifSetFilter('all');

        // Tab styles
        var gBtn = document.getElementById('nif-tab-global');
        var lBtn = document.getElementById('nif-tab-local');
        if (gBtn && lBtn) {
            if (tab === 'global') {
                gBtn.style.background = 'linear-gradient(135deg,#FF9800,#E65100)';
                gBtn.style.color = 'white';
                lBtn.style.background = '#1a1a2e';
                lBtn.style.color = '#888';
            } else {
                lBtn.style.background = 'linear-gradient(135deg,#2196F3,#1565C0)';
                lBtn.style.color = 'white';
                gBtn.style.background = '#1a1a2e';
                gBtn.style.color = '#888';
            }
        }

        _applyFilters();
    };

    // --- UPDATE TAB COUNTS ---
    function _updateTabCounts() {
        var gCount = document.getElementById('nif-tab-global-count');
        var lCount = document.getElementById('nif-tab-local-count');
        if (gCount) gCount.textContent = _globalClients.length;
        if (lCount) lCount.textContent = _localClients.length;
    }

    // --- RELOAD ---
    window.nifReload = function() {
        _globalClients = [];
        _localClients = [];
        _globalUserUid = null;
        _findGlobalUserAndLoad();
    };

    // --- FILTERS ---
    window.nifSetFilter = function(filter) {
        _currentFilter = filter;
        _currentPage = 1;
        ['all', 'missing', 'complete'].forEach(function(f) {
            var btn = document.getElementById('nif-filter-' + f);
            if (!btn) return;
            if (f === filter) {
                btn.style.background = f === 'all' ? '#4CAF50' : (f === 'missing' ? '#FF9800' : '#2196F3');
                btn.style.color = 'white';
            } else {
                btn.style.background = 'transparent';
                btn.style.color = '#aaa';
            }
        });
        _applyFilters();
    };

    var _nifFilterTimer;
    window.nifFilterClients = function() {
        clearTimeout(_nifFilterTimer);
        _nifFilterTimer = setTimeout(function() {
            var input = document.getElementById('nif-client-search');
            _searchText = (input ? input.value : '').trim().toLowerCase();
            _currentPage = 1;
            _applyFilters();
        }, 300);
    };

    function _applyFilters() {
        var source = _activeTab === 'global' ? _globalClients : _localClients;

        _filtered = source.filter(function(c) {
            var hasNif = c.nif && c.nif.trim().length >= 8;
            if (_currentFilter === 'missing' && hasNif) return false;
            if (_currentFilter === 'complete' && !hasNif) return false;

            if (_searchText) {
                var fields = [
                    c.name, c.nif, c.phone || c.senderPhone || '',
                    c.email, c.localidad || c.city || '',
                    c.street || '', c.idNum || '', c.docId || c.uid || ''
                ].join(' ').toLowerCase();
                return fields.indexOf(_searchText) !== -1;
            }
            return true;
        });

        _updateStats();
        _renderTable();
    }

    // --- STATS ---
    function _updateStats() {
        var statsEl = document.getElementById('nif-stats');
        if (!statsEl) return;

        var source = _activeTab === 'global' ? _globalClients : _localClients;
        var total = source.length;
        var withNif = 0;
        source.forEach(function(c) {
            if (c.nif && c.nif.trim().length >= 8) withNif++;
        });
        var withoutNif = total - withNif;
        var pct = total > 0 ? Math.round((withNif / total) * 100) : 0;

        statsEl.innerHTML =
            '<div style="background:rgba(33,150,243,0.1); border:1px solid rgba(33,150,243,0.3); border-radius:8px; padding:8px 14px; text-align:center; cursor:pointer;" onclick="nifSetFilter(\'all\')">' +
                '<div style="font-size:1.3rem; font-weight:900; color:#2196F3;">' + total + '</div>' +
                '<div style="font-size:0.7rem; color:#aaa;">Total</div></div>' +
            '<div style="background:rgba(76,175,80,0.1); border:1px solid rgba(76,175,80,0.3); border-radius:8px; padding:8px 14px; text-align:center; cursor:pointer;" onclick="nifSetFilter(\'complete\')">' +
                '<div style="font-size:1.3rem; font-weight:900; color:#4CAF50;">' + withNif + '</div>' +
                '<div style="font-size:0.7rem; color:#aaa;">Con NIF</div></div>' +
            '<div style="background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.3); border-radius:8px; padding:8px 14px; text-align:center; cursor:pointer;" onclick="nifSetFilter(\'missing\')">' +
                '<div style="font-size:1.3rem; font-weight:900; color:#FF9800;">' + withoutNif + '</div>' +
                '<div style="font-size:0.7rem; color:#aaa;">Sin NIF</div></div>' +
            '<div style="background:rgba(156,39,176,0.1); border:1px solid rgba(156,39,176,0.3); border-radius:8px; padding:8px 14px; text-align:center;">' +
                '<div style="font-size:1.3rem; font-weight:900; color:#9C27B0;">' + pct + '%</div>' +
                '<div style="font-size:0.7rem; color:#aaa;">Completado</div></div>';
    }

    // --- RENDER TABLE ---
    function _renderTable() {
        var listEl = document.getElementById('nif-client-list');
        var titleEl = document.getElementById('nif-table-title');
        var pagEl = document.getElementById('nif-pagination');
        if (!listEl) return;

        var total = _filtered.length;
        var totalPages = Math.ceil(total / _pageSize) || 1;
        if (_currentPage > totalPages) _currentPage = totalPages;

        var start = (_currentPage - 1) * _pageSize;
        var page = _filtered.slice(start, start + _pageSize);

        // Title
        var src = _activeTab === 'global' ? 'Directorio Global' : 'Clientes Locales';
        var filterLabel = _currentFilter === 'all' ? src :
                          _currentFilter === 'missing' ? src + ' sin NIF' : src + ' con NIF';
        if (titleEl) {
            var icon = _activeTab === 'global' ? 'cloud' : 'people';
            titleEl.innerHTML = '<span class="material-symbols-outlined">' + icon + '</span> ' + filterLabel +
                ' <span style="color:#666; font-weight:normal; font-size:0.85rem;">(' + total + ')</span>';
        }

        // Pagination
        if (pagEl) {
            if (totalPages > 1) {
                pagEl.innerHTML =
                    '<button onclick="nifGoPage(' + Math.max(1, _currentPage - 1) + ')" ' +
                        'style="background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:0.8rem;' +
                        (_currentPage <= 1 ? ' opacity:0.3; cursor:default;' : '') + '"' +
                        (_currentPage <= 1 ? ' disabled' : '') + '>&laquo; Ant</button>' +
                    '<span>' + _currentPage + ' / ' + totalPages + '</span>' +
                    '<button onclick="nifGoPage(' + Math.min(totalPages, _currentPage + 1) + ')" ' +
                        'style="background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:0.8rem;' +
                        (_currentPage >= totalPages ? ' opacity:0.3; cursor:default;' : '') + '"' +
                        (_currentPage >= totalPages ? ' disabled' : '') + '>Sig &raquo;</button>';
            } else {
                pagEl.innerHTML = '';
            }
        }

        if (page.length === 0) {
            listEl.innerHTML = '<div style="padding:30px; text-align:center; color:#888;">' +
                '<span class="material-symbols-outlined" style="font-size:2rem; display:block; margin-bottom:8px;">search_off</span>' +
                (_searchText ? 'Sin resultados para "' + _esc(_searchText) + '".' :
                 (_activeTab === 'global' && _globalClients.length === 0 ? 'No se encontr\u00f3 el directorio global. Verifica que el usuario Cooper existe.' : 'No hay clientes en esta categor\u00eda.')) +
                '</div>';
            return;
        }

        var isGlobal = _activeTab === 'global';
        var html = '<table style="width:100%; border-collapse:collapse; font-size:0.82rem;">';
        html += '<thead><tr style="background:#1a1a2e; position:sticky; top:0; z-index:1;">';
        html += '<th style="padding:8px; text-align:left; color:#aaa; width:50px;">#</th>';
        html += '<th style="padding:8px; text-align:left; color:#aaa;">Nombre</th>';
        if (isGlobal) {
            html += '<th style="padding:8px; text-align:left; color:#aaa;">Localidad</th>';
            html += '<th style="padding:8px; text-align:left; color:#aaa;">Tel\u00e9fono</th>';
        } else {
            html += '<th style="padding:8px; text-align:left; color:#aaa;">Email</th>';
        }
        html += '<th style="padding:8px; text-align:left; color:#aaa; width:130px;">NIF/CIF</th>';
        html += '<th style="padding:8px; text-align:center; color:#aaa; width:150px;">Asignar NIF</th>';
        html += '<th style="padding:8px; text-align:center; color:#aaa; width:120px;">Acciones</th>';
        html += '</tr></thead><tbody>';

        page.forEach(function(c, i) {
            var gIdx = start + i;
            var hasNif = c.nif && c.nif.trim().length >= 8;
            var bg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)';

            html += '<tr id="nif-row-' + gIdx + '" style="background:' + bg + '; border-bottom:1px solid #222;">';
            html += '<td style="padding:6px 8px; color:#FF9800; font-weight:bold; font-size:0.75rem;">' + (gIdx + 1) + '</td>';

            // Name
            html += '<td style="padding:6px 8px;">' +
                '<div style="font-weight:700; color:#eee;">' + _esc(c.name || 'Sin nombre') + '</div>' +
                (isGlobal && c.street ? '<div style="font-size:0.72rem; color:#555;">' + _esc(c.street) + '</div>' : '') +
                '</td>';

            // Extra column
            if (isGlobal) {
                html += '<td style="padding:6px 8px; color:#888; font-size:0.8rem;">' + _esc(c.localidad || '-') + (c.cp ? ' (' + _esc(c.cp) + ')' : '') + '</td>';
                html += '<td style="padding:6px 8px; color:#888; font-size:0.8rem;">' + _esc(c.phone || '-') + '</td>';
            } else {
                html += '<td style="padding:6px 8px; color:#888; font-size:0.8rem;">' + _esc(c.email || '-') + '</td>';
            }

            // NIF
            html += '<td style="padding:6px 8px;">';
            if (hasNif) {
                html += '<span style="color:#4CAF50; font-weight:bold;">' + _esc(c.nif) + '</span>';
            } else {
                html += '<span style="color:#FF5252; font-style:italic;">Sin NIF</span>';
            }
            html += '</td>';

            // Input
            html += '<td style="padding:6px 8px; text-align:center;">' +
                '<input type="text" id="nif-input-' + gIdx + '" placeholder="B12345678" ' +
                'style="background:#2a2a2d; border:1px solid #444; color:#d4d4d4; padding:4px 8px; border-radius:4px; font-size:0.82rem; width:110px; text-transform:uppercase;" ' +
                'value="' + _esc(c.nif || '') + '">' +
                '</td>';

            // Actions
            html += '<td style="padding:6px 8px; text-align:center; white-space:nowrap;">' +
                '<button onclick="nifSearchFor(' + gIdx + ')" style="background:#2196F3; border:none; color:white; padding:3px 8px; border-radius:4px; font-size:0.72rem; cursor:pointer; margin-right:3px;" title="Buscar online">\ud83d\udd0d</button>' +
                '<button onclick="nifApplyOne(' + gIdx + ')" style="background:#4CAF50; border:none; color:white; padding:3px 8px; border-radius:4px; font-size:0.72rem; cursor:pointer; margin-right:3px;" title="Guardar NIF">\u2713</button>' +
                '<button onclick="nifOpenWeb(' + gIdx + ')" style="background:#555; border:none; color:white; padding:3px 8px; border-radius:4px; font-size:0.72rem; cursor:pointer;" title="Buscar en web">\ud83c\udf10</button>' +
                '</td>';
            html += '</tr>';
        });

        html += '</tbody></table>';
        listEl.innerHTML = html;
    }

    // --- PAGINATION ---
    window.nifGoPage = function(page) {
        _currentPage = page;
        _renderTable();
        var listEl = document.getElementById('nif-client-list');
        if (listEl) listEl.scrollTop = 0;
    };

    // --- SEARCH ONLINE (cleaned name) ---
    window.nifSearchFor = async function(idx) {
        var client = _filtered[idx];
        if (!client || !client.name) { alert('Cliente sin nombre.'); return; }

        // 1. First try local match with PhantomDirectory
        if (window.PhantomDirectory && window.PhantomDirectory.length > 0) {
            var normTarget = _normalizeName(client.name);
            for (var g = 0; g < window.PhantomDirectory.length; g++) {
                var gEntry = window.PhantomDirectory[g];
                if (gEntry.nif && gEntry.nif.trim().length >= 8 && _normalizeName(gEntry.name) === normTarget) {
                    var input = document.getElementById('nif-input-' + idx);
                    if (input) input.value = gEntry.nif.trim().toUpperCase();
                    alert('Encontrado en Gesco:\n' + gEntry.name + ' → ' + gEntry.nif);
                    return;
                }
            }
        }

        // 2. Try API
        var source = document.getElementById('nif-source');
        var sourceVal = source ? source.value : 'apiempresas';
        var apiKey = (document.getElementById('nif-api-key') || {}).value || '';
        apiKey = apiKey.trim();
        var cleanName = _cleanNameForSearch(client.name);

        var panel = document.getElementById('nif-api-panel');
        if (panel) panel.style.display = '';

        if (sourceVal === 'datoscif') {
            window.open('https://www.google.com/search?q=' + encodeURIComponent(cleanName + ' NIF CIF España'), '_blank');
            return;
        }

        var row = document.getElementById('nif-row-' + idx);
        if (row) row.style.opacity = '0.5';

        try {
            var url = 'https://apiempresas.es/autocompletado-cif-empresas/get?q=' + encodeURIComponent(cleanName);
            if (apiKey) url += '&apikey=' + encodeURIComponent(apiKey);

            var resp = await fetch(url);
            var data = await resp.json();
            if (row) row.style.opacity = '1';

            if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
                _showSearchResults(idx, data.data);
            } else if (data && data.data && data.data.cif) {
                var inp = document.getElementById('nif-input-' + idx);
                if (inp) inp.value = data.data.cif;
                alert('Encontrado: ' + data.data.name + ' \u2192 ' + data.data.cif);
            } else {
                // Fallback: open Google search
                window.open('https://www.google.com/search?q=' + encodeURIComponent(cleanName + ' NIF CIF España'), '_blank');
            }
        } catch(err) {
            if (row) row.style.opacity = '1';
            console.warn('[NIF] API error:', err.message);
            // Fallback: Google search
            window.open('https://www.google.com/search?q=' + encodeURIComponent(cleanName + ' NIF CIF España'), '_blank');
        }
    };

    function _showSearchResults(idx, results) {
        var resultsEl = document.getElementById('nif-manual-results');
        if (!resultsEl) return;

        var client = _filtered[idx];
        var html = '<div style="font-size:0.8rem; color:#aaa; margin-bottom:8px;">Resultados para <strong style="color:#FF9800;">' + _esc(client.name) + '</strong>:</div>';
        html += '<div style="display:flex; flex-direction:column; gap:6px;">';

        (Array.isArray(results) ? results.slice(0, 8) : [results]).forEach(function(r) {
            var name = r.name || r.razon_social || '';
            var cif = r.cif || r.nif || '';
            html += '<div style="background:#1a1a2e; border:1px solid #333; border-radius:6px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">';
            html += '<div><strong style="color:#eee;">' + _esc(name) + '</strong> <span style="color:#2196F3; font-weight:bold; margin-left:8px;">' + _esc(cif) + '</span>';
            if (r.province) html += ' <span style="color:#666; font-size:0.75rem;">(' + _esc(r.province) + ')</span>';
            html += '</div>';
            html += '<button onclick="document.getElementById(\'nif-input-' + idx + '\').value=\'' + _esc(cif) + '\'; this.textContent=\'Aplicado!\'; this.style.background=\'#FF9800\';" style="background:#4CAF50; border:none; color:white; padding:4px 12px; border-radius:4px; font-size:0.75rem; cursor:pointer; font-weight:bold;">Usar</button>';
            html += '</div>';
        });

        html += '</div>';
        resultsEl.innerHTML = html;
        resultsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // --- MANUAL SEARCH ---
    window.nifManualSearch = async function() {
        var query = (document.getElementById('nif-manual-search').value || '').trim();
        if (!query || query.length < 3) { alert('Escribe al menos 3 caracteres.'); return; }

        var resultsEl = document.getElementById('nif-manual-results');
        var source = document.getElementById('nif-source');
        var sourceVal = source ? source.value : 'apiempresas';
        var apiKey = (document.getElementById('nif-api-key') || {}).value || '';

        var cleanQuery = _cleanNameForSearch(query);

        if (sourceVal === 'datoscif') {
            window.open('https://www.google.com/search?q=' + encodeURIComponent(cleanQuery + ' NIF CIF España'), '_blank');
            return;
        }

        if (resultsEl) resultsEl.innerHTML = '<div style="color:#aaa; font-size:0.85rem;">Buscando "' + _esc(cleanQuery) + '"...</div>';

        try {
            var url = 'https://apiempresas.es/autocompletado-cif-empresas/get?q=' + encodeURIComponent(cleanQuery);
            if (apiKey.trim()) url += '&apikey=' + encodeURIComponent(apiKey.trim());

            var resp = await fetch(url);
            var data = await resp.json();

            if (data && data.data && ((Array.isArray(data.data) && data.data.length > 0) || data.data.cif)) {
                var items = Array.isArray(data.data) ? data.data.slice(0, 10) : [data.data];
                var html = '<div style="font-size:0.8rem; color:#aaa; margin-bottom:8px;">' + items.length + ' resultado(s):</div>';
                html += '<div style="display:flex; flex-direction:column; gap:6px;">';
                items.forEach(function(r) {
                    var name = r.name || r.razon_social || '';
                    var cif = r.cif || r.nif || '';
                    html += '<div style="background:#1a1a2e; border:1px solid #333; border-radius:6px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">';
                    html += '<div><strong style="color:#eee;">' + _esc(name) + '</strong> <span style="color:#2196F3; font-weight:bold; margin-left:8px;">' + _esc(cif) + '</span>';
                    if (r.address) html += '<br><span style="color:#666; font-size:0.75rem;">' + _esc(r.address) + '</span>';
                    if (r.province) html += ' <span style="color:#666; font-size:0.75rem;">(' + _esc(r.province) + ')</span>';
                    html += '</div>';
                    html += '<button onclick="navigator.clipboard.writeText(\'' + _esc(cif) + '\'); this.textContent=\'Copiado!\'; setTimeout(()=>this.textContent=\'Copiar\',1500)" style="background:#2196F3; border:none; color:white; padding:4px 12px; border-radius:4px; font-size:0.75rem; cursor:pointer;">Copiar</button>';
                    html += '</div>';
                });
                html += '</div>';
                if (resultsEl) resultsEl.innerHTML = html;
            } else {
                if (resultsEl) resultsEl.innerHTML = '<div style="color:#888; font-size:0.85rem;">Sin resultados para "' + _esc(query) + '".</div>';
            }
        } catch(err) {
            console.warn('[NIF] Manual search error:', err.message);
            if (resultsEl) resultsEl.innerHTML = '<div style="color:#FF9800; font-size:0.85rem;">Error API: ' + _esc(err.message) + '. <a href="https://www.google.com/search?q=' + encodeURIComponent(cleanQuery + ' NIF CIF España') + '" target="_blank" style="color:#2196F3;">Buscar en Google</a></div>';
        }
    };

    // --- APPLY NIF ---
    window.nifApplyOne = async function(idx) {
        var client = _filtered[idx];
        if (!client) return;

        var input = document.getElementById('nif-input-' + idx);
        var nif = (input ? input.value : '').trim().toUpperCase();

        if (!nif || nif.length < 8) {
            alert('Introduce un NIF/CIF v\u00e1lido (m\u00ednimo 8 caracteres).');
            return;
        }

        try {
            if (_activeTab === 'global' && client.docId && _globalUserUid) {
                // Save to Cooper destinations subcollection
                await db.collection('users').doc(_globalUserUid)
                    .collection('destinations').doc(client.docId)
                    .update({ nif: nif });
            } else if (client.uid) {
                // Save to users collection
                await db.collection('users').doc(client.uid).update({ nif: nif });
                if (typeof userMap !== 'undefined' && userMap[client.uid]) {
                    userMap[client.uid].nif = nif;
                }
            }

            // Update local data
            client.nif = nif;

            // Visual feedback
            var row = document.getElementById('nif-row-' + idx);
            if (row) {
                row.style.background = 'rgba(76,175,80,0.15)';
                row.style.transition = 'background 0.5s';
            }
            if (input) {
                input.style.borderColor = '#4CAF50';
                input.style.background = 'rgba(76,175,80,0.2)';
                setTimeout(function() {
                    input.style.borderColor = '#444';
                    input.style.background = '#2a2a2d';
                }, 2000);
            }

            _updateStats();
            _updateTabCounts();

        } catch(err) {
            alert('Error al guardar: ' + err.message);
        }
    };

    // --- OPEN WEB (improved: clean name before searching) ---
    window.nifOpenWeb = function(idx) {
        var client = _filtered[idx];
        if (!client || !client.name) return;
        var clean = _cleanNameForSearch(client.name);
        // Use Google search as most reliable fallback
        window.open('https://www.google.com/search?q=' + encodeURIComponent(clean + ' NIF CIF España'), '_blank');
    };

    // ====================================================
    // AUTO-MATCH: Cross-reference with Gesco (PhantomDirectory)
    // ====================================================
    window.nifAutoMatch = async function() {
        if (!window.PhantomDirectory || window.PhantomDirectory.length === 0) {
            alert('PhantomDirectory (gesco_clients.json) no está cargado. Espera unos segundos y reintenta.');
            return;
        }

        var statusEl = document.getElementById('nif-automatch-status');
        if (statusEl) { statusEl.style.display = 'block'; statusEl.innerHTML = 'Iniciando auto-match...'; }

        // Build normalized lookup from Gesco
        var gescoMap = {}; // normalized name → nif
        window.PhantomDirectory.forEach(function(g) {
            if (!g.nif || g.nif.trim().length < 8 || !g.name) return;
            var key = _normalizeName(g.name);
            if (key.length >= 3) gescoMap[key] = g.nif.trim().toUpperCase();
        });

        var source = _activeTab === 'global' ? _globalClients : _localClients;
        var matched = 0;
        var alreadyHad = 0;
        var noMatch = 0;
        var toSave = []; // [{client, nif}]

        source.forEach(function(c) {
            if (c.nif && c.nif.trim().length >= 8) { alreadyHad++; return; }
            var key = _normalizeName(c.name);
            if (gescoMap[key]) {
                toSave.push({ client: c, nif: gescoMap[key] });
                matched++;
            } else {
                noMatch++;
            }
        });

        if (statusEl) statusEl.innerHTML = 'Coincidencias encontradas: <strong style="color:#4CAF50;">' + matched + '</strong> | Ya tenían NIF: ' + alreadyHad + ' | Sin coincidencia: ' + noMatch;

        if (matched === 0) {
            if (statusEl) statusEl.innerHTML += '<br><span style="color:#FF9800;">No se encontraron coincidencias directas. Los nombres pueden diferir entre bases de datos.</span>';
            return;
        }

        // Confirm before saving
        if (!confirm('Se encontraron ' + matched + ' coincidencias.\n¿Guardar los NIFs en Firestore?')) return;

        if (statusEl) statusEl.innerHTML += '<br>Guardando en Firestore...';

        var saved = 0;
        var errors = 0;
        for (var i = 0; i < toSave.length; i++) {
            var item = toSave[i];
            try {
                if (_activeTab === 'global' && item.client.docId && _globalUserUid) {
                    await db.collection('users').doc(_globalUserUid)
                        .collection('destinations').doc(item.client.docId)
                        .update({ nif: item.nif });
                } else if (item.client.uid) {
                    await db.collection('users').doc(item.client.uid).update({ nif: item.nif });
                    if (typeof userMap !== 'undefined' && userMap[item.client.uid]) {
                        userMap[item.client.uid].nif = item.nif;
                    }
                }
                item.client.nif = item.nif;
                saved++;

                // Progress update every 20
                if (saved % 20 === 0 && statusEl) {
                    statusEl.innerHTML = 'Guardando... ' + saved + ' / ' + toSave.length;
                }
            } catch(e) {
                errors++;
                console.warn('[NIF AutoMatch] Error saving', item.client.name, e.message);
            }
        }

        if (statusEl) {
            statusEl.innerHTML = '<span style="color:#4CAF50; font-weight:bold;">Auto-Match completado: ' + saved + ' NIFs guardados.</span>' +
                (errors > 0 ? ' <span style="color:#FF5252;">' + errors + ' errores.</span>' : '') +
                ' | Ya tenían: ' + alreadyHad + ' | Sin coincidencia: ' + noMatch;
        }

        _updateStats();
        _updateTabCounts();
        _applyFilters();
    };

    // ====================================================
    // NAME NORMALIZATION for matching
    // ====================================================
    function _normalizeName(name) {
        if (!name) return '';
        return name
            .toUpperCase()
            .replace(/[.,;:'"()]/g, '')           // punctuation
            .replace(/\bS\.?L\.?U?\.?\b/g, '')    // S.L., S.L.U., SL
            .replace(/\bS\.?A\.?U?\.?\b/g, '')    // S.A., S.A.U., SA
            .replace(/\bS\.?C\.?P?\.?\b/g, '')    // S.C., S.C.P.
            .replace(/\bC\.?B\.?\b/g, '')          // C.B.
            .replace(/\bSOCIEDAD\s*(LIMITADA|ANONIMA|COOPERATIVA)\b/gi, '')
            .replace(/^(X|NO-)\s*/i, '')           // prefixes from import
            .replace(/\.{3,}.*$/, '')              // "AHORA 1534" style suffixes
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ====================================================
    // CLEAN NAME for web search
    // ====================================================
    function _cleanNameForSearch(name) {
        if (!name) return '';
        return name
            .replace(/^(X|NO-)\s*/i, '')
            .replace(/\.{3,}.*$/, '')
            .replace(/\s*,\s*/g, ' ')
            .trim();
    }

    // --- HELPERS ---
    function _showLoading(msg) {
        var el = document.getElementById('nif-client-list');
        if (el) el.innerHTML = '<div style="padding:30px; text-align:center; color:#aaa;"><span class="material-symbols-outlined" style="font-size:2rem; display:block; margin-bottom:8px;">hourglass_top</span>' + _esc(msg) + '</div>';
    }

    function _showError(msg) {
        var el = document.getElementById('nif-client-list');
        if (el) el.innerHTML = '<div style="padding:30px; text-align:center; color:#FF5252;"><span class="material-symbols-outlined" style="font-size:2rem; display:block; margin-bottom:8px;">error</span>' + _esc(msg) + '</div>';
    }

    function _esc(str) {
        var div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

})();
