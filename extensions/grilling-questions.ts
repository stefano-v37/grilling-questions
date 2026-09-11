import {
  CustomEditor,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

type Question = {
  label: string;
  text: string;
};

// A question line is just ❓ followed by the Qn label - whatever separator the
// agent chose (dash, comma, colon, bold wrap, "(reopened)") is part of the text,
// not the identity. \b stops Q15 matching inside Q15x.
const QUESTION_LINE = /^\s*❓\s*(?:\*\*)?(Q\d+)\b\s*(.*)$/;

function isRule(line: string): boolean {
  return /^[\s─—–-]+$/.test(line) && line.trim().length >= 3;
}

// Questions are kept exactly as received - the full source line(s) including
// the ❓ emoji and ** markers - so the pane can render them with the same
// markdown styling the transcript uses. `label` is the Qn key used for the
// header and for assembling submitted answers.
export function parseQuestions(text: string): Question[] {
  const questions: Question[] = [];
  let current: Question | undefined;

  for (const line of text.split(/\r?\n/)) {
    const match = QUESTION_LINE.exec(line);
    if (match) {
      if (current) questions.push(current);
      current = { label: match[1]!, text: line.trim() };
      continue;
    }

    if (current && !isRule(line)) {
      current.text += `\n${line}`;
    }
  }

  if (current) questions.push(current);
  return questions
    .map((question) => ({ ...question, text: question.text.trim() }))
    .filter((question) => question.text.length > 0);
}

// Bottom-dock layout: scrollable question pane (left - questions rendered as
// received, transcript markdown styling) beside the editor (right). The editor
// answers one question at a time - a header line above it just names the
// active question (Qn (i/n)); ctrl+shift+←/→ switches questions (the draft is
// stored per question) and scrolls the pane so that question sits on top, last
// one included. Submit assembles all stored answers:
//   Q1: ...
//   Q2: ...
// Narrow terminals fall back to pane stacked above the editor.
const PANE_SHARE = 0.5; // block height = 50% of terminal rows
const MIN_PANE_HEIGHT = 6;
const MIN_COLUMNS_WIDTH = 60;

function padLine(line: string, width: number): string {
  const visible = visibleWidth(line);
  if (visible >= width) return truncateToWidth(line, width, "");
  return line + " ".repeat(width - visible);
}

export class QuestionState {
  questions: Question[] = [];
  answers: string[] = [];
  activeIndex = 0;
  scrollOffset = 0;
  requestRender?: () => void;

  set(questions: Question[]): void {
    this.questions = questions;
    this.answers = questions.map(() => "");
    this.activeIndex = 0;
    this.scrollOffset = 0;
    this.requestRender?.();
  }

  clear(): void {
    this.set([]);
  }
}

export class GrillingEditor extends CustomEditor {
  private readonly questionState: QuestionState;
  private appOnSubmit?: (text: string) => void;
  private paneSource?: Question[];
  private paneWidth?: number;
  private paneLines: string[] = [];
  private paneQuestionStarts: number[] = [];
  private lastLayout?: {
    width: number;
    wide: boolean;
    paneRows: number;
    leftWidth: number;
    headerRows: number;
  };

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    questionState: QuestionState,
  ) {
    super(tui, theme, keybindings);
    this.questionState = questionState;
    questionState.requestRender = () => tui.requestRender();
    // The app assigns onSubmit after the factory returns and calls it from two
    // paths (Enter via Editor.submitValue, alt+enter via handleFollowUp) - an
    // instance accessor wraps both so answers are assembled either way.
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      enumerable: true,
      get: () =>
        this.appOnSubmit ? (text: string) => this.appOnSubmit!(this.assembleAnswers(text)) : undefined,
      set: (fn: ((text: string) => void) | undefined) => {
        this.appOnSubmit = fn;
      },
    });
  }

  private assembleAnswers(activeText: string): string {
    const state = this.questionState;
    if (state.questions.length === 0) return activeText;
    const trimmed = activeText.trim();
    if (trimmed.startsWith("/")) return activeText; // slash command, not an answer
    const answers = [...state.answers];
    answers[state.activeIndex] = trimmed;
    state.answers = state.questions.map(() => ""); // consumed → a re-submit can't resend them
    return state.questions
      .map((question, index) => {
        const raw = answers[index]?.trim();
        if (!raw) return undefined;
        // `*` = "take your ➡️ recommendation" - the agent has its own questions
        // in context, so the label alone tells it which recommendation was meant.
        return `${question.label}: ${raw === "*" ? "recommended" : raw}`;
      })
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  private buildPane(width: number): void {
    if (this.paneSource === this.questionState.questions && this.paneWidth === width) return;

    const contentWidth = Math.max(1, width - 2);
    const markdownTheme = getMarkdownTheme(); // same styling the transcript uses
    const lines: string[] = [];
    const starts: number[] = [];
    for (const question of this.questionState.questions) {
      starts.push(lines.length);
      for (const line of new Markdown(question.text, 0, 0, markdownTheme).render(contentWidth)) {
        lines.push(line);
      }
      lines.push("");
    }
    if (lines.length > 0) lines.pop(); // no separator after the last question

    this.paneSource = this.questionState.questions;
    this.paneWidth = width;
    this.paneLines = lines;
    this.paneQuestionStarts = starts;
  }

  invalidate(): void {
    this.paneSource = undefined;
    super.invalidate();
  }

  private contentHeight(): number {
    return Math.max(1, Math.max(MIN_PANE_HEIGHT, Math.floor(this.tui.terminal.rows * PANE_SHARE)) - 2);
  }

  private maxScroll(): number {
    // Virtual padding below the content so the last question can also align to
    // the pane top, like every other question.
    const lastStart = this.paneQuestionStarts[this.paneQuestionStarts.length - 1] ?? 0;
    return Math.max(0, Math.max(this.paneLines.length, lastStart + this.contentHeight()) - this.contentHeight());
  }

  private clampScroll(offset: number): number {
    return Math.max(0, Math.min(this.maxScroll(), offset));
  }

  private scrollBy(delta: number): void {
    const next = this.clampScroll(this.questionState.scrollOffset + delta);
    if (next === this.questionState.scrollOffset) return;
    this.questionState.scrollOffset = next;
    this.tui.requestRender();
  }

  private navigateQuestion(direction: -1 | 1): void {
    const state = this.questionState;
    const next = state.activeIndex + direction;
    if (state.questions.length === 0 || next < 0 || next >= state.questions.length) return;
    state.answers[state.activeIndex] = this.getText();
    state.activeIndex = next;
    this.setText(state.answers[next] ?? "");
    this.buildPane(this.lastLayout?.leftWidth ?? MIN_COLUMNS_WIDTH);
    state.scrollOffset = this.clampScroll(this.paneQuestionStarts[next] ?? 0);
    this.tui.requestRender();
  }

  private scrollBorder(direction: "↑" | "↓", hidden: number, width: number): string {
    if (hidden <= 0) return "─".repeat(Math.max(0, width));
    const label = ` ${direction} ${hidden} more `;
    const labelWidth = visibleWidth(label);
    if (labelWidth + 2 <= width) {
      const leftWidth = Math.floor((width - labelWidth) / 2);
      return "─".repeat(leftWidth) + label + "─".repeat(width - leftWidth - labelWidth);
    }
    return "─".repeat(Math.max(0, width)); // ponytail: skip tiny-width ellipsis fallback, plain dashes if label can't fit
  }

  private headerLine(): string | undefined {
    const state = this.questionState;
    const question = state.questions[state.activeIndex];
    if (!question) return undefined;
    const nav = state.questions.length > 1 ? ` (${state.activeIndex + 1}/${state.questions.length})` : "";
    return ` ${this.theme.borderColor(`${question.label}${nav}`)}`;
  }

  private renderPane(width: number, height: number): string[] {
    this.buildPane(width);
    const contentHeight = Math.max(1, height - 2);
    const offset = this.clampScroll(this.questionState.scrollOffset);
    this.questionState.scrollOffset = offset;

    const visible: string[] = [];
    for (let index = 0; index < contentHeight; index++) visible.push(this.paneLines[offset + index] ?? "");

    const lines = [this.theme.borderColor(this.scrollBorder("↑", offset, width))];
    for (const line of visible) lines.push(padLine(` ${line}`, width));
    lines.push(
      this.theme.borderColor(
        this.scrollBorder("↓", Math.max(0, this.paneLines.length - offset - visible.length), width),
      ),
    );
    return lines;
  }

  render(width: number): string[] {
    const paneHeight = Math.max(MIN_PANE_HEIGHT, Math.floor(this.tui.terminal.rows * PANE_SHARE));

    if (this.questionState.questions.length === 0) return super.render(width);

    if (width < MIN_COLUMNS_WIDTH) {
      // Narrow fallback: full-width pane above the editor.
      const header = this.headerLine();
      const editorLines = super.render(width);
      if (header) editorLines.unshift(padLine(header, width));
      const blockHeight = Math.max(paneHeight, editorLines.length);
      this.lastLayout = {
        width,
        wide: false,
        paneRows: blockHeight,
        leftWidth: width,
        headerRows: header ? 1 : 0,
      };
      return [...this.renderPane(width, blockHeight), ...editorLines];
    }

    const leftWidth = Math.floor(width / 2);
    const rightWidth = width - leftWidth;
    const header = this.headerLine();
    const editorLines = super.render(rightWidth);
    if (header) editorLines.unshift(padLine(header, rightWidth));
    const blockHeight = Math.max(paneHeight, editorLines.length);

    if (!this.isShowingAutocomplete() && editorLines.length < blockHeight) {
      // Stretch the editor box: blanks go inside, above its bottom border.
      const pad = blockHeight - editorLines.length;
      editorLines.splice(editorLines.length - 1, 0, ...new Array<string>(pad).fill(""));
    } else {
      while (editorLines.length < blockHeight) editorLines.push("");
    }

    const pane = this.renderPane(leftWidth, blockHeight);
    const lines: string[] = [];
    for (let row = 0; row < blockHeight; row++) {
      lines.push(padLine(pane[row] ?? "", leftWidth) + padLine(editorLines[row] ?? "", rightWidth));
    }
    this.lastLayout = { width, wide: true, paneRows: blockHeight, leftWidth, headerRows: header ? 1 : 0 };
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "shift+up")) return this.scrollBy(-1);
    if (matchesKey(data, "shift+down")) return this.scrollBy(1);
    if (matchesKey(data, "shift+pageup")) return this.scrollBy(-this.contentHeight());
    if (matchesKey(data, "shift+pagedown")) return this.scrollBy(this.contentHeight());
    if (matchesKey(data, "ctrl+shift+left")) return this.navigateQuestion(-1);
    if (matchesKey(data, "ctrl+shift+right")) return this.navigateQuestion(1);
    super.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent) {
    if (this.questionState.questions.length === 0) return super.handleMouse(event);

    const layout = this.lastLayout?.width === event.width ? this.lastLayout : undefined;
    if (!layout) return super.handleMouse(event);

    if (layout.wide) {
      if (event.x < layout.leftWidth) {
        if (event.type === "wheel") {
          const before = this.questionState.scrollOffset;
          this.scrollBy(event.wheelDelta ?? 0);
          // Unscrollable pane: let the wheel fall through to the transcript scroll.
          return before === this.questionState.scrollOffset ? undefined : { handled: true };
        }
        return { handled: true };
      }
      return super.handleMouse({
        ...event,
        x: event.x - layout.leftWidth,
        y: event.y - layout.headerRows,
        width: event.width - layout.leftWidth,
      });
    }

    if (event.y < layout.paneRows) {
      if (event.type === "wheel") {
        const before = this.questionState.scrollOffset;
        this.scrollBy(event.wheelDelta ?? 0);
        return before === this.questionState.scrollOffset ? undefined : { handled: true };
      }
      return { handled: true };
    }
    return super.handleMouse({
      ...event,
      y: event.y - layout.paneRows - layout.headerRows,
      height: Math.max(1, event.height - layout.paneRows - layout.headerRows),
    });
  }
}

function messageText(message: MessageEndEvent["message"]): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function lastAssistantQuestions(ctx: ExtensionContext): Question[] {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    return parseQuestions(messageText(entry.message as MessageEndEvent["message"]));
  }
  return [];
}

export default function grillingQuestions(pi: ExtensionAPI) {
  const state = new QuestionState();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    state.set(lastAssistantQuestions(ctx));
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new GrillingEditor(tui, theme, keybindings, state),
    );
  });

  pi.on("before_agent_start", () => {
    state.clear(); // answers submitted → collapse the two-column view immediately
  });

  pi.on("message_end", (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    state.set(parseQuestions(messageText(event.message))); // no questions → pane gone, plain editor
  });

  pi.on("session_shutdown", () => {
    state.requestRender = undefined;
    state.clear();
  });
}
