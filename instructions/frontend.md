# [App name] — Frontend Specification

A local-first learning tracker and emotional diary for new programmers.
This document covers everything the user sees and touches. The companion file
`backend.md` covers data, storage, the insight engine, AI integration and export.

---

## 1. Product summary

New coders start with high motivation, shadow tutorials for a few days, and quit
around day 3. The app fights that by making the learning loop visible:

1. **Log** what you learned today, in your own words.
2. **Practice** it with problems generated from your own concept list.
3. **Reflect** on how it felt, and see evidence that struggle is followed by progress.

The app does **not** include a code editor or compiler. Users code in whatever
editor they already use; the app tracks time, concepts, problems and feelings.

### Guiding principles

- **Logging a full day must take under 2 minutes.** If a feature adds friction to
  daily logging, it gets redesigned or cut.
- **The home screen always shows one obvious next action.**
- **Kind by default.** Copy never shames. A bad day still counts toward a streak
  if anything was logged.
- **Private by default.** Nothing leaves the device unless the user explicitly
  copies it, exports it, or configures an AI model.

---

## 2. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | Tauri 2 | Desktop app for Windows, macOS, Linux. Small installers. |
| UI framework | React 18 + TypeScript (strict) | |
| Build tool | Vite | |
| Routing | React Router (hash or memory router) | Desktop app, no server URLs. |
| Server/data state | TanStack Query | Wraps calls to the data layer; handles caching and invalidation. |
| Local UI state | Zustand | Active timers, UI preferences, draft diary text. |
| Styling | CSS Modules + CSS custom properties (design tokens) | No utility framework needed; tokens keep themes consistent. |
| Charts | Recharts | Line, bar, area. Heatmap is a custom component. |
| Forms | React Hook Form + Zod | Zod schemas are shared with the data layer. |
| Dates | date-fns | Day boundary logic lives in one helper. |
| Icons | Lucide React | Stroke icons, consistent with the mockups. |
| PDF | @react-pdf/renderer | Report templates are React components. |
| Testing | Vitest, React Testing Library, Playwright (via `tauri-driver`) | |
| Lint/format | ESLint, Prettier, TypeScript strict mode | |

---

## 3. Design system

### 3.1 Color tokens

Two colors carry meaning everywhere:
**teal = progress** (time, problems, usefulness), **orange = feelings** (mood, emotion tags, struggles).
Charts that show both must also differ by line style (solid vs dashed) so meaning never relies on color alone.

```css
:root {
  /* Surfaces */
  --bg:            #F6F3EC;  /* paper */
  --surface:       #FFFFFF;
  --surface-warm:  #FFFDF8;  /* diary cards */
  --sidebar:       #1F2A2B;
  --sidebar-active:#33474A;

  /* Text */
  --ink:           #1E1D1A;
  --ink-soft:      #3F3B34;
  --muted:         #5E5A52;  /* min contrast 4.5:1 on --bg and --surface */
  --on-dark:       #E8E4DA;
  --on-dark-muted: #A9B3B0;

  /* Lines */
  --line:          #E4DFD3;
  --line-soft:     #EFEBE2;
  --input-border:  #D8D2C4;

  /* Progress (teal) */
  --progress:      #1F6F78;
  --progress-deep: #174F55;
  --progress-tint: #E3EFEE;

  /* Feelings (orange) */
  --feeling:       #B2501A;
  --feeling-deep:  #8A3E14;
  --feeling-tint:  #FDF3E9;

  /* Heatmap scale (0 → 4) */
  --heat-0: #E9E4D8;
  --heat-1: #BCD9D7;
  --heat-2: #7FB5B6;
  --heat-3: #3F878D;
  --heat-4: #174F55;
}

[data-theme="dark"] {
  --bg:        #151B1C;
  --surface:   #1E2627;
  --surface-warm: #222A2A;
  --ink:       #EDEAE3;
  --ink-soft:  #D3CFC6;
  --muted:     #A5ACA9;
  --line:      #2F3A3B;
  --line-soft: #283233;
  --input-border: #3C4849;
  --progress:  #5FB3B9;
  --progress-tint: #1F3B3E;
  --feeling:   #E08A55;
  --feeling-tint: #3A2A20;
}
```

Theme options in Settings: Light, Dark, System (default).

