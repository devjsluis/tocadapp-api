import type { Request, Response } from "express";
import {
  deleteSubscriptionPayment,
  getAdminSubscriptions,
  getSubscriptionPaymentsByUserId,
  grantManualAccess,
  updateSubscriptionPayment,
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

    case "INVALID_MONTHS":
      return {
        status: 400,
        body: {
          error:
            "Debes enviar months como un entero entre 1 y 120, o enviar accessUntil",
          code: "INVALID_MONTHS",
        },
      };

    case "PAYMENT_NOT_FOUND":
      return {
        status: 404,
        body: {
          error: "Pago no encontrado",
          code: "PAYMENT_NOT_FOUND",
        },
      };

    case "INVALID_PAID_AT":
      return {
        status: 400,
        body: {
          error: "La fecha del pago no es válida",
          code: "INVALID_PAID_AT",
        },
      };

    case "INVALID_ACCESS_PERIOD":
      return {
        status: 400,
        body: {
          error: "El periodo de acceso no es válido",
          code: "INVALID_ACCESS_PERIOD",
        },
      };

    case "ACCESS_UNTIL_BEFORE_ACCESS_FROM":
      return {
        status: 400,
        body: {
          error: "La fecha final no puede ser anterior a la fecha inicial",
          code: "ACCESS_UNTIL_BEFORE_ACCESS_FROM",
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

export const editSubscriptionPayment = async (req: Request, res: Response) => {
  try {
    const paymentId = Number(req.params.paymentId);

    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({
        error: "El identificador del pago no es válido",
        code: "INVALID_PAYMENT_ID",
      });
    }

    const {
      amount,
      currency,
      paidAt,
      accessFrom,
      accessUntil,
      reference,
      notes,
    } = req.body;

    if (!Number.isInteger(amount) || amount < 0) {
      return res.status(400).json({
        error: "amount debe enviarse en centavos",
        code: "INVALID_AMOUNT",
      });
    }

    if (
      typeof paidAt !== "string" ||
      typeof accessFrom !== "string" ||
      typeof accessUntil !== "string"
    ) {
      return res.status(400).json({
        error: "paidAt, accessFrom y accessUntil son obligatorios",
        code: "PAYMENT_DATES_REQUIRED",
      });
    }

    const payment = await updateSubscriptionPayment({
      paymentId,
      amount,
      currency: typeof currency === "string" ? currency : undefined,
      paidAt,
      accessFrom,
      accessUntil,
      reference:
        typeof reference === "string" ? reference.trim() || null : null,
      notes: typeof notes === "string" ? notes.trim() || null : null,
    });

    return res.json({
      message: "Pago actualizado correctamente",
      payment,
    });
  } catch (error) {
    const response = getErrorResponse(error);

    return res.status(response.status).json(response.body);
  }
};

export const removeSubscriptionPayment = async (
  req: Request,
  res: Response,
) => {
  try {
    const paymentId = Number(req.params.paymentId);

    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({
        error: "El identificador del pago no es válido",
        code: "INVALID_PAYMENT_ID",
      });
    }

    const payment = await deleteSubscriptionPayment(paymentId);

    return res.json({
      message: "Pago eliminado correctamente",
      payment,
    });
  } catch (error) {
    const response = getErrorResponse(error);

    return res.status(response.status).json(response.body);
  }
};
