import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import {
  getBands,
  createBand,
  joinBand,
  getMyBandJoinRequests,
  getBandJoinRequests,
  acceptBandJoinRequest,
  rejectBandJoinRequest,
  getBandMembers,
  getMemberPeriods,
  deleteBand,
  leaveBand,
  updateMemberPermissions,
  archiveBand,
  restoreBand,
  updateMemberPeriod,
} from "../controllers/bands.controller";

const router = Router();

router.use(authMiddleware);

router.get("/", getBands);
router.post("/", createBand);
router.post("/join", joinBand);
router.get("/my-join-requests", getMyBandJoinRequests);

router.get("/:id/join-requests", getBandJoinRequests);
router.post(
  "/:id/join-requests/:requestId/accept",
  acceptBandJoinRequest,
);
router.post(
  "/:id/join-requests/:requestId/reject",
  rejectBandJoinRequest,
);

router.get("/:id/members", getBandMembers);
router.get("/:id/members/:userId/periods", getMemberPeriods);
router.patch("/:id/members/:userId/periods/:periodId", updateMemberPeriod);
router.patch("/:id/members/:userId/permissions", updateMemberPermissions);

router.patch("/:id/archive", archiveBand);
router.patch("/:id/restore", restoreBand);

router.delete("/:id/leave", leaveBand);
router.delete("/:id", deleteBand);

export default router;
