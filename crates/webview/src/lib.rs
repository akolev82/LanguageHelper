#![allow(non_snake_case, dead_code)]
use dioxus::prelude::*;

pub fn launch_app() {
  dioxus::launch(App);
}

pub fn App() -> Element {
  rsx! {
      div {
          class: "translation-grid",
          h1 { "Translation Editor" }
          // TODO: Render grid based on data from extension host
      }
  }
}
