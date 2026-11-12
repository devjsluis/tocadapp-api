# Portal contable de TocadApp

## Alcance

Portal de negocio para consultar ingresos de suscripciones de TocadApp. No consulta tocadas, bandas ni las finanzas personales de los músicos. El contador accede en `/contabilidad/login`, sin cuenta de músico ni suscripción. Administración gestiona accesos, documentos y conciliaciones desde `/dashboard/admin/accounting`.

## Seguridad y operación

- Credenciales en `accounting_accounts`, separadas de `users`; contraseña aleatoria de 32 caracteres guardada únicamente como hash bcrypt. La contraseña se entrega una sola vez al administrador que crea o rota el acceso, sin enviarla a nadie automáticamente.
- Sesión exclusiva de ocho horas mediante cookie HttpOnly, Secure y SameSite=Strict en producción. Solo se guarda el SHA-256 del token. Las sesiones no sirven para rutas de músicos ni de administración. Los tokens de músicos tampoco abren el portal contable.
- Sin registro público. Solo un usuario con rol `admin` puede crear, rotar o revocar accesos; rotar y revocar cierran inmediatamente sus sesiones. La creación de sesión verifica también que la contraseña no haya sido rotada mientras se validaba el login.
- Login limitado por usuario e IP y restringido a los orígenes de la web. Las respuestas contables llevan `Cache-Control: no-store`. Reportes, exportaciones y descargas de documentos cargados quedan auditados. Los enlaces originales de PDF de Stripe se abren directamente en Stripe.
- Documentos privados en PostgreSQL (`BYTEA`), hasta 10 MB, con nombre validado, comprobación básica de tipo y SHA-256. Se entregan como adjuntos con `nosniff`. XML con entidades o DTD se rechaza; no se procesa XML ni se ejecuta contenido. La carga de un CFDI no valida su timbrado ante el SAT.
- Los respaldos usados para conciliaciones no se pueden eliminar. El contador solo consulta y descarga: no puede cargar archivos ni modificar importes.

## Datos y documentos

Los meses usan `America/Mexico_City` y un intervalo desde el inicio del mes hasta el inicio del siguiente, excluido. PostgreSQL calcula los límites, incluyendo los cambios históricos de horario. Se mantienen separadas las monedas, sin inventar conversiones.

Stripe se consulta en lectura con paginación completa: movimientos por fecha de creación y transferencias por llegada estimada. Se presentan cobros, comisiones, reembolsos, movimiento neto de saldo y transferencias pagadas. Los pagos transferidos no se suman otra vez a los ingresos. El estado `paid` de una transferencia es el informado por Stripe y debe conciliarse con el estado bancario. La consulta abarca la cuenta Stripe configurada para TocadApp.

Los comprobantes PDF se recuperan de facturas Stripe emitidas en el periodo y de las referencias del registro de pagos, filtrando por fecha de pago. Una factura más antigua pagada en el mes se recupera cuando está referenciada por el registro local. Esto no constituye una búsqueda histórica exhaustiva de facturas pagadas con webhooks faltantes. Los comprobantes Stripe no sustituyen los CFDI XML timbrados.

Apple y Google Play no se estiman a partir de precios o compras de usuarios: se carga su reporte oficial y administración registra la liquidación por mes, tienda y moneda, con cobros, comisiones, reembolsos, retenciones y depósitos. El neto se calcula exactamente. Sin un documento del mismo mes y tienda no se guarda una conciliación. Hasta entonces la fuente queda pendiente, incluso si no hay compras registradas.

Se incluyen por separado los pagos de suscripción registrados manualmente. Se pueden descargar CSV con importes en unidades monetarias y los documentos originales PDF/XML/CSV. El resumen se puede imprimir o guardar en PDF desde el navegador. No se emiten CFDI ni se presentan declaraciones al SAT desde el módulo. Un periodo sin movimientos no determina por sí solo una declaración en ceros.

## Activación pendiente

La migración `src/migrations/042_accounting_portal.sql` está preparada; no se ha aplicado a producción. No se crearon credenciales reales. No se modificaron archivos `.env` ni las credenciales existentes.

Antes de activar:

1. Con autorización, respaldar PostgreSQL y aplicar únicamente la migración 042. Es aditiva: crea cinco tablas e índices sin modificar pagos o suscripciones existentes.
2. Construir y desplegar API y web; revisar que el proxy permita solicitudes de hasta 10 MB para documentos. No imprimir configuraciones con secretos al revisar el proxy.
3. Entrar como administrador, abrir **Contabilidad**, crear el acceso y entregar usuario/contraseña y enlace al contador por un canal privado.
4. Cargar los CFDI, estados bancarios y reportes de las tiendas necesarios para los meses que revisará el contador.
5. Comprobar en producción login, revocación, selección mensual y descarga de un documento de prueba controlado. Conciliar los primeros importes con los reportes oficiales.

Los repositorios tienen despliegue automático al hacer push a `main`; coordinar la migración antes del despliegue. No se ha hecho commit, push ni despliegue de este módulo.

## Verificación realizada

- Tests de API: aislamiento de cuentas y cookies, CSRF de login, revocación/rotación y carrera de contraseña, permisos, expiración, documentos, periodos inválidos, caída de Stripe, monedas, transferencias sin doble conteo, CSV y evidencia de liquidaciones.
- Tests de web: cliente separado, importes exactos, login del contador, estados pendientes frente a cero, errores de Stripe y respuestas antiguas al cambiar de mes.
- PostgreSQL en memoria (PGlite, instalación temporal externa al proyecto): migración, zonas horarias históricas, SQL real de credenciales y sesiones, `BYTEA`, restricciones de evidencia, liquidaciones, CSV y auditoría. No se usó una base de datos de producción.
- Navegador Edge con el build de producción y API simulada: nueve comprobaciones de login/logout, CSV, acción de impresión PDF, vista móvil sin desbordamiento, creación de credenciales, subida, conciliación y descarga idéntica al original, sin errores JavaScript.
- Builds de producción de API y Next.js, TypeScript y ESLint de los archivos web modificados.

Las comprobaciones de base de datos en memoria y navegador validan el flujo con datos controlados. Falta validar las cifras reales y los documentos oficiales tras activar el módulo.
