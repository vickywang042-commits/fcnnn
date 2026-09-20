(function (root) {
  "use strict";
  const OCR_SCRIPT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const NAME_MAP = Object.freeze({
    SKHY: "SK海力士", MU: "美光", MRVL: "邁威爾", COHR: "科赫特",
    TSM: "台積電", AAPL: "蘋果", NVDA: "輝達", TSLA: "特斯拉",
    DELL: "戴爾", AAL: "美國航空",
    AMD: "超微", AVGO: "博通", AMZN: "亞馬遜", META: "Meta",
    MSFT: "微軟", GOOGL: "Alphabet", GOOG: "Alphabet", NFLX: "Netflix",
    ARM: "安謀", QCOM: "高通", INTC: "英特爾", SMCI: "美超微", MPWR: "芯源系統",
    ORCL: "甲骨文", PLTR: "Palantir", CRWD: "CrowdStrike", DRAM: "DRAM ETF",
    "6361": "荏原製作所", "3110": "日東紡", "8035": "東京威力科創", "8002": "丸紅"
  });
  const BOND_ISSUER_MAP = Object.freeze({
    AMZN: "亞馬遜", AAPL: "蘋果", MSFT: "微軟", GOOG: "Alphabet", GOOGL: "Alphabet",
    META: "Meta", NVDA: "輝達", TSLA: "特斯拉", NFLX: "Netflix", TSM: "台積電",
    JPM: "摩根大通", BAC: "美國銀行", GS: "高盛", C: "花旗", HSBC: "匯豐"
  });
  function normalizeText(value) {
    return String(value || "").normalize("NFKC")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/[|｜]/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  function cleanNumber(value, fallback = "—") {
    const number = Number(String(value || "").replace(/,/g, ""));
    return Number.isFinite(number) ? String(number) : fallback;
  }
  function sameLinePercent(lines, labels) {
    for (const line of lines) {
      for (const label of labels) {
        const labelMatch = line.match(label);
        if (!labelMatch) continue;
        const hit = line.slice(labelMatch.index + labelMatch[0].length).match(/(\d{1,3}(?:\.\d+)?)\s*%/);
        if (hit) return cleanNumber(hit[1]);
      }
    }
    return null;
  }
  function allPercents(text) {
    return Array.from(text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g), (match) => cleanNumber(match[1]));
  }
  function allNumbers(text) {
    return Array.from(String(text || "").matchAll(/(?:^|\s)(\d{1,3}(?:[.,]\d{1,3})?)(?=\s|$|%|\()/g), (match) => cleanNumber(match[1].replace(",", ".")));
  }
  function markedTableRow(text, rowNumber) {
    const marker = `[[FCN_TABLE_ROW_${rowNumber}]]`;
    const start = text.indexOf(marker);
    if (start < 0) return "";
    const body = text.slice(start + marker.length);
    const next = body.search(/\[\[FCN_[A-Z0-9_]+\]\]/);
    return (next >= 0 ? body.slice(0, next) : body).trim();
  }
  function markedPricingCell(text) {
    const marker = "[[FCN_PRICING_CELL]]";
    const start = text.indexOf(marker);
    if (start < 0) return "";
    const body = text.slice(start + marker.length);
    const next = body.search(/\[\[FCN_[A-Z0-9_]+\]\]/);
    return (next >= 0 ? body.slice(0, next) : body).trim();
  }
  function markedTickerCells(text) {
    const marker = "[[FCN_TICKER_CELLS]]";
    const start = text.indexOf(marker);
    if (start < 0) return "";
    const body = text.slice(start + marker.length);
    const next = body.search(/\[\[FCN_[A-Z0-9_]+\]\]/);
    return (next >= 0 ? body.slice(0, next) : body).trim();
  }
  function markedCell(text, name) {
    const marker = `[[FCN_${name}_CELL]]`;
    const start = text.indexOf(marker);
    if (start < 0) return "";
    const body = text.slice(start + marker.length);
    const next = body.search(/\[\[FCN_[A-Z0-9_]+\]\]/);
    return (next >= 0 ? body.slice(0, next) : body).trim();
  }
  function boundedCellNumber(text, maximum) {
    const match = String(text || "").replace(/,/g, ".").match(/\d{1,6}(?:\.\d{1,3})?/);
    if (!match) return null;
    let number = Number(match[0]);
    while (number > maximum && Number.isInteger(number) && number % 100 === 0) number /= 100;
    return number >= 0 && number <= maximum ? cleanNumber(number) : null;
  }
  function validPercent(value, maximum = 200) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= maximum ? cleanNumber(number) : null;
  }
  function kiTypeFromCell(text) {
    const compact = String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (/A[KX][I1L]|AK$/.test(compact)) return "AKI";
    if (/E[KX][I1L]|EK$/.test(compact)) return "EKI";
    if (/N[O0]NE/.test(compact)) return "None";
    return null;
  }
  function percentFromRow(row, index, fallbackNumberIndex = index) {
    const percents = allPercents(row);
    if (percents[index] != null) return percents[index];
    const numbers = allNumbers(row);
    return numbers[fallbackNumberIndex] ?? null;
  }
  function tickerRows(text, allowStandalone = false) {
    const rows = [], seen = new Set(), marketSuffixes = [];
    const aliases = { AAI: "AAL", AAPI: "AAPL", AAP: "AAPL", APPL: "AAPL", AAFL: "AAPL", NVOA: "NVDA", NV0A: "NVDA", NTC: "INTC", INTG: "INTC", INTO: "INTC", TNTC: "INTC", T5LA: "TSLA", TSIA: "TSLA", T5M: "TSM" };
    const add = (rawSymbol, suffix = "") => {
      let cleaned = String(rawSymbol || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
      if (!suffix) {
        const gluedSuffix = cleaned.match(/^(.{2,9}?)(UN|UW|US|UQ|UF|JT|JP|AT|HK)$/);
        if (gluedSuffix) { cleaned = gluedSuffix[1]; suffix = gluedSuffix[2]; }
      }
      const symbol = aliases[cleaned] || cleaned;
      // Two-letter OCR fragments such as "TT" are common when a red ticker
      // is partly lost. Do not present an invented symbol as a confident result.
      if (!symbol || (symbol.length < 3 && !NAME_MAP[symbol] && !/^\d{4,6}$/.test(symbol)) || seen.has(symbol)) return;
      seen.add(symbol); if (suffix) marketSuffixes.push(suffix.toUpperCase());
      rows.push({ symbol, name: NAME_MAP[symbol] || "" });
    };
    const paired = /\b([A-Z][A-Z0-9.-]{1,8}?|\d{4,6})[\s.-]?(UN|UW|US|UQ|UF|JT|JP|AT|HK)\b/gi;
    for (const match of text.matchAll(paired)) {
      add(match[1], match[2]);
    }
    if (allowStandalone) {
      const ignored = new Set(["UN", "UW", "US", "UQ", "UF", "JT", "JP", "AT", "HK", "FCN", "USD", "JPY", "AUD", "TWD"]);
      for (const line of String(text || "").split("\n")) {
        const candidate = (line.toUpperCase().match(/\b(?:[A-Z][A-Z0-9.]{1,8}|\d{4,6})\b/g) || []).find((token) => !ignored.has(token));
        if (candidate) add(candidate);
      }
    }
    for (const [symbol, name] of Object.entries(NAME_MAP)) {
      if (seen.has(symbol) || !new RegExp(`\\b${symbol}\\b`, "i").test(text)) continue;
      seen.add(symbol); rows.push({ symbol, name });
    }
    // The source inquiry table has at most four linked-underlying columns.
    // Limiting to those four also prevents a second, noisier OCR pass from
    // appending a hallucinated duplicate after the real row has been read.
    return { rows: rows.slice(0, 4), marketSuffixes };
  }
  function parseProductOcrText(rawText) {
    const text = normalizeText(rawText), lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const flat = text.replace(/\n/g, " ");
    const taggedRow1 = markedTableRow(text, 1), taggedRow2 = markedTableRow(text, 2), taggedRow3 = markedTableRow(text, 3), taggedPricing = markedPricingCell(text), taggedTickers = markedTickerCells(text);
    const taggedTickerCellTexts = [1, 2, 3, 4].map((index) => markedCell(text, `TICKER_${index}`));
    const row1 = taggedRow1 || lines.find((line) => /\b(?:USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\b/i.test(line) && tickerRows(line).rows.length >= 1) || "";
    const row2 = taggedRow2 || lines.find((line) => /\b(?:DAILY|MEMORY|PERIOD|EKI|AKI|NONE)\b/i.test(line) && /\d/.test(line)) || "";
    const row3 = taggedRow3 || lines.find((line) => /20\d{2}\s*SN\s*\d+/i.test(line)) || "";
    const codeMatch = `${row3} ${flat}`.match(/\b(?:MA\s*)?20\d{2}\s*SN\s*\d{2,6}\b/i);
    const code = codeMatch ? codeMatch[0].replace(/\s+/g, "").toUpperCase() : "";
    const structureSource = `${row1} ${flat}`;
    const structure = /STEP\s*DOWN\s*FCN|STEPDOWNFCN/i.test(structureSource) ? "Stepdown FCN" : /EXPRESS\s*FCN/i.test(structureSource) ? "Express FCN" : /\bDAC\b/i.test(structureSource) ? "DAC" : "FCN";
    const stepdown = structure === "Stepdown FCN";
    const taggedAutocall = boundedCellNumber(markedCell(text, stepdown ? "STEP_AUTOCALL" : "AUTOCALL"), 200);
    const taggedTenor = boundedCellNumber(markedCell(text, stepdown ? "STEP_TENOR" : "TENOR"), 24);
    const taggedKiType = kiTypeFromCell(markedCell(text, stepdown ? "STEP_KI_TYPE" : "KI_TYPE"));
    const taggedKi = boundedCellNumber(markedCell(text, stepdown ? "STEP_KI" : "KI"), 200);
    const taggedStepDown = stepdown ? boundedCellNumber(markedCell(text, "STEP_DOWN"), 100) : null;
    const currencyMatch = `${row1} ${flat}`.match(/\b(USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\b/i);
    const currency = currencyMatch?.[1]?.toUpperCase() || "USD";
    const typeMatch = `${row2} ${flat}`.match(/\b(EKI|AKI|NONE)\b/i);
    const kiType = taggedKiType || kiTypeFromCell(row2) || (typeMatch ? typeMatch[1].toUpperCase().replace("NONE", "None") : "待確認");
    const row1Percents = allPercents(row1), row1Numbers = allNumbers(row1);
    const row1Financials = row1Percents.length >= 2 ? row1Percents : row1Numbers.slice(-3);
    const row2Numbers = allNumbers(row2);
    const row2KiMatch = row2.match(/\b(?:EKI|AKI)\b\s*(\d{1,3}(?:[.,]\d{1,3})?)\s*%?/i);
    const strike = validPercent((taggedRow1 ? row1Financials[0] : null) || sameLinePercent(lines, [/執行價/, /Strike/i]) || row1Financials[0]) || "—";
    const coupon = validPercent((taggedRow1 ? row1Financials[1] : null) || sameLinePercent(lines, [/年化配息/, /Coupon/i]) || row1Financials[1]) || "—";
    const autocall = validPercent(taggedAutocall || (taggedRow2 ? row2Numbers[0] : null) || sameLinePercent(lines, [/提前出場條件/, /提前出場/, /Auto.?call/i]) || percentFromRow(row2, 0, 0)) || "—";
    const ki = kiType === "None" ? "0" : (validPercent(taggedKi || (taggedRow2 ? (row2KiMatch ? cleanNumber(row2KiMatch[1]) : row2Numbers[2]) : null) || sameLinePercent(lines, [/觸及價格/, /觸發價格/, /\bKI\b/i]) || percentFromRow(row2, 1, 2)) || "—");
    const tenorMatch = (taggedRow2 ? row2.match(/(?:^|\s)(\d{1,2})\s*\(?月\)?/i) : null)
      || flat.match(/產品天期[\s\S]{0,180}?(\d{1,2})\s*\/?\s*\(?月\)?/i)
      || flat.match(/(?:Tenor|期間)[^\d]{0,30}(\d{1,2})\s*(?:M|個?月)/i)
      || row2.match(/(?:^|\s)(\d{1,2})\s*\(?月\)?/i);
    const tenor = taggedTenor || (tenorMatch ? cleanNumber(tenorMatch[1]) : "—");
    const stepDown = stepdown ? (validPercent(taggedStepDown || row2Numbers[1], 100) || "—") : null;
    const guaranteedMatch = row1.match(/\b(?:USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\s+(\d{1,2})\b/i)
      || flat.match(/保證領息(?:期間)?\s*(?:\(月\))?\s*[:：]?\s*(\d{1,2})(?:\s*(?:個?月|\(月\)))?/i)
      || flat.match(/\b(?:USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\s+(\d{1,2})\b/i);
    const guaranteed = guaranteedMatch ? cleanNumber(guaranteedMatch[1]) : "—";
    const pricingSource = `${taggedPricing} ${row3} ${flat}`.replace(/\s+/g, "");
    const pricing = /開/.test(pricingSource) ? "開盤價" : /收|盤/.test(pricingSource) ? "收盤價" : "待確認";
    const targetedTickerRows = taggedTickerCellTexts.filter(Boolean).flatMap((cell) => tickerRows(cell, true).rows.slice(0, 1));
    const targetedTickerText = taggedTickerCellTexts.filter(Boolean).join("\n");
    const fallbackTickers = taggedTickers ? tickerRows(taggedTickers, true) : tickerRows(`${row1}\n${flat}`);
    const targetedSeen = new Set();
    const targetedUnique = targetedTickerRows.filter((item) => item.symbol && !targetedSeen.has(item.symbol) && targetedSeen.add(item.symbol));
    const combinedTickerRows = [...targetedUnique, ...fallbackTickers.rows.filter((item) => !targetedSeen.has(item.symbol))].slice(0, 4);
    const targetedMarkets = tickerRows(targetedTickerText, true).marketSuffixes;
    const tickers = { rows: combinedTickerRows, marketSuffixes: targetedMarkets.length ? targetedMarkets : fallbackTickers.marketSuffixes };
    const markets = new Set(tickers.marketSuffixes.map((suffix) => ["JT", "JP"].includes(suffix) ? "日股" : suffix === "AT" ? "澳股" : "美股"));
    const market = markets.size === 1 ? [...markets][0] : markets.size > 1 ? "跨市場" : "美股";
    const currencyNames = { USD: "美金", JPY: "日圓", AUD: "澳幣", TWD: "台幣", HKD: "港幣", EUR: "歐元", GBP: "英鎊", CHF: "瑞郎", CNH: "人民幣", CNY: "人民幣" };
    const missing = [];
    if (!code) missing.push("商品代號");
    if (!tickers.rows.length) missing.push("連結標的");
    if (strike === "—") missing.push("執行價");
    if (autocall === "—") missing.push("提前出場");
    if (tenor === "—") missing.push("期間");
    if (guaranteed === "—") missing.push("保證領息");
    if (coupon === "—") missing.push("年化配息率");
    if (kiType === "待確認") missing.push("觸及類型");
    if (pricing === "待確認") missing.push("期初定價");
    return { structure, currency, currencyName: currencyNames[currency] || currency, market, code, pricing, underlyings: tickers.rows, strike, ki, kiType, autocall, stepDown, tenor, guaranteed, coupon, missing, rawText: text };
  }
  function formatProductOcrResult(parsed) {
    const isStepdownResult = parsed.structure === "Stepdown FCN";
    const underlyings = parsed.underlyings.length ? parsed.underlyings.map((item) => `${item.symbol}${item.name ? `${isStepdownResult ? " " : "  "}${item.name}` : ""}`).join("\n") : "（請手動輸入）";
    const suffix = (value, unit) => value === "—" ? "—" : `${value}${unit}`;
    const structureTitle = isStepdownResult ? "STEPDOWNFCN" : parsed.structure;
    const kiTypeLabel = isStepdownResult && parsed.kiType === "EKI" ? "EKI(到期比價)"
      : isStepdownResult && parsed.kiType === "AKI" ? "AKI(存續期間監測)" : parsed.kiType;
    let autocallText = suffix(parsed.autocall, "%");
    if (isStepdownResult && parsed.autocall !== "—" && parsed.stepDown !== "—") {
      const initial = Number(parsed.autocall), decline = Number(parsed.stepDown), months = Math.max(0, Math.min(24, Number(parsed.tenor) || 0));
      const schedule = Array.from({ length: months }, (_, index) => `${cleanNumber(Math.max(0, initial - decline * index))}%`);
      autocallText = `${suffix(parsed.autocall, "%")}開始遞減，逐月遞減${suffix(parsed.stepDown, "%")}${schedule.length ? `（${schedule.join("，")}）` : ""}`;
    }
    return `${structureTitle} 條件(${parsed.currencyName}/${parsed.market})\n${parsed.code || "商品代號待補"}(${parsed.pricing})\n\n🔶連結標的：\n\n${underlyings}\n\n🔸執行價：${suffix(parsed.strike, "%")}\n🔸下限價：${suffix(parsed.ki, "%")}\n🔸觸及類型：${kiTypeLabel}\n🔸提前出場：${autocallText}\n🔸期間：${suffix(parsed.tenor, "個月")}\n🔸保證領息：${suffix(parsed.guaranteed, "個月")}\n🔸年化配息率：${suffix(parsed.coupon, "%")}`;
  }
  function cleanDistributionCustomer(value) {
    return String(value || "").replace(/\s+/g, "")
      .replace(/^[A-Z]?\d{5,10}/i, "")
      .replace(/(?:投資)?股份有限公司$/, "")
      .replace(/有限公司$/, "")
      .trim();
  }
  function cleanDistributionAmount(value) {
    const compact = String(value || "").replace(/[，]/g, ",").replace(/\s+/g, "").replace(/[Oo]/g, "0");
    const match = compact.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!match) return "";
    const number = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(number)) return "";
    const decimals = (match[0].split(".")[1] || "").length;
    return number.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function bondIdentity(productText) {
    const compact = String(productText || "").toUpperCase().replace(/[—–]/g, "-");
    const isinMatch = compact.match(/\b([A-Z]{2}[A-Z0-9]{9}\d)\b/);
    if (!isinMatch) return null;
    const afterIsin = compact.slice(compact.indexOf(isinMatch[1]) + isinMatch[1].length);
    const issuerMatch = afterIsin.match(/-\s*([A-Z][A-Z0-9.&]{1,12})\b/);
    const issuerCode = issuerMatch?.[1] || "";
    return { isin: isinMatch[1], issuerCode, issuerName: BOND_ISSUER_MAP[issuerCode] || issuerCode || isinMatch[1] };
  }
  function parseDistributionOcrText(rawText) {
    const text = normalizeText(rawText), marker = "[[FCN_DISTRIBUTION_ROW]]", entries = [];
    for (const part of text.split(marker).slice(1)) {
      const nextMarker = part.search(/\[\[FCN_[A-Z0-9_]+\]\]/);
      const body = (nextMarker >= 0 ? part.slice(0, nextMarker) : part).trim();
      const field = (name) => body.match(new RegExp(`(?:^|\\n)${name}=(.*?)(?=\\n[A-Z_]+=|$)`, "is"))?.[1]?.trim() || "";
      const customer = cleanDistributionCustomer(field("CUSTOMER"));
      const productText = field("PRODUCT");
      const amount = cleanDistributionAmount(field("AMOUNT"));
      const orderType = field("TYPE");
      if (orderType && !/配|息/.test(orderType)) continue;
      const codeMatch = productText.match(/\b((?:MA\s*)?20\d{2}\s*SN\s*\d{2,6})\b/i);
      const code = codeMatch ? codeMatch[1].replace(/\s+/g, "").toUpperCase() : "";
      const bond = code ? null : bondIdentity(productText);
      if (customer && amount && (code || bond)) entries.push({ customer, amount, code, bond, productText });
    }
    return { entries, rawText: text };
  }
  function formatDistributionOcrResult(parsed) {
    const structureBlocks = parsed.entries.filter((entry) => entry.code)
      .map((entry) => `${entry.code}\n${entry.customer}　　${entry.amount}`);
    const bondGroups = new Map();
    parsed.entries.filter((entry) => entry.bond).forEach((entry) => {
      const key = entry.bond.isin;
      if (!bondGroups.has(key)) bondGroups.set(key, { bond: entry.bond, clients: [] });
      bondGroups.get(key).clients.push(entry);
    });
    const bondBlocks = Array.from(bondGroups.values()).map(({ bond, clients }) =>
      `${bond.issuerName}債券配息\n\n${clients.map((entry) => `${entry.customer}　　${entry.amount}`).join("\n")}`);
    return [...structureBlocks, ...bondBlocks].join("\n\n");
  }
  function flattenOcrWords(data) {
    if (Array.isArray(data?.words)) return data.words;
    const blockWords = (data?.blocks || []).flatMap((block) => (block.paragraphs || []).flatMap((paragraph) =>
      (paragraph.lines || []).flatMap((line) => line.words || [])));
    if (blockWords.length) return blockWords;
    if (typeof data?.tsv === "string") return data.tsv.split("\n").slice(1).map((line) => line.split("\t")).filter((columns) => columns.length >= 12 && columns[0] === "5" && columns[11]?.trim()).map((columns) => ({
      text: columns.slice(11).join("\t").trim(),
      bbox: { x0: Number(columns[6]), y0: Number(columns[7]), x1: Number(columns[6]) + Number(columns[8]), y1: Number(columns[7]) + Number(columns[9]) },
    }));
    return [];
  }
  function distributionRowsFromWords(data, imageWidth, imageHeight) {
    const width = Number(imageWidth) || 1, height = Number(imageHeight) || 1;
    const words = flattenOcrWords(data).map((word) => {
      const box = word.bbox || word.boundingBox || {};
      const x0 = Number(box.x0 ?? box.left), x1 = Number(box.x1 ?? box.right), y0 = Number(box.y0 ?? box.top), y1 = Number(box.y1 ?? box.bottom);
      return { text: String(word.text || "").trim(), x: ((x0 + x1) / 2) / width, y: ((y0 + y1) / 2) / height, y0: y0 / height, x0 };
    }).filter((word) => word.text && Number.isFinite(word.x) && Number.isFinite(word.y));
    // The CRM table changes column widths with browser zoom and horizontal
    // layout. Find the actual 配息 column first instead of assuming one x-axis.
    const typeWords = words.filter((word) => word.x >= .34 && word.x <= .69 && word.y >= .04 && /配/.test(word.text));
    const candidateCenters = [];
    typeWords.sort((a, b) => a.y - b.y).forEach((word) => {
      const existing = candidateCenters.find((group) => Math.abs(group.y - word.y) < .018);
      if (existing) { existing.words.push(word); existing.y = existing.words.reduce((sum, item) => sum + item.y, 0) / existing.words.length; }
      else candidateCenters.push({ y: word.y, words: [word] });
    });
    const distributionCenters = candidateCenters.filter((group) => /配/.test(group.words.map((word) => word.text).join("")));
    if (!distributionCenters.length) return [];
    const centers = distributionCenters.map((group) => group.y).sort((a, b) => a - b);
    const gaps = centers.slice(1).map((center, index) => center - centers[index]).filter((gap) => gap > .025 && gap < .12).sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : .06;
    const rowHalf = Math.max(.024, Math.min(.036, medianGap * .47));
    const typeX = typeWords.reduce((sum, word) => sum + word.x, 0) / Math.max(1, typeWords.length);
    const firstRowY = centers[0];
    const headerWord = (pattern) => words.filter((word) => word.y < firstRowY - .012 && word.y > firstRowY - .25 && pattern.test(word.text.replace(/\s+/g, "")))
      .sort((a, b) => b.y - a.y)[0] || null;
    const customerHeader = headerWord(/客戶/), productHeader = headerWord(/商品/), amountHeader = headerWord(/應收付|收付金額|付金額/);
    const customerBounds = customerHeader ? [Math.max(0, customerHeader.x - .09), customerHeader.x + .10] : [Math.max(0, typeX - .44), Math.max(.17, typeX - .24)];
    const productBounds = productHeader ? [Math.max(0, productHeader.x - .105), productHeader.x + .105] : [Math.max(0, typeX - .235), typeX - .025];
    const cellWords = (center, minX, maxX) => words.filter((word) => word.x >= minX && word.x <= maxX && Math.abs(word.y - center) <= rowHalf);
    const cellText = (center, minX, maxX) => cellWords(center, minX, maxX)
      .sort((a, b) => Math.abs(a.y - b.y) > .008 ? a.y - b.y : a.x0 - b.x0).map((word) => word.text).join(" ");
    const amountText = (center) => {
      const numericWords = cellWords(center, Math.min(.98, typeX + .16), Math.min(.99, typeX + .36))
        .filter((word) => /\d/.test(word.text));
      if (!numericWords.length) return "";
      const selected = amountHeader
        ? [...numericWords].sort((a, b) => Math.abs(a.x - amountHeader.x) - Math.abs(b.x - amountHeader.x))[0]
        : [...numericWords].sort((a, b) => b.x - a.x)[0];
      return selected.text;
    };
    return distributionCenters.map(({ y }) => ({
      customer: cleanDistributionCustomer(cellText(y, customerBounds[0], customerBounds[1]).split(/\s+/).filter((token) => !/^[A-Z]?\d{5,10}$/i.test(token)).join("")),
      product: cellText(y, productBounds[0], productBounds[1]),
      amount: cleanDistributionAmount(amountText(y)),
    })).filter((row) => row.customer && row.product && row.amount);
  }
  function distributionMarkerText(rows) {
    return rows.map((row) => `[[FCN_DISTRIBUTION_ROW]]\nCUSTOMER=${row.customer}\nPRODUCT=${row.product}\nAMOUNT=${row.amount}`).join("\n");
  }
  function loadOcrLibrary() {
    if (root.Tesseract?.createWorker) return Promise.resolve(root.Tesseract);
    if (root.__fcnOcrLibraryPromise) return root.__fcnOcrLibraryPromise;
    root.__fcnOcrLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = OCR_SCRIPT; script.async = true; script.crossOrigin = "anonymous";
      script.onload = () => root.Tesseract?.createWorker ? resolve(root.Tesseract) : reject(new Error("OCR library unavailable"));
      script.onerror = () => reject(new Error("OCR library failed to load"));
      document.head.appendChild(script);
    }).catch((error) => { delete root.__fcnOcrLibraryPromise; throw error; });
    return root.__fcnOcrLibraryPromise;
  }
  async function imageSource(file) {
    if (typeof createImageBitmap === "function") return createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image unreadable")); };
      image.src = url;
    });
  }
  async function prepareImage(file) {
    const source = await imageSource(file);
    const naturalWidth = source.width || source.naturalWidth, naturalHeight = source.height || source.naturalHeight;
    const scale = Math.min(1.8, 2400 / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale)); canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(source, 0, 0, canvas.width, canvas.height); source.close?.();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height), data = pixels.data;
    for (let index = 0; index < data.length; index += 4) {
      // Red tickers are used to highlight some underlyings in the source
      // table. Normal luminance can wash those characters out, so also look
      // at the green/blue channels and keep whichever representation is darker.
      const gray = Math.min(
        data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114,
        (data[index + 1] + data[index + 2]) / 2 + 18
      );
      const value = Math.max(0, Math.min(255, (gray - 128) * 1.22 + 128));
      data[index] = data[index + 1] = data[index + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }
  function binarizeCanvas(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height), histogram = new Array(256).fill(0);
    for (let index = 0; index < pixels.data.length; index += 4) histogram[pixels.data[index]] += 1;
    const total = canvas.width * canvas.height;
    let sum = 0, backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, threshold = 185;
    for (let level = 0; level < 256; level += 1) sum += level * histogram[level];
    for (let level = 0; level < 256; level += 1) {
      backgroundWeight += histogram[level];
      if (!backgroundWeight) continue;
      const foregroundWeight = total - backgroundWeight;
      if (!foregroundWeight) break;
      backgroundSum += level * histogram[level];
      const meanBackground = backgroundSum / backgroundWeight;
      const meanForeground = (sum - backgroundSum) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
      if (variance > bestVariance) { bestVariance = variance; threshold = level; }
    }
    threshold = Math.max(145, Math.min(215, threshold + 12));
    for (let index = 0; index < pixels.data.length; index += 4) {
      const value = pixels.data[index] < threshold ? 0 : 255;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }
  function extractTableRows(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas, pixels = context.getImageData(0, 0, width, height).data;
    const left = Math.floor(width * .055), right = Math.ceil(width * .945), startY = Math.floor(height * .16), endY = Math.floor(height * .88);
    const bands = [];
    let bandStart = -1, lastDark = -1;
    const finishBand = () => {
      if (bandStart >= 0 && lastDark - bandStart + 1 >= height * .025) bands.push({ start: bandStart, end: lastDark });
      bandStart = -1; lastDark = -1;
    };
    for (let y = startY; y < endY; y += 1) {
      let dark = 0, sampled = 0;
      for (let x = left; x < right; x += 4) { sampled += 1; if (pixels[(y * width + x) * 4] < 92) dark += 1; }
      if (dark / sampled > .42) {
        if (bandStart < 0) bandStart = y;
        lastDark = y;
      } else if (bandStart >= 0 && y - lastDark > Math.max(3, Math.round(height * .004))) finishBand();
    }
    finishBand();
    if (bands.length < 3) return [];
    const headers = bands.slice(0, 3);
    const lightGaps = [headers[1].start - headers[0].end, headers[2].start - headers[1].end].filter((gap) => gap > 0);
    const lastRowHeight = Math.round((lightGaps.reduce((sumValue, gap) => sumValue + gap, 0) / Math.max(1, lightGaps.length)) * .9);
    return headers.map((header, index) => {
      const cropTop = Math.min(height - 1, header.end + 2);
      const cropBottom = index < headers.length - 1 ? headers[index + 1].start - 2 : Math.min(Math.floor(height * .92), cropTop + lastRowHeight);
      const cropWidth = right - left, cropHeight = Math.max(1, cropBottom - cropTop);
      const scale = Math.min(1.65, 3000 / cropWidth);
      const rowCanvas = document.createElement("canvas");
      rowCanvas.width = Math.max(1, Math.round(cropWidth * scale)); rowCanvas.height = Math.max(1, Math.round(cropHeight * scale));
      const rowContext = rowCanvas.getContext("2d", { willReadFrequently: true });
      rowContext.fillStyle = "#fff"; rowContext.fillRect(0, 0, rowCanvas.width, rowCanvas.height);
      rowContext.drawImage(canvas, left, cropTop, cropWidth, cropHeight, 0, 0, rowCanvas.width, rowCanvas.height);
      return binarizeCanvas(rowCanvas);
    });
  }
  function extractCellsFromRow(row, columnBounds, targetWidth = 620) {
    if (!row) return [];
    return columnBounds.map(([start, end]) => {
      const sourceX = Math.floor(row.width * start), sourceWidth = Math.max(1, Math.floor(row.width * (end - start)));
      const scale = Math.min(4, targetWidth / sourceWidth);
      const padding = Math.max(12, Math.round(row.height * scale * .14));
      const cell = document.createElement("canvas");
      cell.width = Math.max(1, Math.round(sourceWidth * scale)) + padding * 2;
      cell.height = Math.max(1, Math.round(row.height * scale)) + padding * 2;
      const context = cell.getContext("2d", { willReadFrequently: true });
      context.fillStyle = "#fff"; context.fillRect(0, 0, cell.width, cell.height);
      context.drawImage(row, sourceX, 0, sourceWidth, row.height, padding, padding, cell.width - padding * 2, cell.height - padding * 2);
      return binarizeCanvas(cell);
    });
  }
  function extractTickerCells(tableRows) {
    // Calibrated to the four linked-underlying columns in the inquiry table.
    // Each cell is recognized in its own pass so reading order cannot mix the
    // four symbols or append a neighboring percentage.
    return extractCellsFromRow(tableRows[0], [[.315, .425], [.425, .525], [.525, .625], [.625, .735]]);
  }
  function extractTermCells(tableRows) {
    const cells = extractCellsFromRow(tableRows[1], [[.115, .225], [.225, .335], [.325, .42], [.405, .52]]);
    return ["AUTOCALL", "TENOR", "KI_TYPE", "KI"].map((name, index) => ({ name, canvas: cells[index] })).filter((item) => item.canvas);
  }
  function extractStepdownTermCells(tableRows) {
    const cells = extractCellsFromRow(tableRows[1], [[.13, .245], [.235, .34], [.33, .435], [.425, .525], [.51, .62]]);
    return ["STEP_AUTOCALL", "STEP_DOWN", "STEP_TENOR", "STEP_KI_TYPE", "STEP_KI"].map((name, index) => ({ name, canvas: cells[index] })).filter((item) => item.canvas);
  }
  function extractPricingCell(tableRows) {
    const row = tableRows[2];
    if (!row) return null;
    // In the third data row, the second column is the initial-pricing basis.
    // Isolating this small cell gives Chinese OCR a much cleaner word than the
    // entire wide row, where the product code and other columns dominate.
    const sourceX = Math.floor(row.width * .19), sourceWidth = Math.floor(row.width * .15);
    const scale = Math.min(3, 1200 / Math.max(1, sourceWidth));
    const cell = document.createElement("canvas");
    cell.width = Math.max(1, Math.round(sourceWidth * scale)); cell.height = Math.max(1, Math.round(row.height * scale));
    const context = cell.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#fff"; context.fillRect(0, 0, cell.width, cell.height);
    context.drawImage(row, sourceX, 0, sourceWidth, row.height, 0, 0, cell.width, cell.height);
    return binarizeCanvas(cell);
  }
  function extractTransactionArea(canvas) {
    // Some screenshots are tightly cropped around the table while others
    // include the full CRM header. Starting at 18% keeps every supplied table.
    const sourceY = Math.floor(canvas.height * .18), sourceHeight = canvas.height - sourceY;
    const area = document.createElement("canvas");
    area.width = canvas.width; area.height = sourceHeight;
    const context = area.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#fff"; context.fillRect(0, 0, area.width, area.height);
    context.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, area.width, area.height);
    return area;
  }
  async function recognizeProductImage(file, onProgress = () => {}, signal) {
    if (!file || !/^image\//.test(file.type || "")) throw new Error("請選擇圖片檔");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress({ label: "整理圖片", percent: 0.03 });
    const image = await prepareImage(file), tableRows = extractTableRows(image), tickerCells = extractTickerCells(tableRows), dailyTermCells = extractTermCells(tableRows), stepdownTermCells = extractStepdownTermCells(tableRows), pricingCell = extractPricingCell(tableRows);
    const passCount = 2 + tableRows.length + tickerCells.length + Math.max(dailyTermCells.length, stepdownTermCells.length) + (pricingCell ? 1 : 0);
    const Tesseract = await loadOcrLibrary();
    let worker;
    let passIndex = 0;
    const abort = () => { worker?.terminate().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      worker = await Tesseract.createWorker(["eng", "chi_tra"], 1, { logger(message) {
        const percent = Number.isFinite(message.progress) ? message.progress : 0;
        const label = message.status === "recognizing text" ? "辨識文字" : message.status?.includes("loading") ? "載入辨識工具" : "準備辨識";
        onProgress({ label, percent: message.status === "recognizing text" ? (passIndex + percent) / passCount : Math.min(.08, percent * .08) });
      } });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await worker.recognize(image, {}, { blocks: true, text: true, tsv: true });
      let combinedText = result?.data?.text || "";
      let distributionRows = distributionRowsFromWords(result?.data, image.width, image.height);
      const distributionHint = distributionRows.length > 0 || /配\s*息|委託|應收付|查詢結果|CRM/i.test(combinedText);
      if (distributionHint) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        passIndex = 1;
        await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1", tessedit_char_whitelist: "" });
        const transactionArea = extractTransactionArea(image);
        const transactionResult = await worker.recognize(transactionArea, {}, { blocks: true, text: true, tsv: true });
        const focusedRows = distributionRowsFromWords(transactionResult?.data, transactionArea.width, transactionArea.height);
        if (focusedRows.length >= distributionRows.length) distributionRows = focusedRows;
        const distributionParsed = parseDistributionOcrText(distributionMarkerText(distributionRows));
        if (distributionParsed.entries.length > 0) {
          onProgress({ label: "完成辨識", percent: 1 });
          return { kind: "distribution", parsed: distributionParsed, formatted: formatDistributionOcrResult(distributionParsed) };
        }
      }
      for (let index = 0; index < tableRows.length; index += 1) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        passIndex = index + 1;
        await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
        const rowResult = await worker.recognize(tableRows[index]);
        combinedText += `\n[[FCN_TABLE_ROW_${index + 1}]]\n${rowResult?.data?.text || ""}`;
      }
      for (let index = 0; index < tickerCells.length; index += 1) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        passIndex = 1 + tableRows.length + index;
        await worker.setParameters({ tessedit_pageseg_mode: "7", preserve_interword_spaces: "1", tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789. " });
        const tickerResult = await worker.recognize(tickerCells[index]);
        combinedText += `\n[[FCN_TICKER_${index + 1}_CELL]]\n${tickerResult?.data?.text || ""}`;
      }
      const preliminary = parseProductOcrText(combinedText);
      const termCells = preliminary.structure === "Stepdown FCN" ? stepdownTermCells : dailyTermCells;
      for (let index = 0; index < termCells.length; index += 1) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const item = termCells[index];
        passIndex = 1 + tableRows.length + tickerCells.length + index;
        const lettersOnly = item.name === "KI_TYPE";
        await worker.setParameters({
          tessedit_pageseg_mode: "7",
          preserve_interword_spaces: "1",
          tessedit_char_whitelist: lettersOnly ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" : "0123456789.%()",
        });
        const cellResult = await worker.recognize(item.canvas);
        combinedText += `\n[[FCN_${item.name}_CELL]]\n${cellResult?.data?.text || ""}`;
      }
      if (pricingCell) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        passIndex = 1 + tableRows.length + tickerCells.length + termCells.length;
        await worker.setParameters({ tessedit_pageseg_mode: "7", preserve_interword_spaces: "1", tessedit_char_whitelist: "" });
        const pricingResult = await worker.recognize(pricingCell);
        combinedText += `\n[[FCN_PRICING_CELL]]\n${pricingResult?.data?.text || ""}`;
      }
      const parsed = parseProductOcrText(combinedText);
      onProgress({ label: "完成辨識", percent: 1 });
      return { kind: "product", parsed, formatted: formatProductOcrResult(parsed) };
    } finally { signal?.removeEventListener("abort", abort); if (worker) await worker.terminate().catch(() => {}); }
  }
  root.FcnProductOcr = { normalizeText, parseProductOcrText, formatProductOcrResult, parseDistributionOcrText, formatDistributionOcrResult, distributionRowsFromWords, recognizeProductImage };
})(globalThis);
