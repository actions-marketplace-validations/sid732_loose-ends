import express from "express";
import { routes } from "./routes/index.js";

const app = express();
app.use(express.json());
app.use("/api", routes);

app.listen(Number(process.env.PORT ?? 3000));
