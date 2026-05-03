// =============================================
// NOVAPACK REPARTO — App de Repartidor v4
// GPS Route + Drag & Drop + Notifications
// =============================================

(function() {
'use strict';

// --- GLOBALS ---
var currentDriverPhone = '';
var currentDriverName = '';
var currentRouteLabel = '';
var deliveries = [];
var manualOrder = null; // array of docIds if user has manually reordered
var currentFilter = 'pending';
var confirmationResult = null;
var qrScanner = null;
var googleMap = null;
var mapMarkers = [];
var currentScanDoc = null;
var unsubscribe = null;
var modDocId = null;
var dragSrcIndex = null;
var knownDeliveryIds = new Set(); // To detect NEW deliveries
var confirmInProgress = false; // Guard: prevent snapshot re-render during delivery confirmation
var scannedPackages = {}; // { ticketId: Set([1, 2, 3]) } — tracks scanned bultos
var currentPkgTotal = 0; // total packages expected for current scan
var isFirstSnapshot = true; // Skip notifications on initial load
var notificationSound = null;
var _isMasterPinSession = false; // Flag to prevent onAuthStateChanged interference

// --- GPS LIVE TRACKING ---
var _gpsWatchId = null;
var _gpsLastSent = 0;
var _GPS_SEND_INTERVAL = 30000; // Send position every 30 seconds
var _wakeLockSentinel = null;
var _gpsRetryTimer = null;
var _gpsRetryCount = 0;
var _GPS_MAX_RETRIES = 5;
var _GPS_RETRY_DELAYS = [3000, 5000, 10000, 20000, 30000]; // Escalating retry delays
var _gpsTrackingEnabled = false; // Flag: should tracking be active?
var _gpsLastPosition = null; // Last known good position timestamp
var _gpsHealthCheckTimer = null;
var _GPS_HEALTH_INTERVAL = 60000; // Check GPS health every 60 seconds
var _GPS_STALE_THRESHOLD = 120000; // Position stale after 2 minutes

function startGPSTracking() {
    _gpsTrackingEnabled = true;
    _gpsRetryCount = 0;
    _startGPSWatch();
}

function _startGPSWatch() {
    // Clean up any existing watch first
    if (_gpsWatchId !== null) {
        navigator.geolocation.clearWatch(_gpsWatchId);
        _gpsWatchId = null;
    }
    if (_gpsRetryTimer) {
        clearTimeout(_gpsRetryTimer);
        _gpsRetryTimer = null;
    }

    if (!_gpsTrackingEnabled) return;

    if (!navigator.geolocation) {
        console.warn('[GPS-TRACK] Geolocation not available');
        _updateGPSIndicator('error', 'GPS no disponible');
        return;
    }

    console.log('[GPS-TRACK] Starting live GPS tracking...');
    _updateGPSIndicator('searching', 'Buscando GPS...');

    _gpsWatchId = navigator.geolocation.watchPosition(
        function(pos) {
            // Reset retry count on successful position
            _gpsRetryCount = 0;
            _gpsLastPosition = Date.now();

            var now = Date.now();
            if (now - _gpsLastSent < _GPS_SEND_INTERVAL) {
                // Still update indicator even if throttled
                if (pos.coords.accuracy > 100) {
                    _updateGPSIndicator('weak', 'GPS: ~' + Math.round(pos.coords.accuracy) + 'm');
                } else {
                    _updateGPSIndicator('active', 'GPS activo');
                }
                return;
            }
            _gpsLastSent = now;

            var locationData = {
                phone: currentDriverPhone,
                driverName: currentDriverName,
                routeLabel: currentRouteLabel,
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: Math.round(pos.coords.accuracy),
                speed: pos.coords.speed !== null ? Math.round(pos.coords.speed * 3.6) : null, // m/s → km/h
                heading: pos.coords.heading,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                online: true
            };

            // Update indicator based on accuracy
            if (pos.coords.accuracy > 100) {
                _updateGPSIndicator('weak', 'GPS: ~' + Math.round(pos.coords.accuracy) + 'm');
            } else {
                _updateGPSIndicator('active', 'GPS activo');
            }

            var docId = currentDriverPhone.replace(/[^a-zA-Z0-9]/g, '_');
            db.collection('driver_locations').doc(docId).set(locationData, { merge: true })
                .then(function() { console.log('[GPS-TRACK] Position sent:', locationData.lat.toFixed(4), locationData.lng.toFixed(4), 'accuracy:', locationData.accuracy + 'm'); })
                .catch(function(e) {
                    console.warn('[GPS-TRACK] Error sending position:', e.message);
                    // Queue for offline sync
                    if (typeof enqueueOfflineAction === 'function') {
                        enqueueOfflineAction({ type: 'gps_update', docId: docId, data: locationData });
                    }
                });
        },
        function(err) {
            console.warn('[GPS-TRACK] GPS error (code ' + err.code + '):', err.message);

            if (err.code === 1) {
                // PERMISSION_DENIED - user blocked GPS
                _updateGPSIndicator('error', 'GPS bloqueado');
                showToast('Ubicacion bloqueada. Activa el GPS en los ajustes del navegador.', 'error');
                // Don't retry permission denied - user must fix manually
                _gpsWatchId = null;
                return;
            }

            if (err.code === 2) {
                // POSITION_UNAVAILABLE - hardware/network issue
                _updateGPSIndicator('error', 'GPS no disponible');
            } else if (err.code === 3) {
                // TIMEOUT
                _updateGPSIndicator('searching', 'Buscando GPS...');
            }

            // Auto-retry with escalating delay
            _gpsWatchId = null;
            _scheduleGPSRetry();
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );

    // Wake Lock to keep GPS alive while screen is on
    requestGPSWakeLock();

    // Start health check timer
    _startGPSHealthCheck();
}

function _scheduleGPSRetry() {
    if (!_gpsTrackingEnabled) return;
    if (_gpsRetryCount >= _GPS_MAX_RETRIES) {
        console.warn('[GPS-TRACK] Max retries reached, waiting for visibility change or manual restart');
        _updateGPSIndicator('error', 'GPS perdido');
        showToast('No se puede obtener la ubicacion. Verifica que el GPS esta activo.', 'error');
        return;
    }

    var delay = _GPS_RETRY_DELAYS[Math.min(_gpsRetryCount, _GPS_RETRY_DELAYS.length - 1)];
    _gpsRetryCount++;
    console.log('[GPS-TRACK] Retrying in ' + (delay/1000) + 's (attempt ' + _gpsRetryCount + '/' + _GPS_MAX_RETRIES + ')');
    _updateGPSIndicator('searching', 'Reintentando GPS...');

    _gpsRetryTimer = setTimeout(function() {
        _gpsRetryTimer = null;
        _startGPSWatch();
    }, delay);
}

function _startGPSHealthCheck() {
    if (_gpsHealthCheckTimer) clearInterval(_gpsHealthCheckTimer);
    _gpsHealthCheckTimer = setInterval(function() {
        if (!_gpsTrackingEnabled || _gpsWatchId === null) return;
        // If we haven't received a position in GPS_STALE_THRESHOLD, restart
        if (_gpsLastPosition && (Date.now() - _gpsLastPosition > _GPS_STALE_THRESHOLD)) {
            console.warn('[GPS-TRACK] Position stale (' + Math.round((Date.now() - _gpsLastPosition)/1000) + 's), restarting watch...');
            _updateGPSIndicator('searching', 'Reconectando GPS...');
            _gpsRetryCount = 0;
            _startGPSWatch();
        }
    }, _GPS_HEALTH_INTERVAL);
}

function stopGPSTracking() {
    _gpsTrackingEnabled = false;

    if (_gpsRetryTimer) {
        clearTimeout(_gpsRetryTimer);
        _gpsRetryTimer = null;
    }
    if (_gpsHealthCheckTimer) {
        clearInterval(_gpsHealthCheckTimer);
        _gpsHealthCheckTimer = null;
    }
    if (_gpsWatchId !== null) {
        navigator.geolocation.clearWatch(_gpsWatchId);
        _gpsWatchId = null;
        console.log('[GPS-TRACK] Stopped GPS tracking.');
    }

    _updateGPSIndicator('off', '');

    // Mark driver as offline in Firestore
    if (currentDriverPhone) {
        var docId = currentDriverPhone.replace(/[^a-zA-Z0-9]/g, '_');
        db.collection('driver_locations').doc(docId).update({
            online: false,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function() {});
    }

    releaseGPSWakeLock();
}

function _updateGPSIndicator(status, text) {
    var el = document.getElementById('gps-status-indicator');
    if (!el) return;
    var dot = el.querySelector('.gps-dot');
    var label = el.querySelector('.gps-label');

    el.style.display = 'flex';
    if (label) label.textContent = text;

    if (dot) {
        dot.className = 'gps-dot';
        if (status === 'active') {
            dot.classList.add('gps-active');
        } else if (status === 'weak') {
            dot.classList.add('gps-weak');
        } else if (status === 'searching') {
            dot.classList.add('gps-searching');
        } else if (status === 'error') {
            dot.classList.add('gps-error');
        } else if (status === 'off') {
            el.style.display = 'none';
        }
    }
}

function requestGPSWakeLock() {
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').then(function(sentinel) {
            _wakeLockSentinel = sentinel;
            sentinel.addEventListener('release', function() { _wakeLockSentinel = null; });
        }).catch(function(e) { console.warn('[GPS-TRACK] Wake Lock denied:', e.message); });
    }
}

function releaseGPSWakeLock() {
    if (_wakeLockSentinel) {
        _wakeLockSentinel.release().catch(function() {});
        _wakeLockSentinel = null;
    }
}

// Re-acquire wake lock AND restart GPS when page becomes visible again
document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && _gpsTrackingEnabled) {
        console.log('[GPS-TRACK] Page visible again, recovering GPS...');
        requestGPSWakeLock();
        // Reset retry count on visibility change - fresh start
        _gpsRetryCount = 0;
        // Restart GPS watch to ensure fresh position after background
        _startGPSWatch();
    }
});

// Handle bfcache restore (iOS Safari back/forward cache)
window.addEventListener('pageshow', function(event) {
    if (event.persisted && _gpsTrackingEnabled) {
        console.log('[GPS-TRACK] Page restored from bfcache, restarting GPS...');
        _gpsRetryCount = 0;
        _startGPSWatch();
    }
});

// Handle device coming back online
window.addEventListener('online', function() {
    if (_gpsTrackingEnabled && _gpsWatchId === null) {
        console.log('[GPS-TRACK] Device back online, restarting GPS...');
        _gpsRetryCount = 0;
        _startGPSWatch();
    }
});

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// --- NOTIFICATION SYSTEM ---
function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(function(perm) {
            if (perm === 'granted') {
                showToast('Notificaciones activadas.', 'success');
            }
        });
    }
}

function sendNotification(title, body, onTapCallback) {
    // 1. In-app toast (longer duration for visibility)
    showToast(body, 'success', 8000);

    // 2. Play alert sound EVERY TIME (fresh oscillator)
    try {
        var actx = new (window.AudioContext || window.webkitAudioContext)();
        // Double beep for urgency
        function beep(freq, startTime, duration) {
            var osc = actx.createOscillator();
            var gain = actx.createGain();
            osc.connect(gain);
            gain.connect(actx.destination);
            osc.frequency.value = freq;
            gain.gain.value = 0.4;
            osc.start(actx.currentTime + startTime);
            osc.stop(actx.currentTime + startTime + duration);
        }
        beep(880, 0, 0.15);
        beep(1100, 0.2, 0.15);
        beep(880, 0.4, 0.2);
        setTimeout(function() { actx.close(); }, 1000);
    } catch (e) { console.warn('Sound error:', e); }

    // 3. Vibrate (mobile)
    try {
        if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 300]);
    } catch (e) {}

    // 4. Browser notification (desktop / PWA / Android)
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistration().then(function(reg) {
                    if (reg) {
                        reg.showNotification(title, {
                            body: body,
                            icon: 'icon_new.png',
                            badge: 'icon_new.png',
                            tag: 'reparto-' + Date.now(),
                            requireInteraction: true,
                            vibrate: [200, 100, 200, 100, 300]
                        });
                    } else {
                        // Fallback
                        new Notification(title, { body: body, icon: 'icon_new.png' });
                    }
                });
            } else {
                new Notification(title, { body: body, icon: 'icon_new.png' });
            }
        } catch (e) { console.warn('Notification error:', e); }
    }

    // 5. Persistent in-app banner (visible until dismissed)
    try {
        var existing = document.getElementById('new-delivery-banner');
        if (existing) existing.remove();
        var banner = document.createElement('div');
        banner.id = 'new-delivery-banner';
        banner.style.cssText = 'position:fixed; top:0; left:0; width:100%; z-index:9998; background:linear-gradient(135deg,#FF4D00,#FF6600); color:white; padding:14px 20px; font-weight:800; font-size:0.9rem; text-align:center; cursor:pointer; box-shadow:0 4px 20px rgba(255,77,0,0.5); animation:slideDown 0.3s ease;';
        banner.innerHTML = '\ud83d\udce6 <span style="text-decoration:underline;">' + escapeHtml(title) + '</span> \u2014 ' + escapeHtml(body) + ' <span style="opacity:0.7; font-size:0.75rem; margin-left:10px;">(toca para ver)</span>';
        banner.onclick = function() { banner.remove(); if (typeof onTapCallback === 'function') onTapCallback(); };
        document.body.appendChild(banner);
        // Auto-remove after 20s
        setTimeout(function() { if (banner.parentNode) banner.remove(); }, 20000);
    } catch (e) {}
}

// --- TOAST SYSTEM (with sound & vibration) ---
var _toastAudioCtx = null;
function _toastBeep(freq, ms) {
    try {
        if (!_toastAudioCtx) _toastAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = _toastAudioCtx.createOscillator();
        var gain = _toastAudioCtx.createGain();
        osc.connect(gain); gain.connect(_toastAudioCtx.destination);
        osc.frequency.value = freq;
        gain.gain.value = 0.3;
        osc.start(); osc.stop(_toastAudioCtx.currentTime + (ms / 1000));
    } catch(e) {}
}
function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 3000;
    var container = document.getElementById('toast-container');
    if (!container) return;
    var t = document.createElement('div');
    t.className = 'toast ' + type;
    var icons = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info' };
    t.innerHTML = '<span class="material-symbols-outlined icon-filled">' + (icons[type] || 'info') + '</span><span>' + escapeHtml(message) + '</span>';
    container.appendChild(t);

    // Sound + vibration by type
    if (type === 'success') { _toastBeep(880, 150); }
    else if (type === 'error') { _toastBeep(300, 300); }
    else if (type === 'warning') { _toastBeep(600, 200); }
    if (type === 'error' || type === 'warning') {
        try { navigator.vibrate && navigator.vibrate(type === 'error' ? [200, 100, 200] : [150]); } catch(e) {}
    }

    setTimeout(function() {
        t.classList.add('hide');
        setTimeout(function() { t.remove(); }, 300);
    }, duration);
}

// --- IMAGE COMPRESSION (resize + compress before upload) ---
function compressImage(file, maxWidth, quality) {
    maxWidth = maxWidth || 1200;
    quality = quality || 0.65;
    return new Promise(function(resolve) {
        // If file is small enough (<500KB), skip compression
        if (file.size < 500000) { resolve(file); return; }
        var reader = new FileReader();
        reader.onload = function(e) {
            var img = new Image();
            img.onload = function() {
                var w = img.width, h = img.height;
                if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
                var canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                canvas.toBlob(function(blob) {
                    if (blob && blob.size < file.size) {
                        resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
                    } else {
                        resolve(file); // Original smaller, keep it
                    }
                }, 'image/jpeg', quality);
            };
            img.onerror = function() { resolve(file); };
            img.src = e.target.result;
        };
        reader.onerror = function() { resolve(file); };
        reader.readAsDataURL(file);
    });
}

// --- HELPERS ---
function showLoading() { document.getElementById('loading-overlay').classList.add('active'); }
function hideLoading() { document.getElementById('loading-overlay').classList.remove('active'); }
function normalizePhone(p) {
    var digits = (p || '').toString().replace(/\D/g, '');
    // Strip Spanish country prefixes: 0034, 34
    if (digits.length > 9 && digits.indexOf('0034') === 0) digits = digits.slice(4);
    else if (digits.length > 9 && digits.indexOf('34') === 0) digits = digits.slice(2);
    // Canonical: last 9 digits (Spanish national number length)
    if (digits.length > 9) digits = digits.slice(-9);
    return digits;
}

function getPackageCount(d) {
    if (d.packagesList && d.packagesList.length > 0) {
        return d.packagesList.reduce(function(sum, p) { return sum + (parseInt(p.qty) || 1); }, 0);
    }
    return d.packages || 1;
}

