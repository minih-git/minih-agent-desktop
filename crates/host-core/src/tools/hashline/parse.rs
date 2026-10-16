//! Patch language parser (spec 18 §7).

use std::path::PathBuf;

pub const MAX_OPS_BYTES: usize = 256 * 1024;
pub const MAX_OPS_PER_CALL: usize = 200;
pub const MAX_REGISTER_LINES: usize = 4096;
pub const MAX_REGISTER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Locator {
    Range { start: u32, end: u32 },
    Block { line: u32 },
    Before { line: u32 },
    After { line: u32 },
    End,
    AfterBlock { line: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedOp {
    Put {
        locator: Locator,
        body: Vec<String>,
        register: Option<String>,
    },
    Cut {
        locator: Locator,
        register: Option<String>,
    },
    Rem,
    Mv {
        dest: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOps {
    pub header_path: Option<String>,
    pub header_tag: Option<String>,
    pub ops: Vec<ParsedOp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub code: &'static str,
    pub message: String,
}

impl ParseError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn parse_ops(ops: &str) -> Result<ParsedOps, ParseError> {
    if ops.len() > MAX_OPS_BYTES {
        return Err(ParseError::new(
            "INVALID_ARGUMENT",
            format!("ops payload exceeds {MAX_OPS_BYTES} bytes"),
        ));
    }
    let mut lines: Vec<&str> = ops.split('\n').collect();
    if ops.ends_with('\n') {
        lines.pop();
    }
    let mut idx = 0;
    let mut header_path = None;
    let mut header_tag = None;
    if let Some(first) = lines.first() {
        if let Some((path, tag)) = super::tag::parse_section_header(first) {
            header_path = Some(path.to_string());
            header_tag = Some(tag.to_uppercase());
            idx = 1;
        }
    }

    let mut parsed = Vec::new();
    while idx < lines.len() {
        let raw = lines[idx];
        if raw.trim().is_empty() {
            idx += 1;
            continue;
        }
        if raw.starts_with('+') || raw.starts_with('-') {
            return Err(ParseError::new(
                "EDIT_PARSE_FAILED",
                format!(
                    "body or context row without a header at op line {}: {raw}",
                    idx + 1
                ),
            ));
        }
        let (op, colon) = parse_header(raw)?;
        idx += 1;
        match op {
            ParsedOp::Put {
                locator,
                mut body,
                register,
            } => {
                if colon {
                    if register.is_some() {
                        return Err(ParseError::new(
                            "EDIT_PARSE_FAILED",
                            "a register paste takes no body rows; drop the trailing colon",
                        ));
                    }
                    while idx < lines.len() {
                        let line = lines[idx];
                        if let Some(rest) = line.strip_prefix('+') {
                            body.push(rest.trim_end_matches('\r').to_string());
                            idx += 1;
                        } else {
                            break;
                        }
                    }
                    if body.is_empty() {
                        return Err(ParseError::new(
                            "EDIT_PARSE_FAILED",
                            "PUT with a colon requires at least one + body row; use CUT to delete",
                        ));
                    }
                    parsed.push(ParsedOp::Put {
                        locator,
                        body,
                        register: None,
                    });
                } else if register.is_none() {
                    let next_non_empty = lines[idx..]
                        .iter()
                        .find(|line| !line.trim().is_empty())
                        .copied();
                    if next_non_empty.is_some_and(|line| line.starts_with('+')) {
                        return Err(ParseError::new(
                            "EDIT_PARSE_FAILED",
                            format!(
                                "PUT header `{raw}` is missing a trailing `:` before + body rows; use `{raw}:`"
                            ),
                        ));
                    }
                    return Err(ParseError::new(
                        "EDIT_PARSE_FAILED",
                        "PUT without a body must paste a register (`PUT <1 @name`)",
                    ));
                } else {
                    parsed.push(ParsedOp::Put {
                        locator,
                        body: Vec::new(),
                        register,
                    });
                }
            }
            other => {
                if colon {
                    return Err(ParseError::new(
                        "EDIT_PARSE_FAILED",
                        "CUT/REM/MV take no body rows",
                    ));
                }
                parsed.push(other);
            }
        }
    }

    if parsed.is_empty() {
        return Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            "ops is empty; supply at least one PUT, CUT, REM, or MV",
        ));
    }
    if parsed.len() > MAX_OPS_PER_CALL {
        return Err(ParseError::new(
            "INVALID_ARGUMENT",
            format!("ops exceeds {MAX_OPS_PER_CALL} operations"),
        ));
    }
    Ok(ParsedOps {
        header_path,
        header_tag,
        ops: parsed,
    })
}

/// Recover a complete `ops` payload when a model splits a bodyless `PUT` header
/// in `ops` and places the replacement lines in `new_string`.
pub fn coalesce_split_put_body(ops: &str, new_string: &str) -> Option<String> {
    if parse_ops(ops).is_ok() {
        return None;
    }
    if parse_ops(new_string).is_ok() {
        return Some(new_string.to_string());
    }
    let header = ops.trim();
    if header.is_empty() || header.contains('\n') {
        return None;
    }
    let header_with_colon = if header.ends_with(':') {
        header.to_string()
    } else {
        format!("{header}:")
    };
    let mut raw_lines: Vec<&str> = new_string.split('\n').collect();
    if new_string.ends_with('\n') {
        raw_lines.pop();
    }
    let all_plus = !raw_lines.is_empty() && raw_lines.iter().all(|line| line.starts_with('+'));
    let body_lines: Vec<String> = raw_lines
        .into_iter()
        .map(|line| {
            let trimmed = line.trim_end_matches('\r');
            if all_plus {
                trimmed.to_string()
            } else {
                format!("+{trimmed}")
            }
        })
        .collect();
    let combined = format!("{header_with_colon}\n{}", body_lines.join("\n"));
    parse_ops(&combined).ok().map(|_| combined)
}

fn parse_header(raw: &str) -> Result<(ParsedOp, bool), ParseError> {
    let line = raw.trim_end_matches('\r');
    let trimmed = line.trim_end();
    if let Some((before_colon, after_colon)) = line.split_once(':') {
        let mut head_parts = before_colon.split_whitespace();
        if head_parts.next() == Some("PUT") {
            let locator_raw = head_parts
                .next()
                .ok_or_else(|| ParseError::new("EDIT_PARSE_FAILED", "PUT requires a locator"))?;
            let locator = parse_locator(locator_raw)?;
            let register = match head_parts.next() {
                Some(token) => Some(parse_register(token)?),
                None => None,
            };
            if head_parts.next().is_some() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    format!("unexpected token in PUT header: {raw}"),
                ));
            }
            let inline_trimmed = after_colon.trim_start();
            let body = if inline_trimmed.is_empty() {
                Vec::new()
            } else if inline_trimmed.starts_with('-') {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    format!("PUT body cannot contain - diff rows: {raw}"),
                ));
            } else if let Some(rest) = inline_trimmed.strip_prefix('+') {
                vec![rest.to_string()]
            } else {
                vec![after_colon.to_string()]
            };
            return Ok((
                ParsedOp::Put {
                    locator,
                    body,
                    register,
                },
                true,
            ));
        }
    }
    let colon = trimmed.ends_with(':');
    let core = if colon {
        trimmed[..trimmed.len() - 1].trim_end()
    } else {
        trimmed
    };
    let mut parts = core.split_whitespace();
    let kind = parts
        .next()
        .ok_or_else(|| ParseError::new("EDIT_PARSE_FAILED", "empty operation header"))?;
    match kind {
        "PUT" => {
            let locator_raw = parts
                .next()
                .ok_or_else(|| ParseError::new("EDIT_PARSE_FAILED", "PUT requires a locator"))?;
            let locator = parse_locator(locator_raw)?;
            let register = match parts.next() {
                Some(token) => Some(parse_register(token)?),
                None => None,
            };
            if parts.next().is_some() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    format!("unexpected token in PUT header: {raw}"),
                ));
            }
            Ok((
                ParsedOp::Put {
                    locator,
                    body: Vec::new(),
                    register,
                },
                colon,
            ))
        }
        "CUT" => {
            if colon {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "CUT takes no body; drop the colon",
                ));
            }
            let locator_raw = parts
                .next()
                .ok_or_else(|| ParseError::new("EDIT_PARSE_FAILED", "CUT requires a locator"))?;
            let locator = parse_locator(locator_raw)?;
            let register = match parts.next() {
                Some(token) => Some(parse_register(token)?),
                None => None,
            };
            if parts.next().is_some() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    format!("unexpected token in CUT header: {raw}"),
                ));
            }
            Ok((ParsedOp::Cut { locator, register }, false))
        }
        "REM" => {
            if colon {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "REM takes no body; drop the colon",
                ));
            }
            if parts.next().is_some() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "REM takes no arguments",
                ));
            }
            Ok((ParsedOp::Rem, false))
        }
        "MV" => {
            if colon {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "MV takes no body; drop the colon",
                ));
            }
            let rest = core.strip_prefix("MV").unwrap_or("").trim();
            if rest.is_empty() {
                return Err(ParseError::new(
                    "EDIT_PARSE_FAILED",
                    "MV requires a dest path",
                ));
            }
            let dest = parse_dest(rest)?;
            Ok((ParsedOp::Mv { dest }, false))
        }
        other => Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("unknown operation {other}; expected PUT, CUT, REM, or MV"),
        )),
    }
}

