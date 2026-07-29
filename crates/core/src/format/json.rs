use super::{ProjectTranslations, TranslationAdapter, TranslationItem};
use serde_json::Value;

pub struct JsonAdapter;

fn flatten_json(prefix: &str, value: &Value, items: &mut Vec<TranslationItem>) {
  match value {
    Value::Object(map) => {
      for (k, v) in map {
        let new_prefix = if prefix.is_empty() { k.clone() } else { format!("{}.{}", prefix, k) };
        flatten_json(&new_prefix, v, items);
      }
    }
    Value::String(s) => {
      items.push(TranslationItem { key: prefix.to_string(), value: s.clone() });
    }
    Value::Number(n) => {
      items.push(TranslationItem { key: prefix.to_string(), value: n.to_string() });
    }
    Value::Bool(b) => {
      items.push(TranslationItem { key: prefix.to_string(), value: b.to_string() });
    }
    _ => {}
  }
}

fn set_nested_value(root: &mut Value, key_path: &str, val_str: &str) {
  let parts: Vec<&str> = key_path.split('.').collect();
  let mut curr = root;
  for (i, part) in parts.iter().enumerate() {
    if i == parts.len() - 1 {
      if let Value::Object(map) = curr {
        map.insert((*part).to_string(), Value::String(val_str.to_string()));
      }
    } else {
      if !curr.is_object() {
        *curr = Value::Object(serde_json::Map::new());
      }
      curr = curr.as_object_mut().unwrap().entry((*part).to_string()).or_insert_with(|| Value::Object(serde_json::Map::new()));
    }
  }
}

impl TranslationAdapter for JsonAdapter {
  fn load(&self, source: &str) -> Result<ProjectTranslations, String> {
    if source.trim().is_empty() {
      return Ok(ProjectTranslations { items: Vec::new() });
    }
    let value: Value = serde_json::from_str(source).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    flatten_json("", &value, &mut items);
    Ok(ProjectTranslations { items })
  }

  fn save(&self, translations: &ProjectTranslations, original_source: &str) -> Result<String, String> {
    let mut root: Value = if original_source.trim().is_empty() { Value::Object(serde_json::Map::new()) } else { serde_json::from_str(original_source).unwrap_or_else(|_| Value::Object(serde_json::Map::new())) };

    for item in &translations.items {
      set_nested_value(&mut root, &item.key, &item.value);
    }

    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_json_adapter() {
    let source = r#"{ "app": { "title": "Hello" }, "count": 5 }"#;
    let adapter = JsonAdapter;
    let res = adapter.load(source).unwrap();
    assert_eq!(res.items.len(), 2);
    assert_eq!(res.items[0].key, "app.title");
    assert_eq!(res.items[0].value, "Hello");

    let saved = adapter.save(&res, source).unwrap();
    assert!(saved.contains("Hello"));
  }
}
