import { Router } from "express";
import {
  createUser,
  getUsers,
  loginUser,
  getMe,
  updateMe,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  changePassword,
  deleteAccount,
} from "../controllers/users.controller";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  resendEmailVerification,
  verifyEmail,
} from "../controllers/emailVerification.controller";

const router = Router();

router.get("/me", authMiddleware, getMe);
router.put("/me", authMiddleware, updateMe);
router.delete("/me", authMiddleware, deleteAccount);
router.put("/change-password", authMiddleware, changePassword);
router.get("/", authMiddleware, requireAdmin, getUsers);
router.post("/", createUser);
router.post("/login", loginUser);
router.post("/refresh", refreshAccessToken);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendEmailVerification);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;
