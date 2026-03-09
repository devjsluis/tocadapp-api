# TocadApp — API

API REST para la plataforma TocadApp: gestión de tocadas, músicos y usuarios.
Construida con **Express 5**, **TypeScript** y **PostgreSQL**.

> **Documentación interactiva (Swagger):** una vez corriendo, abre `http://localhost:4000/api-docs`

---

## Índice

- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Variables de entorno](#variables-de-entorno)
- [Base de datos](#base-de-datos)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Endpoints](#endpoints)
- [Autenticación](#autenticación)
- [Tecnologías](#tecnologías)

---

## Requisitos

- Node.js 18+
- npm 9+
- PostgreSQL 14+

---

## Instalación

```bash
# Instalar dependencias
npm install

# Crear archivo de variables de entorno
cp .env.example .env

# Correr en desarrollo (hot-reload)
npm run dev

# Build para producción
npm run build
npm start
```

La API queda disponible en `http://localhost:4000`.
La documentación Swagger en `http://localhost:4000/api-docs`.

---

## Variables de entorno

Crea un archivo `.env` en la raíz con:

```env
PORT=4000
DATABASE_URL=postgresql://usuario:password@localhost:5432/tocadapp
NODE_ENV=development
JWT_SECRET=tu_secreto_super_seguro_aqui
```

| Variable       | Descripción                           | Requerida |
|----------------|---------------------------------------|-----------|
| `PORT`         | Puerto del servidor (default: 4000)   | No        |
| `DATABASE_URL` | Cadena de conexión a PostgreSQL       | Sí        |
| `NODE_ENV`     | Entorno: `development` o `production` | No        |
| `JWT_SECRET`   | Secreto para firmar tokens JWT        | Sí        |

---

## Base de datos

### Crear las tablas

Ejecuta los siguientes SQL en tu base de datos PostgreSQL:

```sql
-- Usuarios
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  name       VARCHAR(255) NOT NULL,
  last_name  VARCHAR(255) NOT NULL,
  password   VARCHAR(255) NOT NULL,
  role       VARCHAR(50)  NOT NULL CHECK (role IN ('musician', 'manager')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tocadas
CREATE TABLE IF NOT EXISTS gigs (
  id         SERIAL PRIMARY KEY,
  title      VARCHAR(255) NOT NULL,
  place      VARCHAR(255) NOT NULL,
  date       DATE NOT NULL,
  time       TIME NOT NULL,
  amount     NUMERIC(10, 2) NOT NULL,
  hours      NUMERIC(4, 1) NOT NULL,
  notes      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Músicos de la banda
CREATE TABLE IF NOT EXISTS musicians (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  instrument VARCHAR(255),
  phone      VARCHAR(50),
  notes      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

Los archivos SQL también están en `src/migrations/`.

---

## Estructura del proyecto

```
tocadapp-api/
├── src/
│   ├── index.ts                    # Punto de entrada, levanta el servidor
│   ├── app.ts                      # Express app: middlewares, rutas, Swagger
│   ├── swagger.ts                  # Spec OpenAPI 3.0 completa
│   ├── lib/
│   │   └── db.ts                   # Pool de conexión a PostgreSQL
│   ├── routes/
│   │   ├── users.routes.ts
│   │   ├── gigs.routes.ts
│   │   └── musicians.routes.ts
│   ├── controllers/
│   │   ├── users.controller.ts
│   │   ├── gigs.controller.ts
│   │   └── musicians.controller.ts
│   └── migrations/
│       └── 002_create_musicians.sql
├── package.json
└── tsconfig.json
```

---

## Endpoints

Consulta la documentación interactiva en `/api-docs` para ver todos los detalles, ejemplos de request/response y probar los endpoints directamente.

### Resumen

#### Auth — `/users`

| Método | Ruta            | Descripción              |
|--------|-----------------|--------------------------|
| POST   | `/users`        | Registrar nuevo usuario  |
| POST   | `/users/login`  | Iniciar sesión → JWT     |
| GET    | `/users`        | Listar todos los usuarios|

#### Tocadas — `/gigs`

| Método | Ruta         | Descripción                             |
|--------|--------------|-----------------------------------------|
| GET    | `/gigs`      | Obtener todas las tocadas (por fecha)   |
| POST   | `/gigs`      | Crear nueva tocada                      |
| PUT    | `/gigs/:id`  | Editar tocada existente                 |
| DELETE | `/gigs/:id`  | Eliminar tocada                         |

#### Músicos — `/musicians`

| Método | Ruta               | Descripción                    |
|--------|--------------------|--------------------------------|
| GET    | `/musicians`       | Listar integrantes de la banda |
| POST   | `/musicians`       | Agregar músico                 |
| DELETE | `/musicians/:id`   | Eliminar músico                |

#### Sistema

| Método | Ruta           | Descripción                          |
|--------|----------------|--------------------------------------|
| GET    | `/`            | Estado de la API                     |
| GET    | `/health`      | Health check con entorno             |
| GET    | `/api-docs`    | Documentación Swagger UI             |
| GET    | `/api-docs.json` | Spec OpenAPI en formato JSON       |

---

## Autenticación

El login retorna un **JWT** con expiración de 24 horas. El token contiene:

```json
{ "id": 1, "email": "usuario@ejemplo.com", "role": "musician" }
```

El frontend lo guarda en una cookie y lo envía en el header:

```
Authorization: Bearer <token>
```

> **Nota:** actualmente los endpoints de gigs y músicos no requieren autenticación (sin middleware). Esto es intencional para el MVP — se puede agregar un guard middleware en las rutas cuando se necesite.

---

## Tecnologías

| Tecnología       | Versión  | Uso                                        |
|------------------|----------|--------------------------------------------|
| Node.js          | 18+      | Runtime                                    |
| Express          | 5.2.1    | Framework HTTP                             |
| TypeScript       | 5        | Tipado estático                            |
| PostgreSQL (pg)  | 8.18.0   | Base de datos                              |
| bcrypt           | 6.0.0    | Hash de contraseñas                        |
| jsonwebtoken     | 9.0.3    | Generación y verificación de JWT           |
| cors             | 2.8.5    | Política de orígenes cruzados              |
| dotenv           | 17.2.3   | Variables de entorno                       |
| swagger-ui-express | latest | UI interactiva de documentación            |
| swagger-jsdoc    | latest   | Generación de spec OpenAPI                 |
