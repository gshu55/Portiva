import type { IDecoration, IBufferLine, IMarker, Terminal } from "@xterm/xterm";
import type { TerminalColorPalette } from "../../shared/types";
import {
  detectDisplayedFileLanguage,
  inferDisplayedContentLanguage,
  terminalSyntaxSpans,
  type TerminalSyntaxLanguage,
  type TerminalSyntaxTone,
} from "./terminalSyntaxHighlight";

type SemanticTone = "debug" | "error" | "info" | "success" | "warning";
type HighlightTone = SemanticTone | TerminalSyntaxTone;

interface HighlightSpan {
  tone: HighlightTone;
  width: number;
  x: number;
}

interface HighlightedRow {
  decorations: IDecoration[];
  marker: IMarker;
  signature: string;
}

interface SearchableLine {
  cellEnds: number[];
  cellStarts: number[];
  defaultForeground: boolean[];
  signature: string;
  text: string;
}

interface SyntaxRegion {
  inclusive: boolean;
  language: TerminalSyntaxLanguage | null;
  marker: IMarker;
}

const semanticKeywordPattern = /\b(?:critical|fatal|exception|errors?|err|failed|failure|denied|warnings?|warn|caution|deprecated|successful|succeeded|success|completed|complete|passed|ready|ok|info|notice|debug)\b/gi;

export class TerminalSemanticHighlighter {
  private enabled: boolean;
  private frameId: number | null = null;
  private palette: TerminalColorPalette;
  private rows: HighlightedRow[] = [];
  private syntaxRegions: SyntaxRegion[] = [];

  constructor(
    private readonly terminal: Terminal,
    palette: TerminalColorPalette,
    enabled: boolean,
  ) {
    this.palette = palette;
    this.enabled = enabled;
  }

  dispose() {
    if (this.frameId !== null) {
      window.cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.disposeRows();
    this.disposeSyntaxRegions();
  }

  trackCommand(command: string) {
    if (!this.enabled || this.terminal.buffer.active.type !== "normal") {
      return;
    }

    this.syntaxRegions = this.syntaxRegions.filter((region) => !region.marker.isDisposed);
    this.syntaxRegions.push({
      inclusive: false,
      language: detectDisplayedFileLanguage(command),
      marker: this.terminal.registerMarker(0),
    });
    this.schedule();
  }

  schedule() {
    if (!this.enabled || this.frameId !== null) {
      return;
    }

    this.frameId = window.requestAnimationFrame(() => {
      this.frameId = null;
      this.refreshVisibleRows();
    });
  }

  update(palette: TerminalColorPalette, enabled: boolean) {
    this.palette = palette;
    this.enabled = enabled;
    this.disposeRows();
    if (!enabled) {
      this.disposeSyntaxRegions();
    }
    if (enabled) {
      this.schedule();
    }
  }

  private disposeRows() {
    this.rows.forEach(disposeHighlightedRow);
    this.rows = [];
  }

  private disposeSyntaxRegions() {
    this.syntaxRegions.forEach((region) => region.marker.dispose());
    this.syntaxRegions = [];
  }

  private refreshVisibleRows() {
    const buffer = this.terminal.buffer.active;
    if (!this.enabled || buffer.type !== "normal") {
      return;
    }

    this.rows = this.rows.filter((row) => !row.marker.isDisposed);
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + this.terminal.rows);

    for (let row = start; row < end; row += 1) {
      const line = buffer.getLine(row);
      if (line) {
        this.refreshRow(row, line);
      }
    }
  }

  private refreshRow(row: number, line: IBufferLine) {
    const searchable = toSearchableLine(line, this.terminal.cols);
    const syntaxLanguage = this.syntaxLanguageForRow(row, searchable.text);
    const signature = `${searchable.signature}\u0000${syntaxLanguage ?? "plain"}`;
    const existing = this.rows.find((entry) => entry.marker.line === row);
    if (existing?.signature === signature) {
      return;
    }

    if (existing) {
      disposeHighlightedRow(existing);
      this.rows = this.rows.filter((entry) => entry !== existing);
    }

    const spans = [
      ...semanticSpans(searchable),
      ...syntaxHighlightSpans(searchable, syntaxLanguage),
    ];
    if (spans.length === 0) {
      return;
    }

    const buffer = this.terminal.buffer.active;
    const marker = this.terminal.registerMarker(row - (buffer.baseY + buffer.cursorY));
    const decorations = spans.flatMap((span) => {
      const decoration = this.terminal.registerDecoration({
        foregroundColor: highlightColor(this.palette, span.tone),
        layer: "top",
        marker,
        width: span.width,
        x: span.x,
      });
      return decoration ? [decoration] : [];
    });

    if (decorations.length === 0) {
      marker.dispose();
      return;
    }

    this.rows.push({ decorations, marker, signature });
  }

