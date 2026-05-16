---
name: hyperframes-etheroi
description: Full-stack AI-powered video production suite. Includes scaffolding, linting, visual inspection, rendering, and advanced media processing (TTS with Kokoro, Whisper transcription, AI Background Removal). Use this skill to manage the entire lifecycle of a HyperFrames project from concept to final MP4/WebM delivery.
---

# HyperFrames Etheroi

HyperFrames is a professional video production framework that treats video as code. It allows authors to build cinematic, data-driven compositions using standard web technologies (HTML, CSS, JS) and render them into high-fidelity video files.

## 🚀 Quick Start Workflow

1. **Scaffold**: `npx hyperframes init my-video` (creates structure and downloads AI assets)
2. **Author**: Edit `index.html` and compositions using HTML/CSS and GSAP/Anime.js
3. **Verify**: 
   - `npx hyperframes lint` (structural check)
   - `npx hyperframes inspect` (visual layout audit)
4. **Preview**: `npx hyperframes preview` (hot-reloading Studio preview)
5. **Render**: `npx hyperframes render --quality high` (final export)

---

## 🛠 Core CLI Capabilities

All commands are executed via `npx hyperframes`.

### 1. Scaffolding & Project Setup
`npx hyperframes init <name>` is the primary entry point. It handles:
- Directory structure creation.
- Media asset organization.
- Initial Whisper transcription of audio files.
- Example template application (e.g., `--example warm-grain`).

### 2. Quality Assurance (The Guardrails)
HyperFrames uses a "Lint-then-Inspect" philosophy to prevent render-time surprises:
- **Linting (`lint`)**: Catches missing IDs, overlapping tracks, and schema errors.
- **Visual Inspection (`inspect`)**: Uses headless Chrome to sweep the timeline and detect text overflows, clipping, or canvas escapes. Use `--json` for agent-readable reports.

### 3. Rendering Pipeline
Renders are performed by capturing frames from a headless browser and encoding them via FFmpeg.
- **Formats**: MP4 (standard), WebM (supports transparency).
- **Quality**: `draft` (fast), `standard` (review), `high` (delivery).
- **Variables**: Use `--variables '{"key":"value"}'` to override composition variables without changing the source code.

---

## 🎙 AI Media Suite (The "Powerhouse")

HyperFrames integrates state-of-the-art AI models for asset generation.

### Text-to-Speech (TTS)
Generate fluid, natural narration in multiple languages.
- **Kokoro-82M**: Ultra-fast, lightweight synthesis via ONNX.
  - **Specialty**: High-fidelity fluency in Spanish (`es`), English (`en`), and other major languages.
  - **Recommended Voice**: `ef_dora` (Spanish), `af_heart` (English).
  - **Usage**: The default high-performance engine for all narration tasks.

### Transcription & Captions
- **Whisper**: Automatic speech-to-text with word-level timestamps.
- **Captions**: The CLI automatically generates caption files that can be styled directly in CSS within the composition.

### Visual Effects
- **Background Removal**: AI-powered removal of backgrounds from video clips, outputting transparent WebM/ProRes files for layering.

---

## 🎨 Design & Composition

Compositions are built as web pages.
- **Animations**: Full support for **GSAP** and **Anime.js**.
- **Styling**: Compatible with **Tailwind CSS** (v4 browser runtime).
- **Architecture**: Use the `data-composition-id` and `data-timeline` attributes to define the video structure.

---

## 🩺 Environment & Troubleshooting

If rendering or synthesis fails, use the diagnostic tools:
- `npx hyperframes doctor`: Checks for FFmpeg, Chrome, Node.js version, and available memory.
- `npx hyperframes browser`: Manages the bundled Chrome instance used for rendering.
- `npx hyperframes info`: Displays current version and system environment.

## 📦 Installation as a Skill
To add this capability to your AI agent:
```bash
npx skills add developerjeremylive/hyperframes-etheroi
```
