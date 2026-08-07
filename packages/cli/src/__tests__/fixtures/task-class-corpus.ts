/**
 * Labelled corpus for the task-class classifier (spec §5.8).
 *
 * GENERATED, never captured. A real corpus would be the developer's own
 * `~/.claude` store, whose transcript paths are `~/repos/<customer>/…` and
 * whose prompts are stored verbatim — committing that to a public repository
 * would be a confidentiality incident. Every path and identifier below is
 * neutral by construction.
 *
 * ── How the labels are honest ────────────────────────────────────────────────
 *
 * Each recipe is a PROSE DESCRIPTION of what a developer did, turned into a
 * plausible tool/file/error trace with seeded noise. The label is the recipe's
 * identity; the classifier sees only the derived signals. The recipes were
 * written from the class narratives in spec §5.4 — deliberately NOT from the
 * threshold table in §5.7 — so agreement is a measurement rather than a
 * restatement of the rules.
 *
 * That is the strongest ground truth available under the confidentiality
 * constraint, and it is weaker than human labels on real sessions in one
 * specific way: recipe authorship and rule authorship share an author. The
 * spec says so, and so does anything that quotes the resulting number.
 *
 * Two recipes are labelled AMBIGUOUS on purpose. A classifier that scores well
 * on the decidable ones while confidently labelling these has failed, not
 * passed — which is why abstention is measured separately.
 */
import type { TaskClass } from "@claude-stats/core/types/insight";
import type { TaskClassMessage } from "@claude-stats/core/taskClass";
import { seededRandom } from "./synthetic.js";

/** Neutral file pools. No customer names, no real repository layout. */
const CODE_FILES = [
  "/w/alpha/src/order.ts", "/w/alpha/src/cart.ts", "/w/alpha/src/user.ts",
  "/w/alpha/src/api/client.ts", "/w/alpha/src/api/routes.ts", "/w/alpha/src/util/date.ts",
  "/w/alpha/src/util/money.ts", "/w/alpha/src/store/index.ts", "/w/alpha/src/view/list.ts",
  "/w/alpha/src/view/detail.ts",
] as const;

const CONFIG_FILES = [
  "/w/alpha/package.json", "/w/alpha/tsconfig.json", "/w/alpha/.github/workflows/ci.yml",
  "/w/alpha/Dockerfile", "/w/alpha/.eslintrc", "/w/alpha/terraform/main.tf",
  "/w/alpha/package-lock.json", "/w/alpha/.npmrc",
] as const;

const PROSE_FILES = [
  "/w/alpha/README.md", "/w/alpha/doc/design.md", "/w/alpha/doc/api.md",
  "/w/alpha/CHANGELOG.md", "/w/alpha/doc/faq.md",
] as const;

/** A tool call paired with the file it touched (null for tools with no file). */
interface Call {
  tool: string;
  file: string | null;
  error?: boolean;
}

/**
 * What the classifier is being asked to recover. `expect` is the fine class the
 * recipe's behaviour should produce; `"ambiguous"` means the correct answer is
 * an abstention.
 */
export type RecipeLabel = Exclude<TaskClass, "review" | "unknown"> | "ambiguous";

export interface Recipe {
  readonly id: string;
  /** The behaviour, in prose. This is what the trace generator implements. */
  readonly narrative: string;
  readonly expect: RecipeLabel;
  readonly build: (rand: () => number) => Call[];
}

/** Pick `k` distinct members of `pool`, seeded. */
function pick<T>(pool: readonly T[], k: number, rand: () => number): T[] {
  const idx = new Set<number>();
  const want = Math.min(k, pool.length);
  let guard = 0;
  while (idx.size < want && guard < 200) {
    idx.add(Math.floor(rand() * pool.length));
    guard++;
  }
  return [...idx].map((i) => pool[i]!);
}

