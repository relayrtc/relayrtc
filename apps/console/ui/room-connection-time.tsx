import { formatConnectionTime } from "@/lib/rooms";

export function RoomConnectionTime({ value }: { value: string | null }) {
  if (!value) return <span className="connection-ongoing">—</span>;
  const { date, time } = formatConnectionTime(value);
  return <time className="connection-timestamp" dateTime={value} title={`${date}, ${time} · Casablanca`}><span>{date}</span><span>{time}</span></time>;
}
