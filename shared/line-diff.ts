export function splitLinesPreserveEndings(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
