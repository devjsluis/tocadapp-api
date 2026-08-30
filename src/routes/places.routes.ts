import { Router } from "express";

import {
  autocompletePlaces,
  getPlaceDetails,
} from "../controllers/places.controller";
import { authMiddleware } from "../middleware/auth";
import { requireActiveSubscription } from "../middleware/requireActiveSubscription";

const router = Router();

router.use(authMiddleware);
router.use(requireActiveSubscription);

router.get("/autocomplete", autocompletePlaces);
router.get("/:placeId", getPlaceDetails);

export default router;
