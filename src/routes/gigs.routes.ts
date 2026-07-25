import { Router } from "express";
import {
  createGig,
  getGigs,
  updateGig,
  deleteGig,
  setMyEarnings,
  setCollected,
  setAttending,
} from "../controllers/gigs.controller";
import { authMiddleware } from "../middleware/auth";
import { requireActiveSubscription } from "../middleware/requireActiveSubscription";

const router = Router();

router.use(authMiddleware);
router.use(requireActiveSubscription);

router.get("/", getGigs);
router.post("/", createGig);
router.put("/:id/my-earnings", setMyEarnings);
router.put("/:id/collected", setCollected);
router.put("/:id/attending", setAttending);
router.put("/:id", updateGig);
router.delete("/:id", deleteGig);

export default router;
