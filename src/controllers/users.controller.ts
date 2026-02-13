import { Request, Response } from "express";
import { supabase } from "../lib/supabase";
import bcrypt from "bcrypt";

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
  const { email, name, password } = req.body;

  if (!email || !name || !password) {
    return res.status(400).json({
      error: "El correo, el nombre y la contraseña son campos obligatorios",
    });
  }

  try {
    const { data: existingUser } = await supabase
      .from("users")
      .select("email")
      .eq("email", email)
      .single();

    if (existingUser) {
      return res.status(400).json({
        error: "Este correo electrónico ya está registrado",
      });
    }
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const { data, error } = await supabase
      .from("users")
      .insert([{ email, name, password: hashedPassword }])
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(400).json({ error: "El correo ya existe" });
      }
      return res.status(500).json({ error: error.message });
    }

    const { password: _, ...userWithoutPassword } = data;
    return res.status(201).json(userWithoutPassword);
  } catch (error) {
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};
