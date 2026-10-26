# Google Play Billing: fase 1 de propiedad y recuperaciÃ³n

ImplementaciÃ³n preparada para activaciÃ³n coordinada. No se debe desplegar mientras
los testers de Android 16 puedan iniciar compras nuevas sin identidad. No hay un
interruptor que vuelva a permitir reclamar tokens desconocidos: la protecciÃ³n es
comÃºn y estricta en todos los caminos.

## Cambios y migraciones

- `038_google_play_billing_identities.sql`: tabla nueva con identificador aleatorio
  por usuario, generado mediante `gen_random_uuid()` (PostgreSQL 13+), Ãºnico,
  estable, de 32 caracteres y sin datos personales. Backfill Ãºnicamente en la
  tabla nueva; trigger para usuarios futuros. UPDATE, DELETE y TRUNCATE estÃ¡n
  prohibidos por triggers. La baja lÃ³gica conserva la identidad; nunca se reasigna.
- `039_google_play_purchase_recovery.sql`: diario nuevo de trabajo. `user_id`
  representa un propietario verificado, nunca la cuenta que presentÃ³ el token.
  Estados: RETRY, DEFERRED, PENDING y PROCESSED. Una versiÃ³n evita que un intento
  anterior sobrescriba el resultado de otro mÃ¡s reciente.
- Se conservan las migraciones 035/036/037, las suscripciones y las asociaciones
  de tokens existentes. No se ejecuta ninguna migraciÃ³n mediante el arranque.

## Identidad y propiedad

La app obtiene su identidad del servidor y la envÃ­a como
`request.google.obfuscatedAccountId` al iniciar Play Billing. expo-iap 5.8.1 admite
ese campo. El identificador no es una credencial ni una firma de la sesiÃ³n.
Google conserva el valor enviado por el cliente; se acepta solo el valor leÃ­do
por el backend desde `purchases.subscriptionsv2.get`, contrastado con la tabla
emitida por el servidor. El cuerpo de verify nunca decide el propietario.

Se contrastan identidad actual, identidad del contexto de compra expirada y
propietarios registrados del token y sus anclas de reemplazo. Todos deben
coincidir. Una identidad desconocida o un conflicto impiden asignaciÃ³n, acceso y
acknowledge. Las anclas desconocidas siguen requiriendo recuperaciÃ³n segura; no
se registra un fragmento desconectado de una cadena como propiedad del solicitante.
La transacciÃ³n vuelve a consultar Google despuÃ©s de adquirir locks de tokens en
orden, y conserva la serializaciÃ³n existente por usuario y token.

El endpoint, RTDN, el diario de recuperaciÃ³n y el trabajador de acknowledge usan
la misma validaciÃ³n. El reconciliador puede atribuir una primera compra identificada
al propietario original sin sesiÃ³n abierta. Un POST desde otra cuenta devuelve
conflicto; su diario no se usa como prueba de propiedad. La recuperaciÃ³n puede
procesarla despuÃ©s para su dueÃ±o real.

## Contrato HTTP

Todos los endpoints siguientes requieren el authMiddleware existente.

### GET /subscriptions/google-play/identity

Cabecera `Cache-Control: no-store`. No admite elegir cuenta mediante body/query.

```json
{
  "obfuscatedAccountId": "<identificador opaco de la cuenta autenticada>",
  "capabilities": {
    "contractVersion": 1,
    "serverIssuedIdentity": true,
    "strictOwnership": true,
    "legacyKnownTokenRecovery": true,
    "legacyUnownedTokenClaim": false,
    "durablePendingRecovery": true,
    "purchaseSpecificResults": true,
    "serverAcknowledgement": true
  }
}
```

404 ACCOUNT_UNAVAILABLE si falta la cuenta; 503
GOOGLE_PLAY_BILLING_IDENTITY_UNAVAILABLE ante error de infraestructura. No habilitar
una compra nueva sin obtener identidad y capacidades de la cuenta actual.

### GET /subscriptions/me

