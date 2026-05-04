// =============================================
// NOVAPACK ERP — Tab Engine v1.0
// =============================================
// Manages a Chrome-style tab bar within Facturación PRO.
// Each tab wraps a workspace/view, only one is visible at a time.

(function() {
    'use strict';

    // --- STATE ---
    const _tabs = [];       // Array of { id, title, icon, closeable, onLoad, loaded }
    let _activeTabId = null;

    // Maximum simultaneous open tabs
    const MAX_TABS = 12;

    const ALL_WS_IDS = [
        'adv-billing-workspace', 'adv-history-workspace', 'adv-reports-workspace',
        'adv-tariffs-workspace', 'adv-clients-workspace', 'conta-workspace',
        'adv-providers-workspace', 'adv-manual-tickets-workspace', 'adv-scanner-workspace',
        'erp-tab-inicio',
        'erp-tab-debidos', 'erp-tab-rutas', 'erp-tab-phones', 'erp-tab-config',
        'erp-tab-maintenance', 'erp-tab-pod', 'erp-tab-pending-deletes', 'erp-tab-driver-incidents', 'erp-tab-users',
        'erp-tab-ticket-search', 'erp-tab-ficha-cliente', 'erp-tab-albaranes-central', 'erp-tab-mailbox',
        'erp-tab-facturas-central', 'erp-tab-route-details', 'erp-tab-route-map', 'erp-tab-comunicaciones', 'erp-tab-nif-enrichment',
        'erp-tab-trash',
        'erp-tab-cooper',
        'erp-tab-analytics',
        'erp-tab-auto-assign',
        'erp-tab-heatmap'
    ];

    // --- TAB DEFINITIONS (built-in tabs that map to existing workspaces) ---
    const TAB_WORKSPACE_MAP = {
        'inicio':          { wsId: null,                         title: 'Inicio',            icon: 'home',               closeable: false },
        'factura':         { wsId: 'adv-billing-workspace',      title: 'Factura',           icon: 'description',        closeable: true },
        'history':         { wsId: 'adv-history-workspace',      title: 'Historial',         icon: 'receipt_long',       closeable: true },
        'reports':         { wsId: 'adv-reports-workspace',      title: 'Listados V4',       icon: 'bar_chart',          closeable: true },
        'tariffs':         { wsId: 'adv-tariffs-workspace',      title: 'Tarifas',           icon: 'paid',               closeable: true },
        'clients':         { wsId: 'adv-clients-workspace',      title: 'Clientes',          icon: 'group',              closeable: true },
        'providers':       { wsId: 'adv-providers-workspace',    title: 'Proveedores',       icon: 'factory',            closeable: true },
        'manual-tickets':  { wsId: 'adv-manual-tickets-workspace', title: 'Albaranes Man.',  icon: 'assignment',         closeable: true },
        'scanner':         { wsId: 'adv-scanner-workspace',      title: 'Escáner QR',        icon: 'qr_code_scanner',    closeable: true },
        'contabilidad':    { wsId: 'conta-workspace',            title: 'Contabilidad',      icon: 'menu_book',          closeable: true },
        // New tabs (sidebar views migrated)
        'debidos':         { wsId: 'erp-tab-debidos',            title: 'Portes Debidos',    icon: 'local_shipping',     closeable: true },
        'rutas':           { wsId: 'erp-tab-rutas',              title: 'Control Rutas',     icon: 'location_on',        closeable: true },
        'phones':          { wsId: 'erp-tab-phones',             title: 'Alertas Pickup',    icon: 'notifications',      closeable: true },
        'config':          { wsId: 'erp-tab-config',             title: 'Ajustes',           icon: 'settings',           closeable: true },
        'maintenance':     { wsId: 'erp-tab-maintenance',        title: 'DB Local',          icon: 'security',           closeable: true },
        'pod':             { wsId: 'erp-tab-pod',                title: 'Justificantes POD', icon: 'task',               closeable: true },
        'pending-deletes': { wsId: 'erp-tab-pending-deletes',    title: 'Anulaciones',       icon: 'notification_important', closeable: true },
        'driver-incidents': { wsId: 'erp-tab-driver-incidents',  title: 'Incidencias Reparto', icon: 'report_problem',     closeable: true },
        'users':           { wsId: 'erp-tab-users',              title: 'Gestión Clientes',  icon: 'group',              closeable: true },
        'ticket-search':   { wsId: 'erp-tab-ticket-search',      title: 'Buscar Albaranes',  icon: 'search',             closeable: true },
        'ficha-cliente':       { wsId: 'erp-tab-ficha-cliente',      title: 'Ficha Cliente',       icon: 'person',             closeable: true },
        'albaranes-central':  { wsId: 'erp-tab-albaranes-central',  title: 'Albaranes Central',   icon: 'inventory_2',        closeable: true },
        'mailbox':         { wsId: 'erp-tab-mailbox',            title: 'Buzón Correo',      icon: 'move_to_inbox',      closeable: true },
        'facturas-central':{ wsId: 'erp-tab-facturas-central',    title: 'Centro Facturación', icon: 'receipt_long',       closeable: true },
        'route-details':   { wsId: 'erp-tab-route-details',       title: 'Albaranes Ruta',     icon: 'route',              closeable: true },
        'route-map':       { wsId: 'erp-tab-route-map',           title: 'GPS Ruta',           icon: 'my_location',        closeable: true },
        'comunicaciones':  { wsId: 'erp-tab-comunicaciones',      title: 'Comunicaciones',     icon: 'campaign',           closeable: true },
        'nif-enrichment':  { wsId: 'erp-tab-nif-enrichment',      title: 'Enriquecer NIF',     icon: 'badge',              closeable: true },
        'trash':           { wsId: 'erp-tab-trash',               title: 'Papelera',           icon: 'delete',             closeable: true },
        'cooper':          { wsId: 'erp-tab-cooper',              title: 'Cooper',             icon: 'local_shipping',     closeable: true },
        'analytics':       { wsId: 'erp-tab-analytics',           title: 'Analítica',          icon: 'monitoring',         closeable: true },
        'auto-assign':     { wsId: 'erp-tab-auto-assign',         title: 'Auto-asignar',       icon: 'auto_awesome',       closeable: true },
        'heatmap':         { wsId: 'erp-tab-heatmap',             title: 'Heatmap retrasos',   icon: 'whatshot',           closeable: true },
    };

    // --- CORE API ---

    /**
     * Open a tab (or focus it if already open)
     * @param {string} tabId - Unique tab identifier (key from TAB_WORKSPACE_MAP or custom)
     * @param {object} opts - Optional: { title, icon, closeable, onLoad }
     */
    window.erpOpenTab = function(tabId, opts = {}) {
        // If already open, just focus it
        const existing = _tabs.find(t => t.id === tabId);
        if (existing) {
            _activateTab(tabId);
            return;
        }

        // Enforce max tabs
        if (_tabs.length >= MAX_TABS) {
            // Close the oldest closeable tab
            const oldest = _tabs.find(t => t.closeable && t.id !== _activeTabId);
            if (oldest) erpCloseTab(oldest.id);
        }

        // Get definition
        const def = TAB_WORKSPACE_MAP[tabId] || {};
        const tab = {
            id: tabId,
            title: opts.title || def.title || tabId,
            icon: opts.icon || def.icon || 'tab',
            closeable: opts.closeable !== undefined ? opts.closeable : (def.closeable !== undefined ? def.closeable : true),
            onLoad: opts.onLoad || null,
            wsId: def.wsId || null,
            loaded: false
        };

        _tabs.push(tab);
        _renderTabBar();
        _activateTab(tabId);
    };

    /**
     * Close a tab
     */
    window.erpCloseTab = function(tabId) {
        const idx = _tabs.findIndex(t => t.id === tabId);
        if (idx === -1) return;
        const tab = _tabs[idx];
        if (!tab.closeable) return;

        // Stop scanner if closing scanner tab
        if (tabId === 'scanner' && typeof window.advStopScanner === 'function') {
            window.advStopScanner();
        }

        // Hide the workspace
        _hideWorkspace(tab);

        _tabs.splice(idx, 1);

        // If we closed the active tab, activate the previous one
        if (_activeTabId === tabId) {
            const newActive = _tabs.length > 0 ? _tabs[Math.max(0, idx - 1)].id : null;
            if (newActive) _activateTab(newActive);
        }

        _renderTabBar();
    };

    /**
     * Get the active tab ID
     */
    window.erpGetActiveTab = function() {
        return _activeTabId;
    };

    // --- INTERNAL ---

    function _activateTab(tabId) {
        const tab = _tabs.find(t => t.id === tabId);
        if (!tab) return;

        // Hide ALL known workspaces (not just open tabs — critical for panels like adv-billing-workspace that start visible)
        ALL_WS_IDS.forEach(wsId => {
            const el = document.getElementById(wsId);
            if (el) {
                el.style.display = 'none';
                el.style.position = '';
                el.style.top = '';
                el.style.left = '';
                el.style.width = '';
                el.style.height = '';
                el.style.zIndex = '';
            }
        });

        // Show the target workspace
        _showWorkspace(tab);

        _activeTabId = tabId;
        _renderTabBar();

        // Fire onLoad callback on first activation
        if (!tab.loaded && tab.onLoad) {
            tab.onLoad();
            tab.loaded = true;
        }

        // Auto-trigger load functions for known tabs
        if (!tab.loaded) {
            _autoLoadTab(tabId);
            tab.loaded = true;
        }
    }

    // Map of legacy sidebar view IDs -> tab container IDs for content migration
    const VIEW_TO_TAB_MIGRATION = {
        'view-pod-panel': 'erp-tab-pod',
        'view-phones': 'erp-tab-phones',
        'view-config': 'erp-tab-config',
        'view-maintenance': 'erp-tab-maintenance',
        'view-pending-deletes': 'erp-tab-pending-deletes',
        'view-users': 'erp-tab-users',
    };

    function _migrateViewContent(tabId) {
        // Find the mapping for this tab
        const tabContainerId = 'erp-tab-' + tabId;
        const tabContainer = document.getElementById(tabContainerId);
        if (!tabContainer) return;
        
        // If the tab already has real content, skip
        if (tabContainer.children.length > 0) return;

        // Find the legacy view that matches
        for (const [viewId, targetId] of Object.entries(VIEW_TO_TAB_MIGRATION)) {
            if (targetId === tabContainerId) {
                const legacyView = document.getElementById(viewId);
                if (legacyView && legacyView.innerHTML.trim().length > 0) {
                    // Move all children from legacy view into tab container
                    while (legacyView.firstChild) {
                        tabContainer.appendChild(legacyView.firstChild);
                    }
                    legacyView.style.display = 'none';
                    console.log(`[ERP Tabs] Migrated content from ${viewId} → ${targetId}`);
                }
                break;
            }
        }
    }

    function _autoLoadTab(tabId) {
        // Migrate legacy view content into the tab container first
        _migrateViewContent(tabId);
        
        switch(tabId) {
            case 'clients':
                if (typeof window.advLoadClients === 'function') window.advLoadClients();
                break;
            case 'providers':
                if (typeof window.advLoadProviders === 'function') window.advLoadProviders();
                break;
            case 'manual-tickets':
                if (typeof window.advInitManualTickets === 'function') window.advInitManualTickets();
                break;
            case 'scanner':
                setTimeout(() => { if (typeof window.advStartScanner === 'function') window.advStartScanner(); }, 500);
                break;
            case 'tariffs':
                if (typeof window.loadTariffClients === 'function') window.loadTariffClients();
                if (typeof window.loadArticlesCount === 'function') window.loadArticlesCount();
                break;
            case 'debidos':
                if (typeof window.loadDebidosManager === 'function') window.loadDebidosManager();
                // Add export button for debidos
                setTimeout(() => {
                    if (typeof addExportButton === 'function') {
                        addExportButton('erp-tab-debidos', () => {
                            return (window.debidosTicketsCache || []).map(t => ({
                                'Fecha': t.createdAt && typeof t.createdAt.toDate === 'function' ? t.createdAt.toDate().toLocaleDateString('es-ES') : '',
                                'Nº Albarán': t.id || t.docId || '',
                                'Remitente': t.senderName || '',
                                'Destinatario': t.receiver || '',
                                'Dirección': t.receiverAddress || '',
                                'Ciudad': t.city || '',
                                'Bultos': t.packages || t.bultos || 0,
                                'Kilos': t.weight || t.kilos || 0,
                                'Tipo': t.shippingType || ''
                            }));
                        }, 'portes_debidos');
                    }
                }, 500);
                break;
            case 'rutas':
                if (typeof window.loadRouteMonitor === 'function') window.loadRouteMonitor();
                break;
            case 'phones':
                if (typeof window.loadPhonesManager === 'function') window.loadPhonesManager();
                // If loadPhonesManager didn't exist, try the internal loadPhones
                else {
                    setTimeout(() => { if (typeof window.loadPhones === 'function') window.loadPhones(); }, 300);
                }
                break;
            case 'config':
                if (typeof window.loadConfigView === 'function') window.loadConfigView();
                break;
            case 'pod':
                // POD doesn't need a load function — the view has inline search logic
                break;
            case 'pending-deletes':
                if (typeof window.loadPendingDeletes === 'function') window.loadPendingDeletes();
                break;
            case 'driver-incidents':
                if (typeof window.loadDriverIncidents === 'function') window.loadDriverIncidents();
                break;
            case 'contabilidad':
                if (typeof window.toggleContabilidad === 'function') window.toggleContabilidad();
                break;
            case 'mailbox':
                if (typeof window.loadMailbox === 'function') window.loadMailbox();
                break;
            case 'comunicaciones':
                if (typeof window.loadComunicaciones === 'function') window.loadComunicaciones();
                break;
            case 'nif-enrichment':
                if (typeof window.loadNifEnrichment === 'function') window.loadNifEnrichment();
                break;
            case 'facturas-central':
                if (typeof window.facCentralInit === 'function') window.facCentralInit();
                break;
            case 'trash':
                if (typeof window.loadTrashBin === 'function') window.loadTrashBin();
                break;
            case 'cooper':
                if (typeof window.loadCooperPanel === 'function') window.loadCooperPanel();
                break;
        }
    }


    function _hideWorkspace(tab) {
        const wsId = tab.wsId || ('erp-tab-' + tab.id);
        const el = document.getElementById(wsId);
        if (el) {
            el.style.display = 'none';
            // Reset any fixed positioning from legacy toggleAdvWorkspace
            el.style.position = '';
            el.style.top = '';
            el.style.left = '';
            el.style.width = '';
            el.style.height = '';
            el.style.zIndex = '';
        }
    }

    function _showWorkspace(tab) {
        const wsId = tab.wsId || ('erp-tab-' + tab.id);
        const el = document.getElementById(wsId);
        if (el) {
            el.style.display = 'flex';
            el.style.flexDirection = 'column';
            el.style.flex = '1';
            el.style.overflow = 'auto';
            el.style.width = '100%';
            el.style.background = '#1e1e1e';
        }

        // Show/hide main toolbar based on whether we're on the invoice tab
        const mainToolbar = document.getElementById('adv-main-toolbar');
        if (mainToolbar) {
            // Always show toolbar — the dropdowns are the navigation now
            mainToolbar.style.display = 'flex';
        }
    }

    // --- RENDER TAB BAR ---

    function _renderTabBar() {
        const bar = document.getElementById('erp-tab-bar');
        if (!bar) return;

        bar.innerHTML = '';

        _tabs.forEach(tab => {
            const isActive = tab.id === _activeTabId;
            const tabEl = document.createElement('div');
            tabEl.className = 'erp-tab' + (isActive ? ' erp-tab-active' : '');
            tabEl.setAttribute('data-tab-id', tab.id);

            let html = `<span class="material-symbols-outlined erp-tab-icon">${tab.icon}</span>`;
            html += `<span class="erp-tab-title">${tab.title}</span>`;
            if (tab.closeable) {
                html += `<span class="erp-tab-close" onclick="event.stopPropagation(); erpCloseTab('${tab.id}')">×</span>`;
            }

            tabEl.innerHTML = html;
            tabEl.addEventListener('click', () => _activateTab(tab.id));

            bar.appendChild(tabEl);
        });
    }

    // --- BACKWARDS COMPATIBILITY ---

    // Override toggleAdvWorkspace to use tabs
    const _originalToggle = window.toggleAdvWorkspace;
    window.toggleAdvWorkspace = function(workspace) {
        if (!workspace || workspace === 'main') {
            erpOpenTab('factura');
        } else {
            erpOpenTab(workspace);
        }
    };

    // Override showView for sidebar views that are now tabs
    const _originalShowView = window.showView;
    window.showView = function(viewId) {
        // Map old sidebar view IDs to tab IDs
        const viewToTab = {
            'adv-billing': 'factura',
            'debidos': 'debidos',
            'users': 'users',
            'admin-tickets': 'manual-tickets',
            'route-monitor': 'rutas',
            'phones': 'phones',
            'config': 'config',
            'maintenance': 'maintenance',
            'pod-panel': 'pod',
            'pending-deletes': 'pending-deletes',
            'welcome': 'inicio',
            'billing': 'factura',
            'qr-scanner-view': 'scanner',
        };

        const tabId = viewToTab[viewId];
        if (tabId) {
            // Make sure we're in PRO view first
            const proView = document.getElementById('view-adv-billing');
            if (proView && proView.style.display === 'none') {
                proView.style.display = 'flex';
            }
            erpOpenTab(tabId);
        } else if (_originalShowView) {
            // Fallback to original for any unmapped views
            _originalShowView(viewId);
        }
    };

    // Override toggleContabilidad
    window.toggleContabilidad = function() {
        erpOpenTab('contabilidad');
    };

    // Override toggleAdvTariffs
    window.toggleAdvTariffs = function() {
        erpOpenTab('tariffs');
    };

    // --- INITIALIZATION ---
    // Called by setAdminIdentity() after the user picks their identity.

    window.erpInitTabs = function() {
        if (window._erpInitialized) { console.log('[ERP Tabs] Already initialized, skipping'); return; }
        window._erpInitialized = true;
        // Activate ERP mode — CSS rules hide sidebar, mobile-header, and main-content
        document.body.classList.add('erp-mode-active');

        var proView = document.getElementById('view-adv-billing');
        if (proView) {
            // CRITICAL FIX: Relocate proView outside of main-content to avoid inherited margins or display:none issues
            if (proView.parentElement !== document.body) {
                document.body.appendChild(proView);
            }

            // Move modals OUT of main-content so they won't be hidden by display:none !important
            ['mailbox-modal', 'view-pod-panel'].forEach(function(modalId) {
                var modal = document.getElementById(modalId);
                if (modal && modal.parentElement !== document.body) {
                    document.body.appendChild(modal);
                }
            });

            // Move tab containers from body into view-adv-billing so they participate in PRO flex layout
            var tabContainerIds = [
                'erp-tab-inicio', 'erp-tab-debidos', 'erp-tab-rutas', 'erp-tab-phones',
                'erp-tab-config', 'erp-tab-maintenance', 'erp-tab-pod',
                'erp-tab-pending-deletes', 'erp-tab-driver-incidents', 'erp-tab-users', 'erp-tab-ficha-cliente', 'erp-tab-albaranes-central',
                'adv-billing-workspace', 'adv-history-workspace', 'adv-reports-workspace', 'adv-tariffs-workspace',
                'adv-clients-workspace', 'adv-providers-workspace', 'adv-manual-tickets-workspace',
                'adv-scanner-workspace', 'erp-tab-mailbox', 'erp-tab-facturas-central', 'erp-tab-route-details',
                'erp-tab-route-map', 'erp-tab-comunicaciones', 'erp-tab-nif-enrichment', 'erp-tab-trash', 'erp-tab-cooper'
            ];
            tabContainerIds.forEach(function(id) {
                var el = document.getElementById(id);
                if (el && el.parentElement !== proView) {
                    proView.appendChild(el);
                }
            });
        }

        // Hide all workspace panels initially
        ALL_WS_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        // Open the "Inicio" tab
        erpOpenTab('inicio');
        console.log('[ERP Tabs] Initialized — ERP mode active, sidebar hidden');
    };
    // --- AUTO-INIT ---
    // If a session identity exists, auto-initialize the ERP layout.
    // This runs as soon as the script is parsed (which is at the bottom of admin.html),
    // guaranteeing all DOM elements are available.
    (function autoInit() {
        // CRITICAL FIX: Always clear sessionStorage on fresh page load
        // so the identity picker is shown every time.
        // The identity is ONLY persisted during same-page navigation (tab switches etc.)
        // but a full page load (F5, new tab, or URL entry) forces re-identification.
        var wasJustSet = sessionStorage.getItem('adminIdentityJustSet');
        if (wasJustSet) {
            // Identity was just set by the picker — allow auto-init this one time
            sessionStorage.removeItem('adminIdentityJustSet');
            var savedIdentity = sessionStorage.getItem('adminActiveIdentity');
            if (savedIdentity) {
                console.log('[ERP Tabs] Auto-init: identity just set =', savedIdentity);

                // 1. Force ERP mode on body
                document.body.classList.add('erp-mode-active');

                // 2. Hide legacy elements
                var sidebar = document.getElementById('sidebar');
                if (sidebar) sidebar.style.display = 'none';
                var mobileH = document.querySelector('.mobile-header');
                if (mobileH) mobileH.style.display = 'none';
                var mainContent = document.getElementById('main-content');
                if (mainContent) mainContent.style.display = 'none';

                // 3. Show PRO ERP fullscreen
                var proView = document.getElementById('view-adv-billing');
                if (proView) {
                    proView.style.display = 'flex';
                    proView.style.left = '0';
                    proView.style.width = '100%';
                    proView.style.top = '0';
                    proView.style.position = 'fixed';
                    proView.style.height = '100vh';
                    proView.style.zIndex = '30000';
                }

                // 4. Set welcome name + toolbar identity
                var erpName = document.getElementById('erp-welcome-name');
                if (erpName) erpName.textContent = savedIdentity;
                var toolbarId = document.getElementById('erp-toolbar-identity');
                if (toolbarId) toolbarId.textContent = '👤 ' + savedIdentity;

                // 5. Set admin identity globally
                window.adminIdentity = savedIdentity;

                // 6. Run full tab init
                try {
                    window.erpInitTabs();
                } catch(e) {
                    console.error('[ERP Tabs] Auto-init error:', e);
                }

                // 7. Prevent re-running on window.load
                window._erpAutoInitDone = true;
                return; // Done
            }
        }

        // Clear any stale session identity — force the picker on every load
        sessionStorage.removeItem('adminActiveIdentity');
        window.adminIdentity = null;
        console.log('[ERP Tabs] No active session — showing identity picker in ERP Inicio tab');

        // Instead of showing the old view-welcome, initialize the ERP directly
        // The erp-tab-inicio now contains the identity picker built-in
        document.body.classList.add('erp-mode-active');

        // Hide legacy elements
        var sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.style.display = 'none';
        var mobileH = document.querySelector('.mobile-header');
        if (mobileH) mobileH.style.display = 'none';
        var mainContent = document.getElementById('main-content');
        if (mainContent) mainContent.style.display = 'none';

        // Show PRO ERP fullscreen
        var proView = document.getElementById('view-adv-billing');
        if (proView) {
            proView.style.display = 'flex';
            proView.style.left = '0';
            proView.style.width = '100%';
            proView.style.top = '0';
            proView.style.position = 'fixed';
            proView.style.height = '100vh';
            proView.style.zIndex = '30000';
        }

        // Run full tab init — will show Inicio tab with identity picker
        try {
            window.erpInitTabs();
        } catch(e) {
            console.error('[ERP Tabs] Init error:', e);
        }
    })();

})();
