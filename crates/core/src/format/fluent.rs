use super::{ProjectTranslations, TranslationAdapter, TranslationItem};
use fluent_syntax::ast::Entry;
use fluent_syntax::parser::parse;

pub struct FluentAdapter;

impl TranslationAdapter for FluentAdapter {
    fn load(&self, source: &str) -> Result<ProjectTranslations, String> {
        let resource = parse(source)
            .map_err(|e| format!("Parse error: {:?}", e.1))?;

        let mut items = Vec::new();

        for entry in resource.body {
            if let Entry::Message(msg) = entry {
                let key = msg.id.name.to_string();
                let mut value_str = String::new();

                if let Some(pattern) = msg.value {
                    for element in pattern.elements {
                        match element {
                            fluent_syntax::ast::PatternElement::TextElement { value } => {
                                value_str.push_str(value);
                            }
                            fluent_syntax::ast::PatternElement::Placeable { expression } => {
                                match expression {
                                    fluent_syntax::ast::Expression::Inline(inline) => match inline {
                                        fluent_syntax::ast::InlineExpression::VariableReference { id } => {
                                            value_str.push_str("{ $");
                                            value_str.push_str(id.name);
                                            value_str.push_str(" }");
                                        }
                                        fluent_syntax::ast::InlineExpression::StringLiteral { value } => {
                                            value_str.push_str("{ \"");
                                            value_str.push_str(value);
                                            value_str.push_str("\" }");
                                        }
                                        fluent_syntax::ast::InlineExpression::NumberLiteral { value } => {
                                            value_str.push_str("{ ");
                                            value_str.push_str(value);
                                            value_str.push_str(" }");
                                        }
                                        fluent_syntax::ast::InlineExpression::MessageReference { id, attribute } => {
                                            value_str.push_str("{ ");
                                            value_str.push_str(id.name);
                                            if let Some(attr) = attribute {
                                                value_str.push('.');
                                                value_str.push_str(attr.name);
                                            }
                                            value_str.push_str(" }");
                                        }
                                        fluent_syntax::ast::InlineExpression::TermReference { id, attribute, arguments: _ } => {
                                            value_str.push_str("{ -");
                                            value_str.push_str(id.name);
                                            if let Some(attr) = attribute {
                                                value_str.push('.');
                                                value_str.push_str(attr.name);
                                            }
                                            value_str.push_str(" }");
                                        }
                                        fluent_syntax::ast::InlineExpression::FunctionReference { id, arguments: _ } => {
                                            value_str.push_str("{ ");
                                            value_str.push_str(id.name);
                                            value_str.push_str("(...) }");
                                        }
                                        fluent_syntax::ast::InlineExpression::Placeable { .. } => {
                                            value_str.push_str("{ ... }");
                                        }
                                    },
                                    fluent_syntax::ast::Expression::Select { selector: _, variants: _ } => {
                                        value_str.push_str("{ ... }");
                                    }
                                }
                            }
                        }
                    }
                }
                items.push(TranslationItem {
                    key,
                    value: value_str,
                });
            }
        }

        Ok(ProjectTranslations { items })
    }

    fn save(
        &self,
        translations: &ProjectTranslations,
        original_source: &str,
    ) -> Result<String, String> {
        let mut lines: Vec<String> = original_source.lines().map(|s| s.to_string()).collect();
        let mut updated_keys = std::collections::HashSet::new();

        for i in 0..lines.len() {
            let line = lines[i].trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if let Some(eq_idx) = lines[i].find('=') {
                let key = lines[i][..eq_idx].trim().to_string();
                if let Some(item) = translations.items.iter().find(|it| it.key == key) {
                    lines[i] = format!("{} = {}", key, item.value);
                    updated_keys.insert(key);
                }
            }
        }

        for item in &translations.items {
            if !updated_keys.contains(&item.key) {
                lines.push(format!("{} = {}", item.key, item.value));
            }
        }

        let mut result = lines.join("\n");
        if original_source.ends_with('\n') && !result.ends_with('\n') {
            result.push('\n');
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_fluent() {
        let ftl = "hello-title = Hello, world!\nwelcome = Welcome { $user }";
        let adapter = FluentAdapter;
        let result = adapter.load(ftl).expect("Failed to parse fluent source");
        assert_eq!(result.items.len(), 2);
        assert_eq!(result.items[0].key, "hello-title");
        assert_eq!(result.items[0].value, "Hello, world!");
        assert_eq!(result.items[1].key, "welcome");
        assert_eq!(result.items[1].value, "Welcome { $user }");
    }
}
