# Design System Specification: Architectural Chromaticism

## 1. Overview & Creative North Star
**Creative North Star: "The Neon Observatory"**

This design system rejects the "SaaS-Blue" status quo in favor of a high-contrast, architectural aesthetic. By combining a brutalist, pitch-black foundation (`surface-container-lowest: #000000`) with a sophisticated pastel spectrum, we create a "dark-mode" experience that feels like a precision instrument rather than a generic dashboard.

The system breaks the "template" look through **Intentional Asymmetry** and **Tonal Depth**. We do not use lines to define space; we use light. By leveraging the contrast between the deep `background` (#0c0e10) and the ethereal glow of `primary` (Purple) and `secondary` (Mint), the UI feels curated, premium, and authoritative.

---

## 2. Color Strategy
Our palette moves away from saturated primaries toward a "desaturated-neon" aesthetic. This ensures that even in a dark environment, the colors feel soft on the eyes while remaining functionally distinct.

### The "No-Line" Rule
**Borders are a design failure.** To section content, designers must use background shifts. 
- A card should not have a border; it should be a `surface-container` (#171a1d) sitting on a `background` (#0c0e10). 
- Boundaries are felt through the transition of values, not a 1px stroke.

### Surface Hierarchy & Nesting
Treat the UI as a physical stack of materials. 
- **Base Layer:** `surface-dim` (#0c0e10) for global backgrounds.
- **Mid Layer:** `surface-container` (#171a1d) for primary content areas.
- **Top Layer:** `surface-container-highest` (#22262a) for floating elements or active states.
*Rule:* Each inner container must move exactly one tier "higher" or "lower" than its parent to define its importance.

### Signature Roles
- **Purple (`primary` #e1c3ff):** The beacon. Used for high-intent actions and primary navigation.
- **Mint (`secondary` #8bd6b4):** The pulse. Used for progress, success states, and positive growth.
- **Yellow (`tertiary` #ffb6be *Mapping Note: Used for Warning/Alerts*):** The caution. Used for non-destructive alerts.
- **Rose (`error` #fd6f85):** The barrier. Reserved strictly for critical failures or blocked paths.

---

## 3. Typography: Editorial Authority
The type scale uses a juxtaposition between the technical "Space Grotesk" and the human-centric "Manrope."

- **Display & Headlines (Space Grotesk):** These should be treated as architectural elements. Use `display-lg` (3.5rem) with tight letter-spacing to create a "poster-like" impact in Hero sections.
- **Body & Labels (Manrope):** Chosen for its legibility at small scales. Use `body-md` (0.875rem) for standard UI text to maintain a sophisticated, data-dense look without clutter.
- **The Hierarchy Rule:** Never use two different weights of the same size to create hierarchy. Change the color token (e.g., move from `on-surface` to `on-surface-variant`) to create a softer, more professional distinction.

---

## 4. Elevation & Depth
In this system, depth is "baked-in" through tonal layering rather than traditional drop shadows.

- **The Layering Principle:** To lift a card, do not add a shadow. Instead, transition from `surface-container-low` (#111416) to `surface-container-high` (#1d2023). 
- **Ambient Shadows:** For floating Modals or Tooltips, use a "Large-Scale Ambient Shadow." 
  - *Specs:* Blur: 40px, Spread: -10px, Opacity: 8% of `#000000`. This mimics natural light diffusion in a dark room.
- **The "Ghost Border" Fallback:** If accessibility requires a container edge, use `outline-variant` (#44484c) at **15% opacity**. A solid 100% border is strictly prohibited.
- **Glassmorphism:** Use `surface-tint` (#e1c3ff) at 5% opacity with a `backdrop-filter: blur(12px)` for navigation bars. This allows the architectural background to bleed through, maintaining a sense of place.

---

## 5. Components

### Buttons
- **Primary (Purple):** Solid `primary` (#e1c3ff) with `on-primary` (#553777) text. **0px Border Radius.**
- **Secondary (Mint):** Ghost style. No background, `secondary` (#8bd6b4) text, and a 1px `secondary` border at 20% opacity.
- **Tertiary:** Pure text using `on-surface-variant`. No background.

### Cards & Lists
- **The "No Divider" Rule:** Never use a horizontal line to separate list items. Use **2.5** (0.5rem) or **4** (0.9rem) spacing from the scale to create a "negative space" divider.
- **Active State:** To show a list item is selected, shift the background to `surface-bright` (#282d31).

### Input Fields
- **Resting:** `surface-container-highest` background, no border.
- **Focus:** Add a 1px bottom-border only (the "Architect's Underline") in `primary` (#e1c3ff). 
- **Error:** Background shifts to `error_container` (#8a1632) at 20% opacity, text remains `on-surface`.

### Chips
- Use `surface-variant` (#22262a) as the base.
- **Status Indicator:** A small 4px circle of the status color (Mint/Rose/Yellow) to the left of the text. Do not color the whole chip.

---

## 6. Do’s and Don’ts

### Do:
- **Use the Spacing Scale religiously.** Layouts should feel rhythmic. Use **16** (3.5rem) for section breathing room and **4** (0.9rem) for internal component spacing.
- **Embrace the Dark.** Allow large areas of `surface-container-lowest` (#000000) to exist. This creates a "premium gallery" feel.
- **Use Gradients for CTAs.** A subtle linear gradient from `primary` (#e1c3ff) to `primary_container` (#d6b2fc) adds the "soul" that flat colors lack.

### Don’t:
- **Don’t use Rounded Corners.** The `roundedness` scale is set to **0px**. Every element must be sharp, architectural, and precise.
- **Don’t use White.** Pure `#ffffff` is too harsh. Use `on-background` (#e3e6ea) for high-emphasis text and `on-surface-variant` (#a8abb0) for secondary text.
- **Don’t Center-Align everything.** Use intentional asymmetry. Align titles to the far left and metadata to the far right to maximize the "Editorial" feel.