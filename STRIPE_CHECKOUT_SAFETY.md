# Stripe: Checkout y sincronización

## Preparación del despliegue

Aplicar src/migrations/041_stripe_checkout_attempts.sql con autorización antes de desplegar la API. El código falla sin crear cargos si falta la tabla. La migración no modifica suscripciones ni pagos existentes. Aplicada en producción el 2026-11-12 con autorización; ver registro de verificación abajo.

Los pushes a main despliegan automáticamente API y web mediante GitHub Actions. Estos commits usan [skip ci] para publicar el código sin activar esos despliegues. Aplicar la migración y autorizar el despliegue antes de activar los cambios. Desplegar API antes de web.

Checkout persiste la petición exacta y una clave UUID antes de llamar a Stripe. Usa un bloqueo PostgreSQL por cuenta compartido con los webhooks; los reintentos recuperan la misma sesión, y cambiar de plan expira el enlace anterior. También revisa enlaces anteriores a este cambio y todas las suscripciones históricas de Stripe para detectar cobros que continúan aunque hayan sido marcados EXPIRED localmente.

Una operación ambigua de más de 23 horas sin session_id exige conciliación manual antes de reintentar; nunca se reutiliza ciegamente una clave fuera de su retención. Investigar el intento y las sesiones de Stripe antes de modificar el registro. Los errores STRIPE_SUBSCRIPTION_CONFLICT requieren resolver las suscripciones duplicadas en los proveedores: el webhook no cancela compras ni oculta suscripciones pagadas automáticamente.

Los eventos de suscripción se actualizan consultando Stripe bajo el bloqueo, incluso para eventos antiguos y cancelaciones. Se admiten planes desactivados para sincronizar compras históricas. Los importes contratados proceden de Stripe; las fechas del historial de pagos proceden de la factura original.

## Verificación en Stripe de prueba

1. Mensual y anual: completar Checkout y comprobar acceso tras webhook firmado.
2. Dos pestañas/reintento tras timeout: mismo enlace y una sola suscripción; cambio de plan invalida el enlace anterior.
3. Reenviar eventos duplicados y desordenados, incluidos los anteriores a cancelar: conservar el estado actual y un solo pago.
4. Renovación exitosa/fallida, cancelación al fin de periodo y reactivación.
5. Plan desactivado: sincronizar renovación existente e impedir nueva compra.
6. Compra nativa activa o Stripe histórico aún facturable: impedir otro Checkout sin cancelar ni alterar la compra.
7. Reiniciar API entre creación remota y persistencia de session_id: recuperar con la misma clave.

Las pruebas automatizadas usan sustitutos de Stripe/PostgreSQL y no realizan cobros, migraciones ni cambios de datos reales.

## Despliegue y verificación: 2026-11-12

- Migración 041 aplicada y sus cinco columnas comprobadas en la base de producción.
- Respaldo previo: /home/ubuntu/tocadapp-backups/before-stripe-041-20261112T205035Z.dump. Se verificó que pg_restore puede leer su catálogo; no se ensayó una restauración.
- API 135990d y web e4306a6 construidas y desplegadas por SSH, preservando los Dockerfiles existentes. Imágenes anteriores conservadas con etiqueta before-stripe-041.
- En las imágenes del servidor pasaron las 31 pruebas de Stripe de API y las 5 de web. El build de API y el build de producción de Next.js terminaron correctamente.
- https://tocadapp.com/api/health devuelve 200 con ok=true; login devuelve 200; Checkout sin autenticación devuelve 401; webhook sin firma devuelve 400. Se comprobó que el bundle público contiene las protecciones nuevas.
- Stripe real: webhook habilitado con los eventos de suscripción y factura requeridos; catálogo mensual 7900 y anual 69900 centavos MXN, coincidente con la web.
- Stripe de prueba: 11 comprobaciones programáticas pasaron contra PostgreSQL real en una base temporal separada. Incluyeron Checkout concurrente, cambio de plan y expiración del enlace anterior, evento firmado real de prueba, pago mensual, pago anual, deduplicación, bloqueo de otra compra, renovación pagada mediante reloj de pruebas, renovación rechazada sin acceso ni pago registrado, plan desactivado, cancelación/reactivación y eventos antiguos tras cancelar.
- Durante la validación, el webhook de prueba hacia producción permaneció desactivado. Los eventos de prueba se procesaron solo contra la base aislada. Los clientes, suscripciones y relojes de prueba creados se limpiaron; los enlaces abiertos se expiraron y la base temporal se eliminó. No se generaron cobros reales.

Límite de esta verificación: los pagos de suscripción de prueba se confirmaron mediante la API de Stripe y sus eventos reales; no se automatizó la introducción de tarjeta ni el recorrido visual completo en la página hospedada de Checkout. Falta esa comprobación manual en navegador. No se cambió la configuración del webhook de prueba para habilitar envíos a producción.
