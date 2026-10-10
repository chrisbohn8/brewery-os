// Brewery OS — drawing a menu board
//
// One file draws a taproom's menu the same way everywhere: on a TV (board.html with a TV link), on
// the public page (board.html with a public link, also embedded in a website), on paper, and in
// the app's preview and board builder. What's on the board comes from the database (menu_board_content
// in supabase/migrations/..._board_builder.sql), already worked out: this file only lays it out.
//
// A board's look is a handful of settings (board.board, made in the app's board builder): a layout,
// what each beer shows and in what order, the sections' order, colors, and fonts. They're choices
// from fixed lists, never free-form, so every combination still reads well from across a room.
//
//   BoardView.render(board, mode)  the board's HTML; mode is "tv", "public", or "print"
//   BoardView.fit(element)         TV only: the biggest text that fits the screen with no scrolling
//   BoardView.loadExtras(board, el) adds the board's fonts to the page and its logo to the drawn board
//                                   in el; resolves when they're ready
//   BoardView.setFileSource(fn)    where the brewery's own files come from: fn(id) resolves to
//                                   { mime, data } (board.html: the board's link; the app: signed in)
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // A beer's color: the usual approximation of SRM to a color on screen
  function srmColor(srm) {
    const c = (base) => Math.round(255 * base ** Math.min(Math.max(srm, 0), 40));
    return `rgb(${c(0.975)}, ${c(0.88)}, ${c(0.7)})`;
  }
  // $7, $4.50
  const money = (n) => (n == null ? "" : `$${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`);
  const num = (n, digits = 1) => +Number(n).toFixed(digits);

  // ---------- The choices a board is built from ----------
  const LAYOUTS = [
    { id: "list", label: "Classic list", help: "One list; on a TV, two columns when there are many lines." },
    { id: "columns", label: "Two columns", help: "Always two columns on a TV and on paper (one on a phone)." },
    { id: "cards", label: "Cards", help: "Each beer in its own box, with its prices underneath." },
    { id: "compact", label: "Compact", help: "Name, dotted line, price: fits the most lines." },
  ];
  // What each beer can show. The name is always shown; the rest can be hidden or put in another order.
  const PARTS = [
    { id: "number", label: "Line number", row: "title", help: "not on the public page" },
    { id: "color", label: "Color dot", row: "title" },
    { id: "name", label: "Name", row: "title", always: true },
    { id: "tags", label: "Tags", row: "title" },
    { id: "style", label: "Style", row: "facts" },
    { id: "abv", label: "ABV", row: "facts" },
    { id: "ibu", label: "IBU", row: "facts" },
    { id: "words", label: "Short line (TV) / description", row: "words" },
    { id: "fields", label: "Your own fields", row: "fields", help: "not on the TV" },
    { id: "prices", label: "Prices", row: "prices" },
  ];
  const DEFAULT_PARTS = ["number", "color", "name", "style", "abv", "ibu", "tags", "words", "fields", "prices"];
  // Color schemes: background, text, and accent (headings and badges). "auto" is step 2's look:
  // dark on a TV, the phone's light or dark on the public page.
  const THEMES = [
    { id: "auto", label: "Usual (dark TV, the phone's light or dark)" },
    { id: "dark", label: "Dark", bg: "#111110", text: "#f6f3ec", accent: "#f0a050" },
    { id: "light", label: "Light", bg: "#fbfaf7", text: "#1c1b19", accent: "#9a4b12" },
    { id: "chalkboard", label: "Chalkboard", bg: "#1f2b24", text: "#f2efe2", accent: "#f2d06b" },
    { id: "kraft", label: "Kraft paper", bg: "#d9c3a0", text: "#2a1f14", accent: "#7a2e12" },
    { id: "midnight", label: "Midnight", bg: "#0f1a2e", text: "#eef2f8", accent: "#7cc4ff" },
    { id: "contrast", label: "High contrast", bg: "#000000", text: "#ffffff", accent: "#ffd400" },
    { id: "custom", label: "My own colors" },
  ];
  // Headline and body fonts that go together (all from Google Fonts; "" is the device's usual font)
  const FONT_PAIRS = [
    { id: "usual", label: "Usual", head: "", body: "" },
    { id: "classic", label: "Classic", head: "Playfair Display", body: "Source Sans 3" },
    { id: "taproom", label: "Taproom", head: "Oswald", body: "Roboto" },
    { id: "sign", label: "Sign painter", head: "Bebas Neue", body: "Lato" },
    { id: "friendly", label: "Friendly", head: "Fredoka", body: "Nunito" },
    { id: "chalk", label: "Chalk", head: "Cabin Sketch", body: "Cabin" },
    { id: "typewriter", label: "Typewriter", head: "Special Elite", body: "Courier Prime" },
    { id: "modern", label: "Modern", head: "Space Grotesk", body: "Inter" },
    { id: "western", label: "Old west", head: "Rye", body: "Lora" },
  ];
  const FONT_NAME = /^[A-Za-z0-9 ]{1,40}$/; // a Google Font's name, as typed
  const SYSTEM_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  // ---------- Colors ----------
  const hex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const mix = (a, b, t) => toHex(hex(a).map((v, i) => v * t + hex(b)[i] * (1 - t)));
  // How readable one color is on another (1 to 21; 4.5 is the usual minimum for text, 7 for a TV across a room)
  function contrast(a, b) {
    const lum = (c) => hex(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }
  // A board's three colors (null for "auto": the mode's own)
  function colorsOf(theme) {
    const t = theme || {};
    if (t.scheme === "custom") return hex(t.bg) && hex(t.text) && hex(t.accent) ? { bg: t.bg, text: t.text, accent: t.accent } : null;
    return THEMES.find((x) => x.id === t.scheme && x.bg) || null;
  }
  // The CSS variables for a board's colors (the dim text and the lines are mixed from the two main colors)
  function colorVars(c) {
    if (!c) return "";
    const accentText = contrast(c.accent, "#000000") >= contrast(c.accent, "#ffffff") ? "#000000" : "#ffffff";
    return `--mb-bg:${c.bg};--mb-text:${c.text};--mb-dim:${mix(c.text, c.bg, 0.68)};--mb-line:${mix(c.text, c.bg, 0.2)};--mb-accent:${c.accent};--mb-accent-text:${accentText};`;
  }

  // ---------- Fonts ----------
  const fontStack = (name) => (name && FONT_NAME.test(name) ? `"${name}", ${SYSTEM_FONT}` : "");
  // The brewery's own files (uploaded fonts, logos), each fetched once: a file never changes
  let fileSource = null;
  const files = new Map(); // id -> Promise of { mime, data }
  const setFileSource = (fn) => { fileSource = fn; };
  function getFile(id) {
    if (!files.has(id)) {
      const p = Promise.resolve(fileSource ? fileSource(id) : null).then((f) => { if (!f) throw new Error("no file"); return f; });
      p.catch(() => files.delete(id)); // (try again next time)
      files.set(id, p);
    }
    return files.get(id);
  }
  const dataUrl = (f) => `data:${f.mime};base64,${f.data}`;
  const uploadedFont = (board, name) => (board.files || []).find((f) => f.kind === "font" && name && f.name.toLowerCase() === name.toLowerCase());

  // Adds the board's Google Fonts to the page (once each) and resolves when they're loaded, or after
  // a few seconds (no signal, or a name Google doesn't have: the usual font is used instead).
  const asked = new Set();
  const added = new Set(); // uploaded fonts already on this page
  const missing = new Set(); // names Google Fonts didn't have
  const fontMissing = (name) => missing.has(name);
  // The brewery's own fonts: from their files, added to the page under their names
  function loadUploadedFonts(board, doc) {
    const theme = board?.board?.theme || {};
    const fonts = [theme.head, theme.body].map((n) => uploadedFont(board, n)).filter(Boolean);
    return Promise.all(fonts.filter((f) => !added.has(f.id)).map((f) => getFile(f.id).then(async (file) => {
      const face = new FontFace(f.name, `url(${dataUrl(file)})`);
      await face.load();
      doc.fonts.add(face);
      added.add(f.id);
    }).catch(() => null)));
  }
  // The board's logo, in a board drawn into el
  function loadLogo(el) {
    const img = el?.querySelector("img.mb-logo[data-file]");
    if (!img || img.getAttribute("src")) return Promise.resolve();
    return getFile(img.dataset.file).then((file) => new Promise((r) => {
      img.addEventListener("load", r, { once: true });
      img.addEventListener("error", r, { once: true });
      img.src = dataUrl(file);
    })).catch(() => { img.remove(); });
  }
  function loadExtras(board, el, doc = document) {
    const done = Promise.all([loadFonts(board, doc), doc.fonts ? loadUploadedFonts(board, doc) : null, loadLogo(el)]);
    return Promise.race([done, new Promise((r) => setTimeout(r, 6000))]);
  }

  function loadFonts(board, doc = document) {
    const theme = board?.board?.theme || {};
    const names = [theme.head, theme.body].filter((n) => n && FONT_NAME.test(n) && !uploadedFont(board, n));
    for (const name of names) {
      if (asked.has(name)) continue;
      asked.add(name);
      // The regular weight is always there; bold isn't for every font, so it's asked for on its own
      for (const weight of ["", ":wght@700"]) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}${weight}&display=swap`;
        link.addEventListener("load", () => { link.dataset.done = "1"; if (!weight) missing.delete(name); });
        link.addEventListener("error", () => { link.dataset.done = "1"; if (!weight) missing.add(name); });
        doc.head.append(link);
      }
    }
    if (!names.length || !doc.fonts) return Promise.resolve();
    // (each font's stylesheet first, so a name Google doesn't have is known by the time this resolves)
    const sheets = [...doc.querySelectorAll('link[href^="https://fonts.googleapis.com/css2"]')]
      .map((l) => (l.dataset.done ? Promise.resolve() : new Promise((r) => { l.addEventListener("load", r, { once: true }); l.addEventListener("error", r, { once: true }); })));
    const ready = Promise.all(sheets).then(() =>
      Promise.all(names.flatMap((n) => [`400 1em "${n}"`, `700 1em "${n}"`].map((f) => doc.fonts.load(f).catch(() => null)))));
    return Promise.race([ready, new Promise((r) => setTimeout(r, 4000))]);
  }

  // ---------- A board's settings (step 2 boards have none: the usual look) ----------
  function settingsOf(board) {
    const s = board.board || {};
    const parts = Array.isArray(s.parts) && s.parts.length ? s.parts.filter((p) => PARTS.some((x) => x.id === p)) : DEFAULT_PARTS;
    return {
      layout: LAYOUTS.some((l) => l.id === s.layout) ? s.layout : "list",
      parts: parts.includes("name") ? parts : ["name", ...parts],
      sectionOrder: Array.isArray(s.section_order) ? s.section_order : [],
      theme: s.theme || { scheme: "auto" },
      showOnTap: s.show_on_tap !== false,
      showComingSoon: s.show_coming_soon ?? true,
      showToGo: s.show_to_go ?? false,
    };
  }

  // The pour sizes any beer on the board has a price for, in the brewery's order
  function sizesUsed(board) {
    const used = new Set(board.lines.flatMap((l) => (l.beer?.prices || []).map((p) => p.size)));
    return board.sizes.filter((s) => used.has(s.id));
  }

  // Groups to show: one list in line order, or by section (in this board's order, then the
  // brewery's), with beers that have no section and "something else" lines at the end
  function groups(board, set) {
    if (board.order !== "sections") return [{ title: "", lines: board.lines }];
    const rank = (s) => { const i = set.sectionOrder.indexOf(s.id); return i < 0 ? 1000 : i; };
    const sections = board.sections.map((s, i) => ({ ...s, i })).sort((a, b) => rank(a) - rank(b) || a.i - b.i);
    const known = new Set(board.sections.map((s) => s.id));
    return [
      ...sections.map((s) => ({ title: s.name, lines: board.lines.filter((l) => l.beer?.section === s.id) })),
      { title: board.sections.length ? "More on tap" : "", lines: board.lines.filter((l) => l.beer && !known.has(l.beer.section)) },
      { title: "Also pouring", lines: board.lines.filter((l) => l.kind === "other") },
    ].filter((g) => g.lines.length);
  }

  // One beer, in the board's parts and order. Its rows: the title row (number, color, name, tags),
  // the facts row (style, ABV, IBU), the words, and its own fields; prices in columns (TV, paper)
  // or under the beer (phone, cards). On a TV the facts sit on the name's row, so more lines fit.
  function item(line, sizes, mode, set) {
    const b = line.beer;
    const shows = (p) => set.parts.includes(p) && !(p === "number" && mode === "public") && !(p === "fields" && mode === "tv");
    const inColumns = mode !== "public" && set.layout !== "cards";
    const no = shows("number") ? `<span class="mb-no">${line.no}</span>` : "";
    if (!b) {
      return `<li class="mb-item mb-other">${no}<div class="mb-main"><div class="mb-name">${esc(line.label || "Something else")}</div></div>${
        inColumns ? sizes.map(() => `<span class="mb-price"></span>`).join("") : ""}</li>`;
    }
    const part = {
      color: () => (b.srm != null ? `<span class="mb-swatch" style="background:${srmColor(b.srm)}" aria-hidden="true"></span>` : ""),
      name: () => `<span class="mb-beer">${esc(b.name)}</span>`,
      tags: () => (b.tags || []).map((t) => `<span class="mb-tag mb-${t.kind === "allergen" ? "allergen" : "badge"}">${esc(t.name)}</span>`).join(""),
      style: () => esc(b.style || ""),
      abv: () => (b.abv != null ? `${num(b.abv)}%` : ""),
      ibu: () => (b.ibu != null ? `${Math.round(b.ibu)} IBU` : ""),
    };
    const ordered = (row) => set.parts.filter((p) => shows(p) && PARTS.find((x) => x.id === p)?.row === row && p !== "number");
    const factText = ordered("facts").map((p) => part[p]()).filter(Boolean).join(" · ");
    const inline = mode === "tv" || set.layout === "compact";
    const title = ordered("title").map((p) => {
      const html = part[p]();
      return p === "name" && inline && factText ? `${html} <span class="mb-facts">${factText}</span>` : html;
    }).join("");
    const words = mode === "tv" ? b.short || "" : b.description || b.short || "";
    const fields = (b.fields || []).map((f) => `<span class="mb-field"><span class="mb-field-name">${esc(f.name)}:</span> ${esc(f.value)}</span>`).join("");
    // The rows under the title, in the order their first part comes in
    const rows = { facts: !inline && factText ? `<div class="mb-facts">${factText}</div>` : "",
      words: shows("words") && words ? `<div class="mb-words">${esc(words)}</div>` : "",
      fields: shows("fields") && fields ? `<div class="mb-fields">${fields}</div>` : "" };
    const below = [...new Set(set.parts.map((p) => PARTS.find((x) => x.id === p)?.row))].filter((r) => r in rows).map((r) => rows[r]).join("");
    const priceOf = (s) => (b.prices || []).find((p) => p.size === s.id)?.price;
    const prices = !shows("prices") ? ""
      : inColumns ? sizes.map((s) => `<span class="mb-price">${money(priceOf(s))}</span>`).join("")
      : `<div class="mb-price-list">${sizes.filter((s) => priceOf(s) != null).map((s) => `<span>${esc(s.name)} <strong>${money(priceOf(s))}</strong></span>`).join("")}</div>`;
    return `<li class="mb-item">${no}<div class="mb-main"><div class="mb-name">${title}</div>${below}${inColumns ? "" : prices}</div>${inColumns ? prices : ""}</li>`;
  }

  function render(board, mode) {
    const set = settingsOf(board);
    const sizes = set.parts.includes("prices") ? sizesUsed(board) : [];
    const inColumns = mode !== "public" && set.layout !== "cards";
    const head = inColumns ? `<div class="mb-cols" aria-hidden="true">${sizes.map((s) => `<span class="mb-price">${esc(s.name)}</span>`).join("")}</div>` : "";
    // (a group with no prices, like "Also pouring", has no price headings)
    const priced = (g) => g.lines.some((l) => (l.beer?.prices || []).length);
    // A section's heading (and its sizes) is kept with its first beer (cards keep the whole grid instead), so in two columns a heading never
    // ends up alone at the bottom of one column with its beers in the other (board.css: .mb-keep)
    const ol = (lines) => `<ol class="mb-list" style="--sizes:${inColumns ? sizes.length : 0}">${lines.map((l) => item(l, sizes, mode, set)).join("")}</ol>`;
    const list = groups(board, set).map((g) => `<section class="mb-group">
        <div class="mb-keep"><div class="mb-group-head">${g.title ? `<h2>${esc(g.title)}</h2>` : "<span></span>"}${priced(g) ? head : ""}</div>
        ${ol(set.layout === "cards" ? [] : g.lines.slice(0, 1))}</div>${set.layout === "cards" ? ol(g.lines) : g.lines.length > 1 ? ol(g.lines.slice(1)) : ""}
      </section>`).join("");
    // A TV or a page of paper has room for a few coming soon; the public page lists them all
    const comingSoon = set.showComingSoon ? board.coming_soon || [] : [];
    const toGo = set.showToGo ? board.to_go || [] : [];
    const soon = comingSoon.slice(0, mode === "public" ? undefined : 8);
    const extra = [
      comingSoon.length ? `<section class="mb-extra mb-soon"><h2>Coming soon</h2>
        <p>${soon.map((b) => `<span>${esc(b.name)}${b.style ? ` <span class="mb-dim">${esc(b.style)}</span>` : ""}</span>`).join("")}${
          comingSoon.length > soon.length ? `<span class="mb-dim">and ${comingSoon.length - soon.length} more</span>` : ""}</p></section>` : "",
      toGo.length ? `<section class="mb-extra mb-togo"><h2>To go</h2>
        <p>${toGo.map((b) => `<span>${esc(b.name)} <span class="mb-dim">${esc((b.packages || []).join(", "))}</span></span>`).join("")}</p></section>` : "",
    ].join("");
    const lines = set.showOnTap ? board.lines : [];
    const many = lines.length > (mode === "print" ? 18 : 14);
    // Colors: the board's scheme on the TV and the public page; paper stays black on white (ink)
    const colors = mode === "print" ? null : colorsOf(set.theme);
    const fonts = [fontStack(set.theme.head) && `--mb-head-font:${fontStack(set.theme.head)};`,
      fontStack(set.theme.body) && `--mb-body-font:${fontStack(set.theme.body)};`].filter(Boolean).join("");
    const style = `${colorVars(colors)}${fonts}`.replace(/"/g, "&quot;");
    // The logo (filled in by loadExtras once its file is in)
    const logoFile = (board.files || []).find((f) => f.kind === "logo" && f.id === set.theme.logo);
    const logo = logoFile ? `<img class="mb-logo" data-file="${esc(logoFile.id)}" alt="${esc(board.brewery)}">` : "";
    const classes = ["mb", `mb-${mode}`, `mb-layout-${set.layout}`, many ? "mb-many" : "", colors ? "mb-themed" : ""].filter(Boolean).join(" ");
    const body = lines.length ? `<div class="mb-body">${list}</div>`
      : set.showOnTap ? `<p class="mb-empty">Nothing on tap right now.</p>`
      : extra ? "" : `<p class="mb-empty">Nothing to show right now.</p>`;
    return `<div class="${classes}"${style ? ` style="${style}"` : ""}>
      <header class="mb-head"><div class="mb-title">${logo}<h1>${esc(board.title)}</h1></div><div class="mb-brewery">${esc(board.brewery)}</div></header>
      ${body}
      ${extra ? `<div class="mb-extras${lines.length ? "" : " mb-extras-only"}">${extra}</div>` : ""}
    </div>`;
  }

  // TV: the biggest text that fits the screen with no scrolling. The board is sized in "em", so
  // one number (the font size) scales everything; a quick halving search finds it.
  function fit(element) {
    const board = element.querySelector(".mb");
    if (!board) return;
    let low = 6, high = Math.max(12, element.clientHeight / 8);
    for (let i = 0; i < 14; i++) {
      const size = (low + high) / 2;
      element.style.fontSize = `${size}px`;
      if (board.scrollHeight <= element.clientHeight && board.scrollWidth <= element.clientWidth) low = size; else high = size;
    }
    element.style.fontSize = `${low}px`;
  }

  window.BoardView = { render, fit, loadFonts, loadExtras, setFileSource, fileUrl: (id) => getFile(id).then(dataUrl), fontMissing, srmColor, money, contrast, colorsOf, settingsOf,
    LAYOUTS, PARTS, DEFAULT_PARTS, THEMES, FONT_PAIRS, FONT_NAME };
})();
