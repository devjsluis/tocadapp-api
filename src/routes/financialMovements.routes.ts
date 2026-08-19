import { Router } from "express";

import {
  createFinancialMovement,
  deleteFinancialMovement,
  getFinancialMovements,
  updateFinancialMovement,
} from "../controllers/financialMovements.controller";

const router = Router();

router.get("/", getFinancialMovements);
router.post("/", createFinancialMovement);
router.put("/:id", updateFinancialMovement);
router.delete("/:id", deleteFinancialMovement);

export default router;
