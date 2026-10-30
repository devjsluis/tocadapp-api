# Preparación de despliegue: Apple y actualizaciones de seguridad

Estado: código validado localmente; despliegue pendiente de verificar respaldo,
recuperación y configuración Docker del servidor. No se ejecutaron migraciones,
consultas de producción, cobros, push ni despliegues.

## Qué se comprobó

- Ambos repositorios siguen en main y conservan los cambios anteriores.
- Identidad Git resuelta en ambos: LuisAngelGGG <devjsluis@gmail.com>.
- Backend: compilación TypeScript aprobada; 132 pruebas aprobadas, una prueba de
  PostgreSQL omitida por no tener una base aislada configurada. No hay lint de backend.
- Móvil: 190 pruebas aprobadas, TypeScript aprobado y lint sin errores; tres
  advertencias preexistentes. Las exportaciones iOS/Android pasaron en la revisión previa.
- npm audit del backend: cero vulnerabilidades. No cambiaron las versiones mayores.
- Los archivos existentes de controladores, servicios Google Play, sus rutas y el
  workflow de despliegue no tienen diferencias respecto a HEAD. Los endpoints se
  mantienen; las rutas Apple se añaden bajo prefijos independientes.
- Prueba nueva de arranque: carga la aplicación Express real con NODE_ENV=production,
  sin ninguna variable APPLE_* ni lectura de .env. Sustituye pg por un doble que
  prohíbe conexiones y mutaciones. Comprueba /health, autenticación, /subscriptions/me,
  identidad Google Play y entradas inválidas en verificación Google, Checkout y Stripe.
  Apple devuelve 503 cuando no está configurado y no consulta sus tablas; el resto
  de la aplicación sigue respondiendo. No demuestra compras o conexiones reales.

## Migración 040 completa

El archivo fuente es src/migrations/040_apple_subscriptions.sql. Se revisaron sus
dos CREATE TABLE, sus claves, restricciones y BEGIN/COMMIT:

1. apple_billing_identities: una identidad UUID única por users.id; el UUID lo genera
   Node, por lo que no necesita extensiones PostgreSQL ni funciones adicionales.
2. apple_subscription_chains: clave compuesta environment/original_transaction_id,
   propietario, transacción, producto, estado Apple 1–5 y última verificación.
3. Ambas referencias usan INTEGER REFERENCES users(id), igual que el esquema
   versionado existente. ON DELETE RESTRICT conserva propiedad histórica; el flujo
   actual elimina usuarios lógicamente con deleted_at.
4. No altera ni actualiza subscriptions, plans, usuarios o tablas de Google Play.
   No modifica precios, tokens, acceso ni cobros existentes. No toca el índice que
   limita a una suscripción abierta por usuario.
5. No usa IF NOT EXISTS: es una aplicación única. Si una de esas tablas ya existe,
   no se debe repetir sin inspeccionar su estructura. No hay registro automático
   de migraciones en este repositorio.

Dictamen: aditiva y de bajo riesgo sobre el esquema versionado. Se recomienda
aplicarla únicamente después de confirmar el destino, tablas ausentes, privilegios
y respaldo recuperable. No se certificó el esquema real de producción. Crear claves
foráneas toma bloqueos breves sobre la tabla referenciada; usar lock_timeout para
fallar antes que esperar indefinidamente. Una aplicación fallida con ON_ERROR_STOP
queda sin COMMIT y se revierte al cerrar la conexión.

Si el rol que aplica la migración es distinto al de la aplicación, comprobar los
GRANT necesarios para SELECT/INSERT/UPDATE de ambas tablas y la política de roles.
No asignar permisos a PUBLIC. La migración no abre acceso a tablas de Android.

040 NO es necesaria para arrancar este backend con Apple sin configurar: solo se
necesita antes de usar Apple. No ejecutar reconcile:apple ni habilitar Apple hasta
aplicar la migración y configurar sus credenciales.

