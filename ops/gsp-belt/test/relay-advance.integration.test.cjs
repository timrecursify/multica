const assert = require("assert");
const { EventEmitter } = require("events");
const Module = require("module");

process.env.JWT_SECRET = "test-jwt-secret";
process.env.DATABASE_URL = "postgres://test.invalid/multica";
process.env.RELAY_AGENT_SECRET = "test-relay-secret";
process.env.MULTICA_WORKSPACE_ID = "test-workspace";

const issueId = "00000000-0000-4000-8000-000000000085";
const edges = new Map([
  ["Registered", ["Spec"]],
  ["Spec", ["Queue"]],
  ["Queue", ["In Progress"]],
  ["In Progress", ["In Review"]],
  ["In Review", ["CI/CD & Deploy", "Human Review", "Done"]],
  ["Human Review", ["CI/CD & Deploy", "Done"]],
  ["CI/CD & Deploy", ["Done"]],
  ["Done", ["Archived"]],
  ["Archived", []]
]);
let state;
let handler;
let auditEvents = 0;
const http = require("http");
const createServer = http.createServer;
http.createServer = (fn) => {
  handler = fn;
  return { listen() {} };
};
const originalWarn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).includes("relay.advance.rejected")) auditEvents += 1;
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "jsonwebtoken") return { sign: () => "stub", verify: () => ({}) };
  if (request === "pg") return { Client: class {
    async connect() { state.connects += 1; }
    async end() {}
    async query(sql, params = []) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        state.transactions.push(sql);
        return { rows: [] };
      }
      if (sql.includes('FROM "issue"')) {
        state.issueLookups += 1;
        return { rows: [{ id: issueId, status: state.status, workspace_id: "test-workspace" }] };
      }
      if (sql.includes("SELECT stage_name")) return { rows: edges.has(params[0]) ? [{ stage_name: params[0] }] : [] };
      if (sql.includes("SELECT next_stage")) {
        const [next_stage, ...alt_next_stages] = edges.get(state.status);
        return { rows: [{ next_stage, alt_next_stages }] };
      }
      if (sql.includes("FROM relay_stage_config rsc")) return { rows: [{ agent_id: null, agent_name: null }] };
      if (sql.includes('UPDATE "issue"')) {
        state.status = params[0];
        state.updatedAt += 1;
        state.updates += 1;
        return { rows: [{ id: issueId, status: state.status }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  } };
  return originalLoad.call(this, request, parent, isMain);
};
require("./../bridge/multica-bridge.cjs");
Module._load = originalLoad;
http.createServer = createServer;

function reset(status) {
  state = {
    status,
    updatedAt: 1,
    updates: 0,
    connects: 0,
    issueLookups: 0,
    transactions: []
  };
}

function request(to_stage) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/relay/advance";
    req.headers = {};
    const res = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body = "") { this.body = body; resolve(this); } };
    handler(req, res);
    req.emit("data", JSON.stringify({ issue_id: issueId, to_stage, agent_token: "test-relay-secret" }));
    req.emit("end");
  });
}

(async () => {
  for (const [from, targets] of edges) {
    for (const to of targets) {
      reset(from);
      const result = await request(to);
      assert.equal(result.status, 200, `${from} -> ${to} succeeds`);
      assert.equal(state.status, to);
      assert.equal(state.updates, 1);
    }
  }

  // This is deliberately outside the default workflow. Both relay target
  // validation and edge validation must read relay_stage_config rather than a
  // copied stage list.
  edges.set("Queue", ["Post-Deploy Check"]);
  edges.set("Post-Deploy Check", ["Done"]);
  reset("Queue");
  const dynamic = await request("Post-Deploy Check");
  assert.equal(dynamic.status, 200);
  assert.equal(state.status, "Post-Deploy Check");
  edges.set("Queue", ["In Progress"]);
  edges.delete("Post-Deploy Check");

  for (const invalid of ["", "Queue; DROP TABLE issue;--", "Ｑｕｅｕｅ", "🧪", null]) {
    reset("Queue");
    const before = { ...state };
    const result = await request(invalid);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).error, "invalid_to_stage");
    assert.equal(state.status, before.status, `invalid target ${String(invalid)} preserves status`);
    assert.equal(state.updatedAt, before.updatedAt, `invalid target ${String(invalid)} preserves timestamp`);
    assert.equal(state.updates, before.updates, `invalid target ${String(invalid)} performs no update`);
    assert.equal(state.issueLookups, 0, `invalid target ${String(invalid)} performs no issue lookup`);
    assert.deepEqual(
      state.transactions,
      typeof invalid === "string" ? ["BEGIN", "ROLLBACK"] : [],
      `invalid target ${String(invalid)} performs no mutation transaction`
    );
  }

  reset("Queue");
  const illegalBefore = { ...state };
  const illegal = await request("Done");
  assert.equal(illegal.status, 409);
  assert.equal(JSON.parse(illegal.body).error, "invalid_transition");
  assert.equal(state.status, illegalBefore.status);
  assert.equal(state.updatedAt, illegalBefore.updatedAt);
  assert.equal(state.updates, illegalBefore.updates);

  reset("Queue");
  const repeated = await request("Queue");
  assert.equal(repeated.status, 200);
  assert.equal(JSON.parse(repeated.body).transition, "already_applied");
  assert.equal(state.updates, 0);
  assert.equal(state.updatedAt, 1);
  assert(auditEvents >= 6, "each rejected request emits a rejection audit event");
  console.log("relay advance integration tests: ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