### 3.2 Typography

| Role | Font | Size / weight |
|---|---|---|
| Page titles, diary prompts, insight quotes | Fraunces (serif) | 40 / 500 page title, 20 / 500 card headline |
| Body, labels, buttons | IBM Plex Sans | 15 / 400 body, 13 / 400 captions, 16–17 / 600 card titles |
| Timers, stats, numbers, prompts | IBM Plex Mono | 56 session timer, 30 stat cards, 13 prompt preview |

Fonts are **bundled with the app** (no Google Fonts request at runtime) so the app works offline and makes no network calls.

### 3.3 Spacing, radius, elevation

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 44 px.
- Radius: 8 (inputs, buttons), 10 (list rows), 12–14 (cards), 999 (chips).
- No drop shadows on cards; 1 px `--line` borders instead. Modals use a single soft shadow.
- Minimum touch/click target: 44 px height for primary controls, 32 px for chips.

### 3.4 Core components

Build these once in `src/components/ui/` and reuse everywhere:

`Button` (primary, secondary, ghost, danger), `IconButton` (requires `aria-label`),
`Card`, `StatCard`, `Chip` (toggle, with `aria-pressed`), `ChipGroup`,
`MoodScale` (5 buttons, number + word label), `DifficultyPicker` (1–5),
`TextField`, `TextArea`, `Select`, `Slider`, `Modal`, `Toast`, `EmptyState`,
`Timer` (display only, driven by store), `ProgressBar`, `Tabs`, `Tooltip`.

---

## 4. App layout

```
┌──────────────┬──────────────────────────────────────────────┐
│  Sidebar     │  Page header (context line + serif title +   │
│  232 px      │  page actions)                               │
│              ├──────────────────────────────────────────────┤
│  Today       │                                              │
│  Dashboard   │  Page content                                │
│  Notebook    │                                              │
│  Practice    │                                              │
│  Insights    │                                              │
│  Library     │                                              │
│  Roadmaps    │                                              │
│              │                                              │
│  Settings    │                                              │
│  "All data   │                                              │
│  stored on   │                                              │
│  this device"│                                              │
└──────────────┴──────────────────────────────────────────────┘
```

- Minimum window: 1024 × 700. Below 1200 px wide, the sidebar collapses to icons only.
- A **mini timer pill** appears in the sidebar whenever a session is running and the user is on another page. Clicking it returns to Today.
- The app opens to **Today** by default (configurable to Dashboard).

