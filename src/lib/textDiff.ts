export type UnifiedDiffLineType = "context" | "add" | "del" | "skip";

export interface UnifiedDiffLine {
  type: UnifiedDiffLineType;
  oldLineNumber?: number;
  newLineNumber?: number;
  text?: string;
  hiddenOldLines?: number;
  hiddenNewLines?: number;
}

export interface UnifiedDiffResult {
  lines: UnifiedDiffLine[];
  addedLines: number;
  removedLines: number;
  changed: boolean;
}

interface RawDiffLine {
  type: "context" | "add" | "del";
  text: string;
}

const MATRIX_MAX_CELLS = 180_000;

const normalizeLineEndings = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const splitLines = (value: string): string[] => {
  const normalized = normalizeLineEndings(value);
  if (!normalized) return [];
  const lines = normalized.split("\n");

  // Trailing newline should not create noisy empty diff lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
};

const buildRawDiffByLcs = (oldLines: string[], newLines: string[]): RawDiffLine[] => {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const dp: number[][] = Array.from({ length: oldLen + 1 }, () => Array.from({ length: newLen + 1 }, () => 0));

  for (let i = oldLen - 1; i >= 0; i -= 1) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    if (!row || !nextRow) continue;
    for (let j = newLen - 1; j >= 0; j -= 1) {
      const nextRowSame = nextRow[j] ?? 0;
      const nextRowNext = nextRow[j + 1] ?? 0;
      const rowNext = row[j + 1] ?? 0;
      if (oldLines[i] === newLines[j]) {
        row[j] = nextRowNext + 1;
      } else {
        row[j] = Math.max(nextRowSame, rowNext);
      }
    }
  }

  const output: RawDiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      output.push({ type: "context", text: oldLines[i] ?? "" });
      i += 1;
      j += 1;
      continue;
    }

    const down = dp[i + 1]?.[j] ?? 0;
    const right = dp[i]?.[j + 1] ?? 0;

    if (down >= right) {
      output.push({ type: "del", text: oldLines[i] ?? "" });
      i += 1;
    } else {
      output.push({ type: "add", text: newLines[j] ?? "" });
      j += 1;
    }
  }

  while (i < oldLen) {
    output.push({ type: "del", text: oldLines[i] ?? "" });
    i += 1;
  }

  while (j < newLen) {
    output.push({ type: "add", text: newLines[j] ?? "" });
    j += 1;
  }

  return output;
};

const buildRawDiffByAnchors = (oldLines: string[], newLines: string[]): RawDiffLine[] => {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const output: RawDiffLine[] = [];

  for (let i = 0; i < prefix; i += 1) {
    output.push({ type: "context", text: oldLines[i] ?? "" });
  }

  for (let i = prefix; i <= oldSuffix; i += 1) {
    output.push({ type: "del", text: oldLines[i] ?? "" });
  }

  for (let i = prefix; i <= newSuffix; i += 1) {
    output.push({ type: "add", text: newLines[i] ?? "" });
  }

  for (let i = oldSuffix + 1; i < oldLines.length; i += 1) {
    output.push({ type: "context", text: oldLines[i] ?? "" });
  }

  return output;
};

const withLineNumbers = (rawLines: RawDiffLine[]): UnifiedDiffLine[] => {
  const output: UnifiedDiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;

  for (const line of rawLines) {
    if (line.type === "context") {
      output.push({
        type: "context",
        oldLineNumber: oldNo,
        newLineNumber: newNo,
        text: line.text
      });
      oldNo += 1;
      newNo += 1;
      continue;
    }

    if (line.type === "del") {
      output.push({
        type: "del",
        oldLineNumber: oldNo,
        text: line.text
      });
      oldNo += 1;
      continue;
    }

    output.push({
      type: "add",
      newLineNumber: newNo,
      text: line.text
    });
    newNo += 1;
  }

  return output;
};

const collapseContext = (lines: UnifiedDiffLine[], radius: number): UnifiedDiffLine[] => {
  const changedIndices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && line.type !== "context") {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length < 1) {
    if (lines.length <= radius * 4 + 2) {
      return lines;
    }

    const head = lines.slice(0, radius * 2);
    const tail = lines.slice(Math.max(lines.length - radius * 2, 0));
    const hidden = lines.slice(radius * 2, Math.max(lines.length - radius * 2, radius * 2));
    let hiddenOld = 0;
    let hiddenNew = 0;
    for (const line of hidden) {
      if (typeof line.oldLineNumber === "number") hiddenOld += 1;
      if (typeof line.newLineNumber === "number") hiddenNew += 1;
    }

    return [
      ...head,
      {
        type: "skip",
        hiddenOldLines: hiddenOld,
        hiddenNewLines: hiddenNew
      },
      ...tail
    ];
  }

  const keep = Array.from({ length: lines.length }, () => false);
  for (const index of changedIndices) {
    const from = Math.max(0, index - radius);
    const to = Math.min(lines.length - 1, index + radius);
    for (let i = from; i <= to; i += 1) {
      keep[i] = true;
    }
  }

  const output: UnifiedDiffLine[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    if (keep[cursor]) {
      output.push(lines[cursor] as UnifiedDiffLine);
      cursor += 1;
      continue;
    }

    let end = cursor;
    let hiddenOld = 0;
    let hiddenNew = 0;
    while (end < lines.length && !keep[end]) {
      const line = lines[end];
      if (line && typeof line.oldLineNumber === "number") hiddenOld += 1;
      if (line && typeof line.newLineNumber === "number") hiddenNew += 1;
      end += 1;
    }

    output.push({
      type: "skip",
      hiddenOldLines: hiddenOld,
      hiddenNewLines: hiddenNew
    });
    cursor = end;
  }

  return output;
};

export const buildUnifiedDiff = (
  oldText: string,
  newText: string,
  options?: { contextLines?: number }
): UnifiedDiffResult => {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const cellCount = oldLines.length * newLines.length;

  const raw =
    cellCount <= MATRIX_MAX_CELLS ? buildRawDiffByLcs(oldLines, newLines) : buildRawDiffByAnchors(oldLines, newLines);

  const numbered = withLineNumbers(raw);
  const contextLines = Math.max(1, Math.min(options?.contextLines ?? 3, 12));
  const collapsed = collapseContext(numbered, contextLines);

  let addedLines = 0;
  let removedLines = 0;
  for (const line of numbered) {
    if (line.type === "add") addedLines += 1;
    if (line.type === "del") removedLines += 1;
  }

  return {
    lines: collapsed,
    addedLines,
    removedLines,
    changed: addedLines > 0 || removedLines > 0
  };
};
