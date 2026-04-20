import { Router } from "express";
import { getExpenses, createExpense, deleteExpense } from "../controllers/expenses.controller";

const router = Router();

router.get("/", getExpenses);
router.post("/", createExpense);
router.delete("/:id", deleteExpense);

export default router;
