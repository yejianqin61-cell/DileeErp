export type Alert = { source_type: string; source_id: string; alert_type: string; order_no: string | null; severity: "high" | "medium" | "low"; title: string; suggestion: string; status: string; created_at: Date };

export function deduplicateAlerts(rows: Alert[]) { const map = new Map<string, Alert>(); for (const row of rows) { const key = `${row.source_type}:${row.source_id}:${row.alert_type}`; if (!map.has(key)) map.set(key, row); } return [...map.values()].sort((a, b) => (a.severity === "high" ? -1 : b.severity === "high" ? 1 : b.created_at.valueOf() - a.created_at.valueOf())); }