Sin cambios: `{ hasAccess, subscription }`. El diario de compras pendientes no
participa en la selecciÃ³n de suscripciÃ³n efectiva.

### POST /subscriptions/google-play/verify

Mismo body: `{ "purchaseToken": "<token>" }`. No se confÃ­a en campos adicionales de
identidad o usuario enviados por el cliente. Mantiene `{ hasAccess, subscription,
googlePlay }` y agrega `purchaseResult`, tambiÃ©n incluido en googlePlay.

```json
{
  "state": "PENDING | CANCELED | ACTIVE | INACTIVE | REPLACED",
  "subscriptionState": "<estado verificado desde Google>",
  "acknowledgementState": "<estado de Google o null>",
  "retryable": true
}
```

`retryable` es true para PENDING y false para resultados finales. ACTIVE describe
esa compra, mientras hasAccess describe el acceso agregado. Un usuario puede
mantener hasAccess=true por una suscripciÃ³n anterior mientras otra compra estÃ¡
PENDING o CANCELED. Los clientes nuevos deben inspeccionar purchaseResult y no
interpretar hasAccess como confirmaciÃ³n del token presentado.

Errores incluyen `{ error, code, retryable }`, sin datos del propietario:

| HTTP | code | retryable |
| --- | --- | --- |
| 409 | GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED | false |
| 409 | GOOGLE_PLAY_OWNER_UNVERIFIABLE | false |
| 409 | GOOGLE_PLAY_BILLING_IDENTITY_UNKNOWN | false |
| 409 | GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN | false |
| 400 | INVALID_PURCHASE_TOKEN / INVALID_GOOGLE_PLAY_PURCHASE | false |
| 404 | PLAN_NOT_FOUND | false |
| 502 | GOOGLE_PLAY_VERIFICATION_FAILED | true |

Un 502 puede ocurrir despuÃ©s de guardar acceso si falla acknowledge. El diario y
la cola 037 conservan el trabajo. Nunca volver a cobrar por un error de verificaciÃ³n.
Un error de propiedad requiere cambiar de cuenta o recuperaciÃ³n asistida; los
workers pueden reexaminarlo si se resuelven sus anclas, sin asumir el solicitante.

## Compras pendientes y cancelaciones

El diario se persiste antes de llamar a Google. Sin respuesta de Google no se
concede Premium ni se asocia el token al solicitante. La siguiente ejecuciÃ³n del
reconciliador vuelve a consultar Google y resuelve propiedad desde fuentes seguras.

PENDING y PENDING_PURCHASE_CANCELED admiten ausencia de startTime/expiryTime. No
crean ni modifican suscripciones Premium, no retiran al predecesor y no reconocen
la compra. Un token pendiente identificado puede conservar propietario verificado
sin conceder acceso. Cuando Google confirma el pago, se usa la transacciÃ³n habitual
y la cola de acknowledge. Cuando confirma la cancelaciÃ³n pendiente, el trabajo
queda PROCESSED y purchaseResult=CANCELED. Una cancelaciÃ³n pendiente sin propietario
puede cerrarse sin asignar token ni acceso. Una consulta vacÃ­a, timeout o error de
Google nunca se interpreta como cancelaciÃ³n.

El comando existente `npm run reconcile:google-play` procesa acknowledge,
recuperaciÃ³n durable y RTDN, y devuelve fallo si alguna cola reporta fallos.
Mantener su frecuencia actual de cinco minutos. Las consultas de negocio vuelven
a consultar Google; no reproducen snapshots viejos como prueba de acceso.

## Compatibilidad con Android 16

- /me y el body de verify no cambian; la respuesta agrega campos.
- Tokens histÃ³ricos ya asociados y reemplazos con anclas conocidas conservan la
  recuperaciÃ³n para su propietario, siempre que no haya identidad contradictoria.
- Una compra nueva de v16 sin identidad ni ancla conocida devuelve 409
  GOOGLE_PLAY_OWNER_UNVERIFIABLE. Queda sin asignar y sin acknowledge.
