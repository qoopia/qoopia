# Qoopia Use Cases

> Real scenarios for developers and AI engineers building agent systems.

---

## 1. Multi-Agent Handoff: Context Doesn't Die at the Boundary

**Problem:** Agent A researches a lead and enriches a contact. Agent B picks up the deal an hour later — starting blind. There's no shared state, so Agent B re-asks questions, re-runs searches, and corrupts data with stale overwrites.

**Solution:** Qoopia is the shared memory layer. Agent A writes context as it works. Agent B calls `brief` on startup and gets the full picture — tasks, deals, contacts, activity — without any explicit handoff protocol between agents.

**Example:**

```js
// Agent A (research agent) — enriches a lead
await mcp.call("note", {
  text: "Spoke with Sarah at Acme Corp. She's the CTO, budget confirmed at $50k, wants a demo next week."
});
// Qoopia: matched contact "Sarah @ Acme", matched deal "Acme Corp Pilot"
// Updated deal stage: prospecting → qualified. Logged activity.

// --- Agent B (sales agent) starts a new session ---

// Agent B calls brief on the deal before doing anything
const context = await mcp.call("brief", { entity: "deal", id: "deal_acme_01" });
// Returns: stage=qualified, budget=$50k, contact=Sarah/CTO,
//          last activity="spoke with Sarah, wants demo next week" (2h ago, by agent-a)

// Agent B proceeds with full context. No re-research needed.
await mcp.call("note", {
  text: "Scheduled demo with Sarah for March 5th at 2pm"
});
// Qoopia: deal stage → demo_scheduled, task created "Prepare Acme demo"
```

No message passing between agents. No shared prompt context. Just a shared database both can read and write.

---

## 2. Cross-Session Memory: The Agent That Remembers

**Problem:** Every new session is a blank slate. Users re-explain their preferences, ongoing work, and history. Agents repeat completed tasks, miss context that was discussed last week, and can't learn from prior interactions without it being re-injected into the prompt.

**Solution:** Agents call `recall` at session start to surface relevant context, and `note` as they work to persist new state. Qoopia stores everything with semantic search — so "what were we discussing about the API redesign?" works even if the exact words weren't used.

**Example:**

```js
// Session starts — agent recalls recent context
const memory = await mcp.call("recall", {
  query: "API redesign discussion",
  limit: 5
});
// Returns: notes from 3 sessions ago, linked task "Redesign auth endpoints",
//          contact "Ben (eng lead)", status: in_progress, last updated 4 days ago

// Agent resumes work naturally
await mcp.call("note", {
  text: "Decided to go with JWT refresh tokens instead of session cookies — Ben confirmed this."
});
// Qoopia: new note linked to task "Redesign auth endpoints",
//         activity logged: decision recorded

// Next session: recall returns this decision immediately.
// The agent never asks Ben again.
```

Semantic search (Voyage embeddings) means queries match by meaning, not just keywords. Degrades gracefully to FTS5 without an API key.

---

## 3. Activity Audit Trail: What Did the Agents Actually Do?

**Problem:** You have 4 agents running in parallel. Something broke in production. You need to know which agent made which change, in what order, and what the data looked like before. Without structured logging baked into the agent layer, you're digging through scattered logs trying to reconstruct a timeline.

**Solution:** Qoopia logs every agent action automatically — who, what, when, before/after state. The activity log is append-only, queryable, and includes diffs. Even agents that don't call Qoopia directly can be observed via webhook (`/api/v1/observe`).

**Example:**

```bash
# Query activity for a specific deal in the last 24h
GET /api/v1/activities?entity=deal&entity_id=deal_acme_01&since=2024-01-15T00:00:00Z

# Response
[
  { "ts": "2024-01-15T09:12:44Z", "actor": "agent-research", "action": "update",
    "entity": "deal", "diff": { "stage": ["prospecting", "qualified"] } },
  { "ts": "2024-01-15T11:30:02Z", "actor": "agent-sales", "action": "update",
    "entity": "deal", "diff": { "stage": ["qualified", "demo_scheduled"] } },
  { "ts": "2024-01-15T14:05:18Z", "actor": "agent-ops", "action": "note",
    "entity": "deal", "text": "Scheduled demo for March 5th" }
]
```

Full timeline, no reconstruction needed. Agents registered with `qoopia agent add` — every API key is attributed. Agents on external platforms log via `/api/v1/observe` webhook.

---

## 4. Deal Pipeline Tracking: Agents as Sales Infrastructure

**Problem:** You're running outbound with AI agents — research, enrichment, outreach, follow-up. Each agent writes results to its own format (JSON files, markdown, memory arrays). When a deal moves stages, someone has to manually reconcile everything. There's no single source of truth for the pipeline.

