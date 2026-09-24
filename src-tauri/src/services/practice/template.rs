//! Minimal `{{var}}` / `{{#if var}}…{{/if}}` renderer for prompt templates.

/// Renders a template. `{{#if x}}…{{/if}}` blocks are kept when `x` is non-empty
/// (whitespace-only counts as empty). Unknown variables render as empty text.
pub fn render(template: &str, vars: &[(&str, String)]) -> String {
    let lookup = |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str()).unwrap_or("");
    let mut text = template.to_string();
    // Conditionals (non-nested).
    while let Some(start) = text.find("{{#if ") {
        let Some(tag_end) = text[start..].find("}}").map(|i| start + i) else { break };
        let name = text[start + 6..tag_end].trim().to_string();
        let Some(close) = text[tag_end..].find("{{/if}}").map(|i| tag_end + i) else { break };
        let inner = text[tag_end + 2..close].to_string();
        let mut after = close + "{{/if}}".len();
        let keep = !lookup(&name).trim().is_empty();
        // Swallow the newline after the block so tags leave no blank lines.
        if text[after..].starts_with('\n') {
            after += 1;
        }
        let replacement = if keep { inner.trim_start_matches('\n').to_string() } else { String::new() };
        text.replace_range(start..after, &replacement);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        match rest[i..].find("}}") {
            Some(j) => {
                out.push_str(lookup(rest[i + 2..i + j].trim()));
                rest = &rest[i + j + 2..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn vars_and_conditionals() {
        let t = "Hi {{name}}!\n{{#if s}}\nStruggles:\n{{s}}\n{{/if}}\nEnd {{missing}}.";
        assert_eq!(render(t, &[("name", "Ana".into()), ("s", "- loops".into())]), "Hi Ana!\nStruggles:\n- loops\nEnd .");
        assert_eq!(render(t, &[("name", "Ana".into()), ("s", " ".into())]), "Hi Ana!\nEnd .");
    }

    #[test]
    fn values_are_not_reinterpreted() {
        // A value containing braces must not be expanded again.
        assert_eq!(render("{{a}}", &[("a", "{{b}}".into()), ("b", "x".into())]), "{{b}}");
    }
}
