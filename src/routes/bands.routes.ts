import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import {
  getBands,
  createBand,
  joinBand,
  getBandMembers,
  deleteBand,
  leaveBand,
  updateMemberPermissions,
} from "../controllers/bands.controller";

const router = Router();

router.use(authMiddleware);

router.get("/", getBands);
router.post("/", createBand);
router.post("/join", joinBand);
router.get("/:id/members", getBandMembers);
router.patch("/:id/members/:userId/permissions", updateMemberPermissions);
router.delete("/:id/leave", leaveBand);
router.delete("/:id", deleteBand);

export default router;
