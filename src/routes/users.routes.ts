import { Router } from "express";
import {
  createUser,
  getUsers,
  loginUser,
} from "../controllers/users.controller";

const router = Router();

router.get("/", getUsers);
router.post("/", createUser);
router.post("/login", loginUser);

export default router;
