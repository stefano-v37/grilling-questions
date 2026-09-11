// Self-contained check for ../extensions/grilling-questions.ts - run: npm test
// Lives outside extensions/ so pi never auto-loads a module that asserts on import.
import assert from "node:assert";

const { matchesKey, sliceByColumn, visibleWidth } = await import("@earendil-works/pi-tui");
const { default: grillingQuestions, GrillingEditor, QuestionState, parseQuestions } = await import("../extensions/grilling-questions.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme(); // the pane renders questions through the transcript's Markdown component

const SAMPLE = `Intro.

❓ **Q1** - **First**: What is the plan for column widths and heights?

➡️ 50/50 with fallback.

---

❓ **Q2** - **Second**: How should scrolling work exactly, key wise?

➡️ shift keys plus wheel.

---

❓ **Q3** - **Third**: What about narrow terminals and small screens?

➡️ Stacked fallback below 60 columns.`;

// --- parsing: questions kept exactly as received ---
const questions = parseQuestions(SAMPLE);
assert(questions.length === 3, `expected 3 questions, got ${questions.length}`);
assert(questions[0]!.label === "Q1" && questions[0]!.text.startsWith("❓ **Q1** - **First**"), "Q1 parse keeps the received line");
assert(questions[2]!.text.includes("60 columns"), "Q3 parse");

// annotated labels: "Q8 (reopened) - ..." still parses as Q8, bold wrap optional
const reopened = parseQuestions(
  "❓ Q8 (reopened) - What's worth one test file, and what isn't: fleet.ts formatting.\n\n➡️ one file + vitest.",
);
assert(reopened.length === 1 && reopened[0]!.label === "Q8", "reopened label parses, label stays Q8");
assert(reopened[0]!.text.startsWith("❓ Q8 (reopened)"), "reopened question kept as received");
assert(parseQuestions("❓ **Q8 (reopened)** - body").length === 1, "bold-wrapped reopened label parses");

// natural agent phrasing without a dash - comma/colon separators, bare label
const plainly = parseQuestions(
  "❓ Q15, explained plainly: An ADR is one of the short docs in docs/adr/.\n\n➡️ No new ADR.",
);
assert(plainly.length === 1 && plainly[0]!.label === "Q15", "comma separator parses");
assert(plainly[0]!.text.includes("docs/adr/"), "comma question keeps its text");
assert(parseQuestions("❓ Q15: no new ADR?").length === 1, "colon separator parses");
assert(parseQuestions("❓ Q15 no separator at all").length === 1, "bare label parses");
assert(parseQuestions("❓ Q15x is not a label").length === 0, "Q15x does not parse as Q15");

// --- editor plumbing ---
let renders = 0;
const tui: any = { terminal: { rows: 40, columns: 200 }, requestRender: () => renders++ };
const theme: any = { borderColor: (s: string) => s, selectList: {} };
const kb: any = { matches: (data: string, action: string) => action === "tui.input.submit" && data === "\r" };
const state = new QuestionState();
const editor = new GrillingEditor(tui, theme, kb, state);

state.set(questions);
assert(renders === 1, "state.set should request a render");

// --- wide two-column layout at 50% of 40 rows = 20 ---
const W = 120;
const LEFT = 60;
const lines = editor.render(W);
assert(lines.length === 20, `expected 20 rows, got ${lines.length}`);
for (const [i, line] of lines.entries()) {
  assert(visibleWidth(line) === W, `row ${i} not exactly full width: ${visibleWidth(line)}`);
}

const left = (i: number) => sliceByColumn(lines[i]!, 0, LEFT);
const right = (i: number) => sliceByColumn(lines[i]!, LEFT, W - LEFT);

// right column: header names the active question without repeating its text
assert(right(0).includes("Q1") && right(0).includes("1/3"), "header shows active question");
assert(!right(0).includes("❓") && !right(0).includes("First:"), "header is bare Qn, no emoji/question text");
assert(right(1) === "─".repeat(LEFT) && right(19) === "─".repeat(LEFT), "editor borders stretch to block");
// rows 2..18: row 2 is the editor's cursor cell, the rest is blank stretch
for (let i = 3; i < 19; i++) assert(right(i).trim() === "", `editor interior row ${i} should be blank stretch`);

// multi-line question text keeps its line breaks in the left pane
state.set([{ label: "Q1", text: "first line\nsecond line\nthird line" }]);
const paneRows = editor.render(W).map((l) => sliceByColumn(l, 0, LEFT).trim());
const secondRow = paneRows.indexOf("second line");
assert(secondRow > 0 && paneRows[secondRow + 1] === "third line", "multi-line question keeps its line breaks");
state.set(questions); // restore the sample

// question labels visible in left column, in order (skip the header row)
const q1row = lines.findIndex((l, i) => i > 0 && sliceByColumn(l, 0, LEFT).includes("Q1"));
const q2row = lines.findIndex((l, i) => i > 0 && sliceByColumn(l, 0, LEFT).includes("Q2"));
const q3row = lines.findIndex((l, i) => i > 0 && sliceByColumn(l, 0, LEFT).includes("Q3"));
assert(q1row > 0 && q2row > q1row && q3row > q2row, `labels should appear in order, got ${q1row},${q2row},${q3row}`);
assert(left(1).includes("❓ Q1"), "pane shows the question as received (emoji at the start)");

// --- key mappings the feature relies on ---
assert(matchesKey("\x1b[6;2~", "shift+pagedown"), "shift+pagedown encoding");
assert(matchesKey("\x1b[5;2~", "shift+pageup"), "shift+pageup encoding");
assert(matchesKey("\x1b[1;6C", "ctrl+shift+right"), "ctrl+shift+right encoding");
assert(matchesKey("\x1b[1;6D", "ctrl+shift+left"), "ctrl+shift+left encoding");

// First visible question-bearing content row inside the pane (rows between borders).
function firstVisibleQuestion(): string | undefined {
  const rows = editor.render(W);
  const block = Math.max(6, Math.floor(tui.terminal.rows * 0.5));
  for (let i = 1; i < block - 1; i++) {
    const t = sliceByColumn(rows[i]!, 0, LEFT).trim();
    if (t.length > 0 && !t.startsWith("─")) return t;
  }
  return undefined;
}

// --- navigation: ctrl+shift+←/→ switches the active question ---
tui.terminal.rows = 12; // block = 6 rows, content = 4; pane overflows
editor.render(W);

editor.setText("draft for Q1");
editor.handleInput("\x1b[1;6C"); // → Q2
assert(state.activeIndex === 1, "ctrl+shift+right moves to the next question");
assert(editor.getText() === "", "editor swaps to the next question's (empty) answer");
assert(firstVisibleQuestion()!.includes("Q2"), `pane scrolls Q2 to top, got: ${firstVisibleQuestion()}`);

editor.handleInput("\x1b[1;6D"); // → back to Q1
assert(state.activeIndex === 0 && editor.getText() === "draft for Q1", "draft round-trips per question");

// the LAST question aligns to the pane top exactly like the others
state.set([
  { label: "Q1", text: "❓ **Q1** - " + "one ".repeat(30) },
  { label: "Q2", text: "❓ **Q2** - " + "two ".repeat(30) },
  { label: "Q3", text: "❓ **Q3** - " + "three ".repeat(30) },
]);
editor.handleInput("\x1b[1;6C"); // → Q2
editor.handleInput("\x1b[1;6C"); // → Q3
assert(state.activeIndex === 2, "reached the last question");
assert(firstVisibleQuestion()!.includes("Q3"), `last question aligns to top, got: ${firstVisibleQuestion()}`);
const atLast = state.scrollOffset;
editor.handleInput("\x1b[1;6C"); // past the end: no-op
assert(state.activeIndex === 2 && state.scrollOffset === atLast, "ctrl+shift+right at the last question is a no-op");

state.set(questions); // restore the original sample for the tests below
assert(state.activeIndex === 0, "state.set resets the active question");

// shift+pagedown scrolls page-wise, top border shows the ↑ hint
editor.handleInput("\x1b[6;2~");
assert(state.scrollOffset > 0, "shift+pagedown should scroll");
assert(renders > 1, "scroll should request render");
const scrolled = editor.render(W);
assert(sliceByColumn(scrolled[0]!, 0, LEFT).includes("↑"), "top border should show ↑ N more after scroll");

// wheel over the left column scrolls; clamped at the end
editor.handleMouse({ type: "wheel", button: "none", x: 10, y: 5, screenX: 10, screenY: 5, width: W, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: 99 } as any);
const atBottom = state.scrollOffset;
assert(atBottom > 0, "wheel scroll applied");
const last = editor.render(W);
assert(sliceByColumn(last[last.length - 1]!, 0, LEFT).includes("↓") === false, "bottom border shows no ↓ when fully scrolled");

// wheel over the editor column must not touch the pane
const paneOff = state.scrollOffset;
editor.handleMouse({ type: "wheel", button: "none", x: 90, y: 5, screenX: 90, screenY: 5, width: W, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: 5 } as any);
assert(state.scrollOffset === paneOff, "wheel over editor column leaves pane alone");

// --- narrow stacked fallback ---
const narrow = editor.render(50);
assert(narrow.every((l) => visibleWidth(l) <= 50), "narrow rows within width");
assert(narrow.some((l) => l === "─".repeat(50)), "narrow pane border present");
assert(narrow[narrow.length - 1] === "─".repeat(50), "editor bottom border last");

// --- submit assembles the stored answers ---
let submitted: string | undefined;
editor.onSubmit = (text) => {
  submitted = text;
};

editor.setText("50/50 with fallback"); // active question: Q1
editor.handleInput("\x1b[1;6C"); // → Q2, draft stored
assert(editor.getText() === "", "navigating away stores the draft");
editor.setText("shift keys plus wheel");
editor.handleInput("\r"); // submit
assert(
  submitted === "Q1: 50/50 with fallback\nQ2: shift keys plus wheel",
  `answers assembled, got: ${JSON.stringify(submitted)}`,
);
assert(editor.getText() === "", "editor cleared after submit");
assert(state.answers.every((answer) => answer === ""), "stored answers consumed on submit");

// unanswered questions are omitted
state.set(questions);
editor.handleInput("\x1b[1;6C"); // → Q2
editor.setText("only this one");
editor.handleInput("\r");
assert(submitted === "Q2: only this one", `unanswered omitted, got: ${JSON.stringify(submitted)}`);

// `*` means "take your ➡️ recommendation" → submitted as "recommended"
state.set(questions);
editor.setText("*");
editor.handleInput("\r");
assert(submitted === "Q1: recommended", `* rewrites to recommended, got: ${JSON.stringify(submitted)}`);

// slash commands pass through unlabeled
editor.setText("/compact");
editor.handleInput("\r");
assert(submitted === "/compact", `slash command passes through, got: ${JSON.stringify(submitted)}`);

// alt+enter path calls onSubmit directly - must assemble too
state.set(questions);
editor.setText("direct");
editor.onSubmit!(editor.getText().trim());
assert(submitted === "Q1: direct", `direct onSubmit assembles, got: ${JSON.stringify(submitted)}`);

// --- no questions: plain editor ---
state.clear();
const plain = editor.render(W);
assert(plain.length === 3, `plain editor should be natural height, got ${plain.length}`);

// --- hooks: split only while the LATEST assistant message has questions ---
tui.terminal.rows = 40; // reset from the scrolling section above
const handlers = new Map<string, (event: any, ctx: any) => void>();
grillingQuestions({ on: (name: string, fn: (event: any, ctx: any) => void) => handlers.set(name, fn) } as any);

let created: GrillingEditor | undefined;
const hookCtx = (branch: any[]) => ({
  mode: "tui",
  ui: { setEditorComponent: (factory: any) => { created = factory(tui, theme, kb); } },
  sessionManager: { getBranch: () => branch },
});
const asstMsg = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const userMsg = { type: "message", message: { role: "user", content: [{ type: "text", text: "answer" }] } };
const endEvent = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });

// restore: branch ends with a question-less reply after the grilling message → plain editor
handlers.get("session_start")!({}, hookCtx([asstMsg(SAMPLE), userMsg, asstMsg("All answered, moving on.")]));
assert(created!.render(W).length === 3, "pane hidden when last message has no questions");

// restore: branch ends with the grilling message → two columns
handlers.get("session_start")!({}, hookCtx([asstMsg(SAMPLE), userMsg]));
assert(created!.render(W).length === 20, "pane shown when last message has questions");

// live update: pi replies without questions → pane vanishes; with questions → pane returns
handlers.get("message_end")!(endEvent("Great, next round."), hookCtx([]));
assert(created!.render(W).length === 3, "pane vanishes on question-less reply");
handlers.get("message_end")!(endEvent(SAMPLE), hookCtx([]));
assert(created!.render(W).length === 20, "pane returns on grilling reply");

// submitting answers collapses the two-column view immediately, before any reply streams in
handlers.get("before_agent_start")!({}, hookCtx([]));
assert(created!.render(W).length === 3, "pane collapses when answers are submitted");

handlers.get("session_shutdown")!({}, {});

console.log("all checks passed");