## Despliegue actual encontrado

.github/workflows/deploy-backend.yml se ejecuta al hacer push a main. Usa los
secretos GitHub HOST, USERNAME y SSH_KEY y ejecuta por SSH:

```sh
cd ~/tocadapp/backend
git pull origin main
docker compose up -d --build backend
docker image prune -f
```

No contiene migraciones, copias de seguridad, restauración ni pruebas previas.
package.json tampoco tiene un comando migrate y src/index.ts no aplica SQL.
El Dockerfile y el Compose no están versionados en este repositorio: no se pudo
confirmar su versión Node, contexto de build, copia de src/migrations, hooks o
montajes de secretos. No se modificó el workflow.

Antes de desplegar, comprobar desde la sesión SSH habitual (sin imprimir .env ni
usar docker compose config sin filtros, porque podría mostrar credenciales):

```sh
cd ~/tocadapp/backend
git status --short
git rev-parse HEAD
docker compose config --services
docker compose ps backend
docker compose exec -T backend node --version
```

Revisar únicamente las instrucciones FROM/RUN/CMD/ENTRYPOINT del Dockerfile y los
campos de build, comando, mounts y secrets del servicio backend. Comprobar que no
ejecute automáticamente SQL y que instale el lockfile y compile TypeScript antes
de iniciar npm start. No modificar las variables actuales de Google Play, Stripe,
DATABASE_URL ni NODE_ENV para preparar Apple.

## Respaldo y recuperación: pendiente concreto

No se encontró un script, cron, política de retención ni prueba de restauración en
los repositorios. La URL local de base de datos no identifica un proveedor con
respaldo gestionado comprobable. Esto NO demuestra que el servidor carezca de
respaldos: hace falta identificar el mecanismo que usa y comprobar una copia.
Las herramientas psql/pg_dump/pg_restore tampoco están en el PATH local de Windows;
pueden existir en el servidor o en el contenedor PostgreSQL, todavía no inspeccionado.

Antes de autorizar SQL: identificar fecha de última copia exitosa, destino fuera
del volumen de la base, retención, acceso del operador y procedimiento de recuperación.
Un archivo existente o pg_restore --list por sí solos no prueban una restauración.
Se debe recuperar una copia en una base aislada y comprobar datos/esquema, con
autorización separada; nunca ensayar una restauración sobre producción.

Comandos de referencia, NO ejecutados. Los servicios libpq tocadapp-production y
tocadapp-restore-check son nombres propuestos: primero deben mapearse a los destinos
verificados mediante pg_service.conf/.pgpass o el gestor de secretos del operador.
No introducir contraseñas en el repositorio ni copiar las URLs al chat.

```sh
# Ejecutar con el cliente PostgreSQL adecuado en el host o contenedor confirmado.
umask 077
backup_file="$HOME/tocadapp-before-apple-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --dbname='service=tocadapp-production' --format=custom --file="$backup_file"
pg_restore --list "$backup_file"

# Solo después de comprobar que el destino de restauración es una base aislada
# vacía y obtener autorización para escribir allí:
pg_restore --dbname='service=tocadapp-restore-check' --exit-on-error \
  --single-transaction --no-owner --no-privileges "$backup_file"
```

No ejecutar restore mientras el destino esté sin identificar. Usar una versión
de pg_dump compatible con la versión del servidor; copiar el respaldo a un destino
privado fuera del host. Los dumps contienen datos personales. Si la instalación
requiere roles/globales u objetos externos, documentar su recuperación además del dump.

## Aplicación futura de SQL, solo con autorización

Con respaldo verificado y servicio libpq confirmado, estas consultas son previas
a la migración y no modifican datos:

```sql
SELECT current_database(), current_user, current_schema();
SELECT data_type FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'id';
SELECT to_regclass('apple_billing_identities'), to_regclass('apple_subscription_chains');
```

