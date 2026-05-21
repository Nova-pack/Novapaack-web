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
const nodemailer = require('nodemailer');
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

// ============================================================
// ENVÍO SALIENTE (SMTP) — procesa la cola /mailbox status:'queued'
// ============================================================
// Configuración SMTP opcional: si faltan SMTP_USER/PASS, sólo se loguea y
// no se procesa nada. Así el motor IMAP sigue funcionando aunque el admin
// no haya configurado todavía las credenciales SMTP.
const SMTP_CONFIG_OK = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.ionos.es';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_BCC  = process.env.SMTP_BCC  || SMTP_USER; // copia oculta al admin
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'NOVAPACK';
// Tope por ejecución para no saturar IONOS ni Firestore en un único disparo.
const OUTGOING_BATCH_MAX = parseInt(process.env.OUTGOING_BATCH_MAX || '20', 10);

let _smtpTransporter = null;
function getSmtpTransporter() {
    if (!SMTP_CONFIG_OK) return null;
    if (_smtpTransporter) return _smtpTransporter;
    _smtpTransporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,   // SSL para 465, STARTTLS para 587
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        tls: { rejectUnauthorized: false }
    });
    return _smtpTransporter;
}

// Detecta si un cuerpo es HTML o texto plano (heurística simple)
function looksLikeHtml(s) {
    if (!s) return false;
    return /<\/?(html|body|p|div|br|table|a|strong|b|i|ul|ol|li|h[1-6])\b/i.test(s);
}

/**
 * Procesa la cola de salida una vez. Lee /mailbox docs con status:'queued'
 * (o legacy 'outgoing'), los marca 'sending' para evitar doble envío si
 * dos procesos coinciden, intenta enviarlos por SMTP y los marca 'sent'
 * (con sentAt + messageId) o 'failed' (con errorMessage + errorCode).
 */
