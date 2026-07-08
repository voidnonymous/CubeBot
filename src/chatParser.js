export function parseMessageSenderAndContent(text) {
  // Strip any leading timestamp, e.g. [16:11:28] and trim
  let cleanText = text.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/§[0-9a-fk-or]/g, '').trim();

  // Pattern for normal chat: optional rank brackets, then alphanumeric username, optional guild tags, separator, message
  // Separators: », :, >>, >
  const chatMatch = /^(?:[~*+])?(?:\[[^\]]+\]\s*)*([a-zA-Z0-9_]{3,16})(?:\s+\[[^\]]+\])*\s*(?:»|:|>>|>)\s*(.+)$/.exec(cleanText);
  if (chatMatch) {
    return {
      username: chatMatch[1],
      content: chatMatch[2].trim(),
      isPm: false
    };
  }

  // Fallback for weird name formats (symbols/guild prefixes between brackets and username)
  // Find the last "word: message" pattern where word looks like a username
  const fallbackMatch = cleanText.match(/\b([a-zA-Z0-9_]{3,16})\s*:\s(.+)$/);
  if (fallbackMatch) {
    return {
      username: fallbackMatch[1],
      content: fallbackMatch[2].trim(),
      isPm: false
    };
  }

  // PM patterns:
  // "From username: message"
  // "From username to me: message"
  // "[username -> me] message"
  const pmMatch1 = /^From\s+([a-zA-Z0-9_]{3,16})\s+(?:to me\s*)?:\s*(.+)$/i.exec(cleanText);
  if (pmMatch1) {
    return {
      username: pmMatch1[1],
      content: pmMatch1[2].trim(),
      isPm: true
    };
  }
  const pmMatch2 = /^\[([a-zA-Z0-9_]{3,16})\s*->\s*me\]\s*(.+)$/i.exec(cleanText);
  if (pmMatch2) {
    return {
      username: pmMatch2[1],
      content: pmMatch2[2].trim(),
      isPm: true
    };
  }

  // "username -> You message" (incoming PM, server-specific format)
  const pmIn = /^([a-zA-Z0-9_]{3,16})\s+->\s+You\s+(.+)$/i.exec(cleanText);
  if (pmIn) {
    return {
      username: pmIn[1],
      content: pmIn[2].trim(),
      isPm: true
    };
  }

  // "You -> username message" (outgoing PM, bot's own messages)
  const pmOut = /^You\s+->\s+[a-zA-Z0-9_]{3,16}\s+(.+)$/i.exec(cleanText);
  if (pmOut) {
    return {
      username: 'You',
      content: pmOut[1].trim(),
      isPm: true
    };
  }

  return null;
}

export function parseNobodyGotScrambler(text) {
  const cleanText = text.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/§[0-9a-fk-or]/g, '').trim();
  const match = /Nobody\s+(?:got|unscrambled)\s+.+?[\s.!,:)]*The\s+(?:correct\s+)?word\s+was:?\s*([\w\s]+)/i.exec(cleanText);
  return match ? match[1].trim() : null;
}

export function parseNobodyNoWord(text) {
  const cleanText = text.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/§[0-9a-fk-or]/g, '').trim();
  return /^Nobody\s+(?:got|unscrambled)\s+.+?\s*[:.(!]?\s*$/.test(cleanText);
}

export function parseTheWordWas(text) {
  const cleanText = text.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/§[0-9a-fk-or]/g, '').trim();
  const match = /^The\s+(?:correct\s+)?word\s+was:?\s*([\w\s]+)/i.exec(cleanText);
  return match ? match[1].trim() : null;
}
