import { Router } from "express";
import { createGig, getGigs } from "../controllers/gigs.controller";

const router = Router();

router.get("/", getGigs);
router.post("/", createGig);

export default router;