fn parse_locator(raw: &str) -> Result<Locator, ParseError> {
    if raw == ">$" {
        return Ok(Locator::End);
    }
    if let Some(rest) = raw.strip_prefix('<') {
        let line = parse_line(rest)?;
        return Ok(Locator::Before { line });
    }
    if let Some(rest) = raw.strip_prefix('>') {
        if let Some(line_raw) = rest.strip_suffix('*') {
            let line = parse_line(line_raw)?;
            return Ok(Locator::AfterBlock { line });
        }
        let line = parse_line(rest)?;
        return Ok(Locator::After { line });
    }
    if let Some(line_raw) = raw.strip_suffix('*') {
        let line = parse_line(line_raw)?;
        return Ok(Locator::Block { line });
    }
    if let Some((start, end)) = raw.split_once(".=") {
        let start = parse_line(start)?;
        let end = parse_line(end)?;
        if start > end {
            return Err(ParseError::new(
                "EDIT_RANGE_INVALID",
                format!("reversed range {start}.={end}"),
            ));
        }
        return Ok(Locator::Range { start, end });
    }
    Err(ParseError::new(
        "EDIT_PARSE_FAILED",
        format!("invalid locator {raw}; expected N.=M, N*, <N, >N, >$, or >N*"),
    ))
}

