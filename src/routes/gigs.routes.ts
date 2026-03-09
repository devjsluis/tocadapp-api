import { Router } from "express";
import {
  createGig,
  getGigs,
  updateGig,
  deleteGig,
} from "../controllers/gigs.controller";

const router = Router();

router.get("/", getGigs);
router.post("/", createGig);
router.put("/:id", updateGig);
router.delete("/:id", deleteGig);

export default router;
