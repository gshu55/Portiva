export const maximumPendingTerminalOutputCharacters = 512 * 1024;

export interface BoundedTerminalOutput {
  droppedCharacters: number;
  value: string;
}

function safeTailStart(value: string, requestedStart: number) {
  let start = Math.max(0, Math.min(value.length, requestedStart));
  if (
    start > 0
    && start < value.length
    && value.charCodeAt(start) >= 0xdc00
    && value.charCodeAt(start) <= 0xdfff
    && value.charCodeAt(start - 1) >= 0xd800
    && value.charCodeAt(start - 1) <= 0xdbff
  ) {
    start += 1;
  }
  return start;
}

/**
 * Appends terminal output without ever constructing a string larger than the
 * configured limit. This is measured in JavaScript UTF-16 code units because
 * that is the memory xterm and the WebView renderer retain.
 */
export function appendBoundedTerminalOutput(
  current: string,
  incoming: string,
  maximumCharacters = maximumPendingTerminalOutputCharacters,
): BoundedTerminalOutput {
  const limit = Math.max(0, Math.floor(maximumCharacters));
  if (limit === 0) {
    return {
      droppedCharacters: current.length + incoming.length,
      value: "",
    };
  }

  const combinedLength = current.length + incoming.length;
  if (combinedLength <= limit) {
    return {
      droppedCharacters: 0,
      value: `${current}${incoming}`,
    };
  }

  if (incoming.length >= limit) {
    const start = safeTailStart(incoming, incoming.length - limit);
    return {
      droppedCharacters: current.length + start,
      value: incoming.slice(start),
    };
  }

  const currentStart = safeTailStart(current, current.length - (limit - incoming.length));
  return {
    droppedCharacters: currentStart,
    value: `${current.slice(currentStart)}${incoming}`,
  };
}
