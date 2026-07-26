pub mod config;
pub mod format;

use wasm_bindgen::prelude::*;
use format::{AdapterFactory, TranslationAdapterFactory};

#[wasm_bindgen]
pub fn parse_format(format_name: &str, source: &str) -> String {
    let factory = AdapterFactory;
    match factory.create_adapter(format_name) {
        Ok(adapter) => match adapter.load(source) {
            Ok(translations) => serde_json::to_string(&translations).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => serde_json::to_string(&serde_json::json!({ "error": e })).unwrap_or_else(|_| "{\"error\":\"Error\"}".to_string()),
        },
        Err(e) => serde_json::to_string(&serde_json::json!({ "error": e })).unwrap_or_else(|_| "{\"error\":\"Error\"}".to_string()),
    }
}

#[wasm_bindgen]
pub fn parse_fluent(source: &str) -> String {
    parse_format("fluent", source)
}

#[wasm_bindgen]
pub fn parse_config(json: &str) -> String {
    match config::ProjectConfig::parse(json) {
        Ok(c) => serde_json::to_string(&c).unwrap_or_else(|_| "{}".to_string()),
        Err(e) => serde_json::to_string(&serde_json::json!({ "error": e })).unwrap_or_else(|_| "{\"error\":\"Error\"}".to_string()),
    }
}

#[wasm_bindgen]
pub fn serialize_format(format_name: &str, items_json: &str, original_source: &str) -> String {
    let factory = AdapterFactory;
    let items: Result<Vec<format::TranslationItem>, _> = serde_json::from_str(items_json);
    match items {
        Ok(items) => {
            let translations = format::ProjectTranslations { items };
            match factory.create_adapter(format_name) {
                Ok(adapter) => match adapter.save(&translations, original_source) {
                    Ok(s) => s,
                    Err(e) => format!("Error: {}", e),
                },
                Err(e) => format!("Error: {}", e),
            }
        }
        Err(e) => format!("Error parsing JSON: {}", e),
    }
}

#[wasm_bindgen]
pub fn serialize_fluent(items_json: &str, original_source: &str) -> String {
    serialize_format("fluent", items_json, original_source)
}
