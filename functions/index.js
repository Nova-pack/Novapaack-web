// =============================================================
// NOVAPACK CLOUD FUNCTIONS
// =============================================================
// Procesado servidor de la cola SMTP (/mailbox) sin depender de
// ningún PC encendido. Reemplaza el dependency de mail_engine.js
// corriendo en máquina del admin.
//
// Funciones expuestas:
//   - processMailboxQueue : scheduler cada 2 min, procesa la cola
//   - flushMailboxNow     : callable HTTP, lanza una pasada manual
//                            desde admin (botón "🚀 Flush ahora")
//
// Secretos requeridos (Firebase Secret Manager):
//   - SMTP_USER : usuario IONOS (administracion@novapack.info)
//   - SMTP_PASS : contraseña SMTP
// =============================================================

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

// Región europea para latencia y soberanía de datos
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

// Secretos (asignados con `firebase functions:secrets:set SMTP_USER` etc.)
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');

const SMTP_HOST = 'smtp.ionos.es';
const SMTP_PORT = 465;
const SMTP_FROM_NAME = 'NOVAPACK Logística';
const OUTGOING_BATCH_MAX = 20;
const SMTP_BCC = ''; // opcional: si quieres recibir copia de TODO

function looksLikeHtml(s) {
    return typeof s === 'string' && /<(html|body|table|div|p|br|h[1-6]|strong|a\s)/i.test(s);
}

