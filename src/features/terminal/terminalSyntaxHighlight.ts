export type TerminalSyntaxLanguage =
  | "c"
  | "cpp"
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "toml"
  | "typescript"
  | "yaml";

export type TerminalSyntaxTone =
  | "comment"
  | "command"
  | "keyword"
  | "number"
  | "property"
  | "string"
  | "variable";

export interface TerminalSyntaxSpan {
  end: number;
  start: number;
  tone: TerminalSyntaxTone;
}

const displayedFileCommandPattern = /(?:^|&&|\|\||;|\||[$#❯]\s+)\s*(?:sudo\s+)?(?:awk|bat|batcat|cat|head|less|more|nl|sed|tail)\b([^;&|]*)/gi;
const shellKeywords = ["case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "time", "until", "while"];
const shellCommands = ["break", "cd", "continue", "echo", "eval", "exec", "exit", "export", "local", "printf", "read", "readonly", "return", "set", "shift", "source", "test", "trap", "typeset", "unset"];
const languageKeywords: Partial<Record<TerminalSyntaxLanguage, string[]>> = {
  c: ["auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while"],
  cpp: ["alignas", "auto", "bool", "break", "case", "catch", "class", "const", "constexpr", "continue", "default", "delete", "do", "else", "enum", "explicit", "export", "extern", "false", "for", "friend", "if", "inline", "namespace", "new", "nullptr", "private", "protected", "public", "return", "static", "struct", "switch", "template", "this", "throw", "true", "try", "typename", "union", "using", "virtual", "void", "while"],
  go: ["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"],
  java: ["abstract", "boolean", "break", "case", "catch", "class", "const", "continue", "default", "do", "else", "enum", "extends", "final", "finally", "for", "if", "implements", "import", "instanceof", "interface", "native", "new", "package", "private", "protected", "public", "return", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile", "while"],
  javascript: ["async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "get", "if", "import", "in", "instanceof", "let", "new", "of", "return", "set", "static", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield"],
  python: ["and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "match", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"],
  rust: ["as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while"],
  typescript: ["abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class", "const", "continue", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof", "interface", "keyof", "let", "namespace", "never", "new", "number", "of", "private", "protected", "public", "readonly", "return", "set", "static", "string", "super", "switch", "this", "throw", "try", "type", "typeof", "unknown", "var", "void", "while", "yield"],
};

export function detectDisplayedFileLanguage(command: string): TerminalSyntaxLanguage | null {
  displayedFileCommandPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = displayedFileCommandPattern.exec(command)) !== null) {
    const candidates = match[1].match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index].replace(/^['"]|['"]$/g, "");
      if (candidate.startsWith("-") || /^\+?\d+$/.test(candidate)) {
        continue;
      }
      const language = languageFromPath(candidate);
      if (language) {
        return language;
      }
    }
  }
  return null;
}

export function inferDisplayedContentLanguage(text: string): TerminalSyntaxLanguage | null {
  const value = text.trim();
  if (!value) {
    return null;
  }
  if (/^#!.*\b(?:ba|z|k)?sh\b/i.test(value)) {
    return "shell";
  }
  if (/^#!.*\bpython\d*\b/i.test(value)) {
    return "python";
  }
  if (/^#!.*\b(?:node|deno|bun)\b/i.test(value)) {
    return "javascript";
  }
  if (/^\{\s*(?:"|$)/.test(value) || /^\[\s*(?:[\{"\d-]|true|false|null|$)/.test(value)) {
    return "json";
  }
  if (/^(?:<!doctype\s+html|<html\b|<\?xml\b|<[A-Za-z][\w:-]*(?:\s|>|\/))/i.test(value)) {
    return "html";
  }
  if (/^(?:package\s+[A-Za-z_]\w*\s*(?:(?:\/\/).*)?$|func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\()/i.test(value)) {
    return "go";
  }
  if (/^(?:use\s+(?:std|crate|super|self)::|(?:pub\s+)?fn\s+[A-Za-z_]\w*\s*\(|(?:pub\s+)?(?:struct|enum|trait|impl)\s+[A-Za-z_]\w*)/.test(value)) {
    return "rust";
  }
  if (/^(?:from\s+[\w.]+\s+import\s+|import\s+[\w.]+(?:\s+as\s+\w+)?\s*$|(?:async\s+)?def\s+\w+\s*\(|class\s+\w+(?:\([^)]*\))?\s*:)/.test(value)) {
    return "python";
  }
  if (/^(?:interface|namespace|type)\s+[A-Za-z_$][\w$]*(?:\s|=|<)/.test(value)) {
    return "typescript";
  }
  if (/^(?:import\s+.+\s+from\s+['"]|export\s+(?:default\s+)?|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\()/.test(value)) {
    return "javascript";
  }
  if (/^(?:package\s+[\w.]+\s*;|import\s+java\.|public\s+(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+\w+)/.test(value)) {
    return "java";
  }
  if (/^#\s*include\s*[<"][^>"]+[>"]/.test(value)) {
    return /(?:iostream|vector|string|memory|unordered_|\.hpp[>"])/.test(value) ? "cpp" : "c";
  }
  if (/^(?:if\s+\[|if\s+\[\[|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=|(?:for|while)\s+.+;?\s*do\b|(?:case\s+.+\s+in|function\s+\w+|\w+\s*\(\)\s*\{))/.test(value)) {
    return "shell";
  }
  if (/^(?:---\s*$|%YAML\b|[A-Za-z_][\w.-]*:\s+(?:[^:=]|$))/.test(value)) {
    return "yaml";
  }
  if (/^(?:\[\[?[A-Za-z_][\w.-]*\]?\]|[A-Za-z_][\w.-]*\s*=\s*(?:['"\d[{]|true\b|false\b))/.test(value)) {
    return "toml";
  }
  if (/^(?:(?:select|insert\s+into|update|delete\s+from|create\s+table|alter\s+table|with)\b)/i.test(value)) {
    return "sql";
  }
  if (/^(?:@(?:media|supports|keyframes|font-face)\b|(?:\.|#|:root\b)[\w-]+[^{}]*\{)/.test(value)) {
    return "css";
  }
  return null;
}

export function terminalSyntaxSpans(text: string, language: TerminalSyntaxLanguage): TerminalSyntaxSpan[] {
  if (language === "json") {
    return jsonSpans(text);
  }
  if (language === "yaml" || language === "toml") {
    return configurationSpans(text, language);
  }
  if (language === "html") {
    return htmlSpans(text);
  }
  if (language === "css") {
    return cssSpans(text);
  }
  if (language === "sql") {
    return sqlSpans(text);
  }
  return codeSpans(text, language);
}

function languageFromPath(path: string): TerminalSyntaxLanguage | null {
  const normalized = path.toLowerCase().replace(/[),:]$/, "");
  if (/\.(?:ba|z|k)?sh$/.test(normalized)) return "shell";
  if (/\.jsonc?$/.test(normalized)) return "json";
  if (/\.ya?ml$/.test(normalized)) return "yaml";
  if (/\.(?:toml|ini|conf|env)$/.test(normalized) || /(?:^|\/)\.env(?:\.|$)/.test(normalized)) return "toml";
  if (/\.py$/.test(normalized)) return "python";
  if (/\.(?:js|jsx|mjs|cjs)$/.test(normalized)) return "javascript";
  if (/\.(?:ts|tsx|mts|cts)$/.test(normalized)) return "typescript";
  if (/\.rs$/.test(normalized)) return "rust";
  if (/\.go$/.test(normalized)) return "go";
  if (/\.java$/.test(normalized)) return "java";
  if (/\.c$/.test(normalized)) return "c";
  if (/\.(?:cc|cpp|cxx|h|hh|hpp)$/.test(normalized)) return "cpp";
  if (/\.css$/.test(normalized)) return "css";
  if (/\.(?:html?|xml|svg)$/.test(normalized)) return "html";
  if (/\.sql$/.test(normalized)) return "sql";
  return null;
}

function codeSpans(text: string, language: TerminalSyntaxLanguage): TerminalSyntaxSpan[] {
  const spans = stringSpans(text);
  const commentStart = findCommentStart(text, language === "shell" || language === "python" ? "#" : "//");
  if (commentStart >= 0) {
    removeStartingAt(spans, commentStart);
    spans.push({ end: text.length, start: commentStart, tone: "comment" });
  }

  const blocked = spans.filter((span) => span.tone === "comment" || span.tone === "string");
  if (language === "shell") {
    addWords(text, shellKeywords, "keyword", spans, blocked);
    addWords(text, shellCommands, "command", spans, blocked);
    addMatches(text, /\$(?:\{[^}\r\n]+\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])/g, "variable", spans, spans.filter((span) => span.tone === "comment"));
    if (/^\s*#!/.test(text)) {
      spans.push({ end: text.trimEnd().length, start: text.indexOf("#!"), tone: "command" });
    }
  } else {
    addWords(text, languageKeywords[language] ?? [], "keyword", spans, blocked);
  }
  addMatches(text, /\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, "number", spans, blocked);
  return spans;
}

function jsonSpans(text: string): TerminalSyntaxSpan[] {
  const spans = stringSpans(text);
  addMatches(text, /"(?:\\.|[^"\\])*"(?=\s*:)/g, "property", spans);
  addMatches(text, /\b(?:false|null|true)\b/g, "keyword", spans, spans.filter((span) => span.tone === "string"));
  addMatches(text, /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, "number", spans, spans.filter((span) => span.tone === "string"));
  return spans;
}

function configurationSpans(text: string, language: "toml" | "yaml"): TerminalSyntaxSpan[] {
  const spans = stringSpans(text);
  const commentStart = findCommentStart(text, "#");
  if (commentStart >= 0) {
    removeStartingAt(spans, commentStart);
    spans.push({ end: text.length, start: commentStart, tone: "comment" });
  }
  const separator = language === "yaml" ? ":" : "=";
  const keyPattern = new RegExp(`^\\s*[A-Za-z_][\\w.-]*(?=\\s*${separator})`);
  addMatches(text, keyPattern, "property", spans);
  const blocked = spans.filter((span) => span.tone === "comment" || span.tone === "string");
  addMatches(text, /\b(?:false|null|true|yes|no|on|off)\b/gi, "keyword", spans, blocked);
  addMatches(text, /\b\d+(?:\.\d+)?\b/g, "number", spans, blocked);
  return spans;
}

function htmlSpans(text: string): TerminalSyntaxSpan[] {
  const spans = stringSpans(text);
  addMatches(text, /<!--.*?(?:-->|$)/g, "comment", spans);
  addMatches(text, /<\/?[A-Za-z][\w:-]*/g, "keyword", spans);
  addMatches(text, /\b[A-Za-z_:][\w:.-]*(?=\s*=)/g, "property", spans, spans.filter((span) => span.tone === "string" || span.tone === "comment"));
  return spans;
}

function cssSpans(text: string): TerminalSyntaxSpan[] {
  const spans = stringSpans(text);
  addMatches(text, /\/\*.*?(?:\*\/|$)/g, "comment", spans);
  addMatches(text, /--?[A-Za-z][\w-]*(?=\s*:)/g, "property", spans);
  addMatches(text, /@[A-Za-z-]+/g, "keyword", spans);
  addMatches(text, /(?:#[\da-f]{3,8}|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|ms|vh|vw)?\b)/gi, "number", spans, spans.filter((span) => span.tone === "string" || span.tone === "comment"));
  return spans;
}

function sqlSpans(text: string): TerminalSyntaxSpan[] {
  const spans = stringSpans(text);
  const commentStart = findCommentStart(text, "--");
  if (commentStart >= 0) {
    removeStartingAt(spans, commentStart);
    spans.push({ end: text.length, start: commentStart, tone: "comment" });
  }
  addWords(text, ["alter", "and", "as", "asc", "begin", "between", "by", "case", "create", "delete", "desc", "distinct", "drop", "else", "end", "exists", "from", "group", "having", "in", "insert", "into", "is", "join", "like", "limit", "not", "null", "on", "or", "order", "outer", "returning", "select", "set", "table", "then", "union", "update", "values", "when", "where", "with"], "keyword", spans, spans.filter((span) => span.tone === "string" || span.tone === "comment"));
  addMatches(text, /\b\d+(?:\.\d+)?\b/g, "number", spans, spans.filter((span) => span.tone === "string" || span.tone === "comment"));
  return spans;
}

function stringSpans(text: string): TerminalSyntaxSpan[] {
  const spans: TerminalSyntaxSpan[] = [];
  addMatches(text, /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "string", spans);
  return spans;
}

function addWords(text: string, words: string[], tone: TerminalSyntaxTone, spans: TerminalSyntaxSpan[], blocked: TerminalSyntaxSpan[] = []) {
  if (words.length === 0) return;
  addMatches(text, new RegExp(`\\b(?:${words.join("|")})\\b`, "gi"), tone, spans, blocked);
}

function addMatches(text: string, pattern: RegExp, tone: TerminalSyntaxTone, spans: TerminalSyntaxSpan[], blocked: TerminalSyntaxSpan[] = []) {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!overlapsAny(start, end, blocked)) {
      spans.push({ end, start, tone });
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
}

function findCommentStart(text: string, token: "#" | "//" | "--") {
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (text.startsWith(token, index)) return index;
  }
  return -1;
}

function overlapsAny(start: number, end: number, spans: TerminalSyntaxSpan[]) {
  return spans.some((span) => start < span.end && end > span.start);
}

function removeStartingAt(spans: TerminalSyntaxSpan[], start: number) {
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (spans[index].start >= start) spans.splice(index, 1);
  }
}
