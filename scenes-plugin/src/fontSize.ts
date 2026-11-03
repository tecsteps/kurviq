/** Text sizes already support fractional values in the editor. */
export const parseFontSize = (text: string): number | null => {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.min(1000, Math.max(1, value));
};
