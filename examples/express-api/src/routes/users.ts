import { Router } from "express";
import { listUsers } from "../services/users.js";

export const users = Router();
users.get("/", async (req, res) => {
  const page = Number(req.query.page ?? 1);
  res.json(await listUsers(page));
});
