# SkyOS Brand Guidelines

## Brand foundation

SkyOS should feel premium, modern, secure, and quietly futuristic. The interface favors structure, precision, and readable information density over spectacle. Dark mode is the primary visual experience; light mode is a fully supported accessibility and preference option.

The approved brand board supplied for this work is the visual source of truth. It is not currently checked into this repository, so this document deliberately does not include a repository-relative image reference. Production logo artwork, app icons, and favicon source files must be supplied separately; contributors must not redraw or approximate the approved mark.

## Official colors

| Role                   | Color     | Intended use                                                    |
| ---------------------- | --------- | --------------------------------------------------------------- |
| Primary blue           | `#0D47FF` | Primary actions, selected states, high-confidence brand moments |
| Bright blue            | `#0091FF` | Focus cues, borders, links on dark surfaces, gradient midpoint  |
| Cyan                   | `#00D4FF` | Small dark-mode highlights, status dots, restrained glow        |
| Purple accent          | `#7C3AED` | Secondary categorization or exceptional accent only             |
| Light neutral          | `#F5F7FA` | Light-mode canvas and dark-mode primary text                    |
| Main dark              | `#0F1117` | Primary dark-mode canvas                                        |
| Secondary dark surface | `#1E232B` | Raised controls, cards, and secondary panels in dark mode       |

Use semantic tokens instead of raw color values in components. Bright blue and cyan are not suitable for small text on light surfaces, so the semantic highlight token resolves to primary blue in light mode and cyan in dark mode. Status is never communicated by color alone.

## Typography

Sora is the SkyOS UI typeface. The web application self-hosts the Sora variable font through `@fontsource-variable/sora`; no font request is made to a third-party runtime service.

- Body: 400 or 500 weight, compact but comfortable line height.
- Labels and controls: 600 weight where emphasis improves scanning.
- Headings: 600 weight with restrained negative tracking.
- Eyebrows and the tagline: uppercase with generous tracking.
- Code, checksums, and technical identifiers: the system monospace stack.

Avoid very light weights in the product UI. They lose clarity at small sizes and on lower-quality displays.

## Spacing philosophy

The spacing system is based on a 4 px unit. Prefer 8, 12, 16, 24, 32, 40, and 48 px intervals. Controls should remain compact; page-level regions need more breathing room. Dense enterprise content may reduce internal spacing, but touch targets must remain at least 40 px in the primary shell.

## Radius system

- Controls: 10 px (`--radius-control`)
- Cards: 14 px (`--radius-card`)
- Large panels and dialogs: 18 px (`--radius-panel`)
- Badges and status chips: fully rounded

Radii are soft enough to feel modern without making the application playful. Do not mix arbitrary corner values within one component family.

## Shadows and elevation

Elevation is functional. Cards use a low, broad shadow; floating dialogs and the utility panel use the raised or panel shadow. Dark surfaces rely primarily on border separation and only secondarily on shadow. Avoid large luminous shadows around ordinary content.

## Gradient and glow usage

The approved gradient runs from primary blue through bright blue to cyan. It is reserved for compact brand accents and exceptional emphasis, not large page backgrounds or every call to action.

The cyan glow is a subtle emphasis utility for a small status or empty-state emblem. Use at most one visually dominant glow within a viewport. Never put glow behind body text, dense tables, or form fields. Purple is not added to the default gradient; it remains an independent accent.

## Component styling rules

- **Buttons:** primary is solid blue; secondary uses a bordered surface; ghost is low-emphasis; danger is reserved for destructive or archival actions. Labels use verbs.
- **Cards:** use semantic surfaces and borders. Interactive cards may strengthen the border on hover but should not move dramatically.
- **Badges:** short labels only. Pair status color with readable text.
- **Inputs, selects, and textareas:** visible border at rest, stronger border on hover, and the shared blue focus ring on keyboard focus.
- **Dialogs:** use the native modal behavior, a clear title, an explicit close control, and optional descriptive copy.
- **Tooltips:** supplementary labels only. Essential instructions must remain visible in the interface.
- **Empty and loading states:** explain the current state without implying unavailable features. Loading states expose a programmatic status.
- **Navigation:** the active route uses a quiet blue surface, a narrow cyan rail, and `aria-current="page"`.

## Accessibility

- Target WCAG 2.2 AA contrast for text and interactive states.
- Do not place cyan or bright-blue small text directly on light neutral or white surfaces; use the semantic highlight token.
- Maintain visible keyboard focus on every interactive element. Do not remove the shared focus ring without an equivalent.
- Use semantic landmarks, labels, and `aria-current` for the shell. Keep the skip link operational.
- Keep touch targets at least 40 by 40 px for primary controls.
- Do not rely on color, glow, hover, or iconography alone to convey state.
- Respect `prefers-reduced-motion`; transitions must not be necessary to understand the interface.
- Modal content must remain keyboard reachable and dismissible with Escape.

## Dark and light modes

Dark mode is the default when a user has not stored a preference. It uses `#0F1117` as the canvas and `#1E232B` as the principal raised surface. Blue and cyan accents are more luminous but remain localized.

Light mode uses `#F5F7FA` as the canvas, white for primary surfaces, and deeper semantic blue for text accents. The component hierarchy and meaning remain identical across themes. Theme choice is persisted locally and applied before hydration to avoid a theme flash.

## Tone of voice

SkyOS copy is modern, professional, reliable, innovative, simple, and secure. Use short declarative sentences, concrete verbs, and calm status language. Avoid hype, jokes in critical workflows, vague futurism, and unsupported claims such as “military-grade” or “unbreakable.”

## Tagline

The official tagline is:

> YOUR SYSTEM. YOUR SKY.

Use the exact wording and punctuation. In display treatments, `YOUR SKY.` may use the semantic highlight color. Keep the tagline uppercase in formal brand placements; sentence case may be used only in metadata where all-uppercase text is inappropriate. Do not append product claims or rewrite the line.
