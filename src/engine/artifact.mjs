// What an agent working on a run gets on top of a plain conversation: the `artifact` tool, which saves the plan,
// the task list and the walkthrough as reviewable documents with revisions, and the instructions for a run's phases.

export const ARTIFACT_DEF = {
  name: 'artifact',
  description:
    'Save a document for the user to review in this run: the implementation plan, the task list, the walkthrough, or a note. Each call saves a new revision of that document (the earlier ones are kept), so always send the complete document, not a patch. It does not change project files and needs no approval.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['plan', 'tasks', 'walkthrough', 'note'], description: 'plan: what you will change and how you will verify it. tasks: a checklist of the steps, updated as you go. walkthrough: what you changed and the evidence that it works. note: anything else worth keeping.' },
      title: { type: 'string', description: 'A short title (optional).' },
      content: { type: 'string', description: 'The complete document, in Markdown.' },
    },
    required: ['kind', 'content'],
  },
};

const PLAN_PHASE = `You are in the planning phase of this run. Nothing may be changed yet: you have the read-only tools and \`artifact\`.
1. Investigate the code until you know what to change. Read the real files; do not guess.
2. Save the plan with artifact(kind="plan"). Write it for a reviewer: the goal in one or two sentences, the files you will change and what changes in each, anything risky or uncertain, and how you will verify the result (the exact test or check commands).
3. Optionally save a checklist with artifact(kind="tasks").
4. Stop. Reply with a two or three line summary of the plan. The user reviews it, may comment on it, and approves it before you may change anything.
If the task is unclear in a way that changes the plan, ask one clear question instead of saving a plan.`;

const EXECUTE_PHASE = `You are in the execution phase of this run: the plan was approved (or the user chose to skip planning).
- Work only inside the project folder shown above. It is a separate git worktree made for this run, so the user's own checkout is not touched until they apply your changes.
- Do not commit, push, merge or switch branches. ORBIX commits and applies the changes when the user accepts them.
- Follow the approved plan. If you find it has to change in a way the user would care about, say so and save a new revision of the plan.
- Keep the task list current if you saved one: artifact(kind="tasks") with the finished steps checked.
- Verify your work: run the tests or checks the plan named and read their output.
- When you are done, save artifact(kind="walkthrough"): what changed and why, file by file; how you verified it, with the commands and their results; anything left undone or worth a second look. Then reply with a short summary.`;

/** The run section of the system prompt. `phase`: 'plan' or 'execute'. */
export function runPrompt({ phase, branch = '', baseBranch = '' }) {
  const where = branch ? `This run works on the branch ${branch}${baseBranch ? `, cut from ${baseBranch}` : ''}.` : '';
  return `# This conversation is an ORBIX run\nA run takes one task from its description to changes the user has reviewed. ${where}\n\n${phase === 'plan' ? PLAN_PHASE : EXECUTE_PHASE}`;
}