// =============================================================
// Núcleo: procesa la cola /mailbox status='queued' o 'outgoing'
// =============================================================
async function processQueue() {
    const user = SMTP_USER.value();
    const pass = SMTP_PASS.value();

    if (!user || !pass) {
        logger.error('SMTP credentials missing — define secrets SMTP_USER and SMTP_PASS');
        return { sent: 0, failed: 0, skipped: 0, error: 'missing_credentials' };
    }

    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: true,
        auth: { user, pass },
        connectionTimeout: 20000,
        socketTimeout: 30000
    });

    try {
        await transporter.verify();
        logger.info(`SMTP connected ${SMTP_HOST}:${SMTP_PORT} as ${user}`);
    } catch (e) {
        logger.error('SMTP verify FAILED', { msg: e.message });
        return { sent: 0, failed: 0, skipped: 0, error: e.message };
    }

    // Cola: status='queued' o 'outgoing' (legacy)
    let queueDocs = [];
    const q1 = await db.collection('mailbox').where('status', '==', 'queued').limit(OUTGOING_BATCH_MAX).get();
    q1.forEach(d => queueDocs.push({ id: d.id, ref: d.ref, ...d.data() }));
    if (queueDocs.length < OUTGOING_BATCH_MAX) {
        const q2 = await db.collection('mailbox').where('status', '==', 'outgoing').limit(OUTGOING_BATCH_MAX - queueDocs.length).get();
        q2.forEach(d => queueDocs.push({ id: d.id, ref: d.ref, ...d.data() }));
    }

    if (!queueDocs.length) {
        logger.info('cola vacía');
        return { sent: 0, failed: 0, skipped: 0 };
    }
    logger.info(`procesando ${queueDocs.length} correos`);

    let sent = 0, failed = 0, skipped = 0;
    for (const doc of queueDocs) {
        const id = doc.id;
        const to = (doc.to || '').trim();
        const subject = (doc.subject || '(sin asunto)').trim();
        const body = doc.body || '';

        if (!to || !to.includes('@')) {
            await doc.ref.update({
                status: 'failed',
                errorMessage: 'Destinatario inválido o vacío',
                errorCode: 'BAD_RECIPIENT',
                failedAt: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
            failed++;
            continue;
        }

        // Compare-and-swap: marcar 'sending' atómicamente
        try {
            const fresh = await doc.ref.get();
            const st = (fresh.exists && fresh.data().status) || '';
            if (st !== 'queued' && st !== 'outgoing') { skipped++; continue; }
            await doc.ref.update({
                status: 'sending',
                sendingAt: admin.firestore.FieldValue.serverTimestamp(),
                sendingBy: 'cloud_function'
            });
        } catch (e) {
            logger.warn(`no pude marcar sending ${id}`, { msg: e.message });
            skipped++;
            continue;
        }

        const isHtml = looksLikeHtml(body);
        const mailOpts = {
            from: `"${SMTP_FROM_NAME}" <${user}>`,
            to,
            subject,
            bcc: SMTP_BCC && SMTP_BCC !== to ? SMTP_BCC : undefined
        };
        if (isHtml) mailOpts.html = body;
        else mailOpts.text = body;

        // Adjuntos (URL HTTPS o base64)
        if (Array.isArray(doc.attachments) && doc.attachments.length > 0) {
            mailOpts.attachments = doc.attachments.map(a => {
                if (!a) return null;
                if (a.contentBase64) {
                    return {
                        filename: a.filename || 'adjunto',
                        content: Buffer.from(a.contentBase64, 'base64'),
                        contentType: a.contentType || 'application/octet-stream'
                    };
                }
                if (a.url) {
                    return {
                        filename: a.filename || 'adjunto.pdf',
                        path: a.url,
                        contentType: a.contentType || 'application/pdf'
                    };
                }
                return null;
            }).filter(Boolean);
        }

        try {
            const info = await transporter.sendMail(mailOpts);
            await doc.ref.update({
                status: 'sent',
                sentAt: admin.firestore.FieldValue.serverTimestamp(),
                smtpMessageId: info.messageId || null,
                smtpResponse: (info.response || '').toString().slice(0, 500),
                sentVia: 'cloud_function'
            });

            // Tracking de tipos especiales
            try {
                if (doc.clientId && (doc.type === 'outgoing_welcome' || doc.type === 'outgoing_pod')) {
                    await db.collection('users').doc(doc.clientId).set({
                        welcomeDeliveredAt: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }
                if (doc.type === 'invoice_email' && doc.invoiceDocId) {
                    await db.collection('invoices').doc(doc.invoiceDocId).update({
                        emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
                        emailSentTo: to,
                        emailSmtpId: info.messageId || null
                    });
                }
            } catch (e) {
                logger.warn('tracking update fail', { id, msg: e.message });
            }

            logger.info(`Sent ${doc.type || 'mail'} → ${to} ✅`, { messageId: info.messageId });
            sent++;
        } catch (e) {
            await doc.ref.update({
                status: 'failed',
                errorMessage: e.message || 'unknown',
                errorCode: e.code || 'SMTP_ERROR',
                failedAt: admin.firestore.FieldValue.serverTimestamp(),
                retries: (doc.retries || 0) + 1
            }).catch(() => {});
            logger.error(`Failed ${id} → ${to}`, { msg: e.message });
            failed++;
        }
    }

    return { sent, failed, skipped, processed: queueDocs.length };
}

// =============================================================
// SCHEDULER cada 2 min — always-on procesado de cola
// =============================================================
exports.processMailboxQueue = onSchedule({
    schedule: 'every 2 minutes',
    timeZone: 'Europe/Madrid',
    secrets: [SMTP_USER, SMTP_PASS],
    timeoutSeconds: 300,
    memory: '256MiB'
}, async (event) => {
    const result = await processQueue();
    logger.info('scheduler tick', result);
});

// =============================================================
// CALLABLE HTTP — botón "🚀 Flush ahora" desde admin
// (cualquier admin autenticado puede forzar una pasada)
// =============================================================
exports.flushMailboxNow = onCall({
    secrets: [SMTP_USER, SMTP_PASS],
    timeoutSeconds: 300,
    memory: '256MiB'
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Debes estar autenticado');
    }
    const result = await processQueue();
    logger.info('manual flush by user', { uid: request.auth.uid, result });
    return result;
});

// =============================================================
// HEALTH CHECK — devuelve stats de la cola sin enviar nada
// Útil para widget de salud en admin
// =============================================================
exports.mailboxHealth = onCall({
    timeoutSeconds: 30
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Debes estar autenticado');
    }
    const [queuedSnap, failedSnap, sendingSnap] = await Promise.all([
        db.collection('mailbox').where('status', '==', 'queued').limit(100).get(),
        db.collection('mailbox').where('status', '==', 'failed').limit(50).get(),
        db.collection('mailbox').where('status', '==', 'sending').limit(50).get()
    ]);

    let oldestQueued = null;
    queuedSnap.forEach(d => {
        const ca = d.data().createdAt;
        if (ca && ca.toDate) {
            const ts = ca.toDate().getTime();
            if (!oldestQueued || ts < oldestQueued) oldestQueued = ts;
        }
    });

    return {
        queued: queuedSnap.size,
        failed: failedSnap.size,
        sending: sendingSnap.size,
        oldestQueuedMs: oldestQueued,
        oldestQueuedAgeMin: oldestQueued ? Math.floor((Date.now() - oldestQueued) / 60000) : 0,
        timestamp: Date.now()
    };
});
