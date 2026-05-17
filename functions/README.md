# NOVAPACK Cloud Functions

Procesado servidor 24/7 de la cola SMTP (`/mailbox`) + utilidades admin.
Reemplaza la dependencia de `mail_engine.js` corriendo en máquina del admin.

## Funciones

| Función | Tipo | Trigger | Descripción |
|---|---|---|---|
| `processMailboxQueue` | scheduler | cada 2 min | Procesa hasta 20 correos/ejecución |
| `flushMailboxNow` | callable | manual desde admin | Forzar pasada (botón "🚀 Flush ahora") |
| `mailboxHealth` | callable | widget admin | Devuelve stats cola (queued/failed/oldest) |

## Pre-requisitos

1. **Plan Blaze (pay-as-you-go) activo** en el proyecto Firebase.
   Sin Blaze, Cloud Functions no se despliegan. Activar desde:
   <https://console.firebase.google.com/project/novapack-68f05/usage/details>
2. Node 20+ instalado localmente
3. Firebase CLI actualizado (`npm i -g firebase-tools`)

## Instalación inicial

```bash
cd functions
npm install
```

## Configurar secretos SMTP

```bash
firebase functions:secrets:set SMTP_USER
# pega: administracion@novapack.info  (el usuario IONOS)

firebase functions:secrets:set SMTP_PASS
# pega: la contraseña SMTP (la misma que IMAP)
```

Verificar:
```bash
firebase functions:secrets:access SMTP_USER
firebase functions:secrets:access SMTP_PASS
```

## Despliegue

```bash
firebase deploy --only functions --project novapack-68f05
```

La primera vez puede tardar 5-10 min (build + Cloud Build API).

## Después del despliegue

1. La función `processMailboxQueue` arranca automáticamente cada 2 min
   en `europe-west1`. Los correos en cola se enviarán solos.
2. El `mail_engine.js` local **deja de ser necesario** — opcionalmente
   se puede mantener como backup para correos entrantes (IMAP).
3. El widget de admin "🚀 Flush ahora" llamará a `flushMailboxNow` para
   procesar la cola al instante.

## Coste estimado

- **Tier gratis**: 2M invocaciones/mes + 400k GB-seconds
- **NOVAPACK**: 22k invocaciones/mes (cada 2 min × 30 días) × ~5s = 110k segundos
- **Estimado**: $0-2/mes incluso con volumen alto

## Logs

```bash
firebase functions:log --project novapack-68f05
```

O en consola: <https://console.cloud.google.com/functions/list?project=novapack-68f05>

## Solución de problemas

| Síntoma | Causa | Fix |
|---|---|---|
| `Permission denied` al desplegar | No estás en Blaze | Activar Blaze en Firebase Console |
| `Cloud Build API not enabled` | Primera vez | Aceptar en consola al hacer deploy |
| Cola crece sin que se envíen | Función no se ha activado o secretos mal | Revisar `firebase functions:log` |
| `SMTP verify FAILED` | Credenciales incorrectas | `firebase functions:secrets:set SMTP_PASS` |