**Solution:** Qoopia's deal module gives agents a shared pipeline with stages, contacts, values, and history. Agents update deals directly via MCP tools or REST. The `note` tool handles natural language updates without knowing the deal ID or stage enum.

**Example:**

```js
// Agent creates a deal
const deal = await mcp.call("createDeal", {
  title: "Acme Corp - API Integration",
  stage: "prospecting",
  value: 50000,
  contact_id: "c_sarah_acme"
});

// Research agent enriches it
await mcp.call("note", {
  text: "Acme confirmed they're evaluating 3 vendors. Decision by end of Q1. Sarah has budget authority."
});
// Auto-matched to deal, note attached, activity logged.

// Follow-up agent checks what's open
const openDeals = await mcp.call("listDeals", { stage: "qualified" });
// Returns: all qualified deals with last activity, contacts, and open tasks per deal

// Outreach agent moves the deal forward
await mcp.call("updateDeal", {
  id: deal.id,
  stage: "proposal_sent",
  notes: "Sent proposal v2 with custom pricing tier"
});
```

Pipeline state lives in Qoopia, not in agent memory or prompts. Any agent can pick up any deal.

---

## 5. Agent Onboarding: `brief` as a Boot Sequence

**Problem:** You add a new specialized agent to your system — a billing agent, a customer success agent, a code review agent. Before it can do anything useful, it needs context: open tasks, active deals, recent decisions, key contacts. Right now that means writing custom onboarding prompts, injecting context manually, or accepting that the new agent will be useless for the first few interactions.

**Solution:** The `brief` tool returns a structured summary of what's relevant to an agent's role. One call at session start gives the agent what it needs to operate immediately — without the human having to re-explain anything.

**Example:**

```js
// New billing agent starts — calls brief with its scope
const onboarding = await mcp.call("brief", {
  scope: ["finance", "deals", "tasks"],
  filter: { assignee: "agent-billing", status: "open" }
});

// Returns:
// - 3 open invoices (IDs, amounts, due dates, linked contacts)
// - 2 deals in "invoice_sent" stage awaiting payment
// - 1 overdue task: "Follow up on Acme invoice #INV-042"
// - Recent activity: "agent-sales noted Acme asked for 30-day terms (3 days ago)"

// Agent immediately knows what to work on — no warm-up needed
await mcp.call("note", {
  text: "Called Acme AR department. Confirmed payment processing, ETA 5 business days."
});
// Linked to deal + invoice + contact automatically.
```

`brief` is designed as a boot sequence. Call it once, get oriented, start working. Each agent gets exactly what it needs based on its API key scope.

---

## 6. Natural Language Task Updates: Stop Writing Plumbing Code

**Problem:** Your agent completes a task and needs to record the result. The standard approach: call `GET /tasks?title=...` to find the task ID, call `PATCH /tasks/{id}` with the new status, call `POST /activities` to log it. Three API calls, explicit IDs, and status enums your agent has to know. This is boilerplate you write over and over.

**Solution:** The `note` tool takes one natural language string and does all three in one call. Qoopia uses LLM matching (Claude Haiku) or keyword fallback to find the relevant task, updates it, and logs the activity. No task IDs. No status enums. No plumbing.

**Example:**

```js
// Without Qoopia (what you write today):
const tasks = await fetch("/api/tasks?title=Fix login 500").then(r => r.json());
const taskId = tasks[0].id;
await fetch(`/api/tasks/${taskId}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "done" })
});
await fetch("/api/activities", {
  method: "POST",
  body: JSON.stringify({ entity: "task", entity_id: taskId,
    action: "update", actor: "agent-backend" })
});

// With Qoopia (one MCP tool call):
await mcp.call("note", {
  text: "Fixed the login bug — was a missing null check in auth middleware. Pushed to main."
});

// Qoopia output:
// matched: { task: "Fix login page 500 error", confidence: "high" }
// status: open → done
// activity logged: { actor: "agent-backend", ts: "...", text: "Fixed login bug..." }
```

The matching works without an LLM — FTS5 handles the common case. With `ANTHROPIC_API_KEY` set, matching accuracy improves significantly on ambiguous inputs.

---

## Summary

| Use Case | Key Tool(s) | What It Solves |
|---|---|---|
| Multi-agent handoff | `brief`, `note` | Shared context without message passing |
| Cross-session memory | `recall`, `note` | Persistent state across sessions |
| Activity audit trail | auto-logging, `/activities` | Who did what, when, with diffs |
| Deal pipeline | `createDeal`, `updateDeal`, `note` | Shared pipeline for parallel agents |
| Agent onboarding | `brief` | Boot sequence for new agents |
| NL task updates | `note` | One call replaces three API calls |

Qoopia runs as a single SQLite file, zero external dependencies (LLM and embeddings are optional). Deploy it anywhere you run Node.