### Global keyboard shortcuts (app-scoped, not system-wide)

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Enter` | Start / pause session |
| `Ctrl/Cmd + K` | Quick log (concept, problem or diary line from anywhere) |
| `Ctrl/Cmd + 1…7` | Jump to sidebar pages |
| `Esc` | Close modal |

---

## 5. Screens

Each screen lists its purpose, sections, states and interactions.
The design canvas contains mockups of Today, Dashboard and Practice.

### 5.1 First-run onboarding (3 steps, skippable)

1. **Name and languages.** "What should we call you?" plus multi-select of languages from a built-in list (Python, JavaScript, TypeScript, Java, C, C++, C#, Go, Rust, Kotlin, Swift, PHP, Ruby, SQL, HTML/CSS, Other → free text). Pick one as primary.
2. **Daily goal.** Minutes per day (default 60) and day boundary (default 04:00, explained as "late-night sessions count toward the previous day").
3. **Letter to future you** (optional). "Why are you learning to code?" Sealed for 30 days.

Ends on Today with a short, dismissible coach mark on the timer.

### 5.2 Today (default screen)

**Purpose:** the daily logging hub. Everything for one day happens here.

Layout: three columns (360 px / flexible / 340 px).

**Left column**
- **Session timer card** (dark): elapsed time `HH:MM:SS`, session start time, Start / Pause / Resume / End buttons, list of today's session ranges (`09:10 – 10:45  1h 35m`), total today.
- **Mood check-in**: `MoodScale` 1–5 with labels *Drained, Low, Okay, Good, Fired up*. Prompted automatically on session start ("before") and session end ("after"). Also available any time.
- Language selector for the session (defaults to primary language).

**Middle column**
- **What I learned**: single-line input with autocomplete from the user's existing concept list (prevents "for loop" / "for-loops" duplicates). On add, an inline expander asks for:
  - "In my words" note (optional but encouraged)
  - Category chip (Loops, Strings, Lists, Functions, …; user-editable list)
  - Source (optional; pick from Library or paste a link)
- **Problems**: list of today's problems. Each row shows status dot, title, concepts, level, source, per-problem timer or final time, and a feeling tag.
  - "Log a problem" opens a modal: title, link (optional), concepts used (multi-select), difficulty 1–5, status (*Solved, Solved with help, Gave up, Revisit later*), feeling tag, solution (pasted code or file path, optional).
  - A problem row can start its own timer. Only **one problem timer** runs at a time; it runs inside the session timer (starting a problem timer auto-starts a session if none is running).

**Right column**
- **Diary card** ("How did today feel?"): free text, autosaved as a draft every 2 s.
  - "What was this about?" chips = today's concepts (one tap links the diary entry to concepts; this link powers insights).
  - Feeling tags: *Excited, Proud, Aha!, Confused, Stuck, Frustrated, Felt like a loser, Bored, Anxious* (user can add custom tags).
- **Was today useful?**: slider 0–100 (self-rating) next to the calculated score bar, with one sentence comparing them (see backend §6 for the formula and copy rules).
- **Close the day** button: saves the day summary, triggers insight evaluation, shows a small summary toast. Optional; the day auto-closes at the day boundary.

**States**
- Empty morning state: "Nothing logged yet. Start a session or add what you learned." with the review suggestion from the Dashboard (e.g. "Practice list comprehensions, learned 3 days ago").
- Low-mood state: if mood ≤ 2 is logged, show a "You've been here before" card when a matching past comeback exists (backend §7).
- Timer running when app was closed: on reopen, show "Your session was still running (2h 10m). Keep it, or end it at the time you stopped?" with a time picker.

### 5.3 Dashboard

**Purpose:** "How am I doing overall?"

- Header: greeting with journey day count, language filter (per language or all), "Start session" button.
- **Stat cards (4)**: Total time (with this-week delta), Concepts learned (with "due for review" count), Problems solved (with average time), Current streak (with best).
- **Mood & usefulness chart**: last 14 days by default (toggle 14 / 30 / 90). Mood as dashed orange line on 1–5 scale, usefulness as solid teal line on 0–100 scale (dual axis). Low-mood days with a linked comeback are marked with a hollow point and tooltip quote.
- **Insight card**: the highest-priority current insight (backend §7), with "See all insights".
- **Activity heatmap**: 12 weeks (toggle to 1 year). Intensity = minutes logged, 5 buckets.
- **Time per day**: bar chart, last 7 days.
- **Due for review**: up to 5 concepts from the spaced-review queue, each with a "Practice" action that opens Practice with that concept preselected.

### 5.4 Notebook

**Purpose:** reread past days. The diary for the future developer.

- Left: month calendar. Each day cell shows a tiny mood color dot and a teal fill proportional to time.
- Right: the selected day as a read-only "page": sessions, concepts with notes, problems with status and times, diary text, feelings, self vs calculated usefulness.
- Edit button reopens the day in the same components used on Today.
- Search across all diary text, concept notes and problem titles.
- Filters: language, concept, feeling tag, mood range.

### 5.5 Practice generator

**Purpose:** turn logged concepts into practice problems.

**Left panel (configuration)**
1. **Concepts from**: Today / Last 3 days / 7 days / Custom range, then concept chips (all preselected; user can toggle).
2. **Difficulty** 1–5: *Warm-up, Easy, Combine, Tricky, Codeforces-style* (definitions in backend §8.3, shown as a tooltip).
3. **How many** (1–10) and **Problem style**: Beginner-clear, Story-based, Codeforces-style.
4. **Generate with**: *Copy prompt* (free ChatGPT / Gemini) or *My model* (configured provider).
5. Toggle: "Include my recent struggles" (adds concepts tagged Stuck / Revisit later).

**Right panel**
- **Prompt preview** (monospace, read-only, expandable). Buttons: *Copy prompt*, *Export PDF report*, *Export LLM-ready report (.md)*.
- In *My model* mode the button becomes *Generate*, with a progress state and cancel.
- **Paste AI response** button (copy-prompt mode): opens a modal with a large textarea; on paste, the app validates the JSON (backend §8.5) and shows a preview of parsed problems before adding them. Invalid responses show a friendly error plus a "Copy fix-up prompt" button that asks the LLM to return valid JSON.
- **Practice queue**: generated problems with level badge, concepts, status, "Start timer" (moves the problem to Today and starts its timer), and "Report bad problem" (marks it and excludes it from stats).

**Problem detail view** (modal or side panel): title, statement, input/output format, samples, hint (hidden behind "Show hint"; revealing it is recorded), reference solution (hidden behind "I'm done / I give up"; revealing before solving sets status to *Solved with help*).

### 5.6 Insights

- Full mood timeline (30 / 90 / all) with markers for comeback events.
- All active insights as cards, newest first, dismissable ("don't show this type again" option).
- Charts:
  - Mood before vs after sessions (paired bars by week).
  - Usefulness by hour of day and by weekday.
  - Average time per problem by difficulty over time ("am I getting faster?").
  - Feeling tags per concept (which concepts felt hardest).
  - Time vs problems attempted (the shadowing detector).
- **Letters to future me**: list of sealed and opened letters, "Write a new letter".

### 5.7 Library

- Grid/list of resources: links, images, PDFs, notes. Each card: title, type icon, tags (concepts), date added.
- Add by paste (link), drag-and-drop (files are copied into the app's local library folder), or "New note".
- Filter by concept, type, language. "Open folder" button reveals the local library folder in the OS file manager.
- Link previews show only data the user entered or the page title fetched on demand; no automatic fetching of remote images unless the user enables it.

### 5.8 Roadmaps

- List of roadmaps (user-created or imported).
- Roadmap view: collapsible tree (or simple node graph in a later version) with node status *Not started / Learning / Done*.
- Nodes can be linked to concepts; when a linked concept is logged, the node moves to *Learning* automatically; the user marks *Done*.
- Create/edit: add, rename, nest and reorder nodes (drag handle plus keyboard reordering).
- Import from JSON file (our format) and from roadmap.sh content (see backend §10 for the import approach and attribution).

### 5.9 Settings

- **Profile**: name, languages (add/remove, set primary), daily goal, day boundary.
- **Appearance**: theme, font size (S/M/L), reduced motion.
- **AI models**: provider list (Copy-prompt only, Ollama, OpenAI-compatible, Gemini, Anthropic, OpenRouter). API key field stored in OS keychain (never shown again after save, only "••••1234" and Replace). "Test connection" button. Toggle: "Allow sending diary text to AI" (default **off**).
- **Data**: data folder location, Backup now, Restore from backup, Export all (JSON), Delete all data (typed confirmation).
- **Reminders**: optional daily reminder time (system notification).
- **About**: version, check for updates, licenses.

---

## 6. Charts specification

| Chart | Type | Data | Location |
|---|---|---|---|
| Mood & usefulness | Dual-axis line | daily avg mood (1–5), daily usefulness (0–100) | Dashboard, Insights |
| Activity heatmap | Custom grid | minutes per day → 5 buckets | Dashboard |
| Time per day | Bar | minutes per day | Dashboard |
| Mood before vs after | Grouped bar | weekly averages | Insights |
| Usefulness by hour | Bar | avg usefulness grouped by session start hour | Insights |
| Speed by difficulty | Multi-line | avg solve minutes per level per week | Insights |
| Feelings per concept | Horizontal stacked bar | feeling tag counts per concept | Insights |
| Time vs attempts | Scatter | per day: minutes vs problems attempted | Insights |

Rules:
- Every chart has a text title, axis labels with units, and an `aria-label` summary sentence generated from the data (e.g. "Mood rose from 2 to 4 over the last 14 days").
- Empty state for fewer than 3 data points: "Log a few more days to see this chart."
- Tooltips show exact values and, for mood points, the linked diary snippet (first 80 characters).
- Colors from tokens only; feelings = orange dashed, progress = teal solid.

---

## 7. State management

- **TanStack Query** for everything read from the data layer. Query keys by domain: `['day', date]`, `['concepts']`, `['stats', range, language]`, `['insights']`.
- Mutations invalidate the smallest affected keys (e.g. logging a problem invalidates `['day', today]` and `['stats', …]`).
- **Zustand stores**:
  - `timerStore`: active session id, active problem id, start timestamps. Elapsed time is always computed as `now − startedAt − pausedDuration`, **never** by counting ticks, so it survives sleep, reload and app restarts.
  - `uiStore`: theme, sidebar collapsed, last visited page.
  - `draftStore`: unsaved diary text and form drafts (persisted to local DB every 2 s).
- A 1-second `requestAnimationFrame`/interval only re-renders the timer display component.

---

## 8. Forms and validation

- All inputs validated with Zod schemas imported from `src/core/schemas` (shared with the data layer).
- Concept name: 1–60 chars, trimmed, case-insensitive uniqueness per language (autocomplete offers the existing one).
- Problem title: 1–120 chars. Link: valid URL or empty.
- Diary: up to 10,000 chars.
- Errors appear inline under the field, in plain language, never as blocking alerts.

---

## 9. Copy and tone guidelines

- Second person, warm, short. "You solved 3 loop problems" not "User completed 3 tasks".
- Never shame: no "You failed your streak", instead "Welcome back. Pick up where you left off."
- Numbers are facts, not judgments. When self-rating is lower than the calculated score, reassure; when higher, gently note it (backend §6.3).
- Feeling tags are the user's words; never auto-assign emotions.

---

## 10. Accessibility

- WCAG 2.2 AA: text contrast 4.5:1 (3:1 for 24 px+), focus rings visible on all interactive elements.
- All interactive elements are real `<button>`, `<a>`, `<input>`; chips use `aria-pressed`; mood scale is a `radiogroup`.
- Charts have text summaries and a "View as table" toggle.
- Full keyboard operation, including roadmap reordering.
- Respect `prefers-reduced-motion` and the in-app reduced-motion setting.
- Timer announces only on start/stop to screen readers (no per-second announcements).

---

## 11. Performance targets

- Cold start to interactive: under 1.5 s on a mid-range laptop.
- Page switches: under 100 ms (data cached by TanStack Query).
- Dashboard with 1 year of data: under 300 ms to render.
- Bundle: code-split by route; charts library loaded only on Dashboard/Insights.

---

## 12. Internationalization

- All UI strings in `src/i18n/en.json` from day one (i18next). Later languages: Bangla first is a natural candidate given the initial audience.
- Dates and numbers formatted with `Intl` using the user's locale.

---

## 13. Folder structure

```
src/
  app/                 # App shell, router, providers, layout
  pages/
    today/
    dashboard/
    notebook/
    practice/
    insights/
    library/
    roadmaps/
    settings/
    onboarding/
  components/
    ui/                # Design-system primitives
    charts/            # Chart wrappers + Heatmap
    domain/            # ConceptRow, ProblemRow, MoodScale, DiaryCard, InsightCard…
  core/                # Shared with data layer (see backend.md)
    schemas/           # Zod schemas
    types/
  data/                # Typed client for backend commands + TanStack Query hooks
  stores/              # Zustand stores
  reports/             # @react-pdf/renderer templates
  i18n/
  styles/
    tokens.css
    global.css
  assets/fonts/
tests/
  unit/
  e2e/
```

---

## 14. Testing

- **Unit** (Vitest): formatters, day-boundary helper, timer math, chart data transforms.
- **Component** (React Testing Library): MoodScale, concept autocomplete, problem modal, paste-AI-response validation flow.
- **E2E** (Playwright + tauri-driver): onboarding → start session → log concept → log problem → diary → close day → dashboard shows updated stats.
- **Visual regression** on the design-system page (optional, later).
- **Accessibility**: axe-core checks in component tests.

---

## 15. Release scope by version

| Version | Frontend scope |
|---|---|
| **v0.1** | Onboarding, Today (session timer, mood check-ins, concepts, diary, usefulness), Settings (profile, theme, backup) |
| **v0.2** | Problems with per-problem timers, feeling tags, streaks, Notebook |
| **v0.3** | Practice generator (copy-prompt mode, paste response, queue, problem detail), spaced-review suggestions |
| **v0.4** | Dashboard charts, Insights page, PDF export |
| **v0.5** | Library, Roadmaps (manual + import), AI model settings (Ollama / API) |
| **v1.0** | Letters to future self, full insight set, i18n, accessibility audit, polish, auto-update |
| **v2.0** | Opt-in community (separate spec) |