Aplicar únicamente el archivo 040, no toda la carpeta histórica. Copiar ese archivo
desde el commit aprobado; el build TypeScript no lo copia a dist automáticamente.

```sh
# Solo tras autorización expresa; desde la copia aprobada del repositorio.
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=60s' \
  psql --dbname='service=tocadapp-production' -X --set=ON_ERROR_STOP=1 \
  --file=src/migrations/040_apple_subscriptions.sql
```

No usar --single-transaction de psql aquí: 040 ya tiene BEGIN/COMMIT.
No ejecutar esta instrucción como parte del arranque de la aplicación.

## Variables Apple

Todas pueden permanecer ausentes para desplegar el backend con Apple inactivo.
APPLE_NEW_PURCHASES_ENABLED ausente equivale a nuevas compras deshabilitadas.
No es necesario modificar ningún secreto existente para ese despliegue.

| Variable | Cuando se active Apple |
| --- | --- |
| APPLE_ENVIRONMENT | Production en producción; no sustituir el entorno actual por Sandbox |
| APPLE_NEW_PURCHASES_ENABLED | false hasta validar todo; true habilita nuevas ventas elegibles |
| APPLE_KEY_ID | ID de clave App Store Server API |
| APPLE_ISSUER_ID | Issuer ID de App Store Connect |
| APPLE_PRIVATE_KEY_PATH | Archivo .p8 montado de forma privada y legible dentro del contenedor |
| APPLE_ROOT_CA_PATHS | Archivos raíz DER oficiales, rutas separadas por comas dentro del contenedor |
| APPLE_APP_ID | ID numérico de la app, obligatorio para Production |
| APPLE_SANDBOX_USER_IDS | Opcional: cuentas TocadApp específicas de revisión que usan Sandbox; no usuarios reales |

No configurar Apple parcialmente como preparación; esperar a la activación de la
membresía, aplicar 040 con autorización y montar los archivos fuera de Git. Al
cambiar claves/configuración, reiniciar el proceso para vaciar su caché.

## Comandos para la liberación futura

Permiso recibido para commits, push, migración 040 y despliegue. Antes del push del backend, confirmar acceso al servidor y respaldo recuperable. Los comandos de producción todavía no se ejecutaron.
Los commits locales usarán la identidad Git ya configurada, sin cambiarla. Revisar
la lista exacta de archivos y git diff --cached; no usar git add . ni incluir .env,
archivos .p8, llaves Android, dumps o archivos de credenciales.

Después de los commits locales y autorización de push, este comando en tocadapp-api
dispara el despliegue automático existente. No repetir luego compose manualmente
sin comprobar primero el resultado de GitHub Actions:

```sh
git push origin main
```

Alternativa manual en el servidor, con push previamente autorizado y evitando un
despliegue simultáneo del workflow:

```sh
set -eu
cd ~/tocadapp/backend
git pull --ff-only origin main
docker compose build backend
docker compose up -d --no-deps backend
docker compose ps backend
```

Comprobar /health y los flujos Android con el procedimiento habitual. No mostrar
logs que puedan contener tokens/credenciales en canales públicos. No activar ventas
Apple ni ejecutar reconciliadores para probar un despliegue con Apple inactivo.
No se requiere publicar otra versión Android para desplegar el backend.
El commit móvil se publica mediante EAS/tiendas en un proceso separado, no con ese push.

Recuperación de código: registrar el SHA e imagen activos antes del despliegue.
Si falla, revertir el commit del backend y desplegar el código anterior mediante
el mecanismo habitual. Conservar las tablas aditivas 040; no borrar datos ni ejecutar
una migración inversa. No restaurar un dump completo de producción solo para revertir
código: podría perder escrituras posteriores. Una restauración real requiere un
procedimiento y autorización específicos.

Referencias: [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html),
[psql](https://www.postgresql.org/docs/current/app-psql.html),
[Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/).
