// Brewery OS — drawing a menu board
//
// One file draws a taproom's menu the same way everywhere: on a TV (board.html with a TV link), on
// the public page (board.html with a public link, also embedded in a website), on paper, and in
// the app's preview. What's on the board comes from the database (menu_board_json in
// supabase/migrations/..._menu_boards.sql), already worked out: this file only lays it out.
//
//   BoardView.render(board, mode)  the board's HTML; mode is "tv", "public", or "print"
//   BoardView.fit(element)         TV only: the biggest text that fits the screen with no scrolling
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

  // The pour sizes any beer on the board has a price for, in the brewery's order
  function sizesUsed(board) {
    const used = new Set(board.lines.flatMap((l) => (l.beer?.prices || []).map((p) => p.size)));
    return board.sizes.filter((s) => used.has(s.id));
  }

  // Groups to show: one list in line order, or by section (in the brewery's order), with beers
  // that have no section and "something else" lines at the end
  function groups(board) {
    if (board.order !== "sections") return [{ title: "", lines: board.lines }];
    const known = new Set(board.sections.map((s) => s.id));
    return [
      ...board.sections.map((s) => ({ title: s.name, lines: board.lines.filter((l) => l.beer?.section === s.id) })),
      { title: board.sections.length ? "More on tap" : "", lines: board.lines.filter((l) => l.beer && !known.has(l.beer.section)) },
      { title: "Also pouring", lines: board.lines.filter((l) => l.kind === "other") },
    ].filter((g) => g.lines.length);
  }

  const facts = (b) => [b.style, b.abv != null ? `${num(b.abv)}%` : "", b.ibu != null ? `${Math.round(b.ibu)} IBU` : ""].filter(Boolean);
  const tags = (b) => (b.tags || []).map((t) => `<span class="mb-tag mb-${t.kind === "allergen" ? "allergen" : "badge"}">${esc(t.name)}</span>`).join("");
  const swatch = (b) => (b.srm != null ? `<span class="mb-swatch" style="background:${srmColor(b.srm)}" aria-hidden="true"></span>` : "");

  // One line of the board. TV and print: prices in columns under the sizes; public: listed under the beer.
  function item(line, sizes, mode) {
    const b = line.beer;
    const no = mode === "public" ? "" : `<span class="mb-no">${line.no}</span>`;
    if (!b) return `<li class="mb-item mb-other">${no}<div class="mb-main"><div class="mb-name">${esc(line.label || "Something else")}</div></div></li>`;
    const words = mode === "tv" ? b.short || "" : b.description || b.short || "";
    const fields = mode === "tv" ? "" : (b.fields || []).map((f) => `<span class="mb-field"><span class="mb-field-name">${esc(f.name)}:</span> ${esc(f.value)}</span>`).join("");
    const priceOf = (s) => (b.prices || []).find((p) => p.size === s.id)?.price;
    const prices = mode === "public"
      ? `<div class="mb-price-list">${sizes.filter((s) => priceOf(s) != null).map((s) => `<span>${esc(s.name)} <strong>${money(priceOf(s))}</strong></span>`).join("")}</div>`
      : sizes.map((s) => `<span class="mb-price">${money(priceOf(s))}</span>`).join("");
    // TV: style and ABV on the beer's own line, so more lines fit at a size readable across the room
    const factText = facts(b).length ? esc(facts(b).join(" · ")) : "";
    return `<li class="mb-item">${no}<div class="mb-main">
        <div class="mb-name">${swatch(b)}${esc(b.name)}${mode === "tv" && factText ? ` <span class="mb-facts">${factText}</span>` : ""}${tags(b)}</div>
        ${mode !== "tv" && factText ? `<div class="mb-facts">${factText}</div>` : ""}
        ${words ? `<div class="mb-words">${esc(words)}</div>` : ""}
        ${fields ? `<div class="mb-fields">${fields}</div>` : ""}
        ${mode === "public" ? prices : ""}
      </div>${mode === "public" ? "" : prices}</li>`;
  }

  function render(board, mode) {
    const sizes = sizesUsed(board);
    const head = mode === "public" ? "" : `<div class="mb-cols" aria-hidden="true">${sizes.map((s) => `<span class="mb-price">${esc(s.name)}</span>`).join("")}</div>`;
    // (a group with no prices, like "Also pouring", has no price headings)
    const priced = (g) => g.lines.some((l) => (l.beer?.prices || []).length);
    const list = groups(board).map((g) => `<section class="mb-group">
        <div class="mb-group-head">${g.title ? `<h2>${esc(g.title)}</h2>` : "<span></span>"}${priced(g) ? head : ""}</div>
        <ol class="mb-list" style="--sizes:${mode === "public" ? 0 : sizes.length}">${g.lines.map((l) => item(l, sizes, mode)).join("")}</ol>
      </section>`).join("");
    // A TV or a page of paper has room for a few coming soon; the public page lists them all
    const soon = (board.coming_soon || []).slice(0, mode === "public" ? undefined : 8);
    const extra = [
      board.coming_soon?.length ? `<section class="mb-extra mb-soon"><h2>Coming soon</h2>
        <p>${soon.map((b) => `<span>${esc(b.name)}${b.style ? ` <span class="mb-dim">${esc(b.style)}</span>` : ""}</span>`).join("")}${
          board.coming_soon.length > soon.length ? `<span class="mb-dim">and ${board.coming_soon.length - soon.length} more</span>` : ""}</p></section>` : "",
      board.to_go?.length ? `<section class="mb-extra mb-togo"><h2>To go</h2>
        <p>${board.to_go.map((b) => `<span>${esc(b.name)} <span class="mb-dim">${esc((b.packages || []).join(", "))}</span></span>`).join("")}</p></section>` : "",
    ].join("");
    const many = board.lines.length > (mode === "print" ? 18 : 14);
    return `<div class="mb mb-${mode}${many ? " mb-many" : ""}">
      <header class="mb-head"><h1>${esc(board.title)}</h1><div class="mb-brewery">${esc(board.brewery)}</div></header>
      ${board.lines.length ? `<div class="mb-body">${list}</div>` : `<p class="mb-empty">Nothing on tap right now.</p>`}
      ${extra ? `<div class="mb-extras">${extra}</div>` : ""}
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

  window.BoardView = { render, fit, srmColor, money };
})();