- No es posible conservar la regla de primer reclamante y garantizar propiedad.
  No se deduce propietario de correo, userId, cuenta Google del dispositivo,
  confirmaciÃ³n de UI ni del solicitante autenticado.
- Hace falta actualizaciÃ³n previa al pago o pausa efectiva y coordinada con TODOS
  los testers de v16. Pausar distribuciÃ³n en Play por sÃ­ solo no impide que una
  instalaciÃ³n existente compre. Un rechazo Ãºnicamente despuÃ©s del cobro no es
  una estrategia suficiente de transiciÃ³n.

## Orden de despliegue (no ejecutado)

1. Confirmar inventario/backup y estado de 035/036/037. Identificar pagos de v16 aÃºn
   no reclamados; tratarlos por recuperaciÃ³n asistida, sin asignaciÃ³n especulativa.
2. Detener efectivamente compras nuevas de v16 antes de activar el cÃ³digo estricto.
   Coordinar actualizaciÃ³n o pausa de testers y finalizar operaciones en curso.
3. Aplicar 038 y despuÃ©s 039 con el rol de migraciones. Son aditivas y no alteran
   usuarios, suscripciones ni tokens existentes. El trigger de identidad queda
   activo tambiÃ©n para nuevos usuarios. Verificar permisos del rol de aplicaciÃ³n.
4. Pausar temporalmente el job y drenar las peticiones/replicas antiguas de Billing
   durante el reemplazo. No mantener cÃ³digo antiguo que reclame tokens desconocidos
   en paralelo con el cÃ³digo nuevo. /me puede mantenerse disponible.
5. Desplegar esta versiÃ³n backend completa en todas las rÃ©plicas, con las dos
   migraciones presentes. No ejecutar las migraciones desde procesos de aplicaciÃ³n.
6. Comprobar identidad estable por cuenta, aislamiento entre cuentas, /me y
   restauraciÃ³n de tokens conocidos de v16. Reanudar el mismo reconciliador cada
   cinco minutos y revisar sus contadores; no registrar tokens en logs.
7. En una fase posterior, integrar/probar el cliente 17 con identidad y estados
   de compra antes de reanudar compras nuevas. Esta fase no modifica el frontend
   ni publica el AAB. Mantener detenidas las compras nuevas desde v16.

Rollback: conservar tablas, identidades y diarios; nunca regenerar identificadores
ni revertir al primer reclamante. Ante incidentes, mantener detenidas las compras
nuevas y recuperar las conocidas con validaciÃ³n de propiedad. La migraciÃ³n no
incluye instrucciones destructivas de rollback.

## VerificaciÃ³n local

- `npx tsc --noEmit`
- `npm test`: pruebas de servicios/controladores con transportes simulados.
- Para ejecutar tambiÃ©n PostgreSQL, definir explÃ­citamente
  GOOGLE_PLAY_TEST_DATABASE_URL apuntando a la base local aislada tocadapp_ack_test.
  Las pruebas rechazan hosts no loopback y otro nombre de base; no cargan .env.
  Crean un schema temporal y aplican 035..039 Ãºnicamente dentro de Ã©l. Su limpieza
  elimina solamente ese schema de prueba.

Cobertura: reclamaciÃ³n entre cuentas, identidad contradictoria/forjada/desconocida,
relectura dentro de locks, v16 con tokens histÃ³ricos y nuevos, RTDN anterior al
callback, PENDING sin fechas, aprobaciÃ³n/cancelaciÃ³n con proceso nuevo, conservaciÃ³n
del acceso anterior, acknowledge Ãºnico y concurrencia real en PostgreSQL. Google
se simula: todavÃ­a hace falta validar la integraciÃ³n real mediante Play.

Pruebas manuales antes de reanudar compras: ambos planes, A paga y cambia a B,
cierre del proceso tras el pago, pÃ©rdida de red/backend, pago pendiente aprobado y
cancelado, RTDN sin app abierta, reinstalaciÃ³n y restauraciÃ³n histÃ³rica de v16.
Comprobar que el identificador emitido llega a subscriptionsv2.get y que no se
reconoce ninguna compra sin acceso guardado para su propietario real.


