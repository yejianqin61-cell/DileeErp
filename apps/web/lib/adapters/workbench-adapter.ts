import { demoOrderProgress, demoProductionProgress, demoReceivablesPayables } from "../demo-data";

export async function getWorkbenchData() {
  return { source: "演示数据" as const, orderProgress: demoOrderProgress, productionProgress: demoProductionProgress, receivablesPayables: demoReceivablesPayables };
}
