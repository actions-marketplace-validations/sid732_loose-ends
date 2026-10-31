import { expect, it } from "vitest";
import { listUsers } from "./users.js";

it("lists the first page", async () => {
  expect((await listUsers(1)).items).toHaveLength(2);
});
