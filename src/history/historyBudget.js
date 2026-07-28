export function estimateBytes(value) {
  if (!value) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.length * 8 + value.reduce((total, item) => total + estimateBytes(item), 0);
  if (typeof value === 'object') {
    let total = 0;
    for (const key of Object.keys(value)) total += estimateBytes(value[key]);
    return total;
  }
  return 16;
}

export function addHistoryEntry(state, entry, stack = state.undo) {
  entry.bytes = entry.bytes || estimateBytes(entry);
  stack.push(entry);
  if (stack === state.undo) state.undoBytes += entry.bytes;
  if (stack === state.redo) state.redoBytes += entry.bytes;
}

export function clearHistoryStack(state, name) {
  state[name].length = 0;
  if (name === 'undo') state.undoBytes = 0;
  if (name === 'redo') state.redoBytes = 0;
}

export function trimUndoHistory(state) {
  while (state.undo.length > state.maxHistory || state.undoBytes > state.maxHistoryBytes) {
    const removed = state.undo.shift();
    state.undoBytes -= removed?.bytes || 0;
  }
}
