/** A short name for a text, to tell whether a file still holds it. */
export function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length}.${h.toString(36)}`;
}
