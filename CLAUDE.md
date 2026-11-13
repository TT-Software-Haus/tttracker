# Working on this repo

Hearth Tracker — a Hearthstone Battlegrounds tracker (Electron + React + TypeScript)
that reads `Power.log` and simulates combats. Developer docs are in
[`docs/`](docs/README.md); read the relevant page before changing a subsystem.

## Plan before you build

For anything bigger than a single-file fix, use the
`milestone-driven-development` skill in `.claude/skills/` and write the plan to
**`PLAN.md`** at the repo root.

1. **Confirm the details with the user first.** Before writing `PLAN.md`, ask about
   anything that would change the shape of the work: scope, which milestones matter,
   constraints, acceptance criteria, anything ambiguous in the request. Ask once, as a
   small set of real questions with a recommended default — don't interrogate, and
   don't guess at a fork you could have just asked about.
2. **Then write `PLAN.md`** — milestones in order, each independently shippable and
   verifiable, with the open questions and risks called out. Follow the skill for how
   to cut and order them.
3. **Get the plan approved before starting work.** Revise on pushback; that's normal.
4. **Ask about the branch before actioning `PLAN.md`.** Once the plan is approved and
   before the first milestone, ask whether the work should go on a separate branch or
   continue on the current one — and if a branch, what to call it. Ask once, then
   carry on; don't re-ask per milestone.
5. **Keep `PLAN.md` current** as milestones land — it's the running record of where
   the work is, not a write-once artifact.

Skip all of this for small, direct tasks (a one-line fix, a question, a typo). The
judgement of "is this big enough to need a plan" is part of the skill.

## One agent unless told otherwise

Work in the main conversation by default. **Do not spawn subagents, parallel agents or
workflows unless the user explicitly asks for them.** This overrides §7 of the
milestone skill: delegation is opt-in here, not a default.

If a task looks like it would genuinely benefit from parallel agents, say so in one
line and let the user decide — don't launch them and report back.

## House rules

- Verify before claiming done: `npm test`, `npm run typecheck`, and for UI changes
  actually run the app (`npm run dev`). "I wrote the code" ≠ "this works".
- **Commit every milestone as soon as it's verified**, then start the next one.
  Approving the plan is the authorisation to commit — don't ask again per milestone
  and don't stop and wait after committing. Order is always verify, *then* commit.
  One commit per milestone, message explaining *why*; never commit half-verified work
  just to keep a cadence.
- Outside a `PLAN.md` milestone, don't commit unless asked. Never push unless asked.
- Match the surrounding style: no new dependencies, no abstractions with one caller.
  Runtime dependencies are kept to the two that have no workable alternative —
  `tesseract.js` (OCR) and `koffi` (native user32 calls) — and each was agreed
  explicitly. Ask before adding another.
- Treat odd-looking existing code as intentional until you've found out why — the log
  parsing and Duos handling in particular encode hard-won quirks of Hearthstone's
  actual log output.
