import { Router } from "express";
import {
  getMusicians,
  createMusician,
  deleteMusician,
} from "../controllers/musicians.controller";

const router = Router();

router.get("/", getMusicians);
router.post("/", createMusician);
router.delete("/:id", deleteMusician);

export default router;
