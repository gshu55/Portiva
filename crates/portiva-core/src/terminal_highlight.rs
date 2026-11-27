//! Display-only highlighting. Syntax parsing never modifies the terminal grid or copied text.
use std::{ops::Range, sync::OnceLock};

use regex::Regex;
use syntect::{
    easy::HighlightLines,
    highlighting::{Color, StyleModifier, Theme, ThemeItem, ThemeSettings},
    parsing::SyntaxSet,
};

use crate::{CodeLanguage, TerminalHighlighting, TerminalPalette};

pub(crate) struct HighlightSpan {
    pub bytes: Range<usize>,
    pub color: u32,
}

struct Patterns {
    level: Regex,
    prompt: Regex,
    command: Regex,
    html: Regex,
    csharp: Regex,
    css: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        level: Regex::new(concat!(
            r"(?i)^\s*(?:(?:\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|",
            r"\d{2}:\d{2}:\d{2}(?:[.,]\d+)?|\[[^\]\r\n]{1,80}\])\s*){0,5}",
            r"[\[(]?(?P<level>ERROR|ERR|FATAL|CRITICAL|PANIC|FAILED|FAILURE|FAIL|WARNING|WARN|",
            r"INFO|NOTICE|HINT|TIP|SUCCESS|PASSED|PASS|DONE|OK|DEBUG|TRACE|错误|异常|失败|警告|提示|信息|成功|完成|调试)"
        )).expect("log pattern"),
        prompt: Regex::new(concat!(
            r"^(?:\([^)]*\)\s*)?(?:PS [^>]+>|[^\s]*@[^\s]*[$#>]|",
            r"[\w.-]+(?::[^\s]*)?[$#]|(?:[^\s]+:)?[~/][^\s]*[$#>]|[$❯➜])(?:\s|$)"
        )).expect("shell prompt pattern"),
        command: Regex::new(r"(?i)(?:^|[\s$>#])(?:cat|bat|less|more|tail|head|get-content|gc|type)\s+(.+)$")
            .expect("file command pattern"),
        html: Regex::new(r"(?i)^\s*<(?:!doctype\s|!--|/?[a-z][\w:-]*(?:\s|/?>))").expect("markup pattern"),
        csharp: Regex::new(concat!(
            r"^\s*(?:using\s+(?:static\s+)?[\w.]+\s*;|namespace\s+[\w.]+\s*[;{]|",
            r"(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly)\s+)*",
            r"(?:class|interface|record|enum|struct)\s+\w+)"
        )).expect("C# pattern"),
        css: Regex::new(r#"^\s*(?:[.#][\w:-]+|(?:body|html|a|div|span|p|h[1-6]|button|input)(?:[.#:\s][\w .#:\[\]="'-]+)?)\s*\{"#)
            .expect("CSS pattern"),
    })
}

fn syntax_set() -> &'static SyntaxSet {
    static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
    SYNTAXES.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn color(rgb: u32) -> Color {
    Color {
        r: (rgb >> 16) as u8,
        g: (rgb >> 8) as u8,
        b: rgb as u8,
        a: 255,
    }
}

fn theme(palette: &TerminalPalette) -> Theme {
    Theme {
        settings: ThemeSettings {
            foreground: Some(color(palette.foreground)),
            ..Default::default()
        },
        scopes: [
            ("comment", palette.muted_foreground()),
            (
                "keyword, storage, punctuation.definition.tag",
                palette.ansi[5],
            ),
            ("string", palette.ansi[2]),
            ("constant", palette.ansi[11]),
            (
                "entity.name.type, entity.name.class, support.type, support.class",
                palette.ansi[3],
            ),
            (
                "entity.name.function, support.function, variable.function",
                palette.ansi[4],
            ),
            ("entity.name.tag", palette.ansi[1]),
            (
                "entity.other.attribute-name, variable.parameter",
                palette.ansi[6],
            ),
            ("invalid", palette.ansi[1]),
        ]
        .into_iter()
        .map(|(scope, rgb)| ThemeItem {
            scope: scope.parse().expect("built-in scope selector"),
            style: StyleModifier {
                foreground: Some(color(rgb)),
                ..Default::default()
            },
        })
        .collect(),
        ..Default::default()
    }
}

