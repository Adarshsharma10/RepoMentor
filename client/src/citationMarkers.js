export function parseCitationMarkers(text, validNumbers = null) {
  const markers = [];
  const pattern = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const numbers = match[1].split(',').map(value => Number(value.trim()))
      .filter(number => !validNumbers || validNumbers.has(number));
    if (numbers.length) markers.push({ start: match.index, end: pattern.lastIndex, numbers, text: match[0] });
  }
  return markers;
}
