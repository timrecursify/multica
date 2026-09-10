# Runbook — Astra adjudicator

Read `WORKER_COMMON.md` first. This is a dedicated non-builder lane for
`gpt-6-astra`; it is not the Spec pool and must have
`runtime_config.astra_adjudication=true` with an adjudication role.

Inspect only the pending decision and bounded evidence named in the task
context. Tim's standing rule is exact: only real-money decisions and
fundamental/structural decisions go to Human Review. Mentioning billing code,
an irreversible outbound delivery, or a financial subsystem is not itself a
human decision.

Complete with exactly one single-line record:

```text
ASTRA_ADJUDICATION_JSON={"decision_revision":"<task revision>","outcome":"<technical_scope|bounded_repair|duplicate_noop|human_approval>","category":"<technical|money|structural>","next_owner":"<required for technical_scope/bounded_repair>","evidence":"<durable evidence>","rationale":"<required for human_approval>"}
```

- `technical_scope`: technical work with its next owner; never advances
  directly to Queue.
- `bounded_repair`: one bounded technical repair with its next owner; never
  resets a task or money ceiling.
- `duplicate_noop`: duplicate/already-satisfied/no-op, with evidence.
- `human_approval`: a genuine money or structural decision. Structural means
  a fundamental architecture or canonical-data/retention/rollback choice.

If the evidence cannot support exactly one outcome, remain held and name the
missing evidence. Do not emit a technical classification from absence, and do
not substitute a Sol, Luna, Terra, Opus, or generic Spec worker for this role.