// --- HAVERSINE DISTANCE (km) ---
function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- GPS ROUTE SORT (Nearest Neighbor) ---
function sortByGPSProximity(items, startLat, startLon) {
    // Only sort items that have coordinates
    var withCoords = items.filter(function(d) { return d._lat && d._lon; });
    var withoutCoords = items.filter(function(d) { return !d._lat || !d._lon; });

    if (withCoords.length === 0) return items;

    var sorted = [];
    var remaining = withCoords.slice();
    var curLat = startLat;
    var curLon = startLon;

    while (remaining.length > 0) {
        var nearest = 0;
        var nearestDist = Infinity;
        for (var i = 0; i < remaining.length; i++) {
            var dist = haversine(curLat, curLon, remaining[i]._lat, remaining[i]._lon);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = i;
            }
        }
        var next = remaining.splice(nearest, 1)[0];
        sorted.push(next);
        curLat = next._lat;
        curLon = next._lon;
    }

    // Append items without coords at the end
    return sorted.concat(withoutCoords);
}

// --- GEOCODE ADDRESS (Google Maps, cached) ---
var geocodeCache = {};
var _geocoder = null;
async function geocodeAddress(d) {
    if (d._lat && d._lon) return; // already geocoded
    var addr = [d.address, d.localidad, d.cp, d.province, 'España'].filter(Boolean).join(', ');
    if (!addr || addr === 'España') return;

    if (geocodeCache[addr]) {
        d._lat = geocodeCache[addr].lat;
        d._lon = geocodeCache[addr].lon;
        return;
    }

    try {
        if (!_geocoder) _geocoder = new google.maps.Geocoder();
        var result = await _geocoder.geocode({ address: addr, region: 'es' });
        if (result.results && result.results[0]) {
            var loc = result.results[0].geometry.location;
            d._lat = loc.lat();
            d._lon = loc.lng();
            geocodeCache[addr] = { lat: d._lat, lon: d._lon };
        }
    } catch (e) { console.warn('Geocode error:', addr, e); }
}

// --- WAIT FOR FIREBASE ---
function waitForFirebase(cb) {
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.firestore) {
        cb();
    } else {
        setTimeout(function() { waitForFirebase(cb); }, 100);
    }
}

// ============================================================
//  OFFLINE QUEUE — IndexedDB-backed retry system
// ============================================================
var _offlineQueue = {
    DB_NAME: 'novapack_offline',
    STORE: 'pending_ops',
    DB_VERSION: 1,
    _db: null,
    _processing: false,

    open: function() {
        var self = this;
        return new Promise(function(resolve, reject) {
            if (self._db) { resolve(self._db); return; }
            var req = indexedDB.open(self.DB_NAME, self.DB_VERSION);
            req.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains(self.STORE)) {
                    db.createObjectStore(self.STORE, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = function(e) { self._db = e.target.result; resolve(self._db); };
            req.onerror = function() { reject(req.error); };
        });
    },

    enqueue: function(operation) {
        var self = this;
        return self.open().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(self.STORE, 'readwrite');
                var store = tx.objectStore(self.STORE);
                operation.queuedAt = new Date().toISOString();
                operation.retries = 0;
                store.add(operation);
                tx.oncomplete = function() {
                    console.log('[OFFLINE] Operación encolada:', operation.type);
                    resolve();
                };
                tx.onerror = function() { reject(tx.error); };
            });
        });
    },

    getAll: function() {
        var self = this;
        return self.open().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(self.STORE, 'readonly');
                var store = tx.objectStore(self.STORE);
                var req = store.getAll();
                req.onsuccess = function() { resolve(req.result || []); };
                req.onerror = function() { reject(req.error); };
            });
        });
    },

    remove: function(id) {
        var self = this;
        return self.open().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(self.STORE, 'readwrite');
                tx.objectStore(self.STORE).delete(id);
                tx.oncomplete = function() { resolve(); };
                tx.onerror = function() { reject(tx.error); };
            });
        });
    },

    processQueue: function() {
        var self = this;
        if (self._processing || !navigator.onLine) return;
        self._processing = true;

        self.getAll().then(function(ops) {
            if (ops.length === 0) { self._processing = false; return; }
            console.log('[OFFLINE] Procesando ' + ops.length + ' operaciones pendientes...');
            if (typeof showToast === 'function') showToast('Sincronizando ' + ops.length + ' operación(es) pendiente(s)...', 'info');

            var chain = Promise.resolve();
            ops.forEach(function(op) {
                chain = chain.then(function() {
                    return self._executeOp(op).then(function() {
                        return self.remove(op.id);
                    }).catch(function(err) {
                        console.warn('[OFFLINE] Reintento fallido para op ' + op.id + ':', err.message);
                        // Keep in queue for next retry, max 5 retries
                        if (op.retries >= 5) {
                            console.error('[OFFLINE] Operación descartada tras 5 reintentos:', op);
                            return self.remove(op.id);
                        }
                    });
                });
            });

            chain.then(function() {
                self._processing = false;
                self.getAll().then(function(remaining) {
                    if (remaining.length === 0 && typeof showToast === 'function') {
                        showToast('Todas las operaciones sincronizadas.', 'success');
                    }
                });
            });
        }).catch(function(err) {
            console.error('[OFFLINE] Error procesando cola:', err);
            self._processing = false;
        });
    },

    _executeOp: function(op) {
        var db = window.db || firebase.firestore();
        var storage = firebase.storage();
        switch (op.type) {
            case 'delivery_confirm':
                // Upload offline signature if present
                var sigPromise = Promise.resolve();
                if (op.deliveryData._offlineSignatureB64) {
                    sigPromise = fetch(op.deliveryData._offlineSignatureB64)
                        .then(function(r) { return r.blob(); })
                        .then(function(blob) {
                            var sigRef = storage.ref('deliveries/' + op.ticketId + '/signature.png');
                            return sigRef.put(blob, { contentType: 'image/png' }).then(function() {
                                return sigRef.getDownloadURL();
                            });
                        }).then(function(url) {
                            op.deliveryData.signatureURL = url;
                            op.archiveData.signatureURL = url;
                            op.deliveryData.billingReady = true;
                            op.archiveData.billingReady = true;
                            delete op.deliveryData._offlineSignatureB64;
                        }).catch(function(e) {
                            console.warn('[OFFLINE] Firma upload fallido:', e.message);
                            delete op.deliveryData._offlineSignatureB64;
                        });
                }
                return sigPromise.then(function() {
                    // Replace ISO strings with server timestamps
                    op.deliveryData.deliveredAt = firebase.firestore.FieldValue.serverTimestamp();
                    op.deliveryData.distributedAt = firebase.firestore.FieldValue.serverTimestamp();
                    op.archiveData.deliveredAt = firebase.firestore.FieldValue.serverTimestamp();
                    op.archiveData.archivedAt = firebase.firestore.FieldValue.serverTimestamp();

                    var batch = db.batch();
                    var ticketRef = db.collection('tickets').doc(op.ticketId);
                    var archiveRef = db.collection('delivery_archive').doc(op.ticketId);
                    batch.update(ticketRef, op.deliveryData);
                    batch.set(archiveRef, op.archiveData);
                    return batch.commit();
                }).then(function() {
                    console.log('[OFFLINE] Entrega sincronizada:', op.ticketId);
                    if (op.notification) {
                        op.notification.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                        db.collection('user_notifications').add(op.notification).catch(function() {});
                    }
                });
            case 'incident_report':
                return db.collection('tickets').doc(op.ticketId).update(op.data).then(function() {
                    console.log('[OFFLINE] Incidencia sincronizada:', op.ticketId);
                });
            case 'pickup_complete':
                return db.collection('driver_alerts').doc(op.alertId).update(op.data).then(function() {
                    console.log('[OFFLINE] Recogida sincronizada:', op.alertId);
                });
            case 'gps_update':
                return db.collection('driver_locations').doc(op.docId).set(op.data, { merge: true }).then(function() {
                    console.log('[OFFLINE] GPS sincronizado');
                });
            default:
                console.warn('[OFFLINE] Tipo desconocido:', op.type);
                return Promise.resolve();
        }
    }
};

// --- INIT ---
document.addEventListener('DOMContentLoaded', function() {
    waitForFirebase(initApp);
});

