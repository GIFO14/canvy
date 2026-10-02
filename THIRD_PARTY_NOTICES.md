# Third-party notices

- [OpenPencil](https://github.com/open-pencil/open-pencil), 0.15.1: Copyright (c) 2026 Danila Poyarkov and OpenPencil contributors. MIT; `licenses/OpenPencil-MIT.txt`.
- [CanvasKit / Skia](https://skia.org/docs/user/modules/canvaskit/), 0.41.1: Copyright (c) 2011 Google Inc. BSD-style license; `licenses/CanvasKit-BSD.txt`. The renderer and WASM are bundled in the native UI.
- [Inter](https://github.com/rsms/inter): Copyright (c) 2016 The Inter Project Authors. SIL Open Font License 1.1; `licenses/Inter-OFL.txt`. Five font weights are bundled without changes.
- [Roboto](https://github.com/google/fonts/tree/main/ofl/roboto): Copyright 2011 The Roboto Project Authors. SIL Open Font License 1.1; `licenses/Roboto-OFL.txt`. Five static weights are instantiated from the variable font with `scripts/build-roboto.py` and bundled for offline rendering.
- [Phosphor Icons](https://github.com/phosphor-icons/vue), 2.2.1: MIT; `licenses/Phosphor-MIT.txt`.
- React and React DOM, 19.3.0 (MIT), esbuild (MIT), Tailwind CSS and its PostCSS plugin, 4.3.3 (MIT), PostCSS (MIT) and Playwright, 1.62.1 (Apache-2.0): frontend capture dependencies. Their package license notices are retained in `node_modules`; Chromium is installed separately by Playwright.

Additional npm dependencies and their transitive dependencies remain subject to their own license notices in their packages. Canvy is an independent integration and is not affiliated with MagicPath or OpenAI.
