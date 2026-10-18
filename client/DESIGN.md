# RepoMentor client design

## Design tokens

The client defines these values once in `src/styles.css` and refers to them through CSS variables.

| Token | Value | Use |
| --- | --- | --- |
| Page | `#F5F6F3` | App background |
| Surface | `#FFFFFF` | Cards, sidebar, dialogs |
| Ink | `#16201C` | Main text and headings |
| Muted text | `#58655F` | Supporting text |
| Brand green | `#1F6B4A` | Primary actions, links, focus ring |
| Danger | `#B3382C` | Destructive actions and errors |
| Code panel | `#101A16` | Code viewer background |
| Code text | `#D9E4DD` | Code viewer fallback text |
| Hairline | `#DDE3DE` | Borders and dividers |

Contrast checks use the WCAG relative-luminance formula. Ink on page is 15.39:1; muted text on page is 5.62:1; brand green on white is 6.44:1; danger on white is 5.97:1; code text on the code panel is 13.62:1. These text pairs meet the 4.5:1 requirement. Hairline is only used for non-text boundaries, never as text.

## Typography

- IBM Plex Sans for interface text and answers; IBM Plex Mono for code. Both are bundled from `@fontsource` so the page makes no external font requests.
- Base text: 16px. Small/support text: 14px minimum. Code: 14px.
- Heading scale: 18px, 22px, 28px, 36px.
- Body line-height: 1.6. Answer line-height: 1.65. Answer copy stays near 70ch wide.
- Sentence case throughout.

## Components and behavior

- Buttons and inputs use a 6px radius; panels use 10px; dialogs use 12px. Shadows are reserved for dialogs and the mobile code sheet. There are no gradients.
- Controls have at least 44px hit areas and a visible keyboard focus ring.
- Motion is limited to click responses. Reduced-motion preferences disable transitions and smooth scrolling.
- Answers render through `react-markdown` without raw HTML. Citation chips are buttons that select a source in the code viewer.
- Code renders with Prism syntax colors, line numbers that start at the cited source line, a copy control, and horizontal overflow contained inside the viewer.

## Page wireframes

### Sign in / create account

```text
+------------------------------------------------------+
| RepoMentor                                           |
|                                                      |
| A clear headline and short product explanation      |
|                                                      |
|                     +----------------------------+   |
|                     | Sign in / Create account   |   |
|                     | Name (create account only) |   |
|                     | Email                      |   |
|                     | Password                   |   |
|                     | Field error                 |   |
|                     | [Sign in / Create account] |   |
|                     +----------------------------+   |
+------------------------------------------------------+
```

### Signed-in app, empty state

```text
+--------------------+---------------------------------+
| RepoMentor         | Workspace                       |
| Repositories       |                                 |
| [Add repository]   | Add a public GitHub repository  |
|                    | to start asking questions       |
|                    | about its code.                 |
|                    | [Add repository]                |
+--------------------+---------------------------------+
```

### Signed-in app, selected repository

```text
+--------------------+---------------------------------+
| RepoMentor         | owner / repository   Ready      |
| Repositories       | [Ask] [Search]                  |
| [Add repository]   | +------------------+ +--------+|
| > selected repo    | | Conversation     | | Code   ||
|   other repo       | | Answer in <=70ch | | viewer||
|                    | | [1] source chip  | | path   ||
|                    | | Sources          | | lines  ||
|                    | | Question input  | | Copy   ||
|                    | | [Ask]            | | code   ||
+--------------------+---------------------------------+
```

On narrow screens, the repository list moves above the workspace, the code viewer opens as a bottom sheet when a citation is selected, and code scrolls inside its panel.

### Add repository dialog

```text
+--------------------------------------+
| Add a public GitHub repository       |
| GitHub URL                           |
| [https://github.com/owner/repo    ]  |
| Error / indexing status              |
| [Cancel]              [Add repository]|
+--------------------------------------+
```

### Delete confirmation dialog

```text
+----------------------------------------------+
| Delete this repository and its indexed code? |
| [Cancel]                    [Delete repository]|
+----------------------------------------------+
```