fn language(token: &str) -> CodeLanguage {
    match token
        .trim_matches(['\'', '"', '`'])
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" | "xml" | "svg" => CodeLanguage::Html,
        "css" | "scss" => CodeLanguage::Css,
        "cs" | "csharp" | "c#" => CodeLanguage::CSharp,
        "js" | "jsx" | "javascript" | "ts" | "tsx" | "typescript" => CodeLanguage::JavaScript,
        "json" | "jsonc" => CodeLanguage::Json,
        "rs" | "rust" => CodeLanguage::Rust,
        "py" | "python" => CodeLanguage::Python,
        "sh" | "bash" | "zsh" | "shell" => CodeLanguage::Shell,
        _ => CodeLanguage::Auto,
    }
}

fn extension(language: CodeLanguage) -> Option<&'static str> {
    Some(match language {
        CodeLanguage::Auto => return None,
        CodeLanguage::Html => "html",
        CodeLanguage::Css => "css",
        CodeLanguage::CSharp => "cs",
        CodeLanguage::JavaScript => "js",
        CodeLanguage::Json => "json",
        CodeLanguage::Rust => "rs",
        CodeLanguage::Python => "py",
        CodeLanguage::Shell => "sh",
    })
}

fn file_command(line: &str) -> Option<CodeLanguage> {
    let args = patterns().command.captures(line)?.get(1)?.as_str();
    // This is only a display hint; no command is sent to the remote host.
    Some(
        args.split_whitespace()
            .filter(|arg| !arg.starts_with('-'))
            .find_map(|token| token.rsplit_once('.').map(|(_, ext)| language(ext)))
            .unwrap_or(CodeLanguage::Auto),
    )
}

fn infer(line: &str, next: Option<&String>) -> CodeLanguage {
    let text = line.trim();
    if patterns().html.is_match(text) {
        CodeLanguage::Html
    } else if [
        "fn ",
        "pub fn ",
        "pub struct ",
        "impl ",
        "use std::",
        "use crate::",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
        || (text.starts_with("struct ") && text.ends_with('{'))
    {
        CodeLanguage::Rust
    } else if patterns().csharp.is_match(text) && !text.ends_with(':') {
        CodeLanguage::CSharp
    } else if patterns().css.is_match(text) {
        CodeLanguage::Css
    } else if ["def ", "async def ", "from ", "import "]
        .iter()
        .any(|prefix| text.starts_with(prefix))
        || (text.starts_with("class ") && text.ends_with(':'))
    {
        CodeLanguage::Python
    } else if ["function ", "export ", "const ", "let ", "async function "]
        .iter()
        .any(|prefix| text.starts_with(prefix))
    {
        CodeLanguage::JavaScript
    } else if (text.starts_with('{') || text.starts_with('['))
        && (text.contains("\":")
            || text.contains("\" :")
            || next.is_some_and(|s| s.trim().starts_with('"') && s.contains(':')))
    {
        CodeLanguage::Json
    } else if text.starts_with("#!/") && (text.contains("sh") || text.contains("bash")) {
        CodeLanguage::Shell
    } else {
        CodeLanguage::Auto
    }
}

fn log_color(line: &str, palette: &TerminalPalette) -> Option<u32> {
    let level = patterns().level.captures(line)?.name("level")?;
    if line[level.end()..]
        .chars()
        .next()
        .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '(' || c == '=')
    {
        return None;
    }
    let index = match level.as_str().to_ascii_uppercase().as_str() {
        "ERROR" | "ERR" | "FATAL" | "CRITICAL" | "PANIC" | "FAILED" | "FAILURE" | "FAIL"
        | "错误" | "异常" | "失败" => 1,
        "WARN" | "WARNING" | "警告" => 3,
        "SUCCESS" | "OK" | "PASS" | "PASSED" | "DONE" | "成功" | "完成" => 2,
        "DEBUG" | "TRACE" | "调试" => 8,
        _ => 6,
    };
    Some(if index == 8 {
        palette.muted_foreground()
    } else {
        palette.ansi[index]
    })
}