fn parse_line(raw: &str) -> Result<u32, ParseError> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) || raw.starts_with('0') {
        return Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("line number must be a positive integer, got {raw}"),
        ));
    }
    raw.parse::<u32>().map_err(|_| {
        ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("line number out of range: {raw}"),
        )
    })
}

fn parse_register(raw: &str) -> Result<String, ParseError> {
    let name = raw.strip_prefix('@').ok_or_else(|| {
        ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("register must start with @, got {raw}"),
        )
    })?;
    if name.is_empty()
        || name.len() > 32
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ParseError::new(
            "EDIT_PARSE_FAILED",
            format!("invalid register name {raw}"),
        ));
    }
    Ok(name.to_string())
}

fn parse_dest(raw: &str) -> Result<String, ParseError> {
    let dest = if (raw.starts_with('"') && raw.ends_with('"'))
        || (raw.starts_with('\'') && raw.ends_with('\''))
    {
        raw[1..raw.len() - 1].to_string()
    } else {
        raw.to_string()
    };
    if dest.is_empty() {
        return Err(ParseError::new("EDIT_PARSE_FAILED", "MV dest is empty"));
    }
    let path = PathBuf::from(&dest);
    if path.as_os_str().is_empty() {
        return Err(ParseError::new("EDIT_PARSE_FAILED", "MV dest is empty"));
    }
    Ok(dest)
}

