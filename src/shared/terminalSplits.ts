import type {
  TerminalSplitLayout,
  TerminalSplitOrientation,
  WorkspaceSessionTab,
  WorkspaceTerminalPane,
} from "./types";

export const maximumSshTerminalPanes = 4;

export function terminalPanesForTab(tab: WorkspaceSessionTab): WorkspaceTerminalPane[] {
  const panes = tab.terminal
    ? [{
        terminal: tab.terminal,
        terminalSnapshot: tab.terminalSnapshot,
        terminalTitle: tab.terminalTitle,
        terminalWorkingDirectory: tab.terminalWorkingDirectory,
      }]
    : [];

  return [...panes, ...(tab.additionalTerminals ?? [])];
}

export function findTerminalPane(
  tabs: WorkspaceSessionTab[],
  terminalId: string,
): WorkspaceTerminalPane | null {
  for (const tab of tabs) {
    const pane = terminalPanesForTab(tab).find((item) => item.terminal.id === terminalId);
    if (pane) {
      return pane;
    }
  }

  return null;
}

export function resolveTerminalSplitLayout(tab: WorkspaceSessionTab): TerminalSplitLayout | null {
  const terminalIds = terminalPanesForTab(tab).map((pane) => pane.terminal.id);
  if (terminalIds.length === 0) {
    return null;
  }

  if (tab.terminalLayout && layoutMatchesTerminalIds(tab.terminalLayout, terminalIds)) {
    return tab.terminalLayout;
  }

  return createDefaultTerminalSplitLayout(terminalIds);
}

export function splitTerminalLayout(
  layout: TerminalSplitLayout,
  targetTerminalId: string,
  newTerminalId: string,
  orientation: TerminalSplitOrientation,
): TerminalSplitLayout {
  if (layout.type === "terminal") {
    if (layout.terminalId !== targetTerminalId) {
      return layout;
    }

    return {
      type: "split",
      orientation,
      ratio: 0.5,
      first: layout,
      second: { type: "terminal", terminalId: newTerminalId },
    };
  }

  const first = splitTerminalLayout(layout.first, targetTerminalId, newTerminalId, orientation);
  if (first !== layout.first) {
    return { ...layout, first };
  }

  const second = splitTerminalLayout(layout.second, targetTerminalId, newTerminalId, orientation);
  return second === layout.second ? layout : { ...layout, second };
}

export function removeTerminalFromLayout(
  layout: TerminalSplitLayout,
  terminalId: string,
): TerminalSplitLayout | null {
  if (layout.type === "terminal") {
    return layout.terminalId === terminalId ? null : layout;
  }

  const first = removeTerminalFromLayout(layout.first, terminalId);
  const second = removeTerminalFromLayout(layout.second, terminalId);
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  return first === layout.first && second === layout.second
    ? layout
    : { ...layout, first, second };
}

export function updateTerminalSplitRatio(
  layout: TerminalSplitLayout,
  path: number[],
  ratio: number,
): TerminalSplitLayout {
  if (layout.type !== "split") {
    return layout;
  }

  if (path.length === 0) {
    return { ...layout, ratio: clampTerminalSplitRatio(ratio) };
  }

  const [head, ...tail] = path;
  if (head === 0) {
    const first = updateTerminalSplitRatio(layout.first, tail, ratio);
    return first === layout.first ? layout : { ...layout, first };
  }

  const second = updateTerminalSplitRatio(layout.second, tail, ratio);
  return second === layout.second ? layout : { ...layout, second };
}

export function isTerminalSplitLayout(value: unknown): value is TerminalSplitLayout {
  const state = { leaves: 0 };
  return validateTerminalSplitLayout(value, 0, state);
}

function validateTerminalSplitLayout(
  value: unknown,
  depth: number,
  state: { leaves: number },
): value is TerminalSplitLayout {
  if (depth > maximumSshTerminalPanes || state.leaves > maximumSshTerminalPanes) {
    return false;
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TerminalSplitLayout>;
  if (candidate.type === "terminal") {
    state.leaves += 1;
    return state.leaves <= maximumSshTerminalPanes &&
      typeof candidate.terminalId === "string" &&
      candidate.terminalId.length > 0;
  }

  return candidate.type === "split" &&
    (candidate.orientation === "columns" || candidate.orientation === "rows") &&
    typeof candidate.ratio === "number" &&
    Number.isFinite(candidate.ratio) &&
    candidate.ratio >= 0.1 &&
    candidate.ratio <= 0.9 &&
    validateTerminalSplitLayout(candidate.first, depth + 1, state) &&
    validateTerminalSplitLayout(candidate.second, depth + 1, state);
}

function createDefaultTerminalSplitLayout(terminalIds: string[]): TerminalSplitLayout {
  const leaves = terminalIds.map<TerminalSplitLayout>((terminalId) => ({
    type: "terminal",
    terminalId,
  }));

  if (leaves.length === 1) {
    return leaves[0];
  }

  if (leaves.length === 2) {
    return splitBranch("columns", leaves[0], leaves[1]);
  }

  if (leaves.length === 3) {
    return splitBranch("columns", leaves[0], splitBranch("rows", leaves[1], leaves[2]));
  }

  return splitBranch(
    "columns",
    splitBranch("rows", leaves[0], leaves[1]),
    splitBranch("rows", leaves[2], leaves[3]),
  );
}

function splitBranch(
  orientation: TerminalSplitOrientation,
  first: TerminalSplitLayout,
  second: TerminalSplitLayout,
): TerminalSplitLayout {
  return { type: "split", orientation, ratio: 0.5, first, second };
}

function layoutMatchesTerminalIds(layout: TerminalSplitLayout, terminalIds: string[]) {
  const layoutIds: string[] = [];
  collectLayoutTerminalIds(layout, layoutIds);
  if (layoutIds.length !== terminalIds.length) {
    return false;
  }

  const expected = new Set(terminalIds);
  return new Set(layoutIds).size === expected.size && layoutIds.every((terminalId) => expected.has(terminalId));
}

function collectLayoutTerminalIds(layout: TerminalSplitLayout, terminalIds: string[]) {
  if (layout.type === "terminal") {
    terminalIds.push(layout.terminalId);
    return;
  }

  collectLayoutTerminalIds(layout.first, terminalIds);
  collectLayoutTerminalIds(layout.second, terminalIds);
}

function clampTerminalSplitRatio(ratio: number) {
  return Math.min(0.78, Math.max(0.22, ratio));
}
