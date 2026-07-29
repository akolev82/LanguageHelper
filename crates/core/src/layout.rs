use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenType {
  Constant,
  Locale,
  File,
  Variable,
  ChangeDirectory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedToken {
  #[serde(rename = "type")]
  pub token_type: TokenType,
  #[serde(rename = "value")]
  pub value: String,
  #[serde(rename = "next")]
  pub next: Option<Box<ParsedToken>>,
}

impl ParsedToken {
  pub fn new(token_type: TokenType, value: Option<String>) -> Self {
    Self { token_type, value: value.unwrap_or_default(), next: None }
  }

  pub fn value(&self) -> &str {
    &self.value
  }

  pub fn get_next(&self) -> Option<&ParsedToken> {
    self.next.as_deref()
  }

  pub fn add_next(&mut self, next_token: ParsedToken) -> &mut ParsedToken {
    self.next = Some(Box::new(next_token));
    self.next.as_mut().unwrap()
  }

  pub fn is_empty(&self) -> bool {
    self.value.is_empty()
  }

  pub fn concat_value(&mut self, val: &str) {
    self.value.push_str(val);
  }

  pub fn close(&mut self) {
    if self.token_type == TokenType::Variable {
      if self.value == "locale" {
        self.token_type = TokenType::Locale;
      } else if self.value == "file" {
        self.token_type = TokenType::File;
      }
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathItem {
  pub root_token: Option<Box<ParsedToken>>,
  pub next: Option<Box<PathItem>>,
}

impl PathItem {
  pub fn new(root_token: Option<Box<ParsedToken>>, next: Option<Box<PathItem>>) -> Self {
    Self { root_token, next }
  }

  pub fn get_root_token(&self) -> Option<&ParsedToken> {
    self.root_token.as_deref()
  }

  pub fn get_next_path(&self) -> Option<&PathItem> {
    self.next.as_deref()
  }

  pub fn has_next_path(&self) -> bool {
    self.next.is_some()
  }

  pub fn add_next_path(&mut self, next_path: PathItem) -> &mut PathItem {
    self.next = Some(Box::new(next_path));
    self.next.as_mut().unwrap()
  }
}

pub fn compile_layout(layout_item: &str) -> Result<PathItem, String> {
  let clean_layout = layout_item.trim_start_matches("./").replace('\\', "/");

  let first_token = ParsedToken::new(TokenType::Constant, None);
  let mut root_path = PathItem::new(Some(Box::new(first_token)), None);
  let mut current_path = &mut root_path;
  let mut current_token = current_path.root_token.as_deref_mut().unwrap();
  let mut is_variable = false;

  for ch in clean_layout.chars() {
    if ch == '{' {
      if is_variable {
        return Err("Invalid layout: nested variables are not allowed".to_string());
      }
      current_token.close();
      if current_token.is_empty() && current_token.token_type == TokenType::Constant {
        current_token.token_type = TokenType::Variable;
      } else {
        current_token = current_token.add_next(ParsedToken::new(TokenType::Variable, None));
      }
      is_variable = true;
      continue;
    }

    if ch == '}' {
      if !is_variable {
        return Err("Invalid layout: unexpected closing brace".to_string());
      }
      current_token.close();
      is_variable = false;
      continue;
    }

    if ch == '/' && !is_variable {
      current_token.close();
      let next_root = ParsedToken::new(TokenType::Constant, None);
      current_path = current_path.add_next_path(PathItem::new(Some(Box::new(next_root)), None));
      current_token = current_path.root_token.as_deref_mut().unwrap();
      continue;
    }

    if !is_variable && current_token.token_type != TokenType::Constant {
      if current_token.is_empty() {
        current_token.token_type = TokenType::Constant;
      } else {
        current_token = current_token.add_next(ParsedToken::new(TokenType::Constant, None));
      }
    }

    current_token.concat_value(&ch.to_string());
  }

  if is_variable {
    return Err("Invalid layout: unclosed variable brace".to_string());
  }

  current_token.close();

  Ok(root_path)
}

pub struct PathCursor<'a> {
  current_path: Option<&'a PathItem>,
  current_token: Option<&'a ParsedToken>,
}

impl<'a> PathCursor<'a> {
  pub fn new(root: &'a PathItem) -> Self {
    Self { current_path: Some(root), current_token: root.get_root_token() }
  }

  pub fn has_next(&self) -> bool {
    self.current_token.is_some() || self.current_path.map_or(false, |p| p.has_next_path())
  }
}

impl<'a> Iterator for PathCursor<'a> {
  type Item = &'a ParsedToken;

  fn next(&mut self) -> Option<Self::Item> {
    if let Some(token) = self.current_token {
      self.current_token = token.get_next();
      Some(token)
    } else if let Some(path) = self.current_path {
      self.current_path = path.get_next_path();
      if let Some(next_path) = self.current_path {
        self.current_token = next_path.get_root_token();
        self.next()
      } else {
        None
      }
    } else {
      None
    }
  }
}

pub fn get_layout_glob(layout_item: &str, locales: &[String]) -> String {
  let clean_layout = layout_item.trim_start_matches("./").replace('\\', "/");
  match compile_layout(&clean_layout) {
    Ok(root_path) => {
      let mut glob = String::new();
      let mut curr_path = Some(&root_path);
      let mut first_path = true;

      let locale_glob = "*".to_string();

      while let Some(path) = curr_path {
        if !first_path {
          glob.push('/');
        }
        first_path = false;

        let mut curr_token = path.root_token.as_deref();
        while let Some(node) = curr_token {
          match node.token_type {
            TokenType::Constant | TokenType::ChangeDirectory => glob.push_str(&node.value),
            TokenType::Locale => glob.push_str(&locale_glob),
            TokenType::File | TokenType::Variable => glob.push('*'),
          }
          curr_token = node.next.as_deref();
        }
        curr_path = path.next.as_deref();
      }
      glob
    }
    Err(_) => {
      let fallback_locale = if locales.is_empty() {
        "*"
      } else if locales.len() == 1 {
        &locales[0]
      } else {
        "*"
      };
      clean_layout.replace("{locale}", fallback_locale).replace("{file}", "*")
    }
  }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MatchedFileInfo {
  pub relative_path: String,
  pub locale: String,
  pub file_basename: String,
}

pub fn normalize_layout_path(path: &str) -> String {
  let s = path.replace('\\', "/");
  let mut trimmed = s.as_str();
  loop {
    if trimmed.starts_with("./") {
      trimmed = &trimmed[2..];
    } else if trimmed.starts_with('/') {
      trimmed = &trimmed[1..];
    } else {
      break;
    }
  }
  trimmed.to_string()
}

pub fn build_layout_regex(layout_item: &str, locales: &[String]) -> Result<Regex, String> {
  let clean_layout = normalize_layout_path(layout_item);
  let root_path = compile_layout(&clean_layout)?;
  let mut pattern = String::from("^");
  let mut curr_path = Some(&root_path);
  let mut first_path = true;

  let locale_regex_part = if locales.is_empty() {
    "(?P<locale>[^/]+)".to_string()
  } else {
    let escaped: Vec<String> = locales.iter().map(|s| regex::escape(s)).collect();
    format!("(?P<locale>{})", escaped.join("|"))
  };

  while let Some(path) = curr_path {
    if !first_path {
      pattern.push('/');
    }
    first_path = false;

    let mut curr_token = path.root_token.as_deref();
    while let Some(node) = curr_token {
      match node.token_type {
        TokenType::Constant | TokenType::ChangeDirectory => pattern.push_str(&regex::escape(&node.value)),
        TokenType::Locale => pattern.push_str(&locale_regex_part),
        TokenType::File => pattern.push_str("(?P<file>.+)"),
        TokenType::Variable => pattern.push_str("([^/]+)"),
      }
      curr_token = node.next.as_deref();
    }
    curr_path = path.next.as_deref();
  }
  pattern.push('$');
  Regex::new(&pattern).map_err(|e| e.to_string())
}

pub fn match_layout_files(layout_item: &str, relative_paths: &[String], locales: &[String]) -> Vec<MatchedFileInfo> {
  let mut matched = Vec::new();
  let re = match build_layout_regex(layout_item, locales) {
    Ok(re) => re,
    Err(_) => return matched,
  };

  for path in relative_paths {
    let clean_path = normalize_layout_path(path);
    if let Some(caps) = re.captures(&clean_path) {
      let locale = caps.name("locale").map_or("", |m| m.as_str()).to_string();
      let file_basename = caps.name("file").map_or("", |m| m.as_str()).to_string();
      matched.push(MatchedFileInfo { relative_path: clean_path, locale, file_basename });
    }
  }

  matched
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_compile_layout() {
    let path_item = compile_layout("translations/locales/loc_{locale}/prefix_{file}.ftl").unwrap();
    let token1 = path_item.get_root_token().unwrap();
    assert_eq!(token1.token_type, TokenType::Constant);
    assert_eq!(token1.value, "translations");

    let path2 = path_item.get_next_path().unwrap();
    let token2 = path2.get_root_token().unwrap();
    assert_eq!(token2.token_type, TokenType::Constant);
    assert_eq!(token2.value, "locales");

    let path3 = path2.get_next_path().unwrap();
    let token31 = path3.get_root_token().unwrap();
    assert_eq!(token31.token_type, TokenType::Constant);
    assert_eq!(token31.value, "loc_");
    let token32 = token31.get_next().unwrap();
    assert_eq!(token32.token_type, TokenType::Locale);
    assert_eq!(token32.value, "locale");

    let path4 = path3.get_next_path().unwrap();
    let token41 = path4.get_root_token().unwrap();
    assert_eq!(token41.token_type, TokenType::Constant);
    assert_eq!(token41.value, "prefix_");
    let token42 = token41.get_next().unwrap();
    assert_eq!(token42.token_type, TokenType::File);
    assert_eq!(token42.value, "file");

    let dot_ftl = token42.get_next().unwrap();
    assert_eq!(dot_ftl.token_type, TokenType::Constant);
    assert_eq!(dot_ftl.value, ".ftl");

    let glob = get_layout_glob("translations/locales/{locale}/{file}.ftl", &[]);
    assert_eq!(glob, "translations/locales/*/*.ftl");

    let glob_filtered = get_layout_glob("translations/locales/{locale}/{file}.ftl", &["en".to_string(), "fr".to_string()]);
    assert_eq!(glob_filtered, "translations/locales/*/*.ftl");

    let files = vec!["translations/locales/en_US/main.ftl".to_string(), "translations/locales/fr_FR/settings.ftl".to_string(), "translations/locales/de_DE/ignored.ftl".to_string(), "other/file.txt".to_string()];
    let locales = vec!["en_US".to_string(), "fr_FR".to_string()];
    let matched = match_layout_files("translations/locales/{locale}/{file}.ftl", &files, &locales);
    assert_eq!(matched.len(), 2);
    assert_eq!(matched[0].locale, "en_US");
    assert_eq!(matched[0].file_basename, "main");
    assert_eq!(matched[1].locale, "fr_FR");
    assert_eq!(matched[1].file_basename, "settings");
  }

  #[test]
  fn test_path_cursor_token_iteration() {
    let root = compile_layout("locales/{locale}/{file}.ftl").unwrap();
    let mut cursor = PathCursor::new(&root);

    assert!(cursor.has_next());
    let t1 = cursor.next().unwrap();
    assert_eq!(t1.token_type, TokenType::Constant);
    assert_eq!(t1.value, "locales");

    assert!(cursor.has_next());
    let t2 = cursor.next().unwrap();
    assert_eq!(t2.token_type, TokenType::Locale);
    assert_eq!(t2.value, "locale");

    assert!(cursor.has_next());
    let t3 = cursor.next().unwrap();
    assert_eq!(t3.token_type, TokenType::File);
    assert_eq!(t3.value, "file");

    assert!(cursor.has_next());
    let t4 = cursor.next().unwrap();
    assert_eq!(t4.token_type, TokenType::Constant);
    assert_eq!(t4.value, ".ftl");

    assert!(!cursor.has_next());
    assert!(cursor.next().is_none());
  }
}
