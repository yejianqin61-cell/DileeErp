const { randomUUID } = require("node:crypto");

function createPrisma() {
  const store = { runs: [], events: [], sessions: [] };
  const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    const value = row[key];
    if (expected && typeof expected === "object" && Array.isArray(expected.in)) return expected.in.includes(value);
    if (expected && typeof expected === "object" && expected.gt !== undefined) return value > expected.gt;
    return value === expected;
  });
  store.gapCandidates = [];
  store.gapReports = [];
  const table = (rows, uniqueKeys, defaults) => ({
    findFirst: async ({ where = {} } = {}) => rows.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where = {}, orderBy } = {}) => { const found = rows.filter((row) => matches(row, where)); if (orderBy?.createdAt === "asc") found.sort((a, b) => a.createdAt - b.createdAt); return found; },
    createMany: async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const item of data) {
        const duplicate = rows.some((row) => uniqueKeys.every((key) => row[key] === item[key]));
        if (duplicate && !skipDuplicates) throw new Error("unique violation");
        if (duplicate) continue;
        rows.push({ id: randomUUID(), ...defaults(), ...item, createdAt: new Date() });
        count += 1;
      }
      return { count };
    },
    updateMany: async ({ where = {}, data }) => { const matched = rows.filter((row) => matches(row, where)); for (const row of matched) Object.assign(row, data); return { count: matched.length }; },
  });
  const db = {
    store,
    agentGapCandidate: table(store.gapCandidates, ["nearestOperation", "missing"], () => ({ status: "accumulating", dispatchedAt: null })),
    agentGapReport: table(store.gapReports, ["candidateId", "runId"], () => ({})),
    agentSession: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.sessions.push(row); return row; },
      findMany: async ({ where = {} } = {}) => store.sessions.filter((row) => matches(row, where)),
    },
    agentRun: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.runs.push(row); return row; },
      findFirst: async ({ where = {} } = {}) => store.runs.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} } = {}) => store.runs.filter((row) => matches(row, where)),
      updateMany: async ({ where = {}, data }) => { const matched = store.runs.filter((row) => matches(row, where)); for (const row of matched) Object.assign(row, data, { updatedAt: new Date() }); return { count: matched.length }; },
    },
    agentRunEvent: {
      findMany: async ({ where = {}, orderBy } = {}) => { const rows = store.events.filter((row) => matches(row, where)); if (orderBy?.seq === "asc") rows.sort((a, b) => a.seq - b.seq); if (orderBy?.seq === "desc") rows.sort((a, b) => b.seq - a.seq); return rows; },
      createMany: async ({ data }) => { for (const row of data) store.events.push({ id: randomUUID(), ...row, createdAt: new Date() }); return { count: data.length }; },
    },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

const USER_A = "11111111-1111-4111-8111-111111111111";

function principalFor(accessLevel) {
  return { user: { id: USER_A, username: "worker", display_name: "员工" }, accessLevel };
}

async function createPlanningRun(state, accessLevel, question = "哪些采购到货超期") {
  const session = await state.createSession(USER_A);
  return state.createRun({ sessionId: session.id, userId: USER_A, clientMessageId: "cm-1", question, accessLevel });
}

function roleReaderFor(accessLevel) {
  return { async readActiveRoleKeys() { return accessLevel === "full" ? ["laoban"] : ["qita"]; } };
}

function scriptedProvider(plans) {
  const captured = [];
  const answerInputs = [];
  return {
    captured,
    answerInputs,
    name: "scripted-provider",
    async plan(messages, tools) { captured.push({ messages, tools }); const next = plans[captured.length - 1]; return { toolCalls: next ? next() : [] }; },
    async *streamAnswer(messages) { answerInputs.push(messages); yield { type: "text", text: "ok" }; },
  };
}

module.exports = { createPrisma, principalFor, createPlanningRun, roleReaderFor, scriptedProvider, USER_A };
