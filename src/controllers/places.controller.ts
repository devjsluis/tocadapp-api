import { Response } from "express";
import { AuthRequest } from "../middleware/auth";

const GOOGLE_PLACES_BASE_URL = "https://places.googleapis.com/v1";

const getApiKey = () => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY no está configurada");
  }

  return apiKey;
};

export const autocompletePlaces = async (req: AuthRequest, res: Response) => {
  const input = String(req.query.input ?? "").trim();
  const sessionToken = String(req.query.sessionToken ?? "").trim();

  if (input.length < 3) {
    return res.json({
      ok: true,
      data: [],
    });
  }

  try {
    const response = await fetch(
      `${GOOGLE_PLACES_BASE_URL}/places:autocomplete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": getApiKey(),
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text",
        },
        body: JSON.stringify({
          input,
          ...(sessionToken ? { sessionToken } : {}),
          regionCode: "MX",
        }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Google Places autocomplete error:", data);

      return res.status(502).json({
        error: "No pudimos buscar lugares",
      });
    }

    const suggestions =
      data.suggestions
        ?.map((suggestion: any) => suggestion.placePrediction)
        .filter(Boolean)
        .map((prediction: any) => ({
          placeId: prediction.placeId,
          text: prediction.text?.text ?? "",
        })) ?? [];

    return res.json({
      ok: true,
      data: suggestions,
    });
  } catch (error) {
    console.error("Error en autocomplete de Places:", error);

    return res.status(500).json({
      error: "No pudimos buscar lugares",
    });
  }
};

export const getPlaceDetails = async (req: AuthRequest, res: Response) => {
  const placeId = String(req.params.placeId ?? "").trim();
  const sessionToken = String(req.query.sessionToken ?? "").trim();

  if (!placeId) {
    return res.status(400).json({
      error: "Place ID requerido",
    });
  }

  try {
    const url = new URL(
      `${GOOGLE_PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}`,
    );

    if (sessionToken) {
      url.searchParams.set("sessionToken", sessionToken);
    }

    const response = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": getApiKey(),
        "X-Goog-FieldMask": "id,displayName,formattedAddress,location",
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Google Places details error:", data);

      return res.status(502).json({
        error: "No pudimos obtener los datos del lugar",
      });
    }

    return res.json({
      ok: true,
      data: {
        placeId: data.id,
        name: data.displayName?.text ?? "",
        address: data.formattedAddress ?? "",
        latitude: data.location?.latitude ?? null,
        longitude: data.location?.longitude ?? null,
      },
    });
  } catch (error) {
    console.error("Error obteniendo detalles de Places:", error);

    return res.status(500).json({
      error: "No pudimos obtener los datos del lugar",
    });
  }
};
