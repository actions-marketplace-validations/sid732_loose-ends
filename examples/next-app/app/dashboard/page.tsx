import { StatCard } from "@/components/stat-card";
import { getStats } from "@/lib/stats";

export default async function Dashboard() {
  const stats = await getStats();
  return (
    <main>
      {stats.map((s) => (
        <StatCard key={s.label} label={s.label} value={s.value} />
      ))}
    </main>
  );
}
