const rate = (runs, judged) => ({ count: runs.filter(judged).length, total: runs.length });
const judgedGap = (record) => record.gap !== null;

function groupMetrics(name, records, questions) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const valid = records.filter((record) => !record.error);
  const ofClass = (className) => valid.filter((record) => byId.get(record.id)?.class === className);
  const gapHits = ofClass("gap").filter(judgedGap);
  const perQuestion = questions
    .map((question) => valid.filter((record) => record.id === question.id))
    .filter((runs) => runs.length > 0);
  const withNearest = valid.filter((record) => judgedGap(record) && byId.get(record.id)?.nearest);
  return {
    recall: rate(ofClass("gap"), judgedGap),
    decoyFp: rate(ofClass("decoy"), judgedGap),
    nodataFp: rate(ofClass("nodata"), judgedGap),
    unstructuredGapRate: rate(ofClass("unstructured"), judgedGap),
    callsBeforeGap: gapHits.length ? gapHits.reduce((sum, record) => sum + record.domainCallsBeforeGap, 0) / gapHits.length : null,
    consistency: rate(perQuestion, (runs) => new Set(runs.map(judgedGap)).size === 1),
    nearestAgree: name === "C" && withNearest.length
      ? rate(withNearest, (record) => record.gap.nearest_operation === byId.get(record.id).nearest)
      : null,
    errors: records.length - valid.length,
  };
}

export function computeMetrics(records, questions) {
  const names = [...new Set(records.map((record) => record.group))].sort();
  return Object.fromEntries(names.map((name) => [name, groupMetrics(name, records.filter((record) => record.group === name), questions)]));
}

const meetsFloor = ({ recall, decoyFp }) => recall.count * 10 >= 8 * recall.total && decoyFp.count * 10 <= decoyFp.total;
const higherByTenPoints = (x, y) => (x.count * y.total - y.count * x.total) * 10 >= x.total * y.total;

export function decide(metricsByGroup) {
  const groups = ["A", "B", "C"].map((name) => metricsByGroup[name]);
  if (groups.some((group) => !group || group.recall.total === 0 || group.decoyFp.total === 0)) return "undecided";
  const [, b, c] = groups;
  const bClearlyBetter = higherByTenPoints(b.recall, c.recall) && higherByTenPoints(c.decoyFp, b.decoyFp);
  if (meetsFloor(c) && !bClearlyBetter) return "adopt_C";
  if (bClearlyBetter) return "reopen_matrix";
  if (!groups.some(meetsFloor)) return "observe_only";
  return "undecided";
}
