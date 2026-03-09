import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "TocadApp API",
      version: "1.0.0",
      description:
        "API REST para la gestión de tocadas, músicos y usuarios de TocadApp. " +
        "Plataforma de administración para músicos: agenda de eventos, finanzas y banda.",
      contact: {
        name: "TocadApp",
      },
    },
    servers: [
      {
        url: "http://localhost:4000",
        description: "Desarrollo local",
      },
      {
        url: "https://api.tocadapp.com",
        description: "Producción",
      },
    ],
    tags: [
      {
        name: "Auth",
        description: "Registro e inicio de sesión de usuarios",
      },
      {
        name: "Gigs",
        description: "Gestión de tocadas / eventos musicales",
      },
      {
        name: "Musicians",
        description: "Integrantes de la banda",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Token JWT obtenido al iniciar sesión",
        },
      },
      schemas: {
        // ── Users ──
        RegisterRequest: {
          type: "object",
          required: ["name", "lastName", "email", "password", "role"],
          properties: {
            name: {
              type: "string",
              example: "Luis Angel",
              description: "Nombre del usuario",
            },
            lastName: {
              type: "string",
              example: "García",
              description: "Apellido del usuario",
            },
            email: {
              type: "string",
              format: "email",
              example: "luis@tocadapp.com",
            },
            password: {
              type: "string",
              format: "password",
              minLength: 6,
              example: "miPassword123",
            },
            role: {
              type: "string",
              enum: ["musician", "manager"],
              example: "musician",
              description: "musician = músico, manager = encargado de banda",
            },
          },
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "luis@tocadapp.com",
            },
            password: {
              type: "string",
              format: "password",
              example: "miPassword123",
            },
          },
        },
        LoginResponse: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "JWT válido por 24 horas",
              example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            },
            user: {
              type: "object",
              properties: {
                id: { type: "string", example: "1" },
                name: { type: "string", example: "Luis Angel" },
                email: {
                  type: "string",
                  format: "email",
                  example: "luis@tocadapp.com",
                },
                role: { type: "string", example: "musician" },
              },
            },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            last_name: { type: "string" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["musician", "manager"] },
            created_at: { type: "string", format: "date-time" },
          },
        },
        // ── Gigs ──
        GigRequest: {
          type: "object",
          required: ["title", "place", "date", "time", "amount", "hours"],
          properties: {
            title: {
              type: "string",
              example: "Boda Familia García",
              description: "Nombre del evento",
            },
            place: {
              type: "string",
              example: "Salón Versalles",
              description: "Lugar o salón donde se toca",
            },
            date: {
              type: "string",
              format: "date",
              example: "2026-04-15",
              description: "Fecha del evento (YYYY-MM-DD)",
            },
            time: {
              type: "string",
              example: "19:00",
              description: "Hora del evento (HH:MM)",
            },
            amount: {
              type: "number",
              example: 15000,
              description: "Monto pactado en MXN",
            },
            hours: {
              type: "number",
              example: 5,
              description: "Duración estimada en horas",
            },
            notes: {
              type: "string",
              example: "Llevar equipo completo",
              description: "Notas adicionales (opcional)",
            },
          },
        },
        Gig: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            place: { type: "string" },
            date: { type: "string", format: "date-time" },
            time: { type: "string" },
            amount: { type: "number" },
            hours: { type: "number" },
            notes: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time" },
          },
        },
        // ── Musicians ──
        MusicianRequest: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              example: "Carlos Mendoza",
              description: "Nombre completo del músico",
            },
            instrument: {
              type: "string",
              example: "Trompeta",
              description: "Instrumento que toca (opcional)",
            },
            phone: {
              type: "string",
              example: "3312345678",
              description: "Teléfono de contacto (opcional)",
            },
            notes: {
              type: "string",
              example: "Disponible fines de semana",
              description: "Notas adicionales (opcional)",
            },
          },
        },
        Musician: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            instrument: { type: "string", nullable: true },
            phone: { type: "string", nullable: true },
            notes: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time" },
          },
        },
        // ── Errors ──
        Error: {
          type: "object",
          properties: {
            error: {
              type: "string",
              example: "Mensaje de error",
            },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: "Token inválido o no proporcionado",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: { error: "Token no válido" },
            },
          },
        },
        NotFound: {
          description: "Recurso no encontrado",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: { error: "Recurso no encontrado" },
            },
          },
        },
        ServerError: {
          description: "Error interno del servidor",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
    paths: {
      // ──────────── AUTH ────────────
      "/users": {
        post: {
          tags: ["Auth"],
          summary: "Registrar nuevo usuario",
          description:
            "Crea una cuenta nueva. La contraseña se hashea con bcrypt antes de guardarse.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RegisterRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Usuario creado correctamente",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/User" },
                },
              },
            },
            "400": {
              description: "Campos faltantes o correo ya registrado",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                  examples: {
                    camposFaltantes: {
                      summary: "Faltan campos",
                      value: {
                        error:
                          "Todos los campos (nombre, apellido, correo, contraseña y rol) son obligatorios",
                      },
                    },
                    correoExistente: {
                      summary: "Correo ya registrado",
                      value: {
                        error: "Este correo electrónico ya está registrado",
                      },
                    },
                  },
                },
              },
            },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
        get: {
          tags: ["Auth"],
          summary: "Obtener todos los usuarios",
          description:
            "Retorna la lista de usuarios registrados sin incluir contraseñas.",
          responses: {
            "200": {
              description: "Lista de usuarios",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/User" },
                      },
                      total: { type: "integer", example: 3 },
                    },
                  },
                },
              },
            },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
      },
      "/users/login": {
        post: {
          tags: ["Auth"],
          summary: "Iniciar sesión",
          description:
            "Autentica al usuario con email y contraseña. Retorna un JWT válido por 24 horas que debe incluirse como `Authorization: Bearer <token>` en las peticiones protegidas.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Inicio de sesión exitoso",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/LoginResponse" },
                },
              },
            },
            "401": {
              description: "Credenciales incorrectas",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                  examples: {
                    correoNoExiste: {
                      summary: "Correo no existe",
                      value: { error: "El correo electrónico no existe" },
                    },
                    passwordIncorrecta: {
                      summary: "Contraseña incorrecta",
                      value: { error: "Contraseña incorrecta" },
                    },
                  },
                },
              },
            },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
      },
      // ──────────── GIGS ────────────
      "/gigs": {
        get: {
          tags: ["Gigs"],
          summary: "Obtener todas las tocadas",
          description:
            "Retorna todas las tocadas ordenadas por fecha ascendente. Las fechas pasadas aparecen primero, seguidas de las futuras.",
          responses: {
            "200": {
              description: "Lista de tocadas",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Gig" },
                      },
                      totals: {
                        type: "object",
                        properties: {
                          count: { type: "integer", example: 12 },
                        },
                      },
                    },
                  },
                },
              },
            },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
        post: {
          tags: ["Gigs"],
          summary: "Crear nueva tocada",
          description: "Registra un nuevo evento musical con todos sus datos.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GigRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Tocada creada",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Gig" },
                },
              },
            },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
      },
      "/gigs/{id}": {
        put: {
          tags: ["Gigs"],
          summary: "Editar una tocada",
          description: "Actualiza todos los campos de una tocada existente.",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
              description: "ID de la tocada",
              example: "5",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GigRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Tocada actualizada",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Gig" },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
        delete: {
          tags: ["Gigs"],
          summary: "Eliminar una tocada",
          description: "Elimina permanentemente una tocada por su ID.",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
              description: "ID de la tocada",
              example: "5",
            },
          ],
          responses: {
            "200": {
              description: "Tocada eliminada",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                    },
                  },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
      },
      // ──────────── MUSICIANS ────────────
      "/musicians": {
        get: {
          tags: ["Musicians"],
          summary: "Obtener todos los músicos",
          description:
            "Retorna la lista de integrantes de la banda ordenados alfabéticamente.",
          responses: {
            "200": {
              description: "Lista de músicos",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Musician" },
                      },
                      totals: {
                        type: "object",
                        properties: {
                          count: { type: "integer", example: 6 },
                        },
                      },
                    },
                  },
                },
              },
            },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
        post: {
          tags: ["Musicians"],
          summary: "Agregar músico a la banda",
          description:
            "Registra un nuevo integrante. Solo el nombre es obligatorio.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MusicianRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Músico creado",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Musician" },
                },
              },
            },
            "400": {
              description: "Nombre no proporcionado",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                  example: { error: "El nombre es obligatorio" },
                },
              },
            },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
      },
      "/musicians/{id}": {
        delete: {
          tags: ["Musicians"],
          summary: "Eliminar músico",
          description: "Elimina un integrante de la banda por su ID.",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
              description: "ID del músico",
              example: "3",
            },
          ],
          responses: {
            "200": {
              description: "Músico eliminado",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                    },
                  },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
            "500": { $ref: "#/components/responses/ServerError" },
          },
        },
      },
    },
  },
  apis: [],
};

export const swaggerSpec = swaggerJsdoc(options);