## Provisional conservative resubscription chain policy

Both `linkedPurchaseToken` and `outOfAppPurchaseContext.expiredPurchaseToken`
from Google must have durable ownership matching the authenticated/resolved
account. A predecessor already replaced by a different token is rejected before
any entitlement, token assignment, replacement, or acknowledgement queue write.
Synchronization and acknowledgement share this validation under ordered token
locks; verify, RTDN and recovery all use that synchronization path.

The existing HTTP 409 `GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED` also represents this
chain conflict; it does NOT prove that the payment was canceled, unpaid, or
invalid. No new response fields or error codes are introduced. Prior valid access
is preserved. The durable recovery journal retains the token, attempt/version,
status `DEFERRED` and conflict reason; existing ownership/replacement rows remain
intact. Reconciliation safely retries against fresh Google data. Tokens and
identities must only be inspected through authorized private operational tools.

**Production prerequisite:** this provisional policy can block legitimate paid
out-of-app resubscriptions referencing a historical replaced token. Establish an
assisted recovery process and a verified successor-chain strategy before
production. Investigate Google state and all durable owners; never clear or
reassign replacement links, force acknowledgement, or grant Premium merely to
bypass the conflict. A reviewed fix may then retry the retained work. Existing
historically inconsistent entitlement rows are not automatically repaired by
this change and require separate assessment.


## Catalog generation 2 (local preparation, sales closed)

The server allowlist accepts only these Google-validated combinations:

| Google product | Google base plan | Internal plan |
| --- | --- | --- |
| tocadapp_premium | monthly | TOCADAPP_MONTHLY |
| tocadapp_premium | yearly | TOCADAPP_YEARLY |
| tocadapp_premium_v2 | monthly | TOCADAPP_MONTHLY |
| tocadapp_premium_v2 | yearly | TOCADAPP_YEARLY |

Both products use the same strict identity/ownership/chain validation. Product
and plan come only from subscriptionsv2.get, never the verify request body or
RTDN product hints. Acknowledgement uses the product from the fresh validated
Google snapshot. Token journals/ownership remain token-keyed; no additional
migration or rewrite of historical records is needed.

GET /subscriptions/google-play/identity keeps contractVersion=1 and all original
capabilities, adding multiProductRecovery=true, purchaseCatalogVersion=1 and:

```json
{
  "purchasePolicy": {
    "newPurchasesEnabled": false,
    "productId": "tocadapp_premium_v2",
    "basePlans": { "TOCADAPP_MONTHLY": "monthly", "TOCADAPP_YEARLY": "yearly" }
  }
}
```

The exact server environment opt-in GOOGLE_PLAY_NEW_PURCHASES_ENABLED=true enables
new sales in compatible clients. Missing/false/malformed values keep them closed.
Do not enable it until the coordinated Play gates pass. This policy is NOT a
Google charging firewall: it cannot stop v16, modified clients, out-of-app sales
or a payment already in flight. Verify/RTDN/recovery/ack intentionally ignore the
sales flag so paid legitimate transactions remain recoverable. /subscriptions/me,
token-only /verify, purchaseResult and existing errors are unchanged.

Operational order: inventory production and Play without assuming zero purchases;
verify the supplied v16 AAB against Alpha; close and test legacy base plans;
apply 038/039 only if absent with the prior backup/permissions checks; deploy
this backend with sales flag absent/false; distribute the reviewed v17 candidate;
configure the new product's ordinary auto-renewing monthly/yearly plans; verify
v16 cannot buy the new catalog; only then opt in for controlled tests. Product
creation/activation, legacy deactivation, production access and deployment have
NOT been performed by this implementation. Rollback closes new sales and keeps
both products' verification and all migrations/ownership/journals intact.

Local artifact evidence is documented in the mobile repository at
`docs/google-play-v16-artifact-review.md`. The conservative chain limitation and
assisted recovery prerequisites above still apply; a new product is not a waiver
of ownership checks or a complete assisted-recovery implementation.
