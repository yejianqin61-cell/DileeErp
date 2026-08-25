import { Badge } from "../ui/badge";
import { displayStatus } from "../../lib/display-text";

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "success" | "warning" | "danger" | "info" }) { return <Badge className={`status-${tone}`}>{displayStatus(label)}</Badge>; }
