# Menu boards: design (draft for review)

Status: **steps 1 and 2 built (2026-10-09); step 3a, the builder, built (2026-10-10); step 3b (uploaded fonts and a logo) next.** "Almost gone" (step 2) waits until keg levels are tracked. Built in three steps, each useful on its own: (1) the menu's data, (2) one good board (TV, print, public link), (3) the board builder. The open questions are at the end.

## What it's for

A taproom's menu today is typed somewhere else (a TV app, a design tool, a chalkboard) and goes stale the moment a keg kicks. The app already knows what's on every tap (the **draft lines**), what's next ("**on deck**"), and each beer's numbers. A menu board built from those is right by itself: change a line, and the TV changes.

Rules from the product principles:
- **Nothing on a menu is guessed.** ABV, IBU, and color can be *filled in* from a batch or recipe, but only into the form, with where it came from, for a person to check and save. "Almost gone" is the one number worked out live, and it can be turned off.
- **Hard to make an ugly board.** Every layout looks good untouched; styling is chosen from safe options, with a contrast check so text stays readable across a room. No blank canvas.
- **The public link shows only the menu.** Never volumes, batches, people, or anything else, and it can be turned off or replaced at any time.

## Step 1: the menu's data

Like the brew sheet: **a catalog of common fields, tick the ones you use, rename them, add your own.** They're set up in **Settings → Menu** by whoever has **"Beer menu details"** (Head brewer, Admin, and the Taproom level, since a taproom manager is the one who adds a pour size or a tag); each beer fills them in on its form, under "On the menu", with the same permission.

### The brewery's lists (admin-made)
- **Pour sizes:** name and size, in order: *16 oz, 10 oz, Flight (4 × 4 oz), 32 oz crowler, 64 oz growler*... Each size knows its ounces (or mL), so a POS sale later turns into poured volume. A catalog to tick from, plus your own.
- **Sections:** *IPAs, Lagers, Sours, Dark, Guest taps, Cider & wine, Non-alcoholic*... in your order. Each beer picks one by hand. (A "fill in from style" rule could come later if picking gets tedious.)
- **Tags,** two kinds:
  - *Badges:* New, Seasonal, Limited, Award winner, Brewer's pick...
  - *Allergens and dietary:* Contains lactose, Gluten-reduced, Contains nuts, Fruit, Vegan...
  Shown as small labels; your own allowed.
- **Your own fields:** a name and a kind (text, number, yes/no, or pick from a list): *Hops, Collab with, Pairs with*...

### Each beer's menu details
- **Prices per pour size:** each beer ticks the sizes it's poured in (a 12% stout might be 10 oz only) and their prices. Today's free-typed prices move onto the brewery's sizes automatically (matching by name; new sizes made for the rest). A beer can also have a different price at one taproom; if it doesn't, both taprooms use the same list.
- **A short line for the TV** (up to 80 characters), besides the longer description (print and the public page).
- **Color** (SRM), shown as a swatch; filled in from the recipe's color (BeerXML has it) for a person to check.
- **Section, tags, and your own fields.**
- **Leave off the public menu** (still on the TV and print): for staff-only or not-ready taps.

### Guest taps and other drinks (later)
These are poured rarely, so for now a draft line's "something else" label shows on the menu as it is. Later it could become a **menu item** with the same details as a beer: who made it (*"Guest: a brewery's name"*), style, ABV, prices, section, tags. Kept in a short list so a returning guest beer or the house wine is picked, not retyped.

## Step 2: one good board

- **What's on it:** each taproom's draft lines in line order (or by section), each with name, style, ABV, short line, tags, and prices in columns by pour size. Optional parts: **Coming soon** (from on deck), **To go** (cans and crowlers from that taproom's finished goods), **Almost gone** (a badge when a keg or serving tank is nearly empty, worked out from the records; off by default, since it's only as good as the level checks).
- **Three ways to show it:**
  - **TV:** fills the screen with no scrolling (text sizes to fit the number of lines), updates on its own within seconds of a change, and keeps the last good copy if the signal drops. Opened from a private link on the TV's browser or a streaming stick, with no sign-in.
  - **Print:** a Letter page (or two), for the bar or a table tent.
  - **Public link:** a page for the brewery's website and social posts, phone-friendly, which can also be **embedded** in the website. Only menu details, never the rest of the brewery.
- **Links:** each board has its own private link (like the calendar links), made and turned off in the app; making a new one stops the old one.
- **Who:** anyone with "Count and move finished goods" (the Taproom level has it) runs the boards; the menu details themselves need "Beer menu details".

## Step 3: the board builder

- **Start from a layout:** a classic list, two columns, a card grid, or a printable sheet. Each looks good with nothing changed.
- **Arrange a tap's entry:** drag its parts (name, style, ABV, IBU, short line, tags, color, prices, your own fields) into the order you want, or into "Hidden". Drag sections into order. Every drag also has up / down buttons (phones, and anyone who finds dragging fiddly).
- **Style it** (the user's picks):
  - **Colors:** a few ready-made color schemes, or your own background, text, and accent colors. A contrast check warns before saving a combination that's hard to read from across a room.
  - **Fonts:** a list of good pairings (a headline font with a body font), or **any Google Font by name**. Fonts are loaded from Google Fonts on the board's page (free, nothing to install). An **Admin can also upload the brewery's own font files** (for example your brand's headline font), which then appear in the font list for every board. Only Admins upload, since a font's license is the brewery's responsibility; the upload screen says so.
  - **Your logo** and the board's title. (The first picture the app stores; kept with the brewery's files.)
  - Light or dark.
- **A live preview** at TV size, phone size, and print, while you build.
- **Several boards per taproom:** *TV 1: drafts*, *TV 2: cans to go*, *the website menu*, each with its own layout, style, and link.

## How it's kept right

- The board draws from the same records as the rest of the app, so it can't disagree with the draft lines.
- Tests: what a public link returns (only menu details; a turned-off link returns nothing), the TV view fitting 8 to 30 lines without scrolling, contrast checks, and the guide's Menu sections, like every feature.
- The guide gets **Settings: Menu**, **Menu boards**, and the builder, in the same release as each step.

## Build order

1. **Data:** pour sizes, sections, tags, your own fields, short line, color, "leave off the public menu", prices moved onto the sizes, an optional price override per taproom. (Guest and other menu items wait.) (Settings → Menu; the beer form's "On the menu".)
2. **One good board:** TV, print, and public link per taproom, with Coming soon, To go, and Almost gone (off by default).
3. **The builder:** layouts, drag to arrange, colors and fonts, logo, several boards.

## Questions for you

1. **Prices at your two taprooms:** *Answered: sometimes different.* Each beer has one price list, with an optional override per taproom.
2. **Sections:** *Answered: pick one for each beer.* No style rule for now; "by style" is left out of step 1.
3. **Guest taps, cider, wine, non-alcoholic:** *Answered: rarely.* A label on the line is enough for now; real menu entries for them wait.
4. **Your TVs:** *Answered: a small computer plugged into each TV.* The TV view is a full-screen browser page, so it can run there directly.
5. **Fonts:** *Answered: the pairings and any Google Font by name, plus Admins can upload the brewery's own font files for a consistent brand look.*
