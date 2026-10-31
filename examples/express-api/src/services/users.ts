import { formatUser, type User } from "../lib/format.js";

const store: User[] = [
  { id: 1, first: "Ada", last: "Lovelace" },
  { id: 2, first: "Alan", last: "Turing" },
];

export async function listUsers(page: number) {
  const size = 10;
  const start = (page - 1) * size;
  const rows = store.slice(start, start + size);
  if (rows.length === 0) return { page, items: [] };
  return { page, items: rows.map((row) => formatUser(row)) };
}
