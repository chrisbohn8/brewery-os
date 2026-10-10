import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
await page.goto("http://localhost:8123/board.html?" + Date.now());
const r = await page.evaluate(() => {
  const out = [];
  const lines = (n) => Array.from({ length: n }, (_, i) => ({ no: i + 1, kind: "beer", beer: { name: `Beer ${i + 1}`, style: "Style", abv: 6, short: "Short line", section: ["a", "b", "c", "d"][i % 4], tags: [], prices: [{ size: "p", price: 7 }, { size: "h", price: 5 }] } }));
  for (const n of [6, 9, 12, 16, 22]) {
    const board = { title: "On tap", brewery: "Test", order: "sections", public: false, sizes: [{ id: "p", name: "16 oz" }, { id: "h", name: "10 oz" }],
      sections: [{ id: "a", name: "IPAs" }, { id: "b", name: "Lagers" }, { id: "c", name: "Sours" }, { id: "d", name: "Dark" }], lines: lines(n), coming_soon: [], to_go: [],
      board: { layout: "columns", parts: ["number", "name", "style", "abv", "words", "prices"], theme: { scheme: "auto" }, show_on_tap: true } };
    const box = document.getElementById("board"); box.className = "tv"; box.innerHTML = BoardView.render(board, "tv"); BoardView.fit(box);
    const orphans = [...box.querySelectorAll(".mb-group")].filter((g) => { const h = g.querySelector(".mb-group-head").getBoundingClientRect(), f = g.querySelector(".mb-item")?.getBoundingClientRect(); return f && Math.abs(h.left - f.left) > 200; }).length;
    out.push(`${n}: ${orphans ? "ORPHAN" : "ok"}`);
  }
  return out;
});
console.log("OLD board files:", r.join(" | "));
await b.close();
