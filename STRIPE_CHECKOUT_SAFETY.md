# Stripe: Checkout y sincronización

## Preparación del despliegue

Aplicar src/migrations/041_stripe_checkout_attempts.sql con autorización antes de desplegar la API. El código falla sin crear cargos si falta la tabla. La migración no modifica suscripciones ni pagos existentes. No se ha ejecutado como parte del cambio.

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
