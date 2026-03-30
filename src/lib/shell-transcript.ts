import type { RemoteShellState } from '@/types';

const ESC = '\u001b';
const BEL = '\u0007';
const TAB_WIDTH = 8;

function ensureScreenLine(lines: string[][], row: number): string[] {
  while (lines.length <= row) {
    lines.push([]);
  }
  return lines[row]!;
}

function fillLineToColumn(line: string[], column: number): void {
  while (line.length < column) {
    line.push(' ');
  }
}

function clearLineFromCursor(line: string[], column: number): void {
  if (column >= line.length) {
    return;
  }
  line.length = column;
}

function clearLineToCursor(line: string[], column: number): void {
  const end = Math.min(column + 1, line.length);
  for (let index = 0; index < end; index += 1) {
    line[index] = ' ';
  }
}

function clearEntireLine(lines: string[][], row: number): void {
  lines[row] = [];
}

function eraseCharacters(line: string[], column: number, count: number): void {
  if (count <= 0) return;
  fillLineToColumn(line, column + count);
  for (let index = column; index < column + count; index += 1) {
    line[index] = ' ';
  }
}

function deleteCharacters(line: string[], column: number, count: number): void {
  if (count <= 0 || column >= line.length) return;
  line.splice(column, count);
}

function insertBlankCharacters(line: string[], column: number, count: number): void {
  if (count <= 0) return;
  fillLineToColumn(line, column);
  line.splice(column, 0, ...Array.from({ length: count }, () => ' '));
}

function parseCsiParameters(raw: string): number[] {
  const normalized = raw.replace(/^[?<=>!]+/, '');
  if (!normalized) {
    return [];
  }
  return normalized.split(';').map((part) => {
    if (!part) {
      return Number.NaN;
    }
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : Number.NaN;
  });
}

function getCsiParameter(params: number[], index: number, fallback: number): number {
  const value = params[index];
  return Number.isFinite(value) && value! > 0 ? value! : fallback;
}

function trimTrailingSpaces(line: string[]): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    end -= 1;
  }
  return line.slice(0, end).join('');
}

export function sanitizeShellTranscriptOutput(output: string): string {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  let savedCursor: { row: number; col: number } | null = null;

  const currentLine = () => ensureScreenLine(lines, row);
  const moveToLineStart = (clearLine: boolean) => {
    col = 0;
    if (clearLine) {
      clearEntireLine(lines, row);
    }
  };

  for (let index = 0; index < output.length; index += 1) {
    const char = output[index]!;

    if (char === ESC) {
      const next = output[index + 1];
      if (!next) break;

      if (next === ']') {
        let cursor = index + 2;
        while (cursor < output.length) {
          const oscChar = output[cursor]!;
          if (oscChar === BEL) {
            break;
          }
          if (oscChar === ESC && output[cursor + 1] === '\\') {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        index = cursor;
        continue;
      }

      if (next === 'P') {
        let cursor = index + 2;
        while (cursor < output.length) {
          const dcsChar = output[cursor]!;
          if (dcsChar === ESC && output[cursor + 1] === '\\') {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        index = cursor;
        continue;
      }

      if (next === '[') {
        let cursor = index + 2;
        while (cursor < output.length) {
          const code = output.charCodeAt(cursor);
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
          cursor += 1;
        }
        if (cursor >= output.length) {
          break;
        }

        const params = parseCsiParameters(output.slice(index + 2, cursor));
        const final = output[cursor]!;

        switch (final) {
          case 'A':
            row = Math.max(0, row - getCsiParameter(params, 0, 1));
            break;
          case 'B':
            row += getCsiParameter(params, 0, 1);
            ensureScreenLine(lines, row);
            break;
          case 'C':
            col += getCsiParameter(params, 0, 1);
            break;
          case 'D':
            col = Math.max(0, col - getCsiParameter(params, 0, 1));
            break;
          case 'E':
            row += getCsiParameter(params, 0, 1);
            col = 0;
            ensureScreenLine(lines, row);
            break;
          case 'F':
            row = Math.max(0, row - getCsiParameter(params, 0, 1));
            col = 0;
            break;
          case 'G':
            col = Math.max(0, getCsiParameter(params, 0, 1) - 1);
            break;
          case 'H':
          case 'f':
            row = Math.max(0, getCsiParameter(params, 0, 1) - 1);
            col = Math.max(0, getCsiParameter(params, 1, 1) - 1);
            ensureScreenLine(lines, row);
            break;
          case 'J': {
            const mode = getCsiParameter(params, 0, 0);
            if (mode === 0) {
              clearLineFromCursor(currentLine(), col);
              lines.length = row + 1;
            } else if (mode === 1) {
              for (let lineIndex = 0; lineIndex < row; lineIndex += 1) {
                lines[lineIndex] = [];
              }
              clearLineToCursor(currentLine(), col);
            } else {
              lines.length = 0;
              ensureScreenLine(lines, row);
            }
            break;
          }
          case 'K': {
            const mode = getCsiParameter(params, 0, 0);
            if (mode === 0) {
              clearLineFromCursor(currentLine(), col);
            } else if (mode === 1) {
              clearLineToCursor(currentLine(), col);
            } else {
              clearEntireLine(lines, row);
            }
            break;
          }
          case 'P':
            deleteCharacters(currentLine(), col, getCsiParameter(params, 0, 1));
            break;
          case '@':
            insertBlankCharacters(currentLine(), col, getCsiParameter(params, 0, 1));
            break;
          case 'X':
            eraseCharacters(currentLine(), col, getCsiParameter(params, 0, 1));
            break;
          case 's':
            savedCursor = { row, col };
            break;
          case 'u':
            if (savedCursor) {
              row = savedCursor.row;
              col = savedCursor.col;
              ensureScreenLine(lines, row);
            }
            break;
          default:
            break;
        }

        index = cursor;
        continue;
      }

      if (next === '7') {
        savedCursor = { row, col };
        index += 1;
        continue;
      }

      if (next === '8') {
        if (savedCursor) {
          row = savedCursor.row;
          col = savedCursor.col;
          ensureScreenLine(lines, row);
        }
        index += 1;
        continue;
      }

      if (next === 'c') {
        row = 0;
        col = 0;
        lines.length = 0;
        lines.push([]);
        index += 1;
        continue;
      }

      if (next === '(' || next === ')' || next === '*' || next === '+') {
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (char === '\r') {
      const next = output[index + 1];
      moveToLineStart(next !== '\n');
      continue;
    }

    if (char === '\n') {
      row += 1;
      col = 0;
      ensureScreenLine(lines, row);
      continue;
    }

    if (char === '\b' || char === '\u007f') {
      col = Math.max(0, col - 1);
      continue;
    }

    if (char === '\t') {
      const remainder = col % TAB_WIDTH;
      const spaces = remainder === 0 ? TAB_WIDTH : TAB_WIDTH - remainder;
      const line = currentLine();
      fillLineToColumn(line, col);
      for (let spaceIndex = 0; spaceIndex < spaces; spaceIndex += 1) {
        line[col] = ' ';
        col += 1;
      }
      continue;
    }

    if (char < ' ' || char === BEL) {
      continue;
    }

    const line = currentLine();
    fillLineToColumn(line, col);
    line[col] = char;
    col += 1;
  }

  return lines.map(trimTrailingSpaces).join('\n');
}

export function isRemoteShellState(value: string | null | undefined): value is RemoteShellState {
  return value === 'idle' || value === 'starting' || value === 'running' || value === 'stopped' || value === 'error';
}