#[allow(dead_code)]
pub fn mv_dest(ops: &ParsedOps) -> Option<&str> {
    ops.ops.iter().find_map(|op| match op {
        ParsedOp::Mv { dest } => Some(dest.as_str()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_range_put_and_gap_insert() {
        let parsed = parse_ops("PUT 2.=3:\n+new two\n+new three\nPUT >$:\n+tail\n").unwrap();
        assert_eq!(parsed.ops.len(), 2);
        match &parsed.ops[0] {
            ParsedOp::Put { locator, body, .. } => {
                assert_eq!(locator, &Locator::Range { start: 2, end: 3 });
                assert_eq!(body, &["new two".to_string(), "new three".to_string()]);
            }
            other => panic!("{other:?}"),
        }
        match &parsed.ops[1] {
            ParsedOp::Put { locator, body, .. } => {
                assert_eq!(locator, &Locator::End);
                assert_eq!(body, &["tail".to_string()]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rejects_minus_rows_and_empty_put() {
        assert_eq!(
            parse_ops("PUT 1.=1:\n-old\n+new\n").unwrap_err().code,
            "EDIT_PARSE_FAILED"
        );
        assert_eq!(
            parse_ops("PUT 1.=1:\n").unwrap_err().code,
            "EDIT_PARSE_FAILED"
        );
        assert_eq!(
            parse_ops("PUT 1.=1\n").unwrap_err().message,
            "PUT without a body must paste a register (`PUT <1 @name`)"
        );
    }

    #[test]
    fn explains_missing_put_body_delimiter() {
        let error = parse_ops("PUT 48.=48\n+replacement\n").unwrap_err();

        assert_eq!(error.code, "EDIT_PARSE_FAILED");
        assert_eq!(
            error.message,
            "PUT header `PUT 48.=48` is missing a trailing `:` before + body rows; use `PUT 48.=48:`"
        );
    }

    #[test]
    fn parses_cut_rem_mv_and_optional_header() {
        let parsed = parse_ops("[src/a.rs#AB12]\nCUT 4.=5\nMV dest.rs\n").unwrap();
        assert_eq!(parsed.header_path.as_deref(), Some("src/a.rs"));
        assert_eq!(parsed.header_tag.as_deref(), Some("AB12"));
        assert!(matches!(parsed.ops[0], ParsedOp::Cut { .. }));
        assert!(matches!(parsed.ops[1], ParsedOp::Mv { .. }));
        assert!(matches!(parse_ops("REM\n").unwrap().ops[0], ParsedOp::Rem));
    }

    #[test]
    fn parses_inline_put_body_and_trailing_whitespace_after_colon() {
        let direct = parse_ops("PUT 14.=14:export type Mode = \"a\" | \"b\";").unwrap();
        assert_eq!(
            direct.ops,
            vec![ParsedOp::Put {
                locator: Locator::Range { start: 14, end: 14 },
                body: vec!["export type Mode = \"a\" | \"b\";".to_string()],
                register: None,
            }]
        );

        let inline_plus = parse_ops(
            "PUT 18.=20: +  defaultBaseUrl: \"https://api.z.ai/api/paas/v4\",\n+  enabled: true,\n",
        )
        .unwrap();
        assert_eq!(
            inline_plus.ops,
            vec![ParsedOp::Put {
                locator: Locator::Range { start: 18, end: 20 },
                body: vec![
                    "  defaultBaseUrl: \"https://api.z.ai/api/paas/v4\",".to_string(),
                    "  enabled: true,".to_string(),
                ],
                register: None,
            }]
        );

        let trailing_ws = parse_ops("PUT 2.=2:   \n+replaced\n").unwrap();
        assert_eq!(
            trailing_ws.ops,
            vec![ParsedOp::Put {
                locator: Locator::Range { start: 2, end: 2 },
                body: vec!["replaced".to_string()],
                register: None,
            }]
        );
    }

    #[test]
    fn coalesces_split_put_header_and_new_string_body() {
        assert_eq!(
            coalesce_split_put_body("PUT <21:", "+  delete: \"Delete\",\n+  close: \"Close\","),
            Some("PUT <21:\n+  delete: \"Delete\",\n+  close: \"Close\",".to_string())
        );
        assert_eq!(
            coalesce_split_put_body("PUT 18.=20", "  line one\n  line two\n"),
            Some("PUT 18.=20:\n+  line one\n+  line two".to_string())
        );
        assert_eq!(
            coalesce_split_put_body("PUT 18.=20:", "PUT 18.=20:\n+  line one\n"),
            Some("PUT 18.=20:\n+  line one\n".to_string())
        );
    }
}