/** An integer in [lo, hi], seeded. */
function between(lo: number, hi: number, rand: () => number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

// ─── The recipes ─────────────────────────────────────────────────────────────

export const RECIPES: readonly Recipe[] = [
  {
    id: "failing-test",
    narrative:
      "A test is failing. The developer runs it, reads the file it points at, " +
      "greps for the symbol, runs it again, tries a small fix, runs it again. " +
      "Several of those runs come back red.",
    expect: "debug",
    build: (rand) => {
      const target = pick(CODE_FILES, 2, rand);
      const calls: Call[] = [];
      const rounds = between(3, 5, rand);
      for (let i = 0; i < rounds; i++) {
        calls.push({ tool: "Bash", file: null, error: i < rounds - 1 });
        calls.push({ tool: "Read", file: target[0]! });
        if (rand() < 0.5) calls.push({ tool: "Grep", file: null });
      }
      calls.push({ tool: "Edit", file: target[0]! });
      calls.push({ tool: "Bash", file: null });
      return calls;
    },
  },
  {
    id: "stack-trace-hunt",
    narrative:
      "A production stack trace. The developer reads the two files it names, " +
      "greps for the message, and repeatedly runs a reproduction script that " +
      "keeps erroring, without changing anything.",
    expect: "debug",
    build: (rand) => {
      const target = pick(CODE_FILES, 2, rand);
      const calls: Call[] = [
        { tool: "Read", file: target[0]! },
        { tool: "Read", file: target[1]! },
        { tool: "Grep", file: null },
      ];
      const runs = between(4, 7, rand);
      for (let i = 0; i < runs; i++) calls.push({ tool: "Bash", file: null, error: rand() < 0.6 });
      return calls;
    },
  },
  {
    id: "build-babysitting",
    narrative:
      "The developer is checking whether the build and the linters are clean. " +
      "Almost every call is a shell command; nothing is edited.",
    expect: "debug",
    build: (rand) => {
      const calls: Call[] = [];
      const runs = between(8, 14, rand);
      for (let i = 0; i < runs; i++) calls.push({ tool: "Bash", file: null });
      if (rand() < 0.5) calls.push({ tool: "Read", file: pick(CODE_FILES, 1, rand)[0]! });
      return calls;
    },
  },
  {
    id: "new-module",
    narrative:
      "A new feature module from scratch: the developer writes several new " +
      "files, glancing at one existing file for the house style.",
    expect: "greenfield",
    build: (rand) => {
      const files = pick(CODE_FILES, between(3, 5, rand), rand);
      const calls: Call[] = [{ tool: "Read", file: pick(CODE_FILES, 1, rand)[0]! }];
      for (const f of files) calls.push({ tool: "Write", file: f });
      if (rand() < 0.5) calls.push({ tool: "Edit", file: files[0]! });
      calls.push({ tool: "Bash", file: null });
      return calls;
    },
  },
  {
    id: "scaffold-with-tests",
    narrative:
      "Scaffolding a component and its test file, then running the suite once. " +
      "Two new files, one small follow-up tweak.",
    expect: "greenfield",
    build: (rand) => {
      const files = pick(CODE_FILES, 2, rand);
      const calls: Call[] = [
        { tool: "Write", file: files[0]! },
        { tool: "Write", file: files[1]! },
        { tool: "Read", file: files[0]! },
        { tool: "Bash", file: null },
      ];
      if (rand() < 0.4) calls.push({ tool: "Edit", file: files[1]! });
      return calls;
    },
  },
  {
    id: "ci-pipeline-fix",
    narrative:
      "The CI workflow and the Dockerfile need adjusting: the developer edits " +
      "the workflow, the Dockerfile and package.json, and re-runs a check.",
    expect: "config-chore",
    build: (rand) => {
      const files = pick(CONFIG_FILES, between(2, 4, rand), rand);
      const calls: Call[] = [];
      for (const f of files) {
        calls.push({ tool: "Read", file: f });
        calls.push({ tool: "Edit", file: f });
      }
      calls.push({ tool: "Bash", file: null });
      return calls;
    },
  },
  {
    id: "dependency-bump",
    narrative:
      "A dependency bump: package.json and the lockfile change, then install " +
      "and a smoke test run.",
    expect: "config-chore",
    build: (rand) => {
      const calls: Call[] = [
        { tool: "Read", file: "/w/alpha/package.json" },
        { tool: "Edit", file: "/w/alpha/package.json" },
        { tool: "Bash", file: null },
        { tool: "Edit", file: "/w/alpha/package-lock.json" },
      ];
      if (rand() < 0.5) calls.push({ tool: "Edit", file: "/w/alpha/.npmrc" });
      calls.push({ tool: "Bash", file: null });
      return calls;
    },
  },
  {
    id: "rename-sweep",
    narrative:
      "A symbol was renamed. The developer greps for it and edits every call " +
      "site across the codebase, then compiles.",
    expect: "refactor-multi-file",
    build: (rand) => {
      const files = pick(CODE_FILES, between(5, 8, rand), rand);
      const calls: Call[] = [{ tool: "Grep", file: null }];
      for (const f of files) {
        calls.push({ tool: "Read", file: f });
        calls.push({ tool: "Edit", file: f });
      }
      calls.push({ tool: "Bash", file: null });
      return calls;
    },
  },
  {
    id: "cross-module-feature",
    narrative:
      "A feature that cuts across modules: edits in the API layer, the store " +
      "and two views, with a couple of MultiEdits and a build at the end.",
    expect: "refactor-multi-file",
    build: (rand) => {
      const files = pick(CODE_FILES, between(4, 6, rand), rand);
      const calls: Call[] = [];
      for (const f of files) calls.push({ tool: "Read", file: f });
      for (const f of files) calls.push({ tool: rand() < 0.3 ? "MultiEdit" : "Edit", file: f });
      calls.push({ tool: "Bash", file: null });
      return calls;
    },
  },
  {
    id: "codebase-orientation",
    narrative:
      "Getting oriented in an unfamiliar area: a lot of reading and searching, " +
      "no changes at all.",
    expect: "explore",
    build: (rand) => {
      const files = pick(CODE_FILES, between(4, 7, rand), rand);
      const calls: Call[] = [];
      for (const f of files) calls.push({ tool: "Read", file: f });
      const searches = between(2, 5, rand);
      for (let i = 0; i < searches; i++) calls.push({ tool: rand() < 0.5 ? "Grep" : "Glob", file: null });
      return calls;
    },
  },
  {
    id: "diff-review",
    narrative:
      "Reviewing a colleague's change: reading the touched files end to end " +
      "and searching for related usages. Nothing is written.",
    expect: "explore",
    build: (rand) => {
      const files = pick(CODE_FILES, between(3, 5, rand), rand);
      const calls: Call[] = [];
      for (const f of files) {
        calls.push({ tool: "Read", file: f });
        if (rand() < 0.4) calls.push({ tool: "Grep", file: null });
      }
      return calls;
    },
  },

  // ── Deliberately ambiguous: the correct answer is an abstention ─────────────
  {
    id: "one-line-fix",
    narrative:
      "A one-line change to a single file, verified once. Real work, but the " +
      "fixed vocabulary has no member for it — the classifier must abstain " +
      "rather than pick the nearest bucket.",
    expect: "ambiguous",
    build: (rand) => {
      const f = pick(CODE_FILES, 1, rand)[0]!;
      return [
        { tool: "Read", file: f },
        { tool: "Edit", file: f },
        { tool: "Bash", file: null },
      ];
    },
  },
  {
    id: "focused-fix-wide-read",
    narrative:
      "A one-file fix that needed wide reading first: the developer reads eight " +
      "files across the codebase to understand the interaction, then edits a " +
      "single file several times and runs the tests. Broad attention, narrow " +
      "change — the class vocabulary has no member for it, so the classifier " +
      "must abstain. This recipe exists because an earlier version of the rules " +
      "keyed the sweep on files SEEN rather than files CHANGED and reported " +
      "exactly this shape as a multi-file refactor.",
    expect: "ambiguous",
    build: (rand) => {
      const read = pick(CODE_FILES, between(6, 9, rand), rand);
      const target = read[0]!;
      const calls: Call[] = [{ tool: "Grep", file: null }];
      for (const f of read) calls.push({ tool: "Read", file: f });
      const edits = between(5, 7, rand);
      for (let i = 0; i < edits; i++) calls.push({ tool: "Edit", file: target });
      calls.push({ tool: "Bash", file: null });
      return calls;
    },
  },
  {
    id: "docs-sweep",
    narrative:
      "A documentation pass across the README and several doc pages. Broad and " +
      "multi-file, but not code — reporting it as a refactor would contaminate " +
      "the class most likely to be quoted in a tier argument.",
    expect: "ambiguous",
    build: (rand) => {
      const files = pick(PROSE_FILES, between(3, 5, rand), rand);
      const calls: Call[] = [];
      for (const f of files) {
        calls.push({ tool: "Read", file: f });
        calls.push({ tool: "Edit", file: f });
      }
      return calls;
    },
  },
];

export interface LabelledSession {
  readonly recipeId: string;
  readonly expect: RecipeLabel;
  readonly messages: readonly TaskClassMessage[];
}

/**
 * Fold a flat call list into messages, so the classifier sees the same shape a
 * real session produces (several tool calls per assistant message) rather than
 * a pre-digested feature vector.
 */
function toMessages(calls: readonly Call[], rand: () => number): TaskClassMessage[] {
  const messages: TaskClassMessage[] = [];
  let i = 0;
  let first = true;
  while (i < calls.length) {
    const width = between(1, 3, rand);
    const slice = calls.slice(i, i + width);
    messages.push({
      tools: slice.map((c) => c.tool),
      filePaths: slice.map((c) => c.file).filter((f): f is string => f !== null),
      toolErrorCount: slice.filter((c) => c.error).length,
      isTurnStart: first,
    });
    first = false;
    i += width;
  }
  return messages;
}

/**
 * Build the corpus: `perRecipe` sessions per recipe, seeded and therefore
 * byte-identical across runs.
 */
export function buildTaskClassCorpus(perRecipe = 20, seed = 20260807): LabelledSession[] {
  const rand = seededRandom(seed);
  const out: LabelledSession[] = [];
  for (const recipe of RECIPES) {
    for (let i = 0; i < perRecipe; i++) {
      out.push({
        recipeId: recipe.id,
        expect: recipe.expect,
        messages: toMessages(recipe.build(rand), rand),
      });
    }
  }
  return out;
}
