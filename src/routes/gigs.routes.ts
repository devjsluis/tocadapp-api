import { Router } from "express";
import { getGigs } from "../controllers/gigs.controller";

const router = Router();

router.get("/", getGigs);

export default router;
