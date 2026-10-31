import { Router } from "express";
import { health } from "./health.js";
import { users } from "./users.js";

export const routes = Router();
routes.get("/health", health);
routes.use("/users", users);
