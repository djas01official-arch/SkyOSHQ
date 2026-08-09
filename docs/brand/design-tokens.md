# SkyOS Design Tokens

## Source and implementation

The web token implementation lives in `apps/web/app/globals.css` and is exposed to Tailwind CSS 4 through `@theme inline`. Components consume semantic names such as `background`, `surface`, `foreground`, `border`, and `accent`; official palette names are available for controlled brand accents.

The approved brand-board image is not stored in the repository. These token definitions capture the approved board values without introducing an unapproved logo asset.

## Primitive palette

| CSS token               | Tailwind utility            | Value     |
| ----------------------- | --------------------------- | --------- |
| `--brand-primary-blue`  | `brand-primary`             | `#0D47FF` |
| `--brand-bright-blue`   | `brand-bright`              | `#0091FF` |
| `--brand-cyan`          | `brand-cyan`                | `#00D4FF` |
| `--brand-purple`        | `brand-purple`              | `#7C3AED` |
| `--brand-light-neutral` | Use through semantic tokens | `#F5F7FA` |
| `--brand-dark`          | Use through semantic tokens | `#0F1117` |
| `--brand-dark-surface`  | Use through semantic tokens | `#1E232B` |

Raw palette tokens do not guarantee contrast. Default component text should use semantic foreground or highlight tokens.

## Semantic color tokens

| Token                | Light      | Dark        | Purpose                              |
| -------------------- | ---------- | ----------- | ------------------------------------ |
| `--background`       | `#F5F7FA`  | `#0F1117`   | Application canvas                   |
| `--surface`          | `#FFFFFF`  | `#151920`   | Primary panels and cards             |
| `--surface-raised`   | `#EEF2F7`  | `#1E232B`   | Nested controls and muted cards      |
| `--surface-overlay`  | `#FFFFFF`  | `#232A34`   | Dialogs and elevated overlays        |
| `--foreground`       | `#0F1117`  | `#F5F7FA`   | Primary text                         |
| `--muted-foreground` | `#596579`  | `#A5AFBD`   | Secondary text                       |
| `--border`           | `#DCE2EB`  | `#2D3440`   | Standard separators                  |
| `--border-strong`    | `#BCC6D5`  | `#465161`   | Controls and emphasis                |
| `--accent`           | `#0D47FF`  | `#0D47FF`   | Primary action                       |
| `--accent-hover`     | `#073CD9`  | `#2D62FF`   | Primary action hover                 |
| `--accent-soft`      | Blue at 9% | Blue at 17% | Selected or informational background |
| `--brand-highlight`  | `#0D47FF`  | `#00D4FF`   | Contrast-aware brand text and icons  |
| `--focus-ring`       | `#0091FF`  | `#0091FF`   | Keyboard focus                       |

Success, warning, and danger each have solid foreground and soft-background pairs. Components must use the pair rather than inventing raw red, amber, or green values.

## Typography tokens

| Token            | Value                                     | Use                            |
| ---------------- | ----------------------------------------- | ------------------------------ |
| `--font-sans`    | Sora Variable, Sora, system sans fallback | All product UI                 |
| `--font-mono`    | SFMono-Regular, Consolas, Liberation Mono | Code and technical identifiers |
| `--type-caption` | 12 px                                     | Metadata and labels            |
| `--type-body`    | 14 px                                     | Dense application copy         |
| `--type-title`   | 32–44 px fluid                            | Major page titles              |

The Sora variable font package is imported once by the root App Router layout. Do not import font CSS in individual components.

## Spacing tokens

| Token        | Value |
| ------------ | ----- |
| `--space-1`  | 4 px  |
| `--space-2`  | 8 px  |
| `--space-3`  | 12 px |
| `--space-4`  | 16 px |
| `--space-5`  | 20 px |
| `--space-6`  | 24 px |
| `--space-8`  | 32 px |
| `--space-10` | 40 px |
| `--space-12` | 48 px |

Prefer this scale in new CSS and the equivalent Tailwind spacing utilities in components.

## Radius and elevation tokens

| Token                | Value / behavior                                               |
| -------------------- | -------------------------------------------------------------- |
| `--radius-control`   | 10 px                                                          |
| `--radius-card`      | 14 px                                                          |
| `--radius-panel`     | 18 px                                                          |
| `--elevation-card`   | Quiet two-layer card shadow                                    |
| `--elevation-raised` | Floating menu and dialog shadow                                |
| `--elevation-panel`  | Directional utility-panel shadow                               |
| `--brand-glow`       | Thin bright-blue edge plus low-opacity 28–30 px cyan/blue glow |

Dark-mode elevation is stronger but always paired with a visible border.

## Brand utilities

| Class                  | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `.brand-gradient`      | Approved blue-to-cyan background gradient                      |
| `.brand-gradient-text` | Approved gradient clipped to short display text only           |
| `.brand-glow`          | Restrained accent glow for one compact focal item              |
| `.focus-ring`          | Shared keyboard focus treatment for component roots            |
| `.surface-elevated`    | Overlay surface, border, and raised shadow                     |
| `.shell-grid`          | Very low-opacity structural grid used only as shell atmosphere |

Utilities are opt-in. The default component appearance should remain flat, legible, and restrained.

## Component mapping

- `Button`: `primary`, `secondary`, `ghost`, and `danger`; sizes `default`, `small`, and `icon`.
- `Card`: `default`, `elevated`, and `muted` surface levels.
- `Badge`: `neutral`, `accent`, `purple`, `success`, `warning`, and `danger` tones.
- `Input`, `Select`, `Textarea`: shared control radius, border, shadow, disabled state, and focus ring.
- `Dialog`: native modal foundation using elevated surface tokens.
- `Tooltip`: surface overlay with hover and focus-within visibility.
- `PageHeader`, `EmptyState`, `LoadingState`, `StatusIndicator`: consistent page hierarchy and state communication.

When adding a component, consume semantic tokens first. Add a new primitive token only when the value is part of the approved brand language; add a semantic token when the meaning must adapt by theme or accessibility context.
