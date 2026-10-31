import { getStats } from "@/lib/stats";

export async function GET() {
  return Response.json(await getStats());
}