  private syntaxLanguageForRow(row: number, text: string) {
    this.syntaxRegions = this.syntaxRegions.filter((region) => !region.marker.isDisposed);
    this.trackEchoedDisplayCommand(row, text);
    this.syntaxRegions.sort((left, right) => left.marker.line - right.marker.line);

    for (let index = this.syntaxRegions.length - 1; index >= 0; index -= 1) {
      const region = this.syntaxRegions[index];
      const next = this.syntaxRegions[index + 1];
      const beginsAfterRegion = region.inclusive ? row >= region.marker.line : row > region.marker.line;
      if (!beginsAfterRegion || (next && row >= next.marker.line)) {
        continue;
      }
      if (!region.language) {
        region.language = inferDisplayedContentLanguage(text);
        if (region.language) {
          this.schedule();
        }
      }
      return region.language;
    }

    const inferredLanguage = inferDisplayedContentLanguage(text);
    if (inferredLanguage) {
      this.syntaxRegions.push({
        inclusive: true,
        language: inferredLanguage,
        marker: this.registerMarkerAtRow(row),
      });
      return inferredLanguage;
    }
    return null;
  }

  private trackEchoedDisplayCommand(row: number, text: string) {
    const language = detectDisplayedFileLanguage(text);
    if (!language || this.syntaxRegions.some((region) => region.marker.line === row)) {
      return;
    }

    this.syntaxRegions.push({
      inclusive: false,
      language,
      marker: this.registerMarkerAtRow(row),
    });
  }

  private registerMarkerAtRow(row: number) {
    const buffer = this.terminal.buffer.active;
    return this.terminal.registerMarker(row - (buffer.baseY + buffer.cursorY));
  }
}

function disposeHighlightedRow(row: HighlightedRow) {
  row.decorations.forEach((decoration) => decoration.dispose());
  row.marker.dispose();
}

function highlightColor(palette: TerminalColorPalette, tone: HighlightTone) {
  switch (tone) {
    case "error":
      return palette.red;
    case "warning":
      return palette.yellow;
    case "success":
      return palette.green;
    case "info":
      return palette.cyan;
    case "debug":
    case "comment":
      return palette.brightBlack;
    case "command":
    case "property":
      return palette.blue;
    case "keyword":
      return palette.magenta;
    case "number":
      return palette.cyan;
    case "string":
      return palette.green;
    case "variable":
      return palette.yellow;
  }
}

function semanticSpans(line: SearchableLine): HighlightSpan[] {
  semanticKeywordPattern.lastIndex = 0;
  const spans: HighlightSpan[] = [];
  let match: RegExpExecArray | null;

  while ((match = semanticKeywordPattern.exec(line.text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!line.defaultForeground.slice(start, end).every(Boolean)) {
      continue;
    }

    const x = line.cellStarts[start];
    const right = line.cellEnds[end - 1];
    if (x === undefined || right === undefined || right <= x) {
      continue;
    }

    spans.push({ tone: semanticTone(match[0]), width: right - x, x });
  }

  return spans;
}

function syntaxHighlightSpans(line: SearchableLine, language: TerminalSyntaxLanguage | null): HighlightSpan[] {
  if (!language) {
    return [];
  }

  return terminalSyntaxSpans(line.text, language).flatMap((span) => {
    if (!line.defaultForeground.slice(span.start, span.end).every(Boolean)) {
      return [];
    }
    const x = line.cellStarts[span.start];
    const right = line.cellEnds[span.end - 1];
    return x === undefined || right === undefined || right <= x
      ? []
      : [{ tone: span.tone, width: right - x, x }];
  });
}

function semanticTone(keyword: string): SemanticTone {
  const value = keyword.toLowerCase();
  if (/^(?:critical|fatal|exception|errors?|err|failed|failure|denied)$/.test(value)) {
    return "error";
  }
  if (/^(?:warnings?|warn|caution|deprecated)$/.test(value)) {
    return "warning";
  }
  if (/^(?:successful|succeeded|success|completed|complete|passed|ready|ok)$/.test(value)) {
    return "success";
  }
  return value === "debug" ? "debug" : "info";
}

function toSearchableLine(line: IBufferLine, columns: number): SearchableLine {
  const cellEnds: number[] = [];
  const cellStarts: number[] = [];
  const defaultForeground: boolean[] = [];
  let text = "";

  for (let x = 0; x < Math.min(columns, line.length); x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }

    const characters = cell.getChars() || " ";
    for (let index = 0; index < characters.length; index += 1) {
      text += characters[index];
      cellStarts.push(x);
      cellEnds.push(x + cell.getWidth());
      defaultForeground.push(cell.isFgDefault());
    }
  }

  return {
    cellEnds,
    cellStarts,
    defaultForeground,
    signature: `${text}\u0000${defaultForeground.map((value) => value ? "1" : "0").join("")}`,
    text,
  };
}
