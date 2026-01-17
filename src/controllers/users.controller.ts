import { Request, Response } from "express";
import { supabase } from "../lib/supabase";

export const getUsers = async (_req: Request, res: Response) => {
  const { data, error } = await supabase.from("users").select("*");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({
    data,
    total: data.length,
  });
};

export const createUser = async (req: Request, res: Response) => {
  const { email, name } = req.body;

  if (!email || !name) {
    return res.status(400).json({
      error: "email and name are required",
    });
  }

  const { data, error } = await supabase
    .from("users")
    .insert([{ email, name }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json(data);
};
