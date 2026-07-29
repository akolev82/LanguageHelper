pub mod fluent;
pub mod json;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationItem {
  pub key: String,
  pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectTranslations {
  pub items: Vec<TranslationItem>,
}

pub trait TranslationAdapter {
  fn load(&self, source: &str) -> Result<ProjectTranslations, String>;
  fn save(&self, translations: &ProjectTranslations, original_source: &str) -> Result<String, String>;
}

pub trait TranslationAdapterFactory {
  fn create_adapter(&self, format: &str) -> Result<Box<dyn TranslationAdapter>, String>;
}

pub struct AdapterFactory;

impl TranslationAdapterFactory for AdapterFactory {
  fn create_adapter(&self, format: &str) -> Result<Box<dyn TranslationAdapter>, String> {
    match format.to_lowercase().as_str() {
      "fluent" | "ftl" => Ok(Box::new(fluent::FluentAdapter)),
      "json" => Ok(Box::new(json::JsonAdapter)),
      _ => Err(format!("Unsupported translation format: {}", format)),
    }
  }
}
