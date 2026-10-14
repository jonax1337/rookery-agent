/**
 * Splits text into sentences: [.!?] followed by whitespace or the end, or a
 * line break. Dots inside "v0.5.1" or "a.ts" are not boundaries.
 */
function sentences(text: string): string[] {
  return text.split(/[.!?]+(?=\s|$)|\n/);
}

// JS \b is ASCII-only, so umlaut words are anchored by hand where it matters.
const INTERIM: RegExp[] = [
  // "Das Dokument schreibe ich, sobald ..." / "Den Rest liefere ich später nach."
  /(?:\bich\s+(?:schreibe|liefere|melde|schicke|sende|erstelle|berichte|reiche)|\b(?:schreibe|liefere|melde|schicke|sende|erstelle|berichte|reiche)\s+ich)\b.*(?:\b(?:sobald|nachdem|nachher)\b|\bspäter|\bwenn\b.*(?:\bzurück|\bfertig|\bdurch\b|\babgeschlossen|\bvorliegen|\bda\s+sind))/iu,
  // "Zwei Agents laufen noch", "Der Test läuft noch"
  /(?:\blaufen|\bläuft)\s+noch\b/iu,
  // "Gamma fehlt noch", "Beta und Gamma stehen noch aus", "weiterhin nicht fertig" (live runs)
  /\b(?:fehlt|fehlen)\s+noch\b|\b(?:steht|stehen)\s+noch\s+aus\b|\bnoch\s+nicht\s+(?:fertig\b|zurück|da\b)|\bweiterhin\s+nicht\s+fertig\b/iu,
  // "Gamma is still missing", "Beta is not back yet"
  /\bstill\s+(?:missing|outstanding)\b|\bnot\s+back\s+yet\b/iu,
  // "Ich warte noch auf ..." ("wartet auf" is a description, not a wait)
  /\bwarte\s+(?:noch\s+)?auf\b|\bwarten\s+noch\s+auf\b/iu,
  // "I'll write the document once the research agents report back."
  /\b(?:i['’]ll|i\s+will|we['’]ll|we\s+will)\b.*(?:\b(?:once|when|after|as\s+soon\s+as)\b.*\b(?:report(?:s|ed)?\s+back|finish(?:es|ed)?|(?:are|is)\s+done|come\s+back|complete[sd]?|return)\b|\blater\b)/iu,
  // "Two agents are still running." (a server still running on a port is final)
  /\b(?:agents?|sub-?agents?|tasks?|jobs?|runs?|tests?|research)\b.*\bstill\s+(?:running|working|pending)\b/iu,
  // "Waiting for the sub-agents to finish."
  /\bwaiting\s+(?:for|on)\b.*\b(?:agents?|sub-?agents?|results?|research|repl(?:y|ies)|feedback|reports?)\b/iu,
];

/**
 * True when a report says it is still waiting for something and the actual
 * result comes later. ponytail: regex heuristic per sentence; misses paraphrases
 * and could be swapped for a small-model classifier if it proves too coarse.
 */
export function looksInterim(text: string): boolean {
  return sentences(text).some((s) => INTERIM.some((re) => re.test(s)));
}

const WRITE_VERB = /\b(?:schreib|speicher|leg|ableg|erstell|writ|sav|creat|output)/i;
const ABS_PATH = /(?:\b[A-Za-z]:[\\/]|(?<![\w.:/\\])\/)\S+/g;

/**
 * Absolute file paths the task names as output: in the same sentence, within
 * 80 characters after a write verb. Paths with spaces are not supported.
 */
export function expectedArtifacts(task: string): string[] {
  const found = new Set<string>();
  for (const s of sentences(task)) {
    for (const m of s.matchAll(ABS_PATH)) {
      const path = m[0].replace(/[.,;:)`"']+$/, '');
      if (!/\.[A-Za-z0-9]+$/.test(path.split(/[\\/]/).pop() ?? '')) continue;
      if (WRITE_VERB.test(s.slice(Math.max(0, m.index - 80), m.index))) found.add(path);
    }
  }
  return [...found];
}
