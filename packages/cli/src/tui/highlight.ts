/**
 * A deliberately tiny syntax highlighter for fenced code blocks.
 *
 * Scope is what makes code *scannable* in a chat transcript rather than what
 * makes an editor: comments, strings, numbers, keywords and the punctuation
 * between them. It is one regular expression per language family and no
 * dependency, which is the trade that matters here - a real grammar engine
 * would cost more than a transcript ever gets back from it.
 *
 * Anything it does not recognise comes back as one plain token, so an unknown
 * language still renders as verbatim code rather than as mangled code.
 */

/** What a token is, semantically. Colours live in the component. */
export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'punctuation';

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Language families, keyed by the aliases people actually write after a fence. */
const FAMILY: Record<string, 'c' | 'shell' | 'data'> = {
  js: 'c',
  jsx: 'c',
  ts: 'c',
  tsx: 'c',
  javascript: 'c',
  typescript: 'c',
  java: 'c',
  c: 'c',
  cpp: 'c',
  cs: 'c',
  go: 'c',
  rust: 'c',
  rs: 'c',
  php: 'c',
  swift: 'c',
  kotlin: 'c',
  python: 'c',
  py: 'c',
  ruby: 'c',
  rb: 'c',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  powershell: 'shell',
  ps1: 'shell',
  json: 'data',
  jsonc: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
};

const KEYWORDS = new Set([
  // Declarations and modifiers, across the C-like family.
  'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'struct',
  'def', 'fn', 'func', 'public', 'private', 'protected', 'static', 'readonly', 'abstract',
  'extends', 'implements', 'export', 'import', 'from', 'as', 'package', 'namespace', 'use',
  // Control flow.
  'if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'return', 'yield', 'try', 'catch', 'except', 'finally', 'throw', 'raise',
  'match', 'when', 'in', 'of', 'with',
  // Values and operators that read as words.
  'new', 'this', 'self', 'super', 'null', 'nil', 'None', 'undefined', 'true', 'false',
  'True', 'False', 'async', 'await', 'not', 'and', 'or', 'is', 'void', 'mut', 'pub',
  'impl', 'trait', 'where', 'lambda', 'pass', 'del', 'global',
]);

/** Shell builtins and the commands a transcript actually shows. */
const SHELL_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
  'function', 'return', 'export', 'local', 'set', 'unset', 'source', 'echo', 'cd', 'ls',
  'cat', 'grep', 'sed', 'awk', 'find', 'git', 'npm', 'node', 'npx', 'sudo', 'rm', 'mv',
  'cp', 'mkdir', 'chmod', 'curl', 'docker', 'python', 'pip', 'make',
]);

/**
 * One pass over a line. The alternatives are ordered so that the greedy
 * constructs - comments and strings - win over anything inside them.
 */
const C_LIKE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=<>+\-*/%!&|?]+)/gu;

const SHELL =
  /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'[^']*')|(\$\{?[A-Za-z_][\w]*\}?)|(\b\d+\b)|([A-Za-z_][\w-]*)|([|&;()<>[\]{}=]+)/gu;

const DATA =
  /(#[^\n]*|\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null|yes|no)\b)|(-?\b\d[\d._eE+-]*\b)|([{}[\],:])/gu;

/**
 * Split one line into styled tokens.
 *
 * Lines are highlighted independently: a block comment or a template literal
 * spanning several lines only colours its first line, which is a knowingly
 * cheap approximation and never wrong enough to mislead.
 */
export function highlightLine(line: string, language: string | undefined): Token[] {
  const family = language ? FAMILY[language.toLowerCase()] : undefined;
  if (!family || !line) return [{ text: line, kind: 'plain' }];

  const pattern = family === 'shell' ? SHELL : family === 'data' ? DATA : C_LIKE;
  const tokens: Token[] = [];
  let cursor = 0;

  pattern.lastIndex = 0;
  let match = pattern.exec(line);
  while (match) {
    if (match.index > cursor) {
      tokens.push({ text: line.slice(cursor, match.index), kind: 'plain' });
    }
    tokens.push({ text: match[0], kind: classify(match, family) });
    cursor = match.index + match[0].length;
    match = pattern.exec(line);
  }

  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: 'plain' });
  return tokens.length ? tokens : [{ text: line, kind: 'plain' }];
}

/** Which capture group fired decides the kind; words are looked up by family. */
function classify(match: RegExpExecArray, family: 'c' | 'shell' | 'data'): TokenKind {
  if (match[1] !== undefined) return 'comment';
  if (match[2] !== undefined) return 'string';

  if (family === 'c') {
    if (match[3] !== undefined) return 'number';
    if (match[4] !== undefined) return KEYWORDS.has(match[4]) ? 'keyword' : 'plain';
    return 'punctuation';
  }

  if (family === 'shell') {
    // A `$VAR` reads like a value, so it is coloured like a string.
    if (match[3] !== undefined) return 'string';
    if (match[4] !== undefined) return 'number';
    if (match[5] !== undefined) return SHELL_WORDS.has(match[5]) ? 'keyword' : 'plain';
    return 'punctuation';
  }

  if (match[3] !== undefined) return 'keyword';
  if (match[4] !== undefined) return 'number';
  return 'punctuation';
}

/** True when the fence language is one the highlighter actually knows. */
export function isHighlightable(language: string | undefined): boolean {
  return Boolean(language && FAMILY[language.toLowerCase()]);
}