function initApp() {
    var storage = firebase.storage();

    // --- CONNECTION STATUS MONITOR ---
    function updateConnectionDot(online) {
        var dot = document.getElementById('connection-dot');
        if (!dot) return;
        dot.className = 'conn-dot ' + (online ? 'online' : 'offline');
        dot.title = online ? 'Conectado' : 'Sin conexión';
    }
    updateConnectionDot(navigator.onLine);
    window.addEventListener('online', function() {
        updateConnectionDot(true);
        showToast('Conexión restablecida. Sincronizando...', 'success');
        var banner = document.getElementById('offline-banner');
        if (banner) banner.remove();
        // Process offline queue on reconnection
        setTimeout(function() { _offlineQueue.processQueue(); }, 1500);
    });
    window.addEventListener('offline', function() {
        updateConnectionDot(false);
        showToast('Sin conexión a Internet.', 'warning', 5000);
        var existing = document.getElementById('offline-banner');
        if (!existing) {
            var banner = document.createElement('div');
            banner.id = 'offline-banner';
            banner.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:99999; background:#FF3B30; color:white; text-align:center; padding:8px; font-weight:bold; font-size:0.85rem;';
            banner.textContent = '\u26a0\ufe0f SIN CONEXI\u00d3N \u2014 Las operaciones no se guardar\u00e1n';
            document.body.appendChild(banner);
        }
    });

    // --- AUTH: PHONE SMS ---
    document.getElementById('btn-send-sms').addEventListener('click', async function() {
        var phoneRaw = document.getElementById('phone-input').value.trim();
        if (!phoneRaw || phoneRaw.length < 6) {
            document.getElementById('login-error').textContent = 'Introduce un número válido.';
            return;
        }
        var phone = '+34' + phoneRaw.replace(/\D/g, '').replace(/^34/, '');
        document.getElementById('login-error').textContent = '';
        showLoading();

        try {
            window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
                size: 'invisible',
                callback: function() {}
            });
            confirmationResult = await auth.signInWithPhoneNumber(phone, window.recaptchaVerifier);
            document.getElementById('login-step-phone').style.display = 'none';
            document.getElementById('login-step-code').style.display = 'block';
        } catch (e) {
            console.error('SMS error:', e);
            document.getElementById('login-error').textContent = 'Error enviando SMS: ' + e.message;
            if (window.recaptchaVerifier) { window.recaptchaVerifier.clear(); window.recaptchaVerifier = null; }
        } finally {
            hideLoading();
        }
    });

    document.getElementById('btn-verify-code').addEventListener('click', async function() {
        var code = document.getElementById('sms-code-input').value.trim();
        if (!code) return;
        showLoading();
        try {
            await confirmationResult.confirm(code);
        } catch (e) {
            document.getElementById('login-error').textContent = 'Código incorrecto.';
            hideLoading();
        }
    });

    document.getElementById('btn-back-phone').addEventListener('click', function() {
        document.getElementById('login-step-code').style.display = 'none';
        document.getElementById('login-step-phone').style.display = 'block';
        document.getElementById('login-error').textContent = '';
    });

    // --- MASTER PIN AUTH ---
    var _adminRoutes = [];

    document.getElementById('btn-master-pin').addEventListener('click', async function() {
        var pin = (document.getElementById('master-pin-input').value || '').trim();
        if (!pin) {
            document.getElementById('login-error').textContent = 'Introduce un PIN maestro.';
            return;
        }
        document.getElementById('login-error').textContent = '';
        showLoading();

        try {
            var configDoc = await db.collection('config').doc('phones').get();
            var configData = configDoc.exists ? configDoc.data() : {};
            var pin1 = configData.masterPin1 || '';
            var pin2 = configData.masterPin2 || '';

            if (pin !== pin1 && pin !== pin2) {
                document.getElementById('login-error').textContent = 'PIN maestro incorrecto.';
                hideLoading();
                return;
            }

            // PIN valid — load all routes
            var phonesSnap = await db.collection('config').doc('phones').collection('list').get();
            _adminRoutes = [];
            phonesSnap.forEach(function(doc) {
                var d = doc.data();
                _adminRoutes.push({
                    docId: doc.id,
                    label: d.label || 'Sin nombre',
                    number: d.number || '',
                    driverNames: [d.driverName, d.driverName2, d.driverName3, d.driverName4].filter(function(n) { return n && n.trim(); })
                });
            });

            if (_adminRoutes.length === 0) {
                document.getElementById('login-error').textContent = 'No hay rutas configuradas.';
                hideLoading();
                return;
            }

            // Anonymous auth needed so Firestore rules (request.auth != null) allow ticket queries
            _isMasterPinSession = true;
            try {
                await auth.signInAnonymously();
                console.log('[REPARTO] Master PIN: anonymous auth OK');
            } catch (authErr) {
                console.error('[REPARTO] Anonymous auth failed:', authErr);
                document.getElementById('login-error').textContent = 'Error de autenticación. Contacta al administrador.';
                hideLoading();
                return;
            }

            showAdminRouteSelector();
        } catch (e) {
            console.error('Master PIN error:', e);
            document.getElementById('login-error').textContent = 'Error: ' + e.message;
        } finally {
            hideLoading();
        }
    });

    function showAdminRouteSelector() {
        document.getElementById('login-view').style.display = 'none';
        document.getElementById('main-app').style.display = 'none';
        document.getElementById('driver-selector-view').style.display = 'none';
        document.getElementById('admin-route-selector').style.display = 'flex';

        var container = document.getElementById('admin-route-options');
        container.innerHTML = '';

        _adminRoutes.forEach(function(route) {
            var driversText = route.driverNames.length > 0 ? route.driverNames.join(' · ') : 'Sin chóferes';
            var btn = document.createElement('button');
            btn.className = 'driver-option-btn';
            btn.style.borderColor = 'rgba(171,71,188,0.3)';
            btn.style.background = 'rgba(171,71,188,0.06)';
            btn.innerHTML = '<span class="driver-icon"><span class="material-symbols-outlined">location_on</span></span><div style="text-align:left; min-width:0; flex:1; overflow:hidden;"><div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(route.label).toUpperCase() + '</div><div style="font-size:0.65rem; color:#888; font-weight:400; letter-spacing:0; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(driversText) + '</div></div>';
            btn.addEventListener('click', function() {
                currentDriverPhone = normalizePhone(route.number);
                currentRouteLabel = route.label;

                if (route.driverNames.length <= 1) {
                    currentDriverName = route.driverNames[0] || 'ADMIN';
                    document.getElementById('admin-route-selector').style.display = 'none';
                    enterMainApp();
                } else {
                    document.getElementById('admin-route-selector').style.display = 'none';
                    showDriverSelector(route.driverNames, route.label);
                }
            });
            container.appendChild(btn);
        });
    }

    document.getElementById('btn-admin-back').addEventListener('click', function() {
        document.getElementById('admin-route-selector').style.display = 'none';
        document.getElementById('login-view').style.display = 'flex';
        document.getElementById('master-pin-input').value = '';
    });

    // --- AUTH STATE ---
    auth.onAuthStateChanged(async function(user) {
        // Skip if master PIN session (anonymous auth) — route selector handles the flow
        if (_isMasterPinSession) return;

        if (user && user.phoneNumber) {
            showLoading();
            try {
                currentDriverPhone = normalizePhone(user.phoneNumber);
                console.log('[REPARTO] Autenticado:', currentDriverPhone);

                var phonesSnap = await db.collection('config').doc('phones').collection('list').get();
                var found = false;
                var foundRouteLabel = '';
                var driverNames = [];

                phonesSnap.forEach(function(doc) {
                    var d = doc.data();
                    var routePhone = normalizePhone(d.number);
                    if (routePhone === currentDriverPhone) {
                        found = true;
                        foundRouteLabel = d.label || '';
                        // Collect all configured driver names
                        if (d.driverName) driverNames.push(d.driverName);
                        if (d.driverName2) driverNames.push(d.driverName2);
                        if (d.driverName3) driverNames.push(d.driverName3);
                        if (d.driverName4) driverNames.push(d.driverName4);
                    }
                });

                currentRouteLabel = foundRouteLabel;

                // If no names found, use a default
                if (driverNames.length === 0) {
                    driverNames.push(found ? 'Repartidor' : 'Repartidor ' + currentDriverPhone.slice(-4));
                }

                // If only one driver, skip selection and go straight to app
                if (driverNames.length === 1) {
                    currentDriverName = driverNames[0];
                    enterMainApp();
                } else {
                    // Show driver selector
                    showDriverSelector(driverNames, foundRouteLabel);
                }

            } catch (e) {
                console.error('Init error:', e);
                showToast('Error al inicializar: ' + e.message, 'error', 5000);
            } finally {
                hideLoading();
            }
        } else {
            // Session expired while driver was logged in
            if (currentDriverPhone) {
                console.warn('[REPARTO] Sesión expirada para', currentDriverPhone);
                showToast('Sesión expirada. Redirigiendo al login...', 'warning', 4000);
                // Clean up listeners
                if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                if (pickupUnsubscribe) { pickupUnsubscribe(); pickupUnsubscribe = null; }
                if (alertUnsubscribe) { alertUnsubscribe(); alertUnsubscribe = null; }
                // Reset session state
                currentDriverPhone = '';
                currentDriverName = '';
                currentRouteLabel = '';
                deliveries = [];
                manualOrder = null;
                setTimeout(function() { window.location.reload(); }, 3000);
                return;
            }
            document.getElementById('login-view').style.display = 'flex';
            document.getElementById('main-app').style.display = 'none';
            document.getElementById('driver-selector-view').style.display = 'none';
            document.getElementById('admin-route-selector').style.display = 'none';
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        }
    });

    // --- DRIVER SELECTOR ---
    function showDriverSelector(names, routeLabel) {
        document.getElementById('login-view').style.display = 'none';
        document.getElementById('main-app').style.display = 'none';
        document.getElementById('driver-selector-view').style.display = 'flex';

        var labelEl = document.getElementById('driver-route-label');
        if (routeLabel) {
            labelEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">location_on</span> ' + escapeHtml(routeLabel);
        } else {
            labelEl.textContent = '';
        }

        var container = document.getElementById('driver-options');
        var driverIcons = ['local_shipping', 'local_shipping', 'two_wheeler', 'airport_shuttle'];
        container.innerHTML = '';

        names.forEach(function(name, idx) {
            var btn = document.createElement('button');
            btn.className = 'driver-option-btn';
            btn.innerHTML = '<span class="driver-icon"><span class="material-symbols-outlined">' + (driverIcons[idx] || 'local_shipping') + '</span></span><span>' + escapeHtml(name).toUpperCase() + '</span>';
            btn.addEventListener('click', function() {
                currentDriverName = name;
                document.getElementById('driver-selector-view').style.display = 'none';
                enterMainApp();
            });
            container.appendChild(btn);
        });
    }

    // --- ENTER MAIN APP (after driver selected) ---
    function enterMainApp() {
        document.getElementById('login-view').style.display = 'none';
        document.getElementById('driver-selector-view').style.display = 'none';
        document.getElementById('admin-route-selector').style.display = 'none';
        document.getElementById('driver-name').textContent = currentDriverName;
        document.getElementById('main-app').style.display = 'block';

        try {
            var savedOrder = localStorage.getItem('routeOrder_' + currentDriverName);
            if (savedOrder) manualOrder = JSON.parse(savedOrder);
        } catch(e) { console.warn('Error loading route order:', e); }

        startDeliveryListener();
        startPickupListener();
        startDriverAlertListener();
        startGPSTracking();
        requestNotificationPermission();
        if (typeof requestWakeLock === 'function') requestWakeLock();
        showToast('Bienvenido, ' + currentDriverName, 'success');
    }

    // --- LOGOUT ---
    document.getElementById('btn-logout').addEventListener('click', function() {
        if (confirm('¿Cerrar sesión?')) {
            stopGPSTracking();
            stopScanner();
            // Unsubscribe from Firestore listeners
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
            if (pickupUnsubscribe) { pickupUnsubscribe(); pickupUnsubscribe = null; }
            if (alertUnsubscribe) { alertUnsubscribe(); alertUnsubscribe = null; }
            // Reset all session state
            currentDriverPhone = '';
            currentDriverName = '';
            currentRouteLabel = '';
            deliveries = [];
            manualOrder = null;
            currentScanDoc = null;
            currentFilter = 'pending';
            knownDeliveryIds = new Set();
            knownPickupIds = new Set();
            isFirstPickupSnapshot = true;
            knownAlertIds = new Set();
            isFirstAlertSnapshot = true;
            scannedPackages = {};
            isFirstSnapshot = true;
            _adminRoutes = [];
            _isMasterPinSession = false;
            confirmInProgress = false;
            // Hide all views, show login
            document.getElementById('main-app').style.display = 'none';
            document.getElementById('driver-selector-view').style.display = 'none';
            document.getElementById('admin-route-selector').style.display = 'none';
            document.getElementById('login-view').style.display = 'flex';
            document.getElementById('master-pin-input').value = '';
            document.getElementById('phone-input').value = '';
            document.getElementById('login-error').textContent = '';
            // Sign out Firebase auth (for SMS users; no-op for PIN users)
            auth.signOut().catch(function(e) { console.error('Logout error:', e); });
            showToast('Sesión cerrada.', 'info');
        }
    });

    // --- REFRESH ---
    document.getElementById('btn-refresh').addEventListener('click', function() {
        var btn = document.getElementById('btn-refresh');
        btn.classList.add('spinning');
        setTimeout(function() { btn.classList.remove('spinning'); }, 800);
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        startDeliveryListener();
        showToast('Entregas actualizadas.', 'info');
    });

    // --- SORT ROUTE BY GPS ---
    document.getElementById('btn-sort-route').addEventListener('click', function() {
        if (deliveries.length === 0) {
            showToast('No hay entregas para ordenar.', 'warning');
            return;
        }

        showLoading();
        showToast('Obteniendo ubicación GPS...', 'info');

        if (!navigator.geolocation) {
            showToast('GPS no disponible en este dispositivo.', 'error');
            hideLoading();
            return;
        }

        navigator.geolocation.getCurrentPosition(
            async function(pos) {
                var myLat = pos.coords.latitude;
                var myLon = pos.coords.longitude;
                showToast('Calculando ruta óptima...', 'info');

                // Geocode all pending deliveries
                var pending = deliveries.filter(function(d) { return d.status !== 'Entregado' && !d.delivered; });
                await Promise.all(pending.map(geocodeAddress));

                // Sort by nearest neighbor
                var sorted = sortByGPSProximity(pending, myLat, myLon);
                var delivered = deliveries.filter(function(d) { return d.status === 'Entregado' || d.delivered; });

                // Save the manual order
                manualOrder = sorted.map(function(d) { return d._id; }).concat(delivered.map(function(d) { return d._id; }));
                try { localStorage.setItem('routeOrder_' + currentDriverName, JSON.stringify(manualOrder)); } catch(e) {}

                // Reorder deliveries array
                deliveries = sorted.concat(delivered);
                renderDeliveries();
                hideLoading();

                var geocoded = pending.filter(function(d) { return d._lat && d._lon; }).length;
                showToast('Ruta optimizada: ' + geocoded + '/' + pending.length + ' puntos geolocalizados.', 'success', 4000);
            },
            function(err) {
                hideLoading();
                showToast('Error GPS: ' + err.message + '. Activa la ubicación.', 'error', 5000);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    });

    // --- REAL-TIME DELIVERY LISTENER ---
    function startDeliveryListener() {
        if (unsubscribe) unsubscribe();

        // Show skeleton while loading
        var skeleton = document.getElementById('skeleton-loader');
        if (skeleton) skeleton.style.display = '';

        unsubscribe = db.collection('tickets')
            .where('driverPhone', '==', currentDriverPhone)
            .onSnapshot(function(snap) {
                deliveries = [];
                snap.forEach(function(doc) {
                    var d = doc.data();
                    d._id = doc.id;
                    d._ref = doc.ref;
                    deliveries.push(d);
                });

                // Detect NEW deliveries (not on first load)
                if (!isFirstSnapshot) {
                    deliveries.forEach(function(d) {
                        if (!knownDeliveryIds.has(d._id) && d.status !== 'Entregado' && !d.delivered) {
                            sendNotification(
                                'Nueva entrega asignada',
                                (d.receiver || 'Sin nombre') + ' — ' + [d.localidad, d.cp].filter(Boolean).join(', ')
                            );
                        }
                    });
                }
                // Update known IDs
                knownDeliveryIds = new Set(deliveries.map(function(d) { return d._id; }));
                isFirstSnapshot = false;

                // Apply manual order if user has reordered
                if (manualOrder && manualOrder.length > 0) {
                    deliveries.sort(function(a, b) {
                        var ia = manualOrder.indexOf(a._id);
                        var ib = manualOrder.indexOf(b._id);
                        if (ia === -1) ia = 9999;
                        if (ib === -1) ib = 9999;
                        return ia - ib;
                    });
                } else {
                    // Default: pending first, then by CP
                    deliveries.sort(function(a, b) {
                        var aD = a.status === 'Entregado' || a.delivered;
                        var bD = b.status === 'Entregado' || b.delivered;
                        if (aD && !bD) return 1;
                        if (!aD && bD) return -1;
                        return (a.cp || '').localeCompare(b.cp || '');
                    });
                }

                // Hide skeleton loader
                var skel = document.getElementById('skeleton-loader');
                if (skel) skel.style.display = 'none';

                // Skip re-render if confirmation is in progress to avoid UI disruption
                if (!confirmInProgress) {
                    renderDeliveries();
                }
                updateStats();
            }, function(err) {
                console.error('Listener error:', err);
                if (err.code === 'permission-denied') {
                    showToast('Sin permisos para ver albaranes. Reinicia la app.', 'error', 8000);
                } else if (err.code === 'failed-precondition') {
                    showToast('Índice Firestore necesario. Contacta al admin.', 'error', 8000);
                }
            });
    }

    // --- PICKUP REQUESTS LISTENER ---
    var pickupUnsubscribe = null;
    var knownPickupIds = new Set();
    var isFirstPickupSnapshot = true;

    function startPickupListener() {
        if (pickupUnsubscribe) pickupUnsubscribe();

        // Listen to pickups assigned to this driver + unassigned pickups
        var unsub1 = null, unsub2 = null;
        var assignedPickups = [], unassignedPickups = [];

        function mergeAndRender() {
            var all = assignedPickups.concat(unassignedPickups);
            // Deduplicate by _id
            var seen = {};
            var pickups = [];
            all.forEach(function(p) { if (!seen[p._id]) { seen[p._id] = true; pickups.push(p); } });

            // Detect NEW pickups
            if (!isFirstPickupSnapshot) {
                pickups.forEach(function(p) {
                    if (!knownPickupIds.has(p._id)) {
                        sendNotification(
                            '\ud83d\udce6 RECOGIDA PENDIENTE',
                            (p.senderName || 'Cliente') + ' \u2014 ' + (p.senderAddress || '') + ' \u2014 ' + (p.packages || 1) + ' bultos'
                        );
                    }
                });
            }
            knownPickupIds = new Set(pickups.map(function(p) { return p._id; }));
            isFirstPickupSnapshot = false;
            renderPickupCards(pickups);
        }

        // Query 1: assigned to this driver
        if (currentDriverPhone) {
            unsub1 = db.collection('pickupRequests')
                .where('status', '==', 'pending')
                .where('driverPhone', '==', currentDriverPhone)
                .onSnapshot(function(snap) {
                    assignedPickups = [];
                    snap.forEach(function(doc) { var d = doc.data(); d._id = doc.id; assignedPickups.push(d); });
                    mergeAndRender();
                }, function(err) { console.warn('Pickup listener (assigned) error:', err); });
        }

        // Query 2: unassigned pickups (no driverPhone)
        unsub2 = db.collection('pickupRequests')
            .where('status', '==', 'pending')
            .where('driverPhone', '==', '')
            .onSnapshot(function(snap) {
                unassignedPickups = [];
                snap.forEach(function(doc) { var d = doc.data(); d._id = doc.id; unassignedPickups.push(d); });
                mergeAndRender();
            }, function(err) { console.warn('Pickup listener (unassigned) error:', err); });

        pickupUnsubscribe = function() {
            if (unsub1) unsub1();
            if (unsub2) unsub2();
        };
    }

    // --- DRIVER ALERTS LISTENER (admin pickup/collection alerts) ---
    var alertUnsubscribe = null;
    var knownAlertIds = new Set();
    var isFirstAlertSnapshot = true;
    var _driverAlerts = [];

    function startDriverAlertListener() {
        if (!currentDriverPhone) return;
        if (alertUnsubscribe) alertUnsubscribe();

        alertUnsubscribe = db.collection('driver_alerts')
            .where('routePhone', '==', currentDriverPhone)
            .where('completed', '==', false)
            .onSnapshot(function(snap) {
                var alerts = [];
                snap.forEach(function(doc) {
                    var d = doc.data();
                    d._id = doc.id;
                    alerts.push(d);
                });

                // Sort newest first
                alerts.sort(function(a, b) {
                    var ta = a.createdAt ? (typeof a.createdAt.toDate === 'function' ? a.createdAt.toDate().getTime() : new Date(a.createdAt).getTime()) : 0;
                    var tb = b.createdAt ? (typeof b.createdAt.toDate === 'function' ? b.createdAt.toDate().getTime() : new Date(b.createdAt).getTime()) : 0;
                    return tb - ta;
                });

                // Notify for new unread alerts
                alerts.forEach(function(a) {
                    if (!a.read && !knownAlertIds.has(a._id)) {
                        sendNotification(
                            a.title || '\ud83d\udce2 AVISO DE ADMIN',
                            a.body || '',
                            function() {
                                // On banner tap: open alerts panel
                                var panel = document.getElementById('alerts-panel');
                                var arrow = document.getElementById('alerts-panel-arrow');
                                if (panel && panel.style.display === 'none') {
                                    panel.style.display = 'block';
                                    if (arrow) arrow.style.transform = 'rotate(180deg)';
                                    _renderAlertsPanel();
                                }
                                // Scroll to alerts button
                                var btn = document.getElementById('btn-alerts-toggle');
                                if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        );
                        // Mark as read (seen) but NOT completed
                        db.collection('driver_alerts').doc(a._id).update({ read: true })
                            .catch(function(e) { console.warn('Error marking alert read:', e); });
                    }
                });

                knownAlertIds = new Set(alerts.map(function(a) { return a._id; }));
                isFirstAlertSnapshot = false;
                _driverAlerts = alerts;
                _updateAlertsBadge();
                _renderAlertsPanel();
            }, function(err) {
                console.warn('Driver alert listener error:', err);
            });
    }

    function _updateAlertsBadge() {
        var badge = document.getElementById('alerts-count-badge');
        if (!badge) return;
        var count = _driverAlerts.length;
        badge.textContent = count;
        badge.style.display = count > 0 ? 'inline-block' : 'none';
        // Pulse the button if there are pending alerts
        var btn = document.getElementById('btn-alerts-toggle');
        if (btn) {
            btn.style.borderColor = count > 0 ? '#4CAF50' : '#333';
            btn.style.boxShadow = count > 0 ? '0 0 12px rgba(76,175,80,0.3)' : 'none';
        }
    }

    window.toggleAlertsPanel = function() {
        var panel = document.getElementById('alerts-panel');
        var arrow = document.getElementById('alerts-panel-arrow');
        if (!panel) return;
        if (panel.style.display === 'none') {
            panel.style.display = 'block';
            if (arrow) arrow.classList.add('open');
            _renderAlertsPanel();
        } else {
            panel.style.display = 'none';
            if (arrow) arrow.classList.remove('open');
        }
    };

    function _renderAlertsPanel() {
        var panel = document.getElementById('alerts-panel');
        if (!panel || panel.style.display === 'none') return;

        if (_driverAlerts.length === 0) {
            panel.innerHTML = '<div style="text-align:center; padding:24px; color:#888; font-size:0.85rem;">' +
                '<span class="material-symbols-outlined" style="font-size:2rem; display:block; margin-bottom:8px; color:#4CAF50;">check_circle</span>' +
                'No hay recogidas ni avisos pendientes</div>';
            return;
        }

        var html = '';
        _driverAlerts.forEach(function(a) {
            var typeIcon = '\ud83d\udce2';
            var typeLabel = 'Aviso';
            var typeColor = '#2196F3';
            if (a.type === 'recogida') { typeIcon = '\ud83d\udce5'; typeLabel = 'Recogida'; typeColor = '#FF9800'; }
            else if (a.type === 'entrega_urgente') { typeIcon = '\ud83d\udea8'; typeLabel = 'Entrega urgente'; typeColor = '#FF3B30'; }

            var dateStr = '';
            if (a.createdAt) {
                var d = typeof a.createdAt.toDate === 'function' ? a.createdAt.toDate() : new Date(a.createdAt);
                dateStr = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
                var today = new Date();
                if (d.toDateString() !== today.toDateString()) {
                    dateStr = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) + ' ' + dateStr;
                }
            }

            html += '<div style="background:linear-gradient(135deg, ' + typeColor + '15, ' + typeColor + '08); border:1px solid ' + typeColor + '44; border-radius:12px; padding:14px; margin-bottom:10px;">';
            // Header
            html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">';
            html += '<span style="color:' + typeColor + '; font-weight:800; font-size:0.82rem; letter-spacing:0.5px;">' + typeIcon + ' ' + escapeHtml(typeLabel).toUpperCase() + '</span>';
            html += '<span style="color:#888; font-size:0.72rem;">' + escapeHtml(dateStr) + '</span>';
            html += '</div>';
            // Address
            if (a.address) {
                html += '<div style="display:flex; align-items:start; gap:6px; margin-bottom:6px; color:#eee; font-size:0.9rem; line-height:1.5;">';
                html += '<span style="font-size:1rem; flex-shrink:0;">\ud83d\udccd</span>';
                html += '<span style="font-weight:600;">' + escapeHtml(a.address) + '</span>';
                html += '</div>';
            }
            // Notes
            if (a.notes) {
                html += '<div style="display:flex; align-items:start; gap:6px; margin-bottom:6px; color:#aaa; font-size:0.82rem; line-height:1.4;">';
                html += '<span style="font-size:0.9rem; flex-shrink:0;">\ud83d\udcdd</span>';
                html += '<span>' + escapeHtml(a.notes) + '</span>';
                html += '</div>';
            }
            // Sent by
            if (a.sentBy) {
                html += '<div style="color:#666; font-size:0.7rem; margin-bottom:8px;">Enviado por: ' + escapeHtml(a.sentBy) + '</div>';
            }
            // Action buttons
            html += '<div style="display:flex; gap:8px; margin-top:10px;">';
            // Google Maps
            if (a.address) {
                html += '<button onclick="window.open(\'https://www.google.com/maps/search/' + encodeURIComponent(a.address) + '\', \'_blank\')" style="flex:1; padding:10px; background:#1e3a5f; color:#5dade2; border:1px solid #2d5a8e; border-radius:8px; font-weight:800; font-size:0.78rem; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px;">\ud83d\udccd C\u00d3MO LLEGAR</button>';
            }
            // Complete
            html += '<button onclick="completeDriverAlert(\'' + escapeHtml(a._id) + '\')" style="flex:1; padding:10px; background:linear-gradient(135deg,#4CAF50,#2E7D32); color:white; border:none; border-radius:8px; font-weight:800; font-size:0.78rem; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px;">\u2705 COMPLETADA</button>';
            html += '</div>';
            html += '</div>';
        });

        panel.innerHTML = html;
    }

    window.completeDriverAlert = async function(alertId) {
        if (!navigator.onLine) {
            sendNotification('Sin conexión', 'No hay conexión a internet. Inténtalo cuando recuperes la señal.', 'warning');
            return;
        }
        if (!confirm('\u00bfMarcar como completada?')) return;
        try {
            await db.collection('driver_alerts').doc(alertId).update({
                completed: true,
                completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                completedBy: currentDriverName
            });
            showToast('Recogida/aviso completado', 'success');
        } catch(e) {
            console.error('Error completing alert:', e);
            showToast('Error: ' + e.message, 'error');
        }
    };

    function renderPickupCards(pickups) {
        var container = document.getElementById('delivery-list');
        if (!container) return;

        // Remove old pickup cards
        var oldCards = container.querySelectorAll('.pickup-card');
        oldCards.forEach(function(c) { c.remove(); });

        if (pickups.length === 0) return;

        pickups.forEach(function(p) {
            var card = document.createElement('div');
            card.className = 'pickup-card';
            var borderColor = p.outOfSchedule ? '#FF9800' : '#4CAF50';
            var bgGrad = p.outOfSchedule
                ? 'linear-gradient(135deg,rgba(255,152,0,0.15),rgba(255,152,0,0.05))'
                : 'linear-gradient(135deg,rgba(76,175,80,0.15),rgba(76,175,80,0.05))';
            card.style.cssText = 'background:' + bgGrad + '; border:2px solid ' + borderColor + '; border-radius:12px; padding:14px; margin-bottom:10px; animation:slideDown 0.3s ease;';

            var turnIcon = p.timeSlot === 'TARDE' ? '\ud83c\udf19' : '\u2600\ufe0f';
            var notesHtml = p.notes ? '<div style="margin-top:6px; font-style:italic; color:#aaa; font-size:0.75rem;">\ud83d\udcdd ' + escapeHtml(p.notes) + '</div>' : '';
            var destHtml = p.destination ? '<div style="margin-top:4px;"><strong>Destino:</strong> ' + escapeHtml(p.destination) + '</div>' : '';
            var createdStr = '';
            if (p.createdAt && typeof p.createdAt.toDate === 'function') {
                var d = p.createdAt.toDate();
                createdStr = d.toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});
            }

            var badges = '';
            if (p.outOfSchedule) badges += '<span style="background:#FF9800; color:#fff; font-size:0.6rem; padding:2px 6px; border-radius:4px; font-weight:800; margin-left:6px;">FUERA HORARIO</span>';
            if (p.pickupType === 'thirdparty') badges += '<span style="background:#2196F3; color:#fff; font-size:0.6rem; padding:2px 6px; border-radius:4px; font-weight:800; margin-left:6px;">TERCERO</span>';
            var requestedByHtml = p.requestedBy ? '<div style="color:#2196F3; font-size:0.7rem; margin-top:2px;">Solicitado por: ' + escapeHtml(p.requestedBy) + '</div>' : '';

            card.innerHTML =
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap;">' +
                    '<span style="color:' + borderColor + '; font-weight:900; font-size:0.8rem; letter-spacing:1px;">RECOGIDA PENDIENTE' + badges + '</span>' +
                    '<span style="color:#888; font-size:0.7rem;">' + turnIcon + ' ' + (p.timeSlot || '') + (createdStr ? ' \u2022 ' + createdStr : '') + '</span>' +
                '</div>' +
                '<div style="font-size:0.9rem; line-height:1.7; color:#eee;">' +
                    '<div><strong>' + escapeHtml(p.senderName || 'Cliente') + '</strong></div>' +
                    '<div>' + escapeHtml(p.senderAddress || 'Sin direcci\u00f3n') + '</div>' +
                    '<div>' + escapeHtml(p.senderPhone || '---') + '</div>' +
                    requestedByHtml +
                    destHtml +
                    '<div>' + escapeHtml(p.packages || 1) + ' bultos</div>' +
                    notesHtml +
                '</div>' +
                '<div style="display:flex; gap:8px; margin-top:10px;">' +
                    '<button onclick="window.open(\'' + (p.mapsUrl || '#') + '\', \'_blank\')" style="flex:1; padding:8px; background:' + borderColor + '; color:white; border:none; border-radius:8px; font-weight:800; font-size:0.75rem; cursor:pointer;">C\u00d3MO LLEGAR</button>' +
                    '<button onclick="completePickup(\'' + p._id + '\')" style="flex:1; padding:8px; background:rgba(255,255,255,0.1); color:' + borderColor + '; border:1px solid ' + borderColor + '; border-radius:8px; font-weight:800; font-size:0.75rem; cursor:pointer;">COMPLETADA</button>' +
                '</div>';

            container.insertBefore(card, container.firstChild);
        });
    }

    window.completePickup = async function(pickupId) {
        if (!navigator.onLine) {
            sendNotification('Sin conexión', 'No hay conexión a internet. Inténtalo cuando recuperes la señal.', 'warning');
            return;
        }
        if (!confirm('\u00bfMarcar esta recogida como completada?')) return;
        try {
            await db.collection('pickupRequests').doc(pickupId).update({
                status: 'completed',
                completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                completedBy: currentDriverName
            });
            showToast('Recogida completada.', 'success');
        } catch (e) {
            console.error('Error completando recogida:', e);
            showToast('Error: ' + e.message, 'error');
        }
    };

    // --- RENDER DELIVERIES ---
    function renderDeliveries() {
        var container = document.getElementById('delivery-list');
        var filtered = deliveries.slice();

        if (currentFilter === 'pending') filtered = filtered.filter(function(d) { return d.status !== 'Entregado' && !d.delivered && d.status !== 'pending_confirmation'; });
        else if (currentFilter === 'delivered') filtered = filtered.filter(function(d) { return d.status === 'Entregado' || d.delivered; });
        else if (currentFilter === 'morning') filtered = filtered.filter(function(d) { return d.timeSlot === 'MAÑANA'; });
        else if (currentFilter === 'afternoon') filtered = filtered.filter(function(d) { return d.timeSlot === 'TARDE'; });

        if (filtered.length === 0) {
            container.innerHTML = '<div class="empty-state">' +
                '<span class="material-symbols-outlined">inventory_2</span>' +
                '<p>No hay entregas' + (currentFilter !== 'all' ? ' con este filtro' : ' asignadas') + '</p>' +
                '</div>';
            return;
        }

        container.innerHTML = filtered.map(function(d, idx) {
            var isDelivered = d.status === 'Entregado' || d.delivered;
            var statusClass = isDelivered ? 'delivered' : 'pending';
            var statusText = isDelivered ? 'ENTREGADO' : (d.status === 'pending_confirmation' ? 'MOD.' : 'PENDIENTE');
            var addr = [d.address, d.localidad, d.cp, d.province].filter(Boolean).join(', ');
            var pkgCount = getPackageCount(d);
            var orderNum = isDelivered ? '' : '<span class="route-order">' + (idx + 1) + '</span>';

            return '<div class="delivery-card ' + statusClass + '" data-id="' + escapeHtml(d._id) + '" data-idx="' + idx + '" draggable="true">' +
                '<span class="drag-handle"><span class="material-symbols-outlined" style="font-size:0.9rem;">drag_indicator</span></span>' +
                '<div class="dc-header">' +
                    '<span class="dc-id">' + orderNum + escapeHtml(d.id || d._id.substring(0,12)) + '</span>' +
                    '<span class="dc-status ' + statusClass + '">' + statusText + '</span>' +
                '</div>' +
                '<div class="dc-name">' + escapeHtml(d.receiver || d.clientName || 'Sin nombre') + '</div>' +
                '<div class="dc-addr">' + escapeHtml(addr || 'Sin dirección') + '</div>' +
                '<div class="dc-footer">' +
                    '<span class="dc-packages"><span class="material-symbols-outlined">inventory_2</span> ' + pkgCount + ' bultos ' + (d.timeSlot ? (d.timeSlot === 'MAÑANA' ? '<span class="material-symbols-outlined" style="color:var(--morning);font-size:0.85rem;">light_mode</span>' : '<span class="material-symbols-outlined" style="color:var(--afternoon);font-size:0.85rem;">dark_mode</span>') : '') + '</span>' +
                    '<button class="dc-gps" data-addr="' + escapeHtml(addr || '') + '"><span class="material-symbols-outlined">near_me</span> GPS</button>' +
                '</div>' +
            '</div>';
        }).join('');

        // Card click → detail modal
        container.querySelectorAll('.delivery-card').forEach(function(card) {
            card.addEventListener('click', function(e) {
                if (e.target.classList.contains('dc-gps') || e.target.classList.contains('drag-handle')) return;
                var id = card.dataset.id;
                var d = deliveries.find(function(x) { return x._id === id; });
                if (d) showDetailModal(d);
            });
        });

        // GPS buttons
        container.querySelectorAll('.dc-gps').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                openGPS(btn.dataset.addr);
            });
        });

        // Drag & drop
        setupDragAndDrop(container);
    }

    // --- DRAG & DROP ---
    function setupDragAndDrop(container) {
        var cards = container.querySelectorAll('.delivery-card');

        cards.forEach(function(card) {
            card.addEventListener('dragstart', function(e) {
                dragSrcIndex = parseInt(card.dataset.idx);
                card.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', card.dataset.idx);
            });

            card.addEventListener('dragend', function() {
                card.classList.remove('dragging');
                container.querySelectorAll('.delivery-card').forEach(function(c) { c.classList.remove('drag-over'); });
            });

            card.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                container.querySelectorAll('.delivery-card').forEach(function(c) { c.classList.remove('drag-over'); });
                card.classList.add('drag-over');
            });

            card.addEventListener('dragleave', function() {
                card.classList.remove('drag-over');
            });

            card.addEventListener('drop', function(e) {
                e.preventDefault();
                card.classList.remove('drag-over');
                var fromIdx = dragSrcIndex;
                var toIdx = parseInt(card.dataset.idx);
                if (fromIdx === toIdx || fromIdx === null) return;

                // Reorder deliveries array
                var item = deliveries.splice(fromIdx, 1)[0];
                deliveries.splice(toIdx, 0, item);

                // Save manual order
                manualOrder = deliveries.map(function(d) { return d._id; });
                try { localStorage.setItem('routeOrder_' + currentDriverName, JSON.stringify(manualOrder)); } catch(e) {}

                renderDeliveries();
                showToast('Orden actualizado.', 'info', 1500);
            });
        });

        // Touch drag support for mobile
        setupTouchDrag(container);
    }

    function setupTouchDrag(container) {
        var touchSrcIdx = null;
        var touchClone = null;
        var touchStartY = 0;

        container.querySelectorAll('.drag-handle').forEach(function(handle) {
            handle.addEventListener('touchstart', function(e) {
                e.preventDefault();
                var card = handle.closest('.delivery-card');
                touchSrcIdx = parseInt(card.dataset.idx);
                touchStartY = e.touches[0].clientY;

                // Create visual clone
                touchClone = card.cloneNode(true);
                touchClone.style.position = 'fixed';
                touchClone.style.zIndex = '500';
                touchClone.style.opacity = '0.8';
                touchClone.style.width = card.offsetWidth + 'px';
                touchClone.style.pointerEvents = 'none';
                touchClone.style.left = card.getBoundingClientRect().left + 'px';
                touchClone.style.top = e.touches[0].clientY - 30 + 'px';
                document.body.appendChild(touchClone);

                card.classList.add('dragging');
            }, { passive: false });
        });

        container.addEventListener('touchmove', function(e) {
            if (touchSrcIdx === null || !touchClone) return;
            e.preventDefault();
            touchClone.style.top = e.touches[0].clientY - 30 + 'px';

            // Highlight target card
            var target = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
            container.querySelectorAll('.delivery-card').forEach(function(c) { c.classList.remove('drag-over'); });
            if (target) {
                var targetCard = target.closest('.delivery-card');
                if (targetCard && targetCard.dataset.idx !== String(touchSrcIdx)) {
                    targetCard.classList.add('drag-over');
                }
            }
        }, { passive: false });

        container.addEventListener('touchend', function(e) {
            if (touchSrcIdx === null) return;

            // Find drop target
            container.querySelectorAll('.delivery-card').forEach(function(c) { c.classList.remove('dragging'); c.classList.remove('drag-over'); });
            if (touchClone) { touchClone.remove(); touchClone = null; }

            var touch = e.changedTouches[0];
            var target = document.elementFromPoint(touch.clientX, touch.clientY);
            if (target) {
                var targetCard = target.closest('.delivery-card');
                if (targetCard) {
                    var toIdx = parseInt(targetCard.dataset.idx);
                    if (toIdx !== touchSrcIdx) {
                        var item = deliveries.splice(touchSrcIdx, 1)[0];
                        deliveries.splice(toIdx, 0, item);
                        manualOrder = deliveries.map(function(d) { return d._id; });
                        try { localStorage.setItem('routeOrder_' + currentDriverName, JSON.stringify(manualOrder)); } catch(e) {}
                        renderDeliveries();
                        showToast('Orden actualizado.', 'info', 1500);
                    }
                }
            }
            touchSrcIdx = null;
        });
    }

    // --- STATS ---
    function updateStats() {
        var pending = deliveries.filter(function(d) { return d.status !== 'Entregado' && !d.delivered; }).length;
        var delivered = deliveries.filter(function(d) { return d.status === 'Entregado' || d.delivered; }).length;
        var morning = deliveries.filter(function(d) { return d.timeSlot === 'MAÑANA'; }).length;
        var afternoon = deliveries.filter(function(d) { return d.timeSlot === 'TARDE'; }).length;
        document.getElementById('stat-pending').textContent = pending;
        document.getElementById('stat-delivered').textContent = delivered;
        document.getElementById('stat-morning').textContent = morning;
        document.getElementById('stat-afternoon').textContent = afternoon;
    }

    // --- FILTERS (stat-box tap) ---
    document.querySelectorAll('.stat-filter').forEach(function(box) {
        box.addEventListener('click', function() {
            var filter = box.dataset.filter;
            if (currentFilter === filter) {
                // Tap again = deselect → show all
                box.classList.remove('active');
                currentFilter = 'all';
            } else {
                document.querySelectorAll('.stat-filter').forEach(function(b) { b.classList.remove('active'); });
                box.classList.add('active');
                currentFilter = filter;
            }
            renderDeliveries();
        });
    });

    // --- GPS ---
    function openGPS(address) {
        if (!address) { showToast('Sin dirección disponible.', 'warning'); return; }
        var url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
        window.open(url, '_blank');
    }
    window.openGPS = openGPS;

    // --- DETAIL MODAL ---
    function showDetailModal(d) {
        var modal = document.getElementById('detail-modal');
        var content = document.getElementById('modal-content');
        var isDelivered = d.status === 'Entregado' || d.delivered;
        var addr = [d.address, d.localidad, d.cp, d.province].filter(Boolean).join(', ');
        var pkgCount = getPackageCount(d);

        content.innerHTML =
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">' +
                '<h3 style="color:var(--brand); margin:0; font-size:1rem; font-weight:800;">' + escapeHtml(d.id || '') + '</h3>' +
                '<span class="dc-status ' + (isDelivered ? 'delivered' : 'pending') + '">' + (isDelivered ? 'ENTREGADO' : 'PENDIENTE') + '</span>' +
            '</div>' +
            '<div style="font-size:0.9rem; line-height:1.8; margin-bottom:20px;">' +
                '<b>Destinatario:</b> ' + escapeHtml(d.receiver || '---') + '<br>' +
                '<b>Dirección:</b> ' + escapeHtml(addr || '---') + '<br>' +
                '<b>Bultos:</b> ' + pkgCount + '<br>' +
                '<b>Turno:</b> ' + (d.timeSlot === 'MAÑANA' ? '<span class="material-symbols-outlined icon-filled" style="font-size:.9rem; vertical-align:middle; color:#FF9800;">light_mode</span> Mañana' : '<span class="material-symbols-outlined icon-filled" style="font-size:.9rem; vertical-align:middle; color:#5C6BC0;">dark_mode</span> Tarde') + '<br>' +
                '<b>Remitente:</b> ' + escapeHtml(d.sender || '---') + '<br>' +
                (d.notes ? '<b>Observaciones:</b> ' + escapeHtml(d.notes) + '<br>' : '') +
                (d.cod ? '<b>Reembolso:</b> ' + escapeHtml(d.cod) + '€<br>' : '') +
                (d.deliveryReceiverName ? '<b>Recibido por:</b> ' + escapeHtml(d.deliveryReceiverName) + '<br>' : '') +
            '</div>' +
            '<div style="display:flex; flex-direction:column; gap:8px;">' +
                '<button class="btn btn-primary" id="modal-btn-gps"><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">near_me</span> ABRIR EN GPS</button>' +
                (!isDelivered ?
                    '<button class="btn btn-success" id="modal-btn-deliver"><span class="material-symbols-outlined icon-filled" style="font-size:1rem; vertical-align:middle;">check_circle</span> ENTREGAR (MANUAL)</button>' +
                    '<button class="btn btn-outline" id="modal-btn-modify"><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">edit_note</span> SOLICITAR MODIFICACIÓN</button>' +
                    '<button class="btn btn-danger" id="modal-btn-incident"><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">warning</span> INCIDENCIA</button>' +
                    '<button class="btn btn-outline" id="modal-btn-reassign" style="color:#FF9800; border-color:rgba(255,152,0,0.3);"><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">swap_horiz</span> REASIGNAR RUTA</button>'
                : '') +
                '<button class="btn btn-outline" id="modal-btn-close" style="color:var(--text-dim);">CERRAR</button>' +
            '</div>';

        modal.classList.add('active');

        document.getElementById('modal-btn-gps').onclick = function() { openGPS(addr); };
        document.getElementById('modal-btn-close').onclick = function() { closeModal(); };

        var btnDeliver = document.getElementById('modal-btn-deliver');
        if (btnDeliver) {
            btnDeliver.onclick = function() {
                closeModal();
                switchView('view-scanner');
                loadTicketForConfirmation(d);
            };
        }

        var btnModify = document.getElementById('modal-btn-modify');
        if (btnModify) {
            btnModify.onclick = function() {
                closeModal();
                openModificationModal(d);
            };
        }

        // Incident button
        var btnIncident = document.getElementById('modal-btn-incident');
        if (btnIncident) {
            btnIncident.onclick = function() {
                reportIncident(d);
            };
        }

        // Reassign button
        var btnReassign = document.getElementById('modal-btn-reassign');
        if (btnReassign) {
            btnReassign.onclick = function() {
                closeModal();
                openReassignModal(d);
            };
        }
    }

    function closeModal() {
        document.getElementById('detail-modal').classList.remove('active');
    }
    window.closeModal = closeModal;

    // --- REASSIGN ROUTE ---
    var REASSIGN_DAILY_LIMIT = 5;
    var _reassignDelivery = null;

    function _getReassignCountToday() {
        var key = 'reassign_' + currentDriverPhone + '_' + new Date().toISOString().split('T')[0];
        return parseInt(localStorage.getItem(key) || '0', 10);
    }

    function _incrementReassignCount() {
        var key = 'reassign_' + currentDriverPhone + '_' + new Date().toISOString().split('T')[0];
        var count = parseInt(localStorage.getItem(key) || '0', 10) + 1;
        localStorage.setItem(key, String(count));
        return count;
    }

    async function openReassignModal(d) {
        var used = _getReassignCountToday();
        if (used >= REASSIGN_DAILY_LIMIT) {
            showToast('Límite de reasignaciones alcanzado (' + REASSIGN_DAILY_LIMIT + '/día). Contacta con administración.', 'error', 6000);
            return;
        }

        _reassignDelivery = d;
        var modal = document.getElementById('reassign-modal');
        var ticketLabel = document.getElementById('reassign-modal-ticket');
        var countLabel = document.getElementById('reassign-daily-count');
        var list = document.getElementById('reassign-routes-list');

        ticketLabel.textContent = 'Albarán: ' + (d.id || d._id) + ' — ' + escapeHtml(d.receiver || '');
        countLabel.textContent = 'Reasignaciones hoy: ' + used + '/' + REASSIGN_DAILY_LIMIT;
        list.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:20px;">Cargando rutas...</div>';
        modal.classList.add('active');

        // Load routes from admin config
        try {
            var snap = await db.collection('config').doc('phones').collection('list').get();
            if (snap.empty) {
                list.innerHTML = '<div style="text-align:center; color:var(--danger); padding:20px;">No hay rutas configuradas.</div>';
                return;
            }

            list.innerHTML = '';
            snap.forEach(function(doc) {
                var route = doc.data();
                var routePhone = (route.number || '').replace(/\D/g, '').replace(/^34/, '');
                // Skip current driver's route
                if (routePhone === currentDriverPhone) return;

                var driverNames = [];
                for (var i = 1; i <= 4; i++) {
                    if (route['driver' + i]) driverNames.push(route['driver' + i]);
                }

                var btn = document.createElement('button');
                btn.style.cssText = 'display:flex; align-items:center; gap:10px; width:100%; padding:12px; background:rgba(255,152,0,0.06); border:1px solid rgba(255,152,0,0.2); border-radius:8px; color:var(--text-main); cursor:pointer; text-align:left; font-size:0.85rem;';
                btn.innerHTML =
                    '<span class="material-symbols-outlined" style="color:#FF9800; font-size:1.3rem;">local_shipping</span>' +
                    '<div style="flex:1; min-width:0;">' +
                        '<div style="font-weight:700; color:#FF9800;">' + escapeHtml(route.label || doc.id).toUpperCase() + '</div>' +
                        '<div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">' + escapeHtml(driverNames.join(', ') || 'Sin conductor') + '</div>' +
                    '</div>' +
                    '<span class="material-symbols-outlined" style="color:var(--text-dim);">chevron_right</span>';

                btn.addEventListener('click', function() {
                    confirmReassign(d, route.label || doc.id, routePhone);
                });
                list.appendChild(btn);
            });

            if (list.children.length === 0) {
                list.innerHTML = '<div style="text-align:center; color:var(--text-dim); padding:20px;">No hay otras rutas disponibles.</div>';
            }
        } catch (e) {
            console.error('Error loading routes:', e);
            list.innerHTML = '<div style="text-align:center; color:var(--danger); padding:20px;">Error al cargar rutas: ' + e.message + '</div>';
        }
    }

    async function confirmReassign(d, targetLabel, targetPhone) {
        var ticketId = d.id || d._id;
        if (!confirm('¿Reasignar albarán ' + ticketId + ' a la ruta ' + targetLabel + '?')) return;

        var modal = document.getElementById('reassign-modal');
        try {
            showLoading();

            // Update ticket's driverPhone to new route
            await d._ref.update({
                driverPhone: targetPhone,
                reassignedFrom: currentRouteLabel || currentDriverPhone,
                reassignedBy: currentDriverName || 'Conductor',
                reassignedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Log reassignment for admin visibility
            await db.collection('driver_reassignments').add({
                ticketId: ticketId,
                ticketRef: d._ref.path,
                receiver: d.receiver || '',
                fromRoute: currentRouteLabel || '',
                fromPhone: currentDriverPhone,
                fromDriver: currentDriverName || '',
                toRoute: targetLabel,
                toPhone: targetPhone,
                reason: 'Reasignación desde app conductor',
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                date: new Date().toISOString().split('T')[0]
            });

            _incrementReassignCount();
            modal.classList.remove('active');
            showToast('Albarán reasignado a ' + targetLabel, 'success', 5000);
        } catch (e) {
            console.error('Reassign error:', e);
            showToast('Error al reasignar: ' + e.message, 'error', 6000);
        } finally {
            hideLoading();
        }
    }

    // Cancel button
    document.getElementById('btn-reassign-cancel').addEventListener('click', function() {
        document.getElementById('reassign-modal').classList.remove('active');
        _reassignDelivery = null;
    });

    // --- REPORT INCIDENT (with optional photo) ---
    var _incidentDelivery = null;

    function reportIncident(d) {
        _incidentDelivery = d;
        var modal = document.getElementById('incident-modal');
        if (!modal) return;
        document.getElementById('incident-modal-ticket').textContent = 'Albaran: ' + (d.id || d._id);
        document.getElementById('incident-reason-select').value = '';
        document.getElementById('incident-detail').value = '';
        document.getElementById('incident-photo-input').value = '';
        document.getElementById('incident-photo-preview').style.display = 'none';
        document.getElementById('incident-photo-preview').src = '';
        closeModal(); // close detail modal first
        modal.classList.add('active');
    }

    // Incident camera
    document.getElementById('btn-incident-camera').addEventListener('click', function() {
        document.getElementById('incident-photo-input').click();
    });
    document.getElementById('incident-photo-input').addEventListener('change', function(e) {
        var f = e.target.files[0];
        if (f) {
            var reader = new FileReader();
            reader.onload = function(ev) {
                document.getElementById('incident-photo-preview').src = ev.target.result;
                document.getElementById('incident-photo-preview').style.display = 'block';
            };
            reader.readAsDataURL(f);
        }
    });

    // Incident cancel
    document.getElementById('btn-incident-cancel').addEventListener('click', function() {
        document.getElementById('incident-modal').classList.remove('active');
        _incidentDelivery = null;
    });

    // Incident send
    document.getElementById('btn-incident-send').addEventListener('click', async function() {
        var d = _incidentDelivery;
        if (!d) return;
        var reason = document.getElementById('incident-reason-select').value;
        if (!reason) { showToast('Selecciona un motivo', 'error'); return; }
        var detail = (document.getElementById('incident-detail').value || '').trim();
        var fullReason = reason + (detail ? ' - ' + detail : '');

        if (!navigator.onLine) {
            sendNotification('Sin conexión', 'No hay conexión a internet. Inténtalo cuando recuperes la señal.', 'warning');
            return;
        }

        var sendBtn = document.getElementById('btn-incident-send');
        sendBtn.disabled = true;
        sendBtn.textContent = 'Enviando...';

        try {
            var updateData = {
                status: 'Incidencia',
                incidentReason: fullReason,
                incidentReportedBy: currentDriverName,
                incidentReportedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            // Upload photo if present
            var photoFile = document.getElementById('incident-photo-input').files[0];
            if (photoFile) {
                photoFile = await compressImage(photoFile);
                var docId = d._id || d.docId;
                var photoRef = storage.ref('incidents/' + docId + '/photo.jpg');
                await photoRef.put(photoFile, { contentType: photoFile.type });
                updateData.incidentPhotoURL = await photoRef.getDownloadURL();
            }

            var docRef = d._ref || db.collection('tickets').doc(d._id);
            await docRef.update(updateData);

            // Notify the sender/user about the incident
            try {
                var notifUid = d.uid || d.clientIdNum || '';
                if (notifUid) {
                    var notifData = {
                        uid: notifUid,
                        type: 'incident',
                        title: 'Incidencia en envío ' + escapeHtml(d.id || d._id),
                        body: escapeHtml(fullReason),
                        ticketId: d.id || d._id,
                        docId: d._id,
                        reportedBy: currentDriverName,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                        read: false
                    };
                    if (updateData.incidentPhotoURL) {
                        notifData.photoURL = updateData.incidentPhotoURL;
                    }
                    await db.collection('user_notifications').add(notifData);
                }
            } catch(ne) { console.warn('No se pudo notificar al usuario:', ne); }

            document.getElementById('incident-modal').classList.remove('active');
            _incidentDelivery = null;
            showToast('Incidencia reportada: ' + (d.id || d._id), 'warning');
        } catch (e) {
            showToast('Error: ' + e.message, 'error');
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = 'ENVIAR INCIDENCIA';
        }
    });

    document.getElementById('detail-modal').addEventListener('click', function(e) {
        if (e.target === e.currentTarget) closeModal();
    });

    // --- MODIFICATION MODAL ---
    function openModificationModal(d) {
        modDocId = d._id;
        var addr = [d.address, d.localidad, d.cp, d.province].filter(Boolean).join(', ');
        document.getElementById('mod-ticket-info').innerHTML =
            '<b>Albarán:</b> ' + escapeHtml(d.id || d._id) + '<br>' +
            '<b>Destino:</b> ' + escapeHtml(d.receiver || '---') + '<br>' +
            '<b>Dirección actual:</b> ' + escapeHtml(addr || '---');
        document.getElementById('mod-address').value = '';
        document.getElementById('mod-packages').value = '';
        document.getElementById('mod-notes').value = '';
        document.getElementById('mod-modal').classList.add('active');
    }

    document.getElementById('btn-mod-cancel').addEventListener('click', function() {
        document.getElementById('mod-modal').classList.remove('active');
        modDocId = null;
    });

    document.getElementById('mod-modal').addEventListener('click', function(e) {
        if (e.target === e.currentTarget) {
            document.getElementById('mod-modal').classList.remove('active');
            modDocId = null;
        }
    });

    document.getElementById('btn-mod-send').addEventListener('click', async function() {
        if (!modDocId) return;
        var d = deliveries.find(function(x) { return x._id === modDocId; });
        if (!d) return;

        var newAddr = document.getElementById('mod-address').value.trim();
        var newPkgs = document.getElementById('mod-packages').value.trim();
        var newNotes = document.getElementById('mod-notes').value.trim();

        if (!newAddr && !newPkgs && !newNotes) {
            showToast('Indica al menos un cambio o motivo.', 'warning');
            return;
        }

        if (!navigator.onLine) {
            sendNotification('Sin conexión', 'No hay conexión a internet. Inténtalo cuando recuperes la señal.', 'warning');
            return;
        }

        showLoading();
        var changes = {};
        if (newAddr && newAddr !== d.address) changes.address = newAddr;
        if (newPkgs) changes.packages = parseInt(newPkgs);
        if (newNotes) changes.notes = (d.notes || '') + ' | [REPARTIDOR ' + currentDriverName + ': ' + newNotes + ']';

        try {
            await d._ref.update({
                pendingChanges: changes,
                pendingChangesText: 'Modificación solicitada por ' + currentDriverName + ' (' + currentDriverPhone + ')',
                status: 'pending_confirmation'
            });
            // Immediately remove it from local state to ensure it hides before snapshot arrives
            var idx = deliveries.findIndex(function(x) { return x._id === d._id; });
            if (idx > -1) deliveries[idx].status = 'pending_confirmation';
            renderDeliveries();
            document.getElementById('mod-modal').classList.remove('active');
            modDocId = null;
            showToast('Solicitud enviada al admin.', 'success');
        } catch (e) {
            showToast('Error: ' + e.message, 'error');
        } finally {
            hideLoading();
        }
    });

    // --- NAVIGATION ---
    function switchView(viewId) {
        document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
        document.getElementById(viewId).classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
        var navBtn = document.querySelector('.nav-btn[data-view="' + viewId + '"]');
        if (navBtn) navBtn.classList.add('active');

        if (viewId === 'view-scanner') { startScanner(); } else { stopScanner(); }
        if (viewId === 'view-map') { setTimeout(initMap, 200); }
    }

    document.querySelectorAll('.nav-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { switchView(btn.dataset.view); });
    });

    document.getElementById('btn-scan-fab').addEventListener('click', function() { switchView('view-scanner'); });

    // --- QR SCANNER ---
    async function startScanner() {
        var container = document.getElementById('qr-reader');
        if (!container || typeof Html5Qrcode === 'undefined') return;
        if (qrScanner) await stopScanner();
        try {
            qrScanner = new Html5Qrcode('qr-reader');
            await qrScanner.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 250, height: 250 } },
                function(text) { stopScanner(); handleScan(text); }
            );
        } catch (e) { console.error('Scanner start error:', e); }
    }

    async function stopScanner() {
        if (qrScanner) {
            try { await qrScanner.stop(); } catch (e) {}
            qrScanner = null;
        }
    }

    document.getElementById('btn-manual-search').addEventListener('click', function() {
        var val = document.getElementById('manual-id-input').value.trim();
        if (val) handleScan(val);
    });

    document.getElementById('manual-id-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            var val = e.target.value.trim();
            if (val) handleScan(val);
        }
    });

    // --- HANDLE SCAN ---
    async function handleScan(rawText) {
        showLoading();
        var searchId = rawText.trim();
        var pkgNum = 0; // 0 = old format (no individual tracking)
        var pkgTotal = 0;

        // Parse structured QR: ID:xxx|DEST:xxx|...|PKG:2/3
        if (rawText.indexOf('|') > -1 && rawText.toUpperCase().indexOf('ID:') > -1) {
            var parts = rawText.split('|');
            parts.forEach(function(p) {
                var idx = p.indexOf(':');
                if (idx > -1) {
                    var key = p.substring(0, idx).trim().toUpperCase();
                    var val = p.substring(idx + 1).trim();
                    if (key === 'ID') searchId = val;
                    if (key === 'PKG') {
                        var pkgParts = val.split('/');
                        if (pkgParts.length === 2) {
                            pkgNum = parseInt(pkgParts[0]) || 0;
                            pkgTotal = parseInt(pkgParts[1]) || 0;
                        }
                    }
                }
            });
        }

        try {
            if (rawText.charAt(0) === '{') {
                var j = JSON.parse(rawText);
                searchId = j.docId || j.id || searchId;
            }
        } catch (e) {}

        try {
            var doc = await db.collection('tickets').doc(searchId).get();
            if (!doc.exists) {
                var snap = await db.collection('tickets').where('id', '==', searchId).get();
                if (snap.empty) {
                    var snap2 = await db.collection('tickets').where('id', '==', searchId.replace(/^0+/, '')).get();
                    if (snap2.empty) {
                        // Ticket not found — could be deleted by admin
                        showToast('ALBARÁN NO ENCONTRADO: ' + searchId + '. Puede haber sido eliminado por administración.', 'error', 6000);
                        hideLoading();
                        return;
                    }
                    doc = snap2.docs[0];
                } else {
                    doc = snap.docs[0];
                }
            }

            var d = doc.data();
            d._id = doc.id;
            d._ref = doc.ref;
            currentScanDoc = d;

            // --- DETECT ALREADY DELIVERED ---
            var isAlreadyDelivered = d.status === 'Entregado' || d.delivered;
            if (isAlreadyDelivered) {
                var deliveredDate = '';
                if (d.deliveredAt) {
                    try { deliveredDate = ' el ' + (d.deliveredAt.toDate ? d.deliveredAt.toDate() : new Date(d.deliveredAt)).toLocaleString('es-ES'); } catch(e) {}
                }
                showToast('ALBARÁN YA ENTREGADO' + deliveredDate + '. Receptor: ' + (d.deliveredTo || d.receiverName || '---'), 'warning', 8000);
            }

            // --- DETECT INCIDENCIA / DEVUELTO ---
            if (d.status === 'Incidencia') {
                showToast('ALBARÁN CON INCIDENCIA registrada. Consulta con administración.', 'warning', 6000);
            } else if (d.status === 'Devuelto') {
                showToast('ALBARÁN MARCADO COMO DEVUELTO. No se debe entregar.', 'error', 6000);
            }

            // Calculate total packages from ticket data
            var totalPkgs = d.packagesList ? d.packagesList.reduce(function(s, p) { return s + (parseInt(p.qty) || 1); }, 0) : (parseInt(d.packages) || 1);
            if (pkgTotal > 0) totalPkgs = pkgTotal; // trust QR if present
            currentPkgTotal = totalPkgs;

            // Initialize scanned set for this ticket if needed
            var ticketKey = d.id || d._id;
            if (!scannedPackages[ticketKey]) {
                scannedPackages[ticketKey] = new Set();
            }

            // --- DETECT DUPLICATE SCAN (same ticket, old format, already fully scanned) ---
            if (pkgNum === 0 && scannedPackages[ticketKey].size >= totalPkgs && scannedPackages[ticketKey].size > 0 && !isAlreadyDelivered) {
                showToast('Este albarán ya fue escaneado en esta sesión.', 'info', 5000);
            }

            // Register scanned package
            if (pkgNum > 0) {
                if (scannedPackages[ticketKey].has(pkgNum)) {
                    showToast('Bulto ' + pkgNum + '/' + totalPkgs + ' ya escaneado (duplicado).', 'warning');
                } else {
                    scannedPackages[ticketKey].add(pkgNum);
                    showToast('Bulto ' + pkgNum + '/' + totalPkgs + ' escaneado', 'success');
                }
            } else {
                // Old QR format without PKG — mark ALL as scanned
                for (var i = 1; i <= totalPkgs; i++) scannedPackages[ticketKey].add(i);
                if (!isAlreadyDelivered && d.status !== 'Devuelto' && d.status !== 'Incidencia') {
                    showToast('Albarán encontrado: ' + ticketKey, 'success');
                }
            }

            await loadTicketForConfirmation(d, totalPkgs);
        } catch (e) {
            showToast('Error buscando albarán: ' + e.message, 'error');
        } finally {
            hideLoading();
        }
    }

    async function loadTicketForConfirmation(d, totalPkgs) {
        currentScanDoc = d;
        var panel = document.getElementById('scan-result');
        panel.style.display = 'block';

        document.getElementById('scan-ticket-id').textContent = 'ALBARÁN: ' + (d.id || d._id);
        var statusEl = document.getElementById('scan-ticket-status');
        var isDelivered = d.status === 'Entregado' || d.delivered;
        var statusText = isDelivered ? 'ENTREGADO' : (d.status === 'Incidencia' ? 'INCIDENCIA' : (d.status === 'Devuelto' ? 'DEVUELTO' : 'PENDIENTE'));
        var statusClass = isDelivered ? 'delivered' : (d.status === 'Incidencia' || d.status === 'Devuelto' ? 'delivered' : 'pending');
        statusEl.textContent = statusText;
        statusEl.className = 'dc-status ' + statusClass;
        if (d.status === 'Incidencia') { statusEl.style.background = 'rgba(255,152,0,0.2)'; statusEl.style.color = '#FF9800'; }
        else if (d.status === 'Devuelto') { statusEl.style.background = 'rgba(255,59,48,0.2)'; statusEl.style.color = '#FF3B30'; }
        else { statusEl.style.background = ''; statusEl.style.color = ''; }

        var addr = [d.address, d.localidad, d.cp, d.province].filter(Boolean).join(', ');
        if (!totalPkgs) totalPkgs = getPackageCount(d);
        var ticketKey = d.id || d._id;
        var scanned = scannedPackages[ticketKey] || new Set();
        var scannedCount = scanned.size;
        var allScanned = scannedCount >= totalPkgs;

        // Build package progress HTML
        var pkgProgressHtml = '';
        if (totalPkgs > 1) {
            pkgProgressHtml = '<div style="margin:8px 0; padding:8px; background:rgba(255,255,255,0.05); border-radius:8px; border:1px solid var(--border);">';
            pkgProgressHtml += '<div style="font-size:0.7rem; color:var(--text-dim); font-weight:700; margin-bottom:6px;">CONTROL DE BULTOS (' + scannedCount + '/' + totalPkgs + '):</div>';
            pkgProgressHtml += '<div style="display:flex; flex-wrap:wrap; gap:4px;">';
            for (var i = 1; i <= totalPkgs; i++) {
                var isScanned = scanned.has(i);
                pkgProgressHtml += '<div style="padding:4px 10px; border-radius:6px; font-size:0.75rem; font-weight:700; ' +
                    (isScanned
                        ? 'background:rgba(76,217,100,0.2); color:#4CD964; border:1px solid rgba(76,217,100,0.4);'
                        : 'background:rgba(255,255,255,0.05); color:var(--text-dim); border:1px solid var(--border);') +
                    '">' + (isScanned ? '<span class="material-symbols-outlined icon-filled" style="font-size:.85rem; vertical-align:middle;">check_circle</span>' : '<span class="material-symbols-outlined" style="font-size:.85rem; vertical-align:middle;">check_box_outline_blank</span>') + ' Bulto ' + i + '</div>';
            }
            pkgProgressHtml += '</div>';
            if (!allScanned && !isDelivered) {
                pkgProgressHtml += '<div style="margin-top:8px; text-align:center;"><button id="btn-scan-next-pkg" style="background:var(--brand); color:white; border:none; padding:8px 20px; border-radius:8px; font-weight:700; font-size:0.8rem; cursor:pointer;"><span class="material-symbols-outlined" style="font-size:.9rem; vertical-align:middle;">qr_code_scanner</span> ESCANEAR SIGUIENTE BULTO</button></div>';
            }
            pkgProgressHtml += '</div>';
        }

        document.getElementById('scan-ticket-details').innerHTML =
            '<b>Destino:</b> ' + escapeHtml(d.receiver || '---') + '<br>' +
            '<b>Dirección:</b> ' + escapeHtml(addr) + '<br>' +
            '<b>Bultos:</b> ' + escapeHtml(totalPkgs) + '<br>' +
            '<b>Remitente:</b> ' + escapeHtml(d.sender || '---') + '<br>' +
            (d.notes ? '<b>Obs:</b> ' + escapeHtml(d.notes) + '<br>' : '') +
            (isDelivered ? '<div style="margin:8px 0; padding:10px; background:rgba(76,217,100,0.15); border:1px solid rgba(76,217,100,0.4); border-radius:8px; text-align:center; font-weight:700; font-size:0.85rem; color:#4CD964;"><span class="material-symbols-outlined icon-filled" style="font-size:1rem; vertical-align:middle;">check_circle</span> YA ENTREGADO' + (d.deliveredTo ? ' — Receptor: ' + escapeHtml(d.deliveredTo) : '') + '</div>' : '') +
            (d.status === 'Devuelto' ? '<div style="margin:8px 0; padding:10px; background:rgba(255,59,48,0.15); border:1px solid rgba(255,59,48,0.4); border-radius:8px; text-align:center; font-weight:700; font-size:0.85rem; color:#FF3B30;"><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">block</span> DEVUELTO — No entregar</div>' : '') +
            (d.status === 'Incidencia' ? '<div style="margin:8px 0; padding:10px; background:rgba(255,152,0,0.15); border:1px solid rgba(255,152,0,0.4); border-radius:8px; text-align:center; font-weight:700; font-size:0.85rem; color:#FF9800;"><span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">warning</span> INCIDENCIA — Consultar con administración</div>' : '') +
            pkgProgressHtml;

        // Bind "scan next" button
        var btnScanNext = document.getElementById('btn-scan-next-pkg');
        if (btnScanNext) {
            btnScanNext.addEventListener('click', function() {
                switchView('view-scanner');
            });
        }

        var confirmPanel = document.getElementById('confirm-panel');
        var btnConfirm = document.getElementById('btn-confirm-delivery');
        if (isDelivered || d.status === 'Devuelto') {
            confirmPanel.style.display = 'none';
            btnConfirm.style.display = 'none';
        } else {
            confirmPanel.style.display = 'block';
            // Show confirm button only if all packages scanned
            if (allScanned) {
                btnConfirm.style.display = 'flex';
                btnConfirm.innerHTML = '<span class="material-symbols-outlined icon-filled" style="font-size:1rem; vertical-align:middle;">check_circle</span> REGISTRAR ENTREGA';
            } else {
                btnConfirm.style.display = 'flex';
                btnConfirm.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">schedule</span> FALTAN ' + (totalPkgs - scannedCount) + ' BULTOS';
            }
            document.getElementById('confirm-receiver').value = '';
            clearSignature();
            document.getElementById('photo-preview').style.display = 'none';
            document.getElementById('confirm-photo').value = '';
            document.getElementById('photo-status').textContent = 'Sin foto';
        }
    }

    // --- CONFIRM DELIVERY ---
    document.getElementById('btn-confirm-delivery').addEventListener('click', async function() {
        if (!currentScanDoc) return;
        if (confirmInProgress) return; // Prevent double-click

        // Offline check moved after validation — we allow queueing if offline

        // Check all packages scanned
        var ticketKey = currentScanDoc.id || currentScanDoc._id;
        var scanned = scannedPackages[ticketKey] || new Set();
        if (currentPkgTotal > 1 && scanned.size < currentPkgTotal) {
            showToast('Faltan ' + (currentPkgTotal - scanned.size) + ' bultos por escanear.', 'warning');
            return;
        }

        var receiverName = document.getElementById('confirm-receiver').value.trim();
        if (!receiverName) {
            showToast('Indica quién recibe el paquete.', 'warning');
            document.getElementById('confirm-receiver').focus();
            return;
        }
        if (isSignatureEmpty()) {
            showToast('Se necesita la firma del receptor.', 'warning');
            return;
        }

        var btn = document.getElementById('btn-confirm-delivery');
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1rem; vertical-align:middle;">hourglass_top</span> Procesando...';
        showLoading();
        confirmInProgress = true; // Block snapshot re-renders

        // Helper: wrap a promise with a timeout
        function withTimeout(promise, ms, label) {
            return Promise.race([
                promise,
                new Promise(function(_, reject) {
                    setTimeout(function() { reject(new Error(label + ' timeout (' + ms + 'ms)')); }, ms);
                })
            ]);
        }

        try {
            var docId = currentScanDoc._id;
            var docRef = currentScanDoc._ref || db.collection('tickets').doc(docId);
            var deliveryData = {
                status: 'Entregado',
                delivered: true,
                deliveredAt: firebase.firestore.FieldValue.serverTimestamp(),
                distributedAt: firebase.firestore.FieldValue.serverTimestamp(),
                deliveryReceiverName: receiverName,
                deliveredByDriver: currentDriverName,
                deliveredByPhone: currentDriverPhone
            };

            // Auto-asignación de cargo según tipo de porte
            if (currentScanDoc.shippingType === 'Debidos') {
                deliveryData.billingTarget = 'destinatario';
                deliveryData.billingName = receiverName;
            } else {
                deliveryData.billingTarget = 'remitente';
                deliveryData.billingName = currentScanDoc.sender || currentScanDoc.clientName || '';
            }
            // --- Prepare archive data before uploads (needed for offline queue) ---
            var archiveData = {
                ticketId: docId,
                ticketRef: currentScanDoc.id || docId,
                status: 'Entregado',
                receiverName: receiverName,
                driverName: currentDriverName,
                driverPhone: currentDriverPhone,
                sender: currentScanDoc.sender || currentScanDoc.clientName || '',
                senderUid: currentScanDoc.uid || null,
                clientIdNum: currentScanDoc.clientIdNum || null,
                recipient: currentScanDoc.recipient || currentScanDoc.destinatario || '',
                destination: currentScanDoc.destination || currentScanDoc.localidad || '',
                shippingType: currentScanDoc.shippingType || '',
                packages: currentScanDoc.packages || currentScanDoc.bultos || 1,
                route: currentScanDoc.route || currentScanDoc.driverPhone || ''
            };
            var notifData = currentScanDoc.uid ? {
                uid: currentScanDoc.uid,
                type: 'delivery_confirmed',
                ticketId: docId,
                message: 'Su envío #' + (currentScanDoc.id || docId) + ' ha sido entregado a ' + receiverName,
                receiverName: receiverName,
                read: false
            } : null;

            // --- OFFLINE PATH: queue everything for later sync ---
            if (!navigator.onLine) {
                var sigB64 = getSignatureDataURL();
                // Remove serverTimestamp (not serializable) — will be set on sync
                var offlineDeliveryData = Object.assign({}, deliveryData);
                offlineDeliveryData.deliveredAt = new Date().toISOString();
                offlineDeliveryData.distributedAt = new Date().toISOString();
                offlineDeliveryData.billingReady = !!sigB64;
                offlineDeliveryData._offlineSignatureB64 = sigB64 || null;

                var offlineArchiveData = Object.assign({}, archiveData);
                offlineArchiveData.deliveredAt = new Date().toISOString();
                offlineArchiveData.archivedAt = new Date().toISOString();

                await _offlineQueue.enqueue({
                    type: 'delivery_confirm',
                    ticketId: docId,
                    deliveryData: offlineDeliveryData,
                    archiveData: offlineArchiveData,
                    notification: notifData
                });

                // Show success to driver — will sync when online
                document.getElementById('scan-ticket-details').innerHTML =
                    '<div style="text-align:center; padding:20px;">' +
                        '<div style="font-size:3rem;"><span class="material-symbols-outlined icon-filled" style="font-size:3rem; color:#FF9800;">cloud_off</span></div>' +
                        '<div style="font-size:1.1rem; font-weight:900; color:#FF9800; margin:8px 0;">ENTREGA GUARDADA OFFLINE</div>' +
                        '<div style="color:var(--text-dim); font-size:0.85rem;">Se sincronizará automáticamente al recuperar conexión</div>' +
                        '<div style="color:var(--text-dim); font-size:0.8rem; margin-top:5px;">Receptor: <b>' + escapeHtml(receiverName) + '</b></div>' +
                    '</div>';
                document.getElementById('confirm-panel').style.display = 'none';
                btn.style.display = 'none';
                showToast('Entrega guardada offline. Se sincronizará al conectar.', 'warning', 6000);

                var doneKey = currentScanDoc.id || currentScanDoc._id;
                delete scannedPackages[doneKey];
                currentPkgTotal = 0;
                setTimeout(function() {
                    document.getElementById('scan-result').style.display = 'none';
                    confirmInProgress = false;
                    switchView('view-deliveries');
                    renderDeliveries();
                    btn.disabled = false;
                    btn.innerHTML = '<span class="material-symbols-outlined icon-filled" style="font-size:1rem; vertical-align:middle;">check_circle</span> REGISTRAR ENTREGA';
                }, 2500);
                hideLoading();
                return; // Exit early — queued for later
            }

            // --- ONLINE PATH: upload + save normally ---
            // Upload signature (MANDATORY — abort delivery if fails)
            var sigData = getSignatureDataURL();
            if (sigData) {
                var sigBlob = await (await fetch(sigData)).blob();
                var sigRef = storage.ref('deliveries/' + docId + '/signature.png');
                await withTimeout(sigRef.put(sigBlob, { contentType: 'image/png' }), 15000, 'Firma');
                deliveryData.signatureURL = await withTimeout(sigRef.getDownloadURL(), 5000, 'Firma URL');
            }

            // Upload photo (optional, non-blocking on failure)
            try {
                var photoFile = document.getElementById('confirm-photo').files[0];
                if (photoFile) {
                    photoFile = await compressImage(photoFile);
                    var photoRef = storage.ref('deliveries/' + docId + '/photo.jpg');
                    await withTimeout(photoRef.put(photoFile, { contentType: photoFile.type }), 20000, 'Foto');
                    deliveryData.photoURL = await withTimeout(photoRef.getDownloadURL(), 5000, 'Foto URL');
                }
            } catch (photoErr) {
                console.warn('Photo upload failed (will save delivery anyway):', photoErr);
            }

            // billingReady only if signature was uploaded
            deliveryData.billingReady = !!deliveryData.signatureURL;

            // Update archive with URLs
            archiveData.signatureURL = deliveryData.signatureURL || null;
            archiveData.photoURL = deliveryData.photoURL || null;
            archiveData.billingTarget = deliveryData.billingTarget || null;
            archiveData.billingName = deliveryData.billingName || null;
            archiveData.billingReady = deliveryData.billingReady || false;
            archiveData.deliveredAt = firebase.firestore.FieldValue.serverTimestamp();
            archiveData.archivedAt = firebase.firestore.FieldValue.serverTimestamp();

            var deliveryBatch = db.batch();
            deliveryBatch.update(docRef, deliveryData);
            deliveryBatch.set(db.collection('delivery_archive').doc(docId), archiveData);
            await withTimeout(deliveryBatch.commit(), 15000, 'Firestore batch');
            console.log('[REPARTO] Entrega confirmada + archivada:', docId);

            // --- POD: Notificar al cliente (non-blocking) ---
            try {
                if (notifData) {
                    notifData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                    await db.collection('user_notifications').add(notifData);
                }
            } catch (notifErr) {
                console.warn('Error mandando notificación al cliente:', notifErr);
            }

            document.getElementById('scan-ticket-details').innerHTML =
                '<div style="text-align:center; padding:20px;">' +
                    '<div style="font-size:3rem;"><span class="material-symbols-outlined icon-filled" style="font-size:3rem; color:var(--success);">check_circle</span></div>' +
                    '<div style="font-size:1.1rem; font-weight:900; color:var(--success); margin:8px 0;">¡ENTREGA REGISTRADA!</div>' +
                    '<div style="color:var(--text-dim); font-size:0.85rem;">Receptor: <b>' + escapeHtml(receiverName) + '</b></div>' +
                '</div>';
            document.getElementById('confirm-panel').style.display = 'none';
            btn.style.display = 'none';
            showToast('Entrega registrada correctamente.', 'success');

            // Clean up package tracker
            var doneKey = currentScanDoc.id || currentScanDoc._id;
            delete scannedPackages[doneKey];
            currentPkgTotal = 0;

            setTimeout(function() {
                document.getElementById('scan-result').style.display = 'none';
                confirmInProgress = false; // Re-enable snapshot renders
                switchView('view-deliveries');
                renderDeliveries(); // Force refresh now
                btn.disabled = false;
                btn.innerHTML = '<span class="material-symbols-outlined icon-filled" style="font-size:1rem; vertical-align:middle;">check_circle</span> REGISTRAR ENTREGA';
                btn.style.display = 'flex';
            }, 2000);

        } catch (e) {
            console.error('Delivery confirmation error:', e);
            showToast('Error: ' + e.message, 'error');
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined icon-filled" style="font-size:1rem; vertical-align:middle;">check_circle</span> REGISTRAR ENTREGA';
            confirmInProgress = false; // Re-enable snapshot renders
        } finally {
            hideLoading();
        }
    });

    // --- SIGNATURE CANVAS (responsive) ---
    (function() {
        var canvas = document.getElementById('sig-canvas');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var drawing = false, lx = 0, ly = 0;

        function resizeCanvas() {
            var wrap = canvas.parentElement;
            var w = wrap ? wrap.clientWidth : 300;
            var h = Math.round(w * 0.35); // ~35% aspect ratio
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        function pos(e) {
            var r = canvas.getBoundingClientRect();
            var sx = canvas.width / r.width, sy = canvas.height / r.height;
            var t = e.touches ? e.touches[0] : e;
            return { x: (t.clientX - r.left) * sx, y: (t.clientY - r.top) * sy };
        }
        function start(e) { e.preventDefault(); drawing = true; var p = pos(e); lx = p.x; ly = p.y; }
        function draw(e) {
            if (!drawing) return; e.preventDefault();
            var p = pos(e);
            ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(p.x, p.y);
            ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.stroke();
            lx = p.x; ly = p.y;
        }
        function stop() { drawing = false; }

        canvas.addEventListener('mousedown', start);
        canvas.addEventListener('mousemove', draw);
        canvas.addEventListener('mouseup', stop);
        canvas.addEventListener('mouseleave', stop);
        canvas.addEventListener('touchstart', start, { passive: false });
        canvas.addEventListener('touchmove', draw, { passive: false });
        canvas.addEventListener('touchend', stop);
    })();

    function clearSignature() {
        var c = document.getElementById('sig-canvas');
        if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    }
    document.getElementById('btn-clear-sig').addEventListener('click', clearSignature);

    function isSignatureEmpty() {
        var c = document.getElementById('sig-canvas');
        if (!c) return true;
        var b = document.createElement('canvas');
        b.width = c.width; b.height = c.height;
        return c.toDataURL() === b.toDataURL();
    }

    function getSignatureDataURL() {
        var c = document.getElementById('sig-canvas');
        return c ? c.toDataURL('image/png') : null;
    }

    // --- PHOTO ---
    document.getElementById('btn-take-photo').addEventListener('click', function() {
        document.getElementById('confirm-photo').click();
    });
    document.getElementById('confirm-photo').addEventListener('change', function(e) {
        var f = e.target.files[0];
        if (f) {
            var reader = new FileReader();
            reader.onload = function(ev) {
                document.getElementById('photo-preview').src = ev.target.result;
                document.getElementById('photo-preview').style.display = 'block';
                document.getElementById('photo-status').innerHTML = '<span class="material-symbols-outlined icon-filled" style="font-size:.9rem; vertical-align:middle; color:var(--success);">check_circle</span> Foto lista';
            };
            reader.readAsDataURL(f);
        }
    });

    // --- MAP (GOOGLE MAPS) ---
    var _infoWindow = null;
    async function initMap() {
        var container = document.getElementById('route-map');
        if (!container) return;

        if (!googleMap) {
            googleMap = new google.maps.Map(container, {
                center: { lat: 36.72, lng: -4.42 },
                zoom: 12,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true
            });
            _infoWindow = new google.maps.InfoWindow();
        }

        // Clear existing markers
        mapMarkers.forEach(function(m) { m.setMap(null); });
        mapMarkers = [];
        if (window._routeLine) { window._routeLine.setMap(null); window._routeLine = null; }

        if (deliveries.length === 0) {
            showToast('No hay entregas para mostrar en el mapa.', 'info');
            return;
        }

        var pending = deliveries.filter(function(d) { return d.status !== 'Entregado' && !d.delivered; });
        var delivered = deliveries.filter(function(d) { return d.status === 'Entregado' || d.delivered; });
        var routeCoords = [];
        var allDeliveries = [].concat(pending, delivered);

        function makeIcon(color, label, size) {
            size = size || 28;
            var half = size / 2;
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
                '<circle cx="' + half + '" cy="' + half + '" r="' + (half - 2) + '" fill="' + color + '" stroke="white" stroke-width="2"/>' +
                '<text x="' + half + '" y="' + (half + 4) + '" text-anchor="middle" fill="white" font-size="' + Math.round(size * 0.38) + '" font-weight="bold">' + (label || '') + '</text>' +
                '</svg>';
            return {
                url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
                scaledSize: new google.maps.Size(size, size),
                anchor: new google.maps.Point(half, half)
            };
        }

        // Helper: geocode with fallback (full addr → locality+cp → province)
        if (!_geocoder) _geocoder = new google.maps.Geocoder();
        async function geocodeWithFallback(d) {
            if (d._lat && d._lon) return true;

            var parts1 = [d.address, d.localidad, d.cp, d.province, 'España'].filter(Boolean);
            if (parts1.length > 1) {
                await tryGeocode(d, parts1.join(', '));
                if (d._lat) return true;
            }
            var parts2 = [d.localidad, d.cp, d.province, 'España'].filter(Boolean);
            if (parts2.length > 1 && parts2.join(',') !== parts1.join(',')) {
                await tryGeocode(d, parts2.join(', '));
                if (d._lat) return true;
            }
            if (d.address && d.address.length > 5) {
                await tryGeocode(d, d.address + ', España');
                if (d._lat) return true;
            }
            return false;
        }

        async function tryGeocode(d, addr) {
            if (!addr || addr.trim() === 'España') return;
            if (geocodeCache[addr]) {
                d._lat = geocodeCache[addr].lat;
                d._lon = geocodeCache[addr].lon;
                return;
            }
            try {
                var result = await _geocoder.geocode({ address: addr, region: 'es' });
                if (result.results && result.results[0]) {
                    var loc = result.results[0].geometry.location;
                    d._lat = loc.lat();
                    d._lon = loc.lng();
                    geocodeCache[addr] = { lat: d._lat, lon: d._lon };
                }
            } catch (e) { console.warn('Geocode error:', addr, e); }
        }

        showToast('Cargando mapa: 0/' + allDeliveries.length + ' direcciones...', 'info');

        var geocoded = 0;
        var failed = 0;
        for (var i = 0; i < allDeliveries.length; i++) {
            var d = allDeliveries[i];
            var success = await geocodeWithFallback(d);

            if (success && d._lat && d._lon) {
                var isDelivered = d.status === 'Entregado' || d.delivered;
                var pkgCount = getPackageCount(d);
                var pendingIdx = pending.indexOf(d);
                var icon = isDelivered
                    ? makeIcon('#4CD964', '\u2713')
                    : makeIcon('#FF6600', String(pendingIdx + 1));

                var marker = new google.maps.Marker({
                    position: { lat: d._lat, lng: d._lon },
                    map: googleMap,
                    icon: icon
                });

                (function(mk, dd, isDel, pkgC, pIdx) {
                    mk.addListener('click', function() {
                        _infoWindow.setContent(
                            '<div style="min-width:160px;">' +
                            '<b style="font-size:0.9rem;">' + (dd.receiver || '') + '</b><br>' +
                            '<span style="color:#666;">' + [dd.address, dd.localidad, dd.cp].filter(Boolean).join(', ') + '</span><br>' +
                            '<span class="material-symbols-outlined" style="font-size:.9rem; vertical-align:middle;">inventory_2</span> ' + pkgC + ' bultos<br>' +
                            '<span style="font-weight:700; color:' + (isDel ? '#4CD964' : '#FF6600') + ';">' +
                            (isDel ? '<span class="material-symbols-outlined icon-filled" style="font-size:.9rem; vertical-align:middle;">check_circle</span> ENTREGADO' : '<span class="material-symbols-outlined" style="font-size:.9rem; vertical-align:middle;">schedule</span> PENDIENTE (#' + (pIdx + 1) + ')') +
                            '</span></div>'
                        );
                        _infoWindow.open(googleMap, mk);
                    });
                })(marker, d, isDelivered, pkgCount, pendingIdx);

                mapMarkers.push(marker);

                if (!isDelivered) {
                    routeCoords[pendingIdx] = { lat: d._lat, lng: d._lon };
                }
                geocoded++;
            } else {
                failed++;
                console.warn('Geocode failed for:', d.receiver, [d.address, d.localidad, d.cp, d.province].filter(Boolean).join(', '));
            }

            if ((i + 1) % 3 === 0 || i === allDeliveries.length - 1) {
                showToast('Mapa: ' + (i + 1) + '/' + allDeliveries.length + ' (' + geocoded + ' ok, ' + failed + ' sin ubicar)', 'info');
            }
        }

        // Final: fit bounds and draw route
        if (mapMarkers.length > 0) {
            var bounds = new google.maps.LatLngBounds();
            mapMarkers.forEach(function(m) { bounds.extend(m.getPosition()); });
            googleMap.fitBounds(bounds);

            var orderedCoords = routeCoords.filter(Boolean);
            if (orderedCoords.length > 1) {
                window._routeLine = new google.maps.Polyline({
                    path: orderedCoords,
                    strokeColor: '#FF6600',
                    strokeWeight: 3,
                    strokeOpacity: 0.6,
                    geodesic: true,
                    map: googleMap
                });
            }
        }

        showToast('Mapa completo: ' + geocoded + ' ubicadas' + (failed > 0 ? ', ' + failed + ' sin localizar' : ''), failed > 0 ? 'warning' : 'success');

        // --- ADD PICKUP/ALERT MARKERS ---
        if (_driverAlerts && _driverAlerts.length > 0) {
            var alertsWithAddr = _driverAlerts.filter(function(a) { return a.address; });
            if (alertsWithAddr.length > 0) {
                showToast('Cargando ' + alertsWithAddr.length + ' recogida(s) en mapa...', 'info');
            }
            for (var ai = 0; ai < alertsWithAddr.length; ai++) {
                var alert = alertsWithAddr[ai];
                var alertCoords = null;

                var alertAddr = alert.address + ', Espa\u00f1a';
                if (geocodeCache[alertAddr]) {
                    alertCoords = geocodeCache[alertAddr];
                } else {
                    try {
                        var gResult = await _geocoder.geocode({ address: alertAddr, region: 'es' });
                        if (gResult.results && gResult.results[0]) {
                            var gLoc = gResult.results[0].geometry.location;
                            alertCoords = { lat: gLoc.lat(), lon: gLoc.lng() };
                            geocodeCache[alertAddr] = alertCoords;
                        }
                    } catch(e) { console.warn('Alert geocode error:', e); }
                }

                if (alertCoords) {
                    var aColor = alert.type === 'recogida' ? '#FF9800' : (alert.type === 'entrega_urgente' ? '#FF3B30' : '#2196F3');
                    var aShort = alert.type === 'recogida' ? 'R' : (alert.type === 'entrega_urgente' ? '!' : 'A');
                    var aLabelFull = alert.type === 'recogida' ? 'RECOGIDA' : (alert.type === 'entrega_urgente' ? 'URGENTE' : 'AVISO');

                    var alertMk = new google.maps.Marker({
                        position: { lat: alertCoords.lat, lng: alertCoords.lon || alertCoords.lng },
                        map: googleMap,
                        icon: makeIcon(aColor, aShort, 34),
                        zIndex: 999
                    });

                    (function(mk, al, col, lbl) {
                        mk.addListener('click', function() {
                            _infoWindow.setContent(
                                '<div style="min-width:180px;">' +
                                '<b style="font-size:0.9rem; color:' + col + ';">' + lbl + '</b><br>' +
                                '<span style="color:#333;">' + al.address + '</span><br>' +
                                (al.notes ? '<span style="color:#666; font-size:0.85em;">' + al.notes + '</span><br>' : '') +
                                '<a href="https://www.google.com/maps/search/' + encodeURIComponent(al.address) + '" target="_blank" style="color:#1a73e8; font-weight:700; font-size:0.85em;">Navegar \u2192</a>' +
                                '</div>'
                            );
                            _infoWindow.open(googleMap, mk);
                        });
                    })(alertMk, alert, aColor, aLabelFull);

                    mapMarkers.push(alertMk);
                }
            }
            // Re-fit bounds to include alert markers
            if (mapMarkers.length > 0) {
                var allBounds = new google.maps.LatLngBounds();
                mapMarkers.forEach(function(m) { allBounds.extend(m.getPosition()); });
                googleMap.fitBounds(allBounds);
            }
        }
    }

    window.addEventListener('resize', function() {
        if (googleMap) google.maps.event.trigger(googleMap, 'resize');
    });

    // --- LIMPIAR JORNADA: Eliminar entregados de la ruta del repartidor ---
    async function clearDeliveredFromRoute() {
        var delivered = deliveries.filter(function(d) { return d.status === 'Entregado' || d.delivered; });
        if (delivered.length === 0) {
            showToast('No hay entregas entregadas para limpiar.', 'info');
            return;
        }
        showLoading();
        try {
            var batch = db.batch();
            var count = 0;
            delivered.forEach(function(d) {
                var ref = d._ref || db.collection('tickets').doc(d._id);
                batch.update(ref, { driverPhone: firebase.firestore.FieldValue.delete() });
                count++;
            });
            await batch.commit();
            showToast('\u2705 ' + count + ' entrega(s) limpiada(s) de tu ruta.', 'success');
        } catch (e) {
            console.error('Error limpiando jornada:', e);
            showToast('Error al limpiar: ' + e.message, 'error');
        } finally {
            hideLoading();
        }
    }
    window.clearDeliveredFromRoute = clearDeliveredFromRoute;

    // Botón "Limpiar Jornada"
    var btnClean = document.getElementById('btn-clean-route');
    if (btnClean) {
        btnClean.addEventListener('click', function() {
            var delivered = deliveries.filter(function(d) { return d.status === 'Entregado' || d.delivered; });
            if (delivered.length === 0) {
                showToast('No hay entregas entregadas para limpiar.', 'info');
                return;
            }
            if (confirm('\u00bfLimpiar ' + delivered.length + ' albar\u00e1n(es) entregados de tu ruta?\n\nLos pendientes se mantendr\u00e1n.')) {
                clearDeliveredFromRoute();
            }
        });
    }

    // --- LIMPIEZA AUTOMÁTICA CADA 8 HORAS ---
    (function schedulePeriodicClean() {
        var INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 horas

        // Ejecutar la primera limpieza tras 5 minutos (dar tiempo a que cargue todo)
        setTimeout(function() {
            console.log('[REPARTO] Limpieza automática inicial ejecutándose...');
            clearDeliveredFromRoute();
        }, 5 * 60 * 1000);

        // Repetir cada 8 horas
        setInterval(function() {
            console.log('[REPARTO] Limpieza automática periódica (cada 8h) ejecutándose...');
            clearDeliveredFromRoute();
        }, INTERVAL_MS);

        console.log('[REPARTO] Limpieza automática programada cada 8 horas.');
    })();

    // ============================================================
    //  COOPER PHOTO — Recogidas & Entregas
    // ============================================================
    var _cooperType = null; // 'recogida' or 'entrega'

    window.openCooperPhoto = function(type) {
        _cooperType = type;
        var modal = document.getElementById('cooper-modal');
        var title = document.getElementById('cooper-modal-title');
        if (!modal) return;
        if (type === 'recogida') {
            title.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.3rem;">download</span> RECOGIDA COOPER';
            title.style.color = '#FF9800';
        } else {
            title.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.3rem;">upload</span> ENTREGA COOPER';
            title.style.color = '#4CAF50';
        }
        // Reset
        document.getElementById('cooper-photo-preview').style.display = 'none';
        document.getElementById('cooper-photo-preview').src = '';
        document.getElementById('cooper-photo-input').value = '';
        document.getElementById('cooper-photo-status').textContent = 'Sin foto';
        document.getElementById('btn-cooper-send').style.display = 'none';
        document.getElementById('btn-cooper-delete-photo').style.display = 'none';
        var noteEl = document.getElementById('cooper-note');
        if (noteEl) noteEl.value = '';
        modal.classList.add('active');
    };

    // Camera button
    document.getElementById('btn-cooper-camera').addEventListener('click', function() {
        document.getElementById('cooper-photo-input').click();
    });

    // Photo selected
    document.getElementById('cooper-photo-input').addEventListener('change', function(e) {
        var f = e.target.files[0];
        if (f) {
            var reader = new FileReader();
            reader.onload = function(ev) {
                document.getElementById('cooper-photo-preview').src = ev.target.result;
                document.getElementById('cooper-photo-preview').style.display = 'block';
                document.getElementById('cooper-photo-status').textContent = 'Foto lista';
                document.getElementById('btn-cooper-send').style.display = 'block';
                document.getElementById('btn-cooper-delete-photo').style.display = 'block';
                document.getElementById('btn-cooper-camera').innerHTML = '<span class="material-symbols-outlined">refresh</span> REPETIR FOTO';
            };
            reader.readAsDataURL(f);
        }
    });

    // Delete selected photo (re-take)
    document.getElementById('btn-cooper-delete-photo').addEventListener('click', function() {
        document.getElementById('cooper-photo-input').value = '';
        document.getElementById('cooper-photo-preview').src = '';
        document.getElementById('cooper-photo-preview').style.display = 'none';
        document.getElementById('cooper-photo-status').textContent = 'Sin foto';
        document.getElementById('btn-cooper-send').style.display = 'none';
        document.getElementById('btn-cooper-delete-photo').style.display = 'none';
        document.getElementById('btn-cooper-camera').innerHTML = '<span class="material-symbols-outlined">camera_alt</span> ABRIR CAMARA';
    });

    // Cancel
    document.getElementById('btn-cooper-cancel').addEventListener('click', function() {
        document.getElementById('cooper-modal').classList.remove('active');
        _cooperType = null;
    });

    // Send photo
    document.getElementById('btn-cooper-send').addEventListener('click', async function() {
        var photoFile = document.getElementById('cooper-photo-input').files[0];
        if (!photoFile) { showToast('Haz una foto primero', 'error'); return; }

        if (!navigator.onLine) {
            sendNotification('Sin conexión', 'No hay conexión a internet. Inténtalo cuando recuperes la señal.', 'warning');
            return;
        }

        var sendBtn = document.getElementById('btn-cooper-send');
        sendBtn.disabled = true;
        sendBtn.textContent = 'Comprimiendo...';

        try {
            photoFile = await compressImage(photoFile);
            sendBtn.textContent = 'Subiendo...';
            var ts = Date.now();
            var storagePath = 'cooper/' + _cooperType + '/' + ts + '.jpg';
            var photoRef = storage.ref(storagePath);
            await photoRef.put(photoFile, { contentType: photoFile.type });
            var photoURL = await photoRef.getDownloadURL();

            // Save record to Firestore
            var noteVal = (document.getElementById('cooper-note') ? document.getElementById('cooper-note').value : '').trim();
            await db.collection('cooper_photos').add({
                type: _cooperType,
                photoURL: photoURL,
                storagePath: storagePath,
                note: noteVal,
                route: currentRouteLabel || 'Sin ruta',
                driverName: currentDriverName || 'Desconocido',
                driverPhone: currentDriverPhone || '',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                timestamp: ts
            });

            showToast((_cooperType === 'recogida' ? 'Recogida' : 'Entrega') + ' Cooper registrada', 'success');
            document.getElementById('cooper-modal').classList.remove('active');
            _cooperType = null;
            // Refresh counters and log
            cooperUpdateCounters();
            if (document.getElementById('cooper-log-panel').style.display !== 'none') {
                loadCooperLog();
            }
        } catch(err) {
            showToast('Error: ' + err.message, 'error');
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = 'ENVIAR FOTO';
        }
    });

    // =============================================
    //  COOPER COUNTERS + DAILY FOLDER ARCHIVE
    // =============================================
    var _cooperLogOpen = false;
    var _cooperAllItems = []; // cached from last load
    var _cooperOpenDay = null; // null = folders view, 'YYYY-MM-DD' = open folder

    // Update today's counters on buttons
    window.cooperUpdateCounters = async function() {
        try {
            var snap = await db.collection('cooper_photos')
                .where('driverName', '==', currentDriverName || 'Desconocido')
                .limit(2000)
                .get();
            var today = new Date().toLocaleDateString('es-ES');
            var recCount = 0, entCount = 0;
            _cooperAllItems = [];
            snap.forEach(function(doc) {
                var item = doc.data(); item.docId = doc.id;
                var d = item.createdAt ? (typeof item.createdAt.toDate === 'function' ? item.createdAt.toDate() : new Date(item.createdAt)) : new Date(item.timestamp || 0);
                _cooperAllItems.push({ data: item, date: d });
                if (d.toLocaleDateString('es-ES') === today) {
                    if (item.type === 'recogida') recCount++;
                    else entCount++;
                }
            });
            _cooperAllItems.sort(function(a, b) { return b.date - a.date; });
            var cR = document.getElementById('cooper-count-recogida');
            var cE = document.getElementById('cooper-count-entrega');
            if (cR) cR.textContent = recCount;
            if (cE) cE.textContent = entCount;
        } catch(e) { console.warn('[Cooper] Counter error:', e.message); }
    };

    window.toggleCooperLog = function() {
        var panel = document.getElementById('cooper-log-panel');
        var arrow = document.getElementById('cooper-log-arrow');
        _cooperLogOpen = !_cooperLogOpen;
        if (_cooperLogOpen) {
            panel.style.display = 'block';
            if (arrow) arrow.classList.add('open');
            _cooperOpenDay = null;
            loadCooperLog();
        } else {
            panel.style.display = 'none';
            if (arrow) arrow.classList.remove('open');
        }
    };

    window.cooperOpenDay = function(dayKey) {
        _cooperOpenDay = dayKey;
        _renderCooperLogContent();
    };

    window.cooperBackToFolders = function() {
        _cooperOpenDay = null;
        _renderCooperLogContent();
    };

    window.loadCooperLog = async function() {
        var panel = document.getElementById('cooper-log-panel');
        if (!panel) return;
        panel.innerHTML = '<div style="text-align:center; padding:20px; color:#888;">Cargando...</div>';
        await cooperUpdateCounters();
        _renderCooperLogContent();
    };

    function _renderCooperLogContent() {
        var panel = document.getElementById('cooper-log-panel');
        if (!panel) return;

        if (_cooperAllItems.length === 0) {
            panel.innerHTML = '<div style="text-align:center; padding:20px; color:#666; font-size:0.82rem;">No hay registros Cooper</div>';
            return;
        }

        // Group by day
        var dayGroups = {};
        _cooperAllItems.forEach(function(entry) {
            var dayKey = entry.date.toISOString().split('T')[0];
            var dayLabel = entry.date.toLocaleDateString('es-ES', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
            if (!dayGroups[dayKey]) dayGroups[dayKey] = { label: dayLabel, items: [] };
            dayGroups[dayKey].items.push(entry);
        });
        var dayKeys = Object.keys(dayGroups).sort().reverse();

        // If a folder is open, show its photos
        if (_cooperOpenDay && dayGroups[_cooperOpenDay]) {
            var folder = dayGroups[_cooperOpenDay];
            var html = '';
            html += '<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">';
            html += '<button onclick="cooperBackToFolders()" style="background:#2a2a2d; border:1px solid #444; color:#2196F3; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:0.78rem; display:flex; align-items:center; gap:4px;">';
            html += '<span style="font-size:0.9rem;">←</span> Volver</button>';
            html += '<span style="color:#FF9800; font-weight:700; font-size:0.82rem; text-transform:capitalize;"><span class="material-symbols-outlined" style="font-size:.9rem; vertical-align:middle;">folder_open</span> ' + escapeHtml(folder.label) + '</span>';
            html += '<span style="color:#666; font-size:0.72rem;">(' + folder.items.length + ')</span>';
            html += '</div>';

            folder.items.forEach(function(entry) {
                var d = entry.date;
                var time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
                var typeIcon = entry.data.type === 'recogida' ? '<span class="material-symbols-outlined" style="font-size:.85rem; vertical-align:middle;">download</span>' : '<span class="material-symbols-outlined" style="font-size:.85rem; vertical-align:middle;">upload</span>';
                var typeLabel = entry.data.type === 'recogida' ? 'Recogida' : 'Entrega';
                var shift = d.getHours() < 14 ? '<span class="material-symbols-outlined icon-filled" style="font-size:.85rem; vertical-align:middle; color:#FF9800;">light_mode</span>' : '<span class="material-symbols-outlined icon-filled" style="font-size:.85rem; vertical-align:middle; color:#5C6BC0;">dark_mode</span>';

                html += '<div style="display:flex; align-items:center; gap:8px; padding:8px; background:rgba(255,255,255,0.03); border-radius:8px; margin-bottom:6px; border:1px solid #222;">';
                html += '<a href="' + escapeHtml(entry.data.photoURL || '#') + '" target="_blank" style="flex-shrink:0;">';
                html += '<img src="' + escapeHtml(entry.data.photoURL || '') + '" style="width:52px; height:52px; object-fit:cover; border-radius:8px; border:1px solid #333;" loading="lazy">';
                html += '</a>';
                html += '<div style="flex:1; min-width:0;">';
                html += '<div style="font-size:0.8rem; color:#ddd;">' + typeIcon + ' ' + escapeHtml(typeLabel) + ' <span style="color:#888;">' + shift + ' ' + escapeHtml(time) + '</span></div>';
                if (entry.data.note) {
                    html += '<div style="font-size:0.72rem; color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"><span class="material-symbols-outlined" style="font-size:.75rem; vertical-align:middle;">edit_note</span> ' + escapeHtml(entry.data.note) + '</div>';
                }
                html += '</div>';
                // WhatsApp button
                var waMsg = '📦 Cooper ' + typeLabel + '\n📅 ' + folder.label + ' ' + time + '\n🚛 ' + (entry.data.route || 'Sin ruta') + '\n👤 ' + (entry.data.driverName || '') + (entry.data.note ? '\n📝 ' + entry.data.note : '') + '\n\n' + (entry.data.photoURL || '');
                html += '<a href="https://wa.me/?text=' + encodeURIComponent(waMsg) + '" target="_blank" style="flex-shrink:0; background:#25D366; color:#fff; padding:4px 8px; border-radius:6px; font-size:0.7rem; text-decoration:none; display:flex; align-items:center; gap:3px;"><span class="material-symbols-outlined" style="font-size:.9rem;">share</span></a>';
                html += '</div>';
            });

            panel.innerHTML = html;
            return;
        }

        // Folder view
        var html = '';
        dayKeys.forEach(function(dayKey) {
            var folder = dayGroups[dayKey];
            var recCount = 0, entCount = 0;
            folder.items.forEach(function(e) {
                if (e.data.type === 'recogida') recCount++; else entCount++;
            });
            var isToday = dayKey === new Date().toISOString().split('T')[0];

            html += '<div onclick="cooperOpenDay(\'' + dayKey + '\')" style="display:flex; align-items:center; gap:10px; padding:10px 12px; background:' + (isToday ? 'rgba(255,152,0,0.08)' : 'rgba(255,255,255,0.02)') + '; border:1px solid ' + (isToday ? 'rgba(255,152,0,0.3)' : '#222') + '; border-radius:8px; margin-bottom:6px; cursor:pointer;" ontouchstart="this.style.background=\'rgba(255,152,0,0.15)\'" ontouchend="this.style.background=\'' + (isToday ? 'rgba(255,152,0,0.08)' : 'rgba(255,255,255,0.02)') + '\'">';
            html += '<span style="font-size:1.4rem;"><span class="material-symbols-outlined" style="font-size:1.4rem; color:#FF9800;">folder</span></span>';
            html += '<div style="flex:1; min-width:0;">';
            html += '<div style="font-size:0.82rem; color:#ddd; font-weight:600; text-transform:capitalize;">' + escapeHtml(folder.label) + (isToday ? ' <span style="color:#FF9800; font-size:0.7rem;">(HOY)</span>' : '') + '</div>';
            html += '<div style="font-size:0.72rem; color:#888; display:flex; gap:10px; margin-top:2px;">';
            html += '<span><span class="material-symbols-outlined" style="font-size:.75rem; vertical-align:middle;">download</span> ' + recCount + ' recogidas</span>';
            html += '<span><span class="material-symbols-outlined" style="font-size:.75rem; vertical-align:middle;">upload</span> ' + entCount + ' entregas</span>';
            html += '<span><span class="material-symbols-outlined" style="font-size:.75rem; vertical-align:middle;">photo_camera</span> ' + folder.items.length + ' total</span>';
            html += '</div></div>';
            html += '<span style="color:#555; font-size:1rem;">›</span>';
            html += '</div>';
        });

        panel.innerHTML = html;
    }

    // Load counters on app init (after route selection)
    var _counterInterval = setInterval(function() {
        if (currentDriverName) {
            clearInterval(_counterInterval);
            cooperUpdateCounters();
        }
    }, 2000);

} // END initApp
})();
