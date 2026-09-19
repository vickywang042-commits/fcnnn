(function (root) {
  "use strict";
  function decimalParts(input) {
    const text = String(input ?? "").trim().replace(/[,，\s]/g, "");
    if (!/^\d+(?:\.\d+)?$/.test(text) || text.length > 40) return null;
    const [whole, fraction = ""] = text.split(".");
    return { units: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) };
  }
  function exactDecimal(units, places) {
    const text = units.toString().padStart(places + 1, "0");
    if (!places) return text;
    const fraction = text.slice(-places).replace(/0+$/, "");
    return text.slice(0, -places) + (fraction ? "." + fraction : "");
  }
  function commaInteger(value) { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function calculateBonus(input) {
    const amount = decimalParts(input);
    if (!amount) return null;
    const { units, scale } = amount;
    // Boundary amounts belong to the higher tier: 30,000→14%,
    // 100,000→16%, and 200,000→18%.
    const rate = units < 30000n * scale ? 10 : units < 100000n * scale ? 14 : units < 200000n * scale ? 16 : 18;
    const divisor = 100n * scale;
    const bonus = (units * BigInt(rate) + divisor / 2n) / divisor;
    // Both coefficients are exact finite decimals. Never use floating point
    // or round P/C: P = bonus * 12 / 100000; C = bonus * 5 / 100000.
    const p = exactDecimal(bonus * 12n, 5);
    const c = exactDecimal(bonus * 5n, 5);
    return { rate, bonus: bonus.toString(), p, c, text: `${commaInteger(bonus)}元\n${p}P\n${c}C` };
  }
  function productMatchesSearch(product, query) {
    const tokens = String(query || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
    const fields = [product.code, product.currency || "USD", ...(product.clients || []).map((client) => client.currency || product.currency || "USD")]
      .map((value) => String(value || "").toUpperCase());
    return tokens.every((token) => fields.some((field) => field.includes(token)));
  }
  function amountInWan(value) {
    const amount = decimalParts(value);
    if (!amount || amount.units <= 0n) return "金額未填";
    const places = amount.scale.toString().length - 1 + 4;
    const [whole, fraction] = exactDecimal(amount.units, places).split(".");
    return commaInteger(whole) + (fraction ? "." + fraction : "") + "萬";
  }
  function buildFilteredCopyText(items, maturityOf, structureLabel) {
    return [...(items || [])].sort((a, b) => {
      const dateOrder = (maturityOf(a.p) || "9999").localeCompare(maturityOf(b.p) || "9999");
      return dateOrder || String(a.p.code || "").localeCompare(String(b.p.code || ""), "en", { numeric: true });
    }).map(({ p }) => {
      const date = maturityOf(p);
      const dateLabel = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : "日期待補";
      const clients = (p.clients || []).map((client) => {
        const currency = String(client.currency || p.currency || "USD").toUpperCase();
        return `${client.name || "客戶未填"} ${amountInWan(client.amount)}${currency !== "USD" ? `（${currency}）` : ""}`;
      }).join("、") || "客戶未填";
      return `${dateLabel}\n${p.code || "商品代號未填"}（${structureLabel(p)}）\n${clients}`;
    }).join("\n\n");
  }
  async function renderProductImage(snapshot) {
    if (document.fonts?.ready) await document.fonts.ready;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    const width = 720, margin = 32, contentWidth = width - margin * 2;
    const font = '"IBM Plex Sans TC", "Microsoft JhengHei", sans-serif';
    const rows = [];
    function wrap(text, size, color, weight = "400") {
      ctx.font = `${weight} ${size}px ${font}`;
      for (const paragraph of String(text || "—").split("\n")) {
        let line = "";
        for (const char of paragraph) {
          if (line && ctx.measureText(line + char).width > contentWidth) { rows.push({ text: line, size, color, weight }); line = ""; }
          line += char;
        }
        rows.push({ text: line, size, color, weight });
      }
    }
    wrap("FCN記錄", 23, "#a9bcc3", "600");
    wrap(snapshot.title, 42, "#f3eee4", "600");
    wrap(snapshot.status, 28, "#efdcaf", "600");
    for (const section of snapshot.sections) {
      rows.push({ gap: 22, separator: true });
      wrap(section.title, 28, "#b6ccbd", "600");
      for (const line of section.lines) wrap(line, 32, "#f3eee4");
    }
    rows.push({ gap: 24 });
    wrap(snapshot.footer, 24, "#bac6c7");
    const height = margin * 2 + rows.reduce((sum, row) => sum + (row.gap || Math.ceil(row.size * 1.6)), 0);
    if (height > 16000) throw new Error("Image too long");
    canvas.width = width; canvas.height = height;
    ctx.fillStyle = "#29373c"; ctx.fillRect(0, 0, width, height);
    let y = margin;
    ctx.textBaseline = "top";
    for (const row of rows) {
      if (row.gap) {
        if (row.separator) { ctx.strokeStyle = "#647b81"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(margin, y + 4); ctx.lineTo(width - margin, y + 4); ctx.stroke(); }
        y += row.gap; continue;
      }
      ctx.font = `${row.weight} ${row.size}px ${font}`; ctx.fillStyle = row.color;
      ctx.fillText(row.text, margin, y); y += Math.ceil(row.size * 1.6);
    }
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG unavailable")), "image/png"));
  }
  root.FcnTools = { calculateBonus, productMatchesSearch, amountInWan, buildFilteredCopyText, renderProductImage };
})(globalThis);
