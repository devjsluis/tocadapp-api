import { Request, Response } from "express";
import { supabase } from "../lib/supabase";

export const getGigs = async (_req: Request, res: Response) => {
  const { data, error } = await supabase.from("gigs").select("*");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({
    ok: true,
    data,
    totals: {
      count: data.length,
    },
  });
};

export const createGig = async (req: Request, res: Response) => {
  const { title, place, date, time, amount, hours, notes } = req.body;

  if (!title || !place || !date || !time || !amount || !hours) {
    return res.status(400).json({
      error: "Missing required fields",
    });
  }

  const { data, error } = await supabase
    .from("gigs")
    .insert([
      {
        title,
        place,
        date,
        time,
        amount,
        hours,
        notes,
      },
    ])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json(data);
};
