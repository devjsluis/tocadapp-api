import { Router } from "express";
import {
  createUser,
  getUsers,
  loginUser,
  getMe,
  updateMe,
  forgotPassword,
  resetPassword,
} from "../controllers/users.controller";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireAdmin";

const router = Router();

router.get("/me", authMiddleware, getMe);
router.put("/me", authMiddleware, updateMe);
router.get("/", authMiddleware, requireAdmin, getUsers);
router.post("/", createUser);
router.post("/login", loginUser);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;
