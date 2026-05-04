/**
 * NOVAPACK MAIL ENGINE v2.0
 * Connects to IONOS IMAP, reads recent emails, and syncs them to Firestore 'mailbox' collection.
 * v2.0: HTML fallback, attachment info, POD auto-detection with ticket lookup
 * Run manually: node mail_engine.js
 * Or schedule via Task Scheduler / cron every 5 minutes.
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { JSDOM } = require('jsdom');
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/firestore');
const path = require('path');
const fs = require('fs');

// Load .env if present (no external dotenv dep)
(function loadDotEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2];
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = val;
    }
})();

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error('[MAIL ENGINE] Missing env var: ' + name + '. Configure it in .env or system env. See .env.example.');
        process.exit(1);
    }
    return v;
}

// ============ CONFIG (from environment) ============
const IMAP_CONFIG = {
    user: requireEnv('IMAP_USER'),
    password: requireEnv('IMAP_PASS'),
    host: process.env.IMAP_HOST || 'imap.ionos.es',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 30000,
    authTimeout: 15000
};

const FIREBASE_CONFIG = {
    apiKey: requireEnv('FIREBASE_API_KEY'),
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'novapack-68f05.firebaseapp.com',
    projectId: process.env.FIREBASE_PROJECT_ID || 'novapack-68f05'
};

const FIREBASE_AUTH_USER = requireEnv('FIREBASE_ADMIN_EMAIL');
const FIREBASE_AUTH_PASS = requireEnv('FIREBASE_ADMIN_PASS');

// How many days back to scan for emails
const DAYS_BACK = 3;
// Max emails to process per run
const MAX_EMAILS = 50;
// Max body length to store (was 2000, now 10000 for full visibility)
const MAX_BODY_LENGTH = 10000;
// IMAP retry config
const IMAP_MAX_RETRIES = 3;
const IMAP_RETRY_DELAY_MS = 5000;
// ================================

// ============ SPAM / PUBLICITY FILTER ============
function isSpamOrPublicity(from, subject, body, headers) {
    const text = ((subject || '') + ' ' + (body || '')).toLowerCase();
    const fromLower = (from || '').toLowerCase();

    // Unsubscribe header or link = newsletter
    if (headers && headers.get && headers.get('list-unsubscribe')) return true;
    if (text.includes('unsubscribe') || text.includes('darse de baja') || text.includes('cancelar suscripci')) return true;

    // Marketing keywords
    const spamWords = ['newsletter', 'promoción especial', 'oferta exclusiva', 'click aquí para ver',
        'no-reply@', 'noreply@', 'marketing@', 'promo@', 'news@', 'info@',
        'has been added to', 'view in browser', 'ver en navegador'];
    for (const w of spamWords) {
        if (text.includes(w) || fromLower.includes(w)) return true;
    }

    // Automated system notifications
    const systemSenders = ['mailer-daemon', 'postmaster', 'notify@', 'notification@', 'alert@', 'system@'];
    for (const s of systemSenders) {
        if (fromLower.includes(s)) return true;
    }

    return false;
}

// ============ HTML TO TEXT FALLBACK ============
function htmlToText(html) {
    try {
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        // Remove script/style tags
        doc.querySelectorAll('script, style, head').forEach(el => el.remove());
        // Get text content, collapse whitespace
        return doc.body.textContent.replace(/\s+/g, ' ').trim();
    } catch(e) {
        // Simple regex fallback
        return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

// ============ CATEGORIZE BY WEIGHTED SCORE ============
function categorizeEmail(subject, body) {
    const text = ((subject || '') + ' ' + (body || '')).toLowerCase();
    const subjectLower = (subject || '').toLowerCase();

    const categories = {
        pod:              { keywords: ['pod', 'prueba de entrega', 'comprobante', 'justificante de entrega', 'acuse de recibo'], score: 0 },
        abono:            { keywords: ['abono', 'devoluc', 'reembolso', 'devolver'], score: 0 },
        rectificacion:    { keywords: ['rectifica', 'error en factura', 'factura rectificativa', 'corregir factura'], score: 0 },
        fiscal:           { keywords: ['fiscal', 'hacienda', 'certificado fiscal', 'modelo 347', 'modelo 303', 'retencion', 'irpf'], score: 0 },
        consulta_albaran: { keywords: ['albar', 'np-', 'envío', 'envio', 'paquete', 'seguimiento', 'donde está', 'estado del envio'], score: 0 },
        reclamacion:      { keywords: ['reclama', 'queja', 'incidencia', 'daño', 'dano', 'roto', 'extravi', 'perdido'], score: 0 },
        facturacion:      { keywords: ['factura', 'cobro', 'pago', 'recibo', 'vencimiento', 'pendiente de pago'], score: 0 }
    };

    for (const [cat, cfg] of Object.entries(categories)) {
        for (const kw of cfg.keywords) {
            if (subjectLower.includes(kw)) cfg.score += 3; // Subject match = 3x weight
            else if (text.includes(kw)) cfg.score += 1;    // Body match = 1x weight
        }
    }

    // Find highest score
    let best = 'otro';
    let bestScore = 0;
    for (const [cat, cfg] of Object.entries(categories)) {
        if (cfg.score > bestScore) {
            bestScore = cfg.score;
            best = cat;
        }
    }

    return best;
}

// ============ EXTRACT ATTACHMENT INFO (filter out inline logos/CID images) ============
function extractAttachmentInfo(attachments) {
    if (!attachments || !attachments.length) return [];
    return attachments
        .filter(att => {
            // Skip inline/CID images (email signature logos, tracking pixels)
            if (att.contentDisposition === 'inline') return false;
            if (att.cid) return false;
            // Skip tiny images (< 5KB) — almost certainly logos or spacer GIFs
            const isImage = (att.contentType || '').startsWith('image/');
            if (isImage && att.size && att.size < 5000) return false;
            // Skip common logo filenames
            const name = (att.filename || '').toLowerCase();
            if (isImage && /^(logo|banner|firma|signature|icon|image\d*|unnamed)\b/i.test(name)) return false;
            // Skip attachments with no filename and image type (embedded graphics)
            if (isImage && !att.filename) return false;
            return true;
        })
        .map(att => ({
            filename: att.filename || 'sin_nombre',
            contentType: att.contentType || 'application/octet-stream',
            size: att.size || 0
        }));
}

// Extract ticket references — ONLY Novapack format: PREFIX-YY-SEQ
// Examples: NP-26-15, 5402-26-3, NOVA-26-100, NP-25-0
// PREFIX = 2-5 alphanumeric chars (company prefix), YY = 2-digit year, SEQ = sequence number
function extractTicketRef(text) {
    if (!text) return null;

    // Normalize: collapse whitespace, remove invisible chars
    const clean = text.replace(/\s+/g, ' ');

    // Current 2-digit year and recent years (to validate YY part)
    const now = new Date();
    const thisYY = now.getFullYear() % 100;
    const validYears = new Set();
    for (let y = thisYY - 3; y <= thisYY + 1; y++) validYears.add(String(y).padStart(2, '0'));

    // Format 1 (PRIMARY): PREFIX-YY-SEQ with alphanumeric prefix (NP-26-15, NOVA-26-0)
    const matches1 = clean.matchAll(/\b([A-Z]{2,5})-(\d{2})-(\d{1,5})\b/gi);
    for (const m of matches1) {
        if (validYears.has(m[2])) return m[1].toUpperCase() + '-' + m[2] + '-' + m[3];
    }

    // Format 2: PREFIX-YY-SEQ with numeric prefix (5402-26-3, 1234-25-10)
    const matches2 = clean.matchAll(/\b(\d{3,5})-(\d{2})-(\d{1,5})\b/g);
    for (const m of matches2) {
        if (validYears.has(m[2])) return m[1] + '-' + m[2] + '-' + m[3];
    }

    // Format 3: Keyword + our format (albarán NP-26-15, ref: 5402-26-3)
    const kwMatch = clean.match(/(?:albar[aáà]n|ref\.?|referencia|ticket|envío|envio|pedido|n[ºo°]\.?)\s*[.:;\-–—#]*\s*([A-Z0-9]{2,5})-(\d{2})-(\d{1,5})/i);
    if (kwMatch && validYears.has(kwMatch[2])) {
        return kwMatch[1].toUpperCase() + '-' + kwMatch[2] + '-' + kwMatch[3];
    }

    return null;
}

// ============ POD TICKET LOOKUP ============
async function lookupTicketPOD(db, ticketRef) {
    try {
        // Search in tickets collection by document ID or ticketId field
        let ticketDoc = await db.collection('tickets').doc(ticketRef).get();

        // If not found by doc ID, try querying by ticketId field
        if (!ticketDoc.exists) {
            const query = await db.collection('tickets')
                .where('ticketId', '==', ticketRef)
                .limit(1)
                .get();
            if (!query.empty) {
                ticketDoc = query.docs[0];
            } else {
                // Try with albaranNumber field
                const query2 = await db.collection('tickets')
                    .where('albaranNumber', '==', ticketRef)
                    .limit(1)
                    .get();
                if (!query2.empty) {
                    ticketDoc = query2.docs[0];
                }
            }
        }

        if (!ticketDoc || !ticketDoc.exists) {
            console.log(`[MAIL ENGINE] POD lookup: ticket ${ticketRef} not found`);
            return { ready: false, reason: 'albaran_no_encontrado' };
        }

        const t = ticketDoc.data();
        const isDelivered = t.status === 'Entregado' || t.delivered === true;

        if (!isDelivered) {
            return { ready: false, reason: 'pendiente_entrega' };
        }

        const hasSignature = !!t.signatureURL;
        const hasPhoto = !!t.photoURL;

        if (!hasSignature && !hasPhoto) {
            return { ready: false, reason: 'entregado_sin_pod', deliveredAt: t.deliveredAt || null };
        }

        return {
            ready: true,
            reason: 'pod_disponible',
            ticketDocId: ticketDoc.id,
            signatureURL: t.signatureURL || null,
            photoURL: t.photoURL || null,
            deliveredAt: t.deliveredAt || null,
            receiverName: t.deliveryReceiverName || t.receiverName || 'N/A',
            driverName: t.deliveredByDriver || 'N/A'
        };
    } catch(e) {
        console.error(`[MAIL ENGINE] POD lookup error for ${ticketRef}:`, e.message);
        return { ready: false, reason: 'error_consulta' };
    }
}

async function run() {
    console.log('[MAIL ENGINE] Starting at', new Date().toLocaleString('es-ES'));

    // 1. Init Firebase
    if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
    }
    const db = firebase.firestore();

    // 2. Auth with Firebase (use any valid account - we'll use the admin check)
    // We need a service account or a known user. For now we try anonymous or skip auth
    // Since rules allow any authenticated user, we need to sign in
    let authUser = firebase.auth().currentUser;
    if (!authUser) {
        // Try to find admin credentials from config
        try {
            // Sign in with a known admin email
            const adminSnap = await db.collection('config').doc('admin').get();
            console.log('[MAIL ENGINE] Attempting Firebase auth...');
        } catch(e) {
            // Expected - need auth first
        }
    }

    // 3. Connect IMAP
    console.log('[MAIL ENGINE] Connecting to IONOS IMAP...');

    return new Promise((resolve, reject) => {
        const imap = new Imap(IMAP_CONFIG);

        imap.once('ready', () => {
            console.log('[MAIL ENGINE] IMAP connected');

            imap.openBox('INBOX', true, async (err, box) => {
                if (err) {
                    console.error('[MAIL ENGINE] Failed to open INBOX:', err.message);
                    imap.end();
                    reject(err);
                    return;
                }

                console.log(`[MAIL ENGINE] INBOX: ${box.messages.total} total, ${box.messages.new} new`);

                // Search for recent emails (last N days)
                const sinceDate = new Date();
                sinceDate.setDate(sinceDate.getDate() - DAYS_BACK);
                const searchDate = sinceDate.toISOString().split('T')[0].split('-');
                const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const imapDate = `${searchDate[2]}-${months[parseInt(searchDate[1])-1]}-${searchDate[0]}`;

                imap.search([['SINCE', imapDate]], async (err, results) => {
                    if (err) {
                        console.error('[MAIL ENGINE] Search error:', err.message);
                        imap.end();
                        reject(err);
                        return;
                    }

                    console.log(`[MAIL ENGINE] Found ${results.length} emails since ${imapDate}`);

                    if (results.length === 0) {
                        console.log('[MAIL ENGINE] No recent emails to process');
                        imap.end();
                        resolve();
                        return;
                    }

                    // Limit to most recent N
                    const toFetch = results.slice(-MAX_EMAILS);
                    console.log(`[MAIL ENGINE] Processing ${toFetch.length} emails...`);

                    const emails = [];
                    let processed = 0;

                    const fetch = imap.fetch(toFetch, {
                        bodies: '',
                        struct: true
                    });

                    fetch.on('message', (msg, seqno) => {
                        let buffer = '';

                        msg.on('body', (stream) => {
                            stream.on('data', (chunk) => {
                                buffer += chunk.toString('utf8');
                            });
                        });

                        msg.once('end', async () => {
                            try {
                                const parsed = await simpleParser(buffer);
                                const from = parsed.from ? parsed.from.text : 'Desconocido';
                                const subject = parsed.subject || '(Sin Asunto)';
                                const date = parsed.date || new Date();
                                const messageId = parsed.messageId || `imap_${seqno}_${Date.now()}`;

                                // Body: store both plain text and HTML
                                let body = '';
                                let htmlBody = '';
                                if (parsed.text) {
                                    body = parsed.text.substring(0, MAX_BODY_LENGTH);
                                }
                                if (parsed.html) {
                                    htmlBody = parsed.html.substring(0, MAX_BODY_LENGTH * 3); // HTML is verbose
                                    if (!body) body = htmlToText(parsed.html).substring(0, MAX_BODY_LENGTH);
                                }

                                // Spam/publicity filter
                                if (isSpamOrPublicity(from, subject, body, parsed.headers)) {
                                    console.log(`[MAIL ENGINE] Filtered (spam/publicity): "${subject}" from ${from}`);
                                    processed++;
                                    return;
                                }

                                // Attachment metadata (already filtered: no inline logos/CID)
                                const attachments = extractAttachmentInfo(parsed.attachments);
                                // Store small REAL attachments as base64 data URLs (< 200KB each)
                                // Map filtered attachments back to their originals by filename
                                if (parsed.attachments && attachments.length > 0) {
                                    attachments.forEach((filtered, idx) => {
                                        const original = parsed.attachments.find(a =>
                                            (a.filename || 'sin_nombre') === filtered.filename &&
                                            !a.cid && a.contentDisposition !== 'inline'
                                        );
                                        if (original && original.content && original.size && original.size < 200000 && idx < 5) {
                                            filtered.dataUrl = `data:${original.contentType || 'application/octet-stream'};base64,${original.content.toString('base64')}`;
                                        }
                                    });
                                }

                                const category = categorizeEmail(subject, body);
                                const ticketRef = extractTicketRef(subject + ' ' + body);

                                emails.push({
                                    messageId,
                                    from,
                                    subject,
                                    body,
                                    htmlBody: htmlBody || '',
                                    date,
                                    category,
                                    ticketRef,
                                    attachments,
                                    status: 'nueva',
                                    source: 'imap_ionos'
                                });
                            } catch(e) {
                                console.warn(`[MAIL ENGINE] Parse error on msg ${seqno}:`, e.message);
                            }
                            processed++;
                        });
                    });

                    fetch.once('error', (err) => {
                        console.error('[MAIL ENGINE] Fetch error:', err.message);
                    });

                    fetch.once('end', async () => {
                        console.log(`[MAIL ENGINE] Parsed ${emails.length} emails, writing to Firestore...`);

                        // Sign in to Firebase first
                        try {
                            // Use anonymous auth or find admin creds
                            // For now, enable anonymous auth or use admin creds
                            if (!firebase.auth().currentUser) {
                                // We'll try to write without explicit login since rules allow authenticated users
                                // If this fails, we need proper service account
                                console.log('[MAIL ENGINE] No Firebase auth - attempting with stored session...');
                            }
                        } catch(e) {
                            console.warn('[MAIL ENGINE] Auth warning:', e.message);
                        }

                        let written = 0, skipped = 0;

                        for (const email of emails) {
                            try {
                                // Use messageId as document ID to prevent duplicates
                                const docId = email.messageId
                                    .replace(/[\/\\<>@.\s]/g, '_')
                                    .substring(0, 100);

                                const docRef = db.collection('mailbox').doc(docId);
                                const existing = await docRef.get();

                                if (existing.exists) {
                                    skipped++;
                                    continue;
                                }

                                // POD auto-detection: if category is POD and we have a ticketRef, look up the ticket
                                let podData = null;
                                if (email.category === 'pod' && email.ticketRef) {
                                    podData = await lookupTicketPOD(db, email.ticketRef);
                                }

                                const docData = {
                                    from: email.from,
                                    subject: email.subject,
                                    body: email.body,
                                    category: email.category,
                                    ticketRef: email.ticketRef || null,
                                    attachments: email.attachments || [],
                                    status: email.status,
                                    source: email.source,
                                    messageId: email.messageId,
                                    createdAt: firebase.firestore.Timestamp.fromDate(email.date instanceof Date ? email.date : new Date(email.date))
                                };

                                // If POD data found, enrich the mailbox doc
                                if (podData) {
                                    docData.podInfo = podData;
                                    if (podData.ready) {
                                        docData.status = 'pod_lista';
                                    }
                                }

                                await docRef.set(docData);
                                written++;

                                if (podData) {
                                    console.log(`[MAIL ENGINE] POD enriched: ticket ${email.ticketRef} → ${podData.ready ? 'READY' : 'NOT READY'}`);
                                }
                            } catch(e) {
                                console.error(`[MAIL ENGINE] Write error for "${email.subject}":`, e.message);
                            }
                        }

                        console.log(`[MAIL ENGINE] Done! Written: ${written}, Skipped (duplicates): ${skipped}, Errors: ${emails.length - written - skipped}`);

                        imap.end();
                        resolve({ written, skipped });
                    });
                });
            });
        });

        imap.once('error', (err) => {
            console.error('[MAIL ENGINE] IMAP error:', err.message);
            reject(err);
        });

        imap.once('end', () => {
            console.log('[MAIL ENGINE] IMAP connection closed');
        });

        imap.connect();
    });
}

// Run and handle Firebase auth
async function main() {
    // Init Firebase
    if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
    }

    // We need to authenticate to write to Firestore
    // Try to sign in with a known user
    try {
        // Read admin UID from environment or hardcode for this script
        // The Firestore rules require auth, so we need a valid user
        const accounts = [
            { email: FIREBASE_AUTH_USER, pass: FIREBASE_AUTH_PASS },
        ];

        let authed = false;
        for (const acc of accounts) {
            try {
                await firebase.auth().signInWithEmailAndPassword(acc.email, acc.pass);
                console.log('[MAIL ENGINE] Firebase auth OK as', acc.email);
                authed = true;
                break;
            } catch(e) {
                console.log('[MAIL ENGINE] Auth failed for', acc.email, '-', e.code);
            }
        }

        if (!authed) {
            console.error('[MAIL ENGINE] Cannot authenticate with Firebase. Creating anonymous session...');
            try {
                await firebase.auth().signInAnonymously();
                console.log('[MAIL ENGINE] Anonymous auth OK');
            } catch(e) {
                console.error('[MAIL ENGINE] Anonymous auth also failed:', e.message);
                console.error('[MAIL ENGINE] Firestore writes will fail. Please register the email in Firebase Auth.');
                // Try anyway - maybe rules changed
            }
        }
    } catch(e) {
        console.error('[MAIL ENGINE] Auth setup error:', e.message);
    }

    // Pause switch (managed from admin UI). When config/admin.mailEngineEnabled
    // is explicitly false, exit early without touching IMAP or Firestore writes.
    try {
        const cfgDoc = await firebase.firestore().collection('config').doc('admin').get();
        const cfg = cfgDoc.exists ? cfgDoc.data() : {};
        if (cfg.mailEngineEnabled === false) {
            console.log('[MAIL ENGINE] Pausado por admin (config/admin.mailEngineEnabled=false). Saliendo sin procesar correos.');
            try { await firebase.firestore().collection('config').doc('admin').set({
                mailEngineLastSkippedAt: firebase.firestore.FieldValue.serverTimestamp(),
                mailEngineLastReason: 'paused_by_admin'
            }, { merge: true }); } catch(e) {}
            try { await firebase.auth().signOut(); } catch(e) {}
            return;
        }
    } catch(e) {
        console.warn('[MAIL ENGINE] No pude leer flag de pausa:', e.message);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= IMAP_MAX_RETRIES; attempt++) {
        try {
            console.log(`[MAIL ENGINE] Attempt ${attempt}/${IMAP_MAX_RETRIES}...`);
            await run();
            lastError = null;
            break;
        } catch(e) {
            lastError = e;
            console.error(`[MAIL ENGINE] Attempt ${attempt} failed: ${e.message}`);
            if (attempt < IMAP_MAX_RETRIES) {
                console.log(`[MAIL ENGINE] Retrying in ${IMAP_RETRY_DELAY_MS / 1000}s...`);
                await new Promise(r => setTimeout(r, IMAP_RETRY_DELAY_MS));
            }
        }
    }

    if (lastError) {
        console.error('[MAIL ENGINE] ALL RETRIES EXHAUSTED. Last error:', lastError.message);
        console.error('[MAIL ENGINE] ⚠️  ALERTA: El buzón no se ha podido sincronizar. Revisa la conexión IMAP o las credenciales.');
    }

    process.exit(lastError ? 1 : 0);
}

main();
