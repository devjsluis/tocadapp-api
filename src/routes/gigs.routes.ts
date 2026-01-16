import { Router } from "express";
import { supabase } from "../lib/supabase";
import { createGig, getGigs } from "../controllers/gigs.controller";

const router = Router();

router.get("/", getGigs);
router.post("/", createGig);

export default router;
