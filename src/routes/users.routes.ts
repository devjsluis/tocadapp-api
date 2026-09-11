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
import {
  registerPushToken,
  deletePushToken,
} from "../controllers/pushTokens.controller";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  loginRateLimiter,
  emailActionRateLimiter,
  resetPasswordRateLimiter,
} from "../middleware/authRateLimit";
import {
  resendEmailVerification,
  verifyEmail,
} from "../controllers/emailVerification.controller";

const router = Router();

router.get("/me", authMiddleware, getMe);
router.put("/me", authMiddleware, updateMe);
router.delete("/me", authMiddleware, deleteAccount);
router.put("/change-password", authMiddleware, changePassword);
router.post("/push-token", authMiddleware, registerPushToken);
router.delete("/push-token", authMiddleware, deletePushToken);
router.get("/", authMiddleware, requireAdmin, getUsers);
router.post("/", createUser);
router.post("/login", loginRateLimiter, loginUser);
router.post("/refresh", refreshAccessToken);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", emailActionRateLimiter, resendEmailVerification);
router.post("/forgot-password", emailActionRateLimiter, forgotPassword);
router.post("/reset-password", resetPasswordRateLimiter, resetPassword);

export default router;
