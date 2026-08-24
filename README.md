# AllSender Auto Calendario

Módulo de agenda y reservas de AllSender Auth. Este repositorio contiene el
espejo mantenible de Auto Calendario (también llamado Auto Cita IA): interfaz,
rutas API, agente conversacional, integración Nylas, recordatorios y migraciones.

> **Importante:** no es una aplicación independiente. Corre dentro de AllSender
> Auth porque comparte autenticación multi-tenant, Drizzle/PostgreSQL, canales,
> contactos y el runtime CodeMorf. El despliegue oficial se hace desde el
> monorepo de Auth; este repositorio sirve para revisar, mantener y sincronizar
> exclusivamente el módulo.

## Qué incluye

- Calendario de reservas con agenda semanal, filtros, acciones y bloqueos.
- Servicios, recursos, horarios, zona horaria y enlace público.
- OAuth y sincronización con Google/Outlook mediante Nylas.
- Agente conversacional autónomo para disponibilidad, nombre, contacto,
  confirmación, creación, reprogramación y cancelación.
- Guard de intención: “reservar mesa/menu/comida” permanece en RestApp/Ventas;
  citas, turnos y consultas llegan a Auto Calendario.
- Idempotencia por equipo/chat/servicio/recurso/horario para evitar reservas
  duplicadas cuando se repite un webhook.
- Recordatorios de correo protegidos por token de cron.
- Auto Calendario y Ventas IA restringidos al proveedor CodeMorf, sin fallback
  silencioso a OpenRouter/OpenAI/Gemini.

## Rutas principales

| Área | Ruta |
| --- | --- |
| Panel | `/[locale]/(dashboard)/modulo/reservas` |
| Servicios y recursos | `/api/reservas/services`, `/api/reservas/resources` |
| Disponibilidad | `/api/reservas/availability-rules`, `/api/reservas/unavailable-blocks` |
| Reservas | `/api/reservas/bookings` |
| Calendario | `/api/reservas/nylas/connect`, `callback`, `status`, `disconnect`, `webhook` |
| Enlace público | `/api/reservas/public-link`, `/api/reservas/public/[slug]/availability`, `/book` |
| Recordatorios | `/api/cron/reservas/reminders` (requiere `x-cron-token`) |

## Contrato operativo

1. Validar tenant, módulo activo, CodeMorf y conexión de calendario cuando se
   solicite sincronización externa.
2. Resolver intención antes de responder: no confundir una mesa de restaurante
   con una cita profesional.
3. Consultar disponibilidad real antes de prometer fecha u hora.
4. Solicitar nombre y teléfono o correo; reutilizar el contacto del canal solo
   cuando esté confirmado.
5. Confirmar el resumen al cliente y crear una única reserva idempotente.
6. Devolver el número/estado de reserva y mostrar si se sincronizó con Nylas.
7. Si falla una dependencia, explicar el límite sin inventar disponibilidad.

## Configuración requerida en el host

Las variables se configuran en AllSender Auth y nunca se guardan en este repo:

- `POSTGRES_URL`
- `NYLAS_ENABLED`, `NYLAS_API_KEY`, `NYLAS_CLIENT_ID`, `NYLAS_CALLBACK_URL`
- `NYLAS_RESERVAS_MODULE_ENABLED`
- `CRON_SECRET` o `RESERVAS_REMINDERS_CRON_TOKEN`
- acceso del tenant a CodeMorf (`morf_ai_wallets` activo y proveedor `codemorf`)

## Desarrollo y verificación

Este espejo no trae `package.json` ni `node_modules` a propósito. Para probarlo
se sincroniza dentro de `campaigns3-work` y se ejecuta:

```powershell
pnpm exec tsc --noEmit --pretty false
node --import tsx --test lib/morf-ai/providers/sales-policy.test.ts
pnpm build
```

El script `scripts/sync-from-auth.ps1` copia los archivos del módulo desde un
checkout de Auth indicado por `-AuthRoot`; no borra archivos y no despliega.

## Fuente y publicación

- Fuente de producción: `CodeMorf/omnichannel-`, branch de release de Auth.
- Branch de esta mejora: `codex/auto-calendario-hardening-20260824`.
- Espejo: `CodeMorf/allsender-auto-calendario`.

Cada cambio debe compilarse, probarse y verificarse en el entorno con su `.env`
real antes de reiniciar el servicio de producción.
