import type { Request, Response } from "express";
import {
  getAdminSubscriptions,
  getSubscriptionPaymentsByUserId,
  grantManualAccess,
} from "../services/adminSubscriptions.service";

const getErrorResponse = (error: unknown) => {
  if (!(error instanceof Error)) {
    return {
      status: 500,
      body: {
        error: "Ocurrió un error inesperado",
      },
    };
  }

  switch (error.message) {
    case "USER_NOT_FOUND":
      return {
        status: 404,
        body: {
          error: "Usuario no encontrado",
          code: "USER_NOT_FOUND",
        },
      };

    case "PLAN_NOT_FOUND":
      return {
        status: 404,
        body: {
          error: "Plan no encontrado o inactivo",
          code: "PLAN_NOT_FOUND",
        },
      };

    case "INVALID_AMOUNT":
      return {
        status: 400,
        body: {
          error: "El monto debe ser un entero mayor o igual a cero",
          code: "INVALID_AMOUNT",
        },
      };

    case "INVALID_CURRENCY":
      return {
        status: 400,
        body: {
          error: "La moneda debe tener tres letras, por ejemplo MXN",
          code: "INVALID_CURRENCY",
        },
      };

    case "INVALID_ACCESS_UNTIL":
      return {
        status: 400,
        body: {
          error: "La fecha de acceso no es válida",
          code: "INVALID_ACCESS_UNTIL",
        },
      };

    case "ACCESS_UNTIL_MUST_BE_FUTURE":
      return {
        status: 400,
        body: {
          error: "La fecha final debe estar en el futuro",
          code: "ACCESS_UNTIL_MUST_BE_FUTURE",
        },
      };

    case "INVALID_MONTHS":
      return {
        status: 400,
        body: {
          error:
            "Debes enviar months como un entero entre 1 y 120, o enviar accessUntil",
          code: "INVALID_MONTHS",
        },
      };

    default:
      console.error("Error administrativo de suscripciones:", error);

      return {
        status: 500,
        body: {
          error: "No fue posible procesar la suscripción",
        },
      };
  }
};

export const grantManualSubscriptionAccess = async (
  req: Request,
  res: Response,
) => {
  try {
    const registeredByUserId = req.user?.id;

    if (!registeredByUserId) {
      return res.status(401).json({
        error: "No autorizado",
      });
    }

    const {
      userId,
      planCode,
      amount,
      currency,
      months,
      accessUntil,
      paymentReference,
      notes,
    } = req.body;

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        error: "userId debe ser un entero positivo",
        code: "INVALID_USER_ID",
      });
    }

    if (typeof planCode !== "string" || !planCode.trim()) {
      return res.status(400).json({
        error: "planCode es obligatorio",
        code: "PLAN_CODE_REQUIRED",
      });
    }

    if (!Number.isInteger(amount) || amount < 0) {
      return res.status(400).json({
        error: "amount debe enviarse en centavos",
        code: "INVALID_AMOUNT",
      });
    }

    if (!accessUntil && months === undefined) {
      return res.status(400).json({
        error: "Debes enviar months o accessUntil",
        code: "ACCESS_PERIOD_REQUIRED",
      });
    }

    if (accessUntil && months !== undefined) {
      return res.status(400).json({
        error: "Envía únicamente months o accessUntil, no ambos",
        code: "AMBIGUOUS_ACCESS_PERIOD",
      });
    }

    const result = await grantManualAccess({
      userId,
      planCode: planCode.trim(),
      amount,
      currency: typeof currency === "string" ? currency : undefined,
      months,
      accessUntil,
      paymentReference:
        typeof paymentReference === "string"
          ? paymentReference.trim() || null
          : null,
      notes: typeof notes === "string" ? notes.trim() || null : null,
      registeredByUserId,
    });

    return res.status(201).json({
      message: "Pago registrado y acceso actualizado",
      data: result,
    });
  } catch (error) {
    const response = getErrorResponse(error);

    return res.status(response.status).json(response.body);
  }
};

export const listAdminSubscriptions = async (_req: Request, res: Response) => {
  try {
    const subscriptions = await getAdminSubscriptions();

    return res.json({
      subscriptions,
    });
  } catch (error) {
    console.error("Error listando suscripciones:", error);

    return res.status(500).json({
      error: "No fue posible obtener las suscripciones",
    });
  }
};

export const listUserSubscriptionPayments = async (
  req: Request,
  res: Response,
) => {
  try {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        error: "El identificador del usuario no es válido",
        code: "INVALID_USER_ID",
      });
    }

    const result = await getSubscriptionPaymentsByUserId(userId);

    return res.json(result);
  } catch (error) {
    const response = getErrorResponse(error);

    return res.status(response.status).json(response.body);
  }
};