/// Input is a bounded window of logical lines, including a little scrollback for parser context.
pub(crate) fn highlight(
    lines: &[String],
    settings: &TerminalHighlighting,
    palette: &TerminalPalette,
) -> Vec<Vec<HighlightSpan>> {
    let theme = theme(palette);
    let mut parser = None;
    let mut active = if settings.code {
        settings.language
    } else {
        CodeLanguage::Auto
    };
    let mut parsed_language = CodeLanguage::Auto;
    let mut fence = None;
    let mut continuation = None;
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            // Avoid pathological grammar work on minified files and huge pasted lines.
            if line.len() > 4096 {
                parser = None;
                parsed_language = CodeLanguage::Auto;
                if settings.logs
                    && fence.is_none()
                    && let Some(color) = log_color(line, palette)
                {
                    return vec![HighlightSpan {
                        bytes: 0..line.len(),
                        color,
                    }];
                }
                return Vec::new();
            }
            let trimmed = line.trim();
            let marker = if trimmed.starts_with("```") {
                Some("```")
            } else if trimmed.starts_with("~~~") {
                Some("~~~")
            } else {
                None
            };
            if let Some(marker) = marker {
                if fence == Some(marker) {
                    fence = None;
                    active = settings.language;
                } else if fence.is_none() {
                    fence = Some(marker);
                    active = language(trimmed[3..].split_whitespace().next().unwrap_or(""));
                }
                parser = None;
                parsed_language = CodeLanguage::Auto;
                continuation = None;
                return Vec::new();
            }
            if fence.is_none() && (patterns().prompt.is_match(line) || file_command(line).is_some())
            {
                active = if settings.code && settings.language == CodeLanguage::Auto {
                    file_command(line).unwrap_or(CodeLanguage::Auto)
                } else {
                    settings.language
                };
                parser = None;
                parsed_language = CodeLanguage::Auto;
                continuation = None;
                return Vec::new();
            }
            if settings.logs && fence.is_none() {
                if let Some(color) = log_color(line, palette) {
                    continuation = Some(color);
                    active = settings.language;
                    parser = None;
                    parsed_language = CodeLanguage::Auto;
                    return vec![HighlightSpan {
                        bytes: 0..line.len(),
                        color,
                    }];
                }
                if let Some(color) = continuation
                    && (line.starts_with(char::is_whitespace) || trimmed.starts_with("Caused by:"))
                    && (!settings.code || infer(line, lines.get(index + 1)) == CodeLanguage::Auto)
                    && !trimmed.is_empty()
                {
                    return vec![HighlightSpan {
                        bytes: 0..line.len(),
                        color,
                    }];
                }
            }
            continuation = None;
            if !settings.code {
                return Vec::new();
            }
            if active == CodeLanguage::Auto && fence.is_none() {
                active = infer(line, lines.get(index + 1));
            }
            let Some(ext) = extension(active) else {
                return Vec::new();
            };
            if parser.is_none() || parsed_language != active {
                let Some(syntax) = syntax_set().find_syntax_by_extension(ext) else {
                    return Vec::new();
                };
                parser = Some(HighlightLines::new(syntax, &theme));
                parsed_language = active;
            }
            let newline = format!("{line}\n");
            let Ok(regions) = parser
                .as_mut()
                .unwrap()
                .highlight_line(&newline, syntax_set())
            else {
                parser = None;
                return Vec::new();
            };
            let mut offset = 0;
            regions
                .into_iter()
                .filter_map(|(style, text)| {
                    let start = offset;
                    offset += text.len();
                    let color = u32::from(style.foreground.r) << 16
                        | u32::from(style.foreground.g) << 8
                        | u32::from(style.foreground.b);
                    (color != palette.foreground && start < line.len()).then_some(HighlightSpan {
                        bytes: start..offset.min(line.len()),
                        color,
                    })
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(lines: &[&str], row: usize, token: &str) -> Option<u32> {
        let text: Vec<String> = lines.iter().map(|s| (*s).into()).collect();
        let colors = highlight(
            &text,
            &TerminalHighlighting::default(),
            &TerminalPalette::default(),
        );
        let offset = lines[row].find(token).unwrap();
        colors[row]
            .iter()
            .find(|span| span.bytes.contains(&offset))
            .map(|span| span.color)
    }

    #[test]
    fn common_log_formats_and_chinese_levels_are_distinct_from_prose() {
        let palette = TerminalPalette::default();
        for (line, index) in [
            ("2026-11-27T11:20:30.123Z [ERROR] failed to connect", 1),
            ("2026-11-27 11:20:30,123 [main] WARN example - retry", 3),
            ("[INFO] listening on localhost", 6),
            ("hint: use --help", 6),
            ("SUCCESS all tests passed", 2),
            ("debug: reading config", 8),
            ("错误：连接失败", 1),
            ("警告：磁盘空间不足", 3),
            ("提示：正在重试", 6),
        ] {
            assert_eq!(
                log_color(line, &palette),
                Some(if index == 8 {
                    palette.muted_foreground()
                } else {
                    palette.ansi[index]
                }),
                "{line}"
            );
        }
        for plain in [
            "errorCount = 0",
            "Error()",
            "the warning flag",
            "information about files",
            "OKValue",
        ] {
            assert_eq!(log_color(plain, &palette), None, "{plain}");
        }
    }

    #[test]
    fn html_csharp_and_css_use_real_syntax_scopes() {
        let palette = TerminalPalette::default();
        let html = ["<html>", "<div class=\"notice\">你好</div>", "</html>"];
        assert_eq!(at(&html, 1, "div"), Some(palette.ansi[1]));
        assert_eq!(at(&html, 1, "class"), Some(palette.ansi[6]));
        assert_eq!(at(&html, 1, "notice"), Some(palette.ansi[2]));
        let cs = [
            "using System;",
            "public class Greeting {",
            "    public string Welcome() { return \"你好\"; }",
            "}",
        ];
        assert_eq!(at(&cs, 1, "public"), Some(palette.ansi[5]));
        assert_eq!(at(&cs, 1, "Greeting"), Some(palette.ansi[3]));
        assert_eq!(at(&cs, 2, "Welcome"), Some(palette.ansi[4]));
        assert_eq!(at(&cs, 2, "你好"), Some(palette.ansi[2]));
        let css = [".notice {", "  color: #ff0000;", "}"];
        assert!(at(&css, 1, "color").is_some());
    }

    #[test]
    fn fences_file_commands_and_prompts_reset_language_context() {
        let palette = TerminalPalette::default();
        let lines = [
            "demo@host:~$ cat 'Greeting.cs'",
            "public class Greeting {}",
            "demo@host:~$ cat page.html",
            "<div class=\"notice\">Hello</div>",
            "demo@host:~$",
            "ordinary text",
        ];
        assert_eq!(at(&lines, 1, "Greeting"), Some(palette.ansi[3]));
        assert_eq!(at(&lines, 3, "class"), Some(palette.ansi[6]));
        assert_eq!(at(&lines, 5, "ordinary"), None);
        let lines = [
            "```csharp",
            "public class Greeting {}",
            "```",
            "```html",
            "<div id=\"a\">Hello</div>",
            "```",
            "[WARN] slow connection",
        ];
        assert_eq!(at(&lines, 1, "Greeting"), Some(palette.ansi[3]));
        assert_eq!(at(&lines, 4, "id"), Some(palette.ansi[6]));
        assert_eq!(at(&lines, 6, "slow"), Some(palette.ansi[3]));
        assert_eq!(
            file_command(r#"PS C:\> Get-Content "C:\My Files\Greeting.cs" -Tail 20"#),
            Some(CodeLanguage::CSharp)
        );
        assert_eq!(file_command("tail -f app.log"), Some(CodeLanguage::Auto));
        assert_eq!(
            file_command("root@server:~# tail -n 100 Greeting.cs"),
            Some(CodeLanguage::CSharp)
        );
        assert_eq!(
            file_command("tail --follow=name --retry app.log"),
            Some(CodeLanguage::Auto)
        );
    }

    #[test]
    fn independent_switches_explicit_language_and_bounded_lines() {
        let palette = TerminalPalette::default();
        let lines = vec![
            "ERROR unavailable".into(),
            "public class Greeting {}".into(),
        ];
        let mut settings = TerminalHighlighting {
            logs: false,
            ..Default::default()
        };
        let spans = highlight(&lines, &settings, &palette);
        assert!(spans[0].is_empty());
        assert!(!spans[1].is_empty());
        settings.code = false;
        assert!(
            highlight(&lines, &settings, &palette)
                .iter()
                .all(Vec::is_empty)
        );
        settings.code = true;
        settings.language = CodeLanguage::Css;
        assert!(!highlight(&["color: #ff0000;".into()], &settings, &palette)[0].is_empty());
        assert!(highlight(&["x".repeat(65_536)], &settings, &palette)[0].is_empty());
    }
}
