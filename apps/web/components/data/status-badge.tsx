import { Badge } from "../ui/badge";

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "success" | "warning" | "danger" | "info" }) { return <Badge className={`status-${tone}`}>{label}</Badge>; }
