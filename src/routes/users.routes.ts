import { Router } from "express";
import {
  createUser,
  getUsers,
  loginUser,
  getMe,
  updateMe,
} from "../controllers/users.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/me", authMiddleware, getMe);
router.put("/me", authMiddleware, updateMe);
router.get("/", getUsers);
router.post("/", createUser);
router.post("/login", loginUser);

export default router;
