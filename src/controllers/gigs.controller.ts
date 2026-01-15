import { Request, Response } from "express";

export const getGigs = (_req: Request, res: Response) => {
  res.json({
    gigs: [],
    message: "List of gigs (mock)",
  });
};