async function processOutgoingQueue(db) {
    if (!SMTP_CONFIG_OK) {
        console.log('[MAIL ENGINE] SMTP no configurado (faltan SMTP_USER/SMTP_PASS en .env) → salto cola saliente.');
        return { sent: 0, failed: 0, skipped: 0 };
    }
    const transporter = getSmtpTransporter();
    if (!transporter) return { sent: 0, failed: 0, skipped: 0 };

    // Verificar conexión SMTP una vez por ejecución
    try {
        await transporter.verify();
        console.log('[MAIL ENGINE] SMTP connected ✅ (' + SMTP_HOST + ':' + SMTP_PORT + ' as ' + SMTP_USER + ')');
    } catch(e) {
        console.error('[MAIL ENGINE] SMTP verify FAILED:', e.message);
        console.error('[MAIL ENGINE] Revisa credenciales SMTP_HOST / SMTP_USER / SMTP_PASS en .env.');
        return { sent: 0, failed: 0, skipped: 0, error: e.message };
    }

    // Cargar cola: status === 'queued' (nuevo) o status === 'outgoing' (legacy)
    let queueDocs = [];
    try {
        const q1 = await db.collection('mailbox').where('status', '==', 'queued').limit(OUTGOING_BATCH_MAX).get();
        q1.forEach(d => queueDocs.push({ id: d.id, ref: d.ref, ...d.data() }));
        if (queueDocs.length < OUTGOING_BATCH_MAX) {
            const q2 = await db.collection('mailbox').where('status', '==', 'outgoing').limit(OUTGOING_BATCH_MAX - queueDocs.length).get();
            q2.forEach(d => queueDocs.push({ id: d.id, ref: d.ref, ...d.data() }));
        }
    } catch(e) {
        console.error('[MAIL ENGINE] No pude leer la cola de salientes:', e.message);
        return { sent: 0, failed: 0, skipped: 0 };
    }

    if (!queueDocs.length) {
        console.log('[MAIL ENGINE] Cola saliente vacía.');
        return { sent: 0, failed: 0, skipped: 0 };
    }
    console.log('[MAIL ENGINE] Procesando ' + queueDocs.length + ' correos salientes…');

    let sent = 0, failed = 0, skipped = 0;
    for (const doc of queueDocs) {
        const id = doc.id;
        const to = (doc.to || '').trim();
        const subject = (doc.subject || '(sin asunto)').trim();
        const body = doc.body || '';

        if (!to || !to.includes('@')) {
            console.warn('[MAIL ENGINE] Skip ' + id + ' — destinatario inválido: "' + to + '"');
            await doc.ref.update({
                status: 'failed',
                errorMessage: 'Destinatario inválido o vacío',
                errorCode: 'BAD_RECIPIENT',
                failedAt: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(()=>{});
            failed++;
            continue;
        }

        // Marca 'sending' (anti doble envío). Si ya está en 'sending' por otro
        // proceso, lo saltamos.
        try {
            const fresh = await doc.ref.get();
            const st = (fresh.exists && fresh.data().status) || '';
            if (st !== 'queued' && st !== 'outgoing') {
                skipped++;
                continue;
            }
            await doc.ref.update({
                status: 'sending',
                sendingAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) {
            console.warn('[MAIL ENGINE] No pude marcar sending ' + id + ':', e.message);
            skipped++;
            continue;
        }

        // Construir mensaje
        const isHtml = looksLikeHtml(body);
        const mailOpts = {
            from: '"' + SMTP_FROM_NAME + '" <' + SMTP_USER + '>',
            to: to,
            subject: subject,
            bcc: SMTP_BCC && SMTP_BCC !== to ? SMTP_BCC : undefined
        };
        if (isHtml) mailOpts.html = body;
        else mailOpts.text = body;

        // ADJUNTOS — nodemailer descarga URLs HTTPS automáticamente cuando se le
        // pasa { path: <url> }. Esto permite enviar facturas PDF subidas a Storage.
        if (Array.isArray(doc.attachments) && doc.attachments.length > 0) {
            mailOpts.attachments = doc.attachments.map(a => {
                if (!a) return null;
                if (a.contentBase64) {
                    // Modo embebido (limitado por tamaño doc Firestore ~1MB)
                    return {
                        filename: a.filename || 'adjunto',
                        content: Buffer.from(a.contentBase64, 'base64'),
                        contentType: a.contentType || 'application/octet-stream'
                    };
                }
                if (a.url) {
                    return {
                        filename: a.filename || 'adjunto.pdf',
                        path: a.url,  // nodemailer descarga la URL
                        contentType: a.contentType || 'application/pdf'
                    };
                }
                return null;
            }).filter(Boolean);
            if (mailOpts.attachments.length > 0) {
                console.log('[MAIL ENGINE] ' + id + ' lleva ' + mailOpts.attachments.length + ' adjunto(s)');
            }
        }

        try {
            const info = await transporter.sendMail(mailOpts);
            await doc.ref.update({
                status: 'sent',
                sentAt: firebase.firestore.FieldValue.serverTimestamp(),
                smtpMessageId: info.messageId || null,
                smtpResponse: (info.response || '').toString().slice(0, 500),
                sentVia: 'smtp_engine'
            });
            // Si el doc tenía clientId, marcamos también el doc del cliente
            // como welcomeSentAt para que el chip se actualice de "queued" a
            // "sent" en el listado de clientes.
            try {
                if (doc.clientId && (doc.type === 'outgoing_welcome' || doc.type === 'outgoing_pod')) {
                    await db.collection('users').doc(doc.clientId).set({
                        welcomeDeliveredAt: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }
            } catch(_) {}

            // FACTURAS: marcar la factura como emailSentAt
            try {
                if (doc.type === 'invoice_email' && doc.invoiceDocId) {
                    await db.collection('invoices').doc(doc.invoiceDocId).update({
                        emailSentAt: firebase.firestore.FieldValue.serverTimestamp(),
                        emailSentTo: to,
                        emailSmtpId: info.messageId || null
                    });
                }
            } catch(_) {}
            console.log('[MAIL ENGINE] Sent ' + (doc.type || 'mail') + ' → ' + to + ' ✅ ' + (info.messageId || ''));
            sent++;
        } catch(e) {
            const code = e.code || e.responseCode || 'SEND_FAIL';
            const msg = (e.message || '').slice(0, 500);
            console.error('[MAIL ENGINE] FAIL → ' + to + ' :: ' + code + ' :: ' + msg);
            await doc.ref.update({
                status: 'failed',
                errorMessage: msg,
                errorCode: String(code),
                failedAt: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(()=>{});
            failed++;
        }
    }

    console.log('[MAIL ENGINE] Saliente: ' + sent + ' enviados · ' + failed + ' fallidos · ' + skipped + ' saltados');
    return { sent, failed, skipped };
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

// ============================================================
// MODOS DE EJECUCIÓN
// ============================================================
// One-shot (default):  ejecuta una pasada IMAP + cola SMTP y sale.
//                      Útil para cron / programador de tareas.
// Watch mode (--watch): IMAP cada IMAP_INTERVAL_MIN minutos +
//                      escucha Firestore EN TIEMPO REAL para
//                      enviar emails salientes al instante (1-2s)
//                      cuando aparecen con status:'queued'.
const WATCH_MODE = process.argv.includes('--watch') || process.env.WATCH_MODE === 'true';
const IMAP_INTERVAL_MIN = parseInt(process.env.IMAP_INTERVAL_MIN || '5', 10);

// Anti doble-procesado de la cola: si hay un envío en curso y llegan
// más cambios, no lanzamos múltiples procesos en paralelo (evita rate
// limits de IONOS y race conditions sobre el doc).
let _processingOutgoing = false;
async function tryProcessOutgoing(db) {
    if (_processingOutgoing) return;
    _processingOutgoing = true;
    try {
        await processOutgoingQueue(db);
    } catch(e) {
        console.error('[MAIL ENGINE] Error cola saliente (watch):', e.message);
    } finally {
        _processingOutgoing = false;
    }
}

// Ejecuta una pasada IMAP completa con retries (lo que antes hacía main
// en una sola tirada). Reutilizable en watch mode.
async function runImapOnce() {
    let lastError = null;
    for (let attempt = 1; attempt <= IMAP_MAX_RETRIES; attempt++) {
        try {
            console.log(`[MAIL ENGINE] IMAP attempt ${attempt}/${IMAP_MAX_RETRIES}...`);
            await run();
            return null;
        } catch(e) {
            lastError = e;
            console.error(`[MAIL ENGINE] IMAP attempt ${attempt} failed: ${e.message}`);
            if (attempt < IMAP_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, IMAP_RETRY_DELAY_MS));
            }
        }
    }
    return lastError;
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

    // ── Flags de pausa (managed from admin UI) ──
    // - config/admin.mailEngineEnabled === false → pausa la LECTURA IMAP
    //   (no procesamos correos entrantes). La cola SALIENTE sigue activa.
    // - config/admin.mailEngineOutgoingEnabled === false → pausa también
    //   la cola saliente (flag opcional, por defecto true).
    let skipImap = false;
    let skipOutgoing = false;
    try {
        const cfgDoc = await firebase.firestore().collection('config').doc('admin').get();
        const cfg = cfgDoc.exists ? cfgDoc.data() : {};
        if (cfg.mailEngineEnabled === false) {
            skipImap = true;
            console.log('[MAIL ENGINE] 🟠 IMAP pausado por admin (mailEngineEnabled=false). Saltando lectura entrante.');
        }
        if (cfg.mailEngineOutgoingEnabled === false) {
            skipOutgoing = true;
            console.log('[MAIL ENGINE] 🟠 Cola saliente pausada por admin (mailEngineOutgoingEnabled=false).');
        }
    } catch(e) {
        console.warn('[MAIL ENGINE] No pude leer flag de pausa:', e.message);
    }

    let lastError = null;

    // ════════════════════════════════════════════════════════════
    //  WATCH MODE — vive eternamente, escucha Firestore en tiempo real
    // ════════════════════════════════════════════════════════════
    if (WATCH_MODE) {
        console.log('[MAIL ENGINE] 🟢 MODO WATCH — quedo escuchando cambios en tiempo real');
        console.log('[MAIL ENGINE]    IMAP cada ' + IMAP_INTERVAL_MIN + ' min · SMTP al instante via Firestore listener');
        const db = firebase.firestore();

        // 1) Pasada inicial IMAP (si no está pausado)
        if (!skipImap) {
            await runImapOnce();
        } else {
            console.log('[MAIL ENGINE] IMAP saltado por pausa de admin.');
        }

        // 2) Pasada inicial cola saliente (procesa lo que estuviera ya pendiente)
        if (!skipOutgoing) {
            await tryProcessOutgoing(db);
        }

        // 3) Listener en tiempo real sobre la cola saliente
        if (!skipOutgoing) {
            console.log('[MAIL ENGINE] 📡 Suscripción Firestore a status="queued" activa.');
            db.collection('mailbox').where('status', '==', 'queued')
                .onSnapshot(snap => {
                    const newOnes = snap.docChanges().filter(c => c.type === 'added' || c.type === 'modified');
                    if (newOnes.length === 0) return;
                    console.log('[MAIL ENGINE] 🔔 ' + newOnes.length + ' email(s) saliente(s) detectado(s) en tiempo real');
                    tryProcessOutgoing(db);
                }, err => {
                    console.error('[MAIL ENGINE] Listener Firestore error:', err.message);
                });
            // También vigilamos el legacy status='outgoing'
            db.collection('mailbox').where('status', '==', 'outgoing')
                .onSnapshot(snap => {
                    const newOnes = snap.docChanges().filter(c => c.type === 'added' || c.type === 'modified');
                    if (newOnes.length === 0) return;
                    console.log('[MAIL ENGINE] 🔔 ' + newOnes.length + ' email(s) saliente(s) legacy detectado(s)');
                    tryProcessOutgoing(db);
                }, err => {
                    console.error('[MAIL ENGINE] Listener Firestore (legacy) error:', err.message);
                });
        }

        // 4) Intervalo IMAP periódico
        if (!skipImap) {
            setInterval(async () => {
                console.log('[MAIL ENGINE] ⏰ Pasada IMAP periódica…');
                // Re-leemos pausa: el admin puede activar/desactivar sobre la marcha
                try {
                    const cfgDoc = await db.collection('config').doc('admin').get();
                    if (cfgDoc.exists && cfgDoc.data().mailEngineEnabled === false) {
                        console.log('[MAIL ENGINE] IMAP sigue pausado por admin. Salto pasada.');
                        return;
                    }
                } catch(_) {}
                await runImapOnce();
            }, IMAP_INTERVAL_MIN * 60 * 1000);
        }

        // 5) Heartbeat cada 30 min para que se vea que sigue vivo en logs
        setInterval(() => {
            console.log('[MAIL ENGINE] ❤️ Heartbeat ' + new Date().toLocaleString('es-ES'));
        }, 30 * 60 * 1000);

        console.log('[MAIL ENGINE] ✅ Listo. NO cerrar esta ventana — el motor vive aquí.');
        // No salimos. El proceso se queda vivo por los listeners y setIntervals.
        return;
    }

    // ════════════════════════════════════════════════════════════
    //  ONE-SHOT MODE — pasada única y salida (compat cron)
    // ════════════════════════════════════════════════════════════
    if (!skipImap) {
        lastError = await runImapOnce();
        if (lastError) {
            console.error('[MAIL ENGINE] ALL RETRIES EXHAUSTED. Last error:', lastError.message);
        }
    } else {
        try { await firebase.firestore().collection('config').doc('admin').set({
            mailEngineLastSkippedAt: firebase.firestore.FieldValue.serverTimestamp(),
            mailEngineLastReason: 'imap_paused_by_admin'
        }, { merge: true }); } catch(e) {}
    }

    if (!skipOutgoing) {
        try {
            const db = firebase.firestore();
            await processOutgoingQueue(db);
        } catch(e) {
            console.error('[MAIL ENGINE] Error procesando cola saliente:', e.message);
        }
    } else {
        console.log('[MAIL ENGINE] Cola saliente saltada por flag de pausa.');
    }

    process.exit(lastError ? 1 : 0);
}

main();
