const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store"
};

function respond(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}

function normalizeYahooSymbol(rawSymbol) {
  let symbol = String(rawSymbol || "").trim().toUpperCase();
  symbol = symbol.replace(/^(NASDAQ|NYSE|AMEX):/, "");
  // The tracker formerly suggested TSM.US for Stooq. Yahoo uses TSM instead.
  if (symbol.endsWith(".US")) symbol = symbol.slice(0, -3);
  // Common structured-note documents write Japanese tickers as 8035 JT or
  // 8035 JP. Yahoo Finance expects the Tokyo suffix: 8035.T.
  symbol = symbol.replace(/^(\d{4})(?:\.?JP|JT)$/, "$1.T");
  if (/^\d{4}$/.test(symbol)) symbol = `${symbol}.T`;
  if (!/^[A-Z0-9.^=\-]{1,30}$/.test(symbol)) return "";
  return symbol;
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const requestUrl = new URL(request.url);
  const symbol = normalizeYahooSymbol(requestUrl.searchParams.get("symbol"));
  if (!symbol) return respond(400, { error: "Invalid symbol" });

  const start = requestUrl.searchParams.get("start");
  const validStart = /^\d{4}-\d{2}-\d{2}$/.test(start || "") ? start : null;

  try {
    const periodParams = validStart
      ? `period1=${Math.floor(Date.parse(`${validStart}T00:00:00Z`) / 1000)}&period2=${Math.floor(Date.now() / 1000) + 86400}`
      : "range=5d";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${periodParams}&interval=1d&includePrePost=false&events=splits`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 FCN-tracker/1.0",
        "Accept": "application/json"
      }
    });
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta || {};
    const quote = result?.indicators?.quote?.[0] || {};
    const closes = quote.close || [];
    const highs = quote.high || [];
    const timestamps = result?.timestamp || [];
    let history = timestamps.map((timestamp, index) => {
      const close = Number(closes[index]);
      const high = Number(highs[index]);
      if (!Number.isFinite(close) || close <= 0) return null;
      return {
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        price: close,
        high: Number.isFinite(high) && high > 0 ? high : close
      };
    }).filter(Boolean);

    // Yahoo's daily chart contains a still-moving daily candle while that
    // exchange is open. It is not an official close and must not trigger KO.
    const exchangeToday = dateInTimeZone(new Date(), meta.exchangeTimezoneName || "America/New_York");
    if (["PRE", "PREPRE", "REGULAR"].includes(meta.marketState) && history.at(-1)?.date === exchangeToday) history = history.slice(0, -1);

    const splits = Object.values(result?.events?.splits || {}).map((event) => {
      const numerator = Number(event?.numerator);
      const denominator = Number(event?.denominator);
      const timestamp = Number(event?.date);
      if (!Number.isFinite(numerator) || numerator <= 0 || !Number.isFinite(denominator) || denominator <= 0 || !Number.isFinite(timestamp)) return null;
      return {
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        numerator,
        denominator,
        ratio: event?.splitRatio || `${numerator}:${denominator}`,
      };
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));

    const latest = history.at(-1);
    const price = latest?.price;
    if (!price) throw new Error("No completed daily close");

    return respond(200, { symbol, price, date: latest.date, history, splits, source: "Yahoo Finance daily close" });
  } catch (error) {
    console.error("Quote lookup failed", symbol, error.message);
    return respond(502, { error: "Quote lookup failed" });
  }
};
