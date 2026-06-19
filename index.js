const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const EODHD_API_KEY = process.env.EODHD_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const manualTickerMap = {
  REL: { eodhd: 'REL.LSE', finnhub: 'REL.L', fmp: 'REL.L' },
  SGRO: { eodhd: 'SGRO.LSE', finnhub: 'SGRO.L', fmp: 'SGRO.L' },
  HWG: { eodhd: 'HWG.LSE', finnhub: 'HWG.L', fmp: 'HWG.L' },
  CWR: { eodhd: 'CWR.LSE', finnhub: 'CWR.L', fmp: 'CWR.L' },
  NDX1: { eodhd: 'NDX1.XETRA', finnhub: 'NDX1.DE', fmp: 'NDX1.DE' },
  AEDAS: { eodhd: 'AEDAS.MC', finnhub: 'AEDAS.MC', fmp: 'AEDAS.MC' }
};

const commands = [
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Get a quick stock snapshot')
    .addStringOption(option =>
      option
        .setName('ticker')
        .setDescription('Ticker symbol, e.g. PLTR, REL, SGRO, CWR, NDX1')
        .setRequired(true)
    )
].map(command => command.toJSON());

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`FINNHUB_API_KEY present: ${Boolean(FINNHUB_API_KEY)}`);
  console.log(`EODHD_API_KEY present: ${Boolean(EODHD_API_KEY)}`);
  console.log(`FMP_API_KEY present: ${Boolean(FMP_API_KEY)}`);

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash commands registered');
  } catch (error) {
    console.error('Slash command registration failed:');
    console.error(error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'stock') return;

  const userTicker = interaction.options.getString('ticker').toUpperCase().trim();

  await interaction.deferReply();

  try {
    const resolved = await resolveTicker_(userTicker);

    if (!resolved) {
      await interaction.editReply(`Could not find reliable data for ${userTicker}.`);
      return;
    }

    const analystText = resolved.analystText || 'No analyst data available';

    const message =
      `🔍 **STOCK SNAPSHOT**\n\n` +
      `**${resolved.name} (${resolved.symbol})**\n` +
      `Requested: ${userTicker}\n` +
      `Source: ${resolved.source}\n\n` +
      `💰 Current Price: ${resolved.currency ? `${resolved.currency} ` : ''}${resolved.price || 'N/A'}\n` +
      `🏢 Market Cap: ${resolved.marketCap || 'N/A'}\n\n` +
      `📊 **Performance**\n` +
      `4W: ${resolved.performance.week4}\n` +
      `13W: ${resolved.performance.week13}\n` +
      `26W: ${resolved.performance.week26}\n` +
      `52W: ${resolved.performance.week52}\n\n` +
      `📈 **Analyst / Rating View**\n` +
      analystText;

    await interaction.editReply(message);
  } catch (error) {
    console.error('Stock lookup failed:');
    console.error(error);
    await interaction.editReply(`Could not fetch data for ${userTicker}.`);
  }
});

async function resolveTicker_(userTicker) {
  const candidates = buildTickerCandidates_(userTicker);

  console.log(`--- LOOKUP FOR ${userTicker} ---`);
  console.log(`Candidates: ${JSON.stringify(candidates)}`);

  for (const candidate of candidates) {
    const eodResult = await tryEodhd_(candidate, userTicker);
    if (eodResult) return eodResult;
  }

  for (const candidate of candidates) {
    const finnhubResult = await tryFinnhub_(candidate, userTicker);
    if (finnhubResult) return finnhubResult;
  }

  return null;
}

function buildTickerCandidates_(userTicker) {
  const raw = String(userTicker).trim().toUpperCase();

  if (manualTickerMap[raw]) {
    return [
      {
        display: raw,
        eodhd: manualTickerMap[raw].eodhd,
        finnhub: manualTickerMap[raw].finnhub,
        fmp: manualTickerMap[raw].fmp
      },
      {
        display: raw,
        eodhd: `${raw}.LSE`,
        finnhub: `${raw}.L`,
        fmp: `${raw}.L`
      },
      {
        display: raw,
        eodhd: `${raw}.US`,
        finnhub: raw,
        fmp: raw
      }
    ];
  }

  if (raw.includes(':')) {
    const [exchange, ticker] = raw.split(':');

    return [
      {
        display: ticker,
        eodhd: mapExchangeToEodhd_(exchange, ticker),
        finnhub: mapExchangeToFinnhub_(exchange, ticker),
        fmp: mapExchangeToFmp_(exchange, ticker)
      },
      {
        display: ticker,
        eodhd: `${ticker}.US`,
        finnhub: ticker,
        fmp: ticker
      }
    ];
  }

  if (raw.endsWith('.L')) {
    const ticker = raw.replace('.L', '');
    return [{ display: ticker, eodhd: `${ticker}.LSE`, finnhub: raw, fmp: raw }];
  }

  if (raw.endsWith('.DE')) {
    const ticker = raw.replace('.DE', '');
    return [{ display: ticker, eodhd: `${ticker}.XETRA`, finnhub: raw, fmp: raw }];
  }

  if (raw.endsWith('.MC')) {
    const ticker = raw.replace('.MC', '');
    return [{ display: ticker, eodhd: `${ticker}.MC`, finnhub: raw, fmp: raw }];
  }

  return [
    { display: raw, eodhd: `${raw}.US`, finnhub: raw, fmp: raw },
    { display: raw, eodhd: `${raw}.LSE`, finnhub: `${raw}.L`, fmp: `${raw}.L` },
    { display: raw, eodhd: `${raw}.XETRA`, finnhub: `${raw}.DE`, fmp: `${raw}.DE` },
    { display: raw, eodhd: `${raw}.MC`, finnhub: `${raw}.MC`, fmp: `${raw}.MC` }
  ];
}

function mapExchangeToEodhd_(exchange, ticker) {
  const ex = String(exchange).toUpperCase();

  if (ex === 'LON' || ex === 'LSE' || ex === 'XLON') return `${ticker}.LSE`;
  if (ex === 'ETR' || ex === 'XETR') return `${ticker}.XETRA`;
  if (ex === 'BME' || ex === 'XMAD') return `${ticker}.MC`;
  if (ex === 'NASDAQ' || ex === 'NYSE') return `${ticker}.US`;

  return `${ticker}.${ex}`;
}

function mapExchangeToFinnhub_(exchange, ticker) {
  const ex = String(exchange).toUpperCase();

  if (ex === 'LON' || ex === 'LSE' || ex === 'XLON') return `${ticker}.L`;
  if (ex === 'ETR' || ex === 'XETR') return `${ticker}.DE`;
  if (ex === 'BME' || ex === 'XMAD') return `${ticker}.MC`;
  if (ex === 'NASDAQ' || ex === 'NYSE') return ticker;

  return ticker;
}

function mapExchangeToFmp_(exchange, ticker) {
  const ex = String(exchange).toUpperCase();

  if (ex === 'LON' || ex === 'LSE' || ex === 'XLON') return `${ticker}.L`;
  if (ex === 'ETR' || ex === 'XETR') return `${ticker}.DE`;
  if (ex === 'BME' || ex === 'XMAD') return `${ticker}.MC`;
  if (ex === 'NASDAQ' || ex === 'NYSE') return ticker;

  return ticker;
}

async function tryEodhd_(candidate, userTicker) {
  if (!EODHD_API_KEY) {
    console.error('Missing EODHD_API_KEY');
    return null;
  }

  if (!candidate.eodhd) return null;

  try {
    const history = await fetchEodhdHistory_(candidate.eodhd);

    console.log(`EODHD history for ${candidate.eodhd}: ${history.length} rows`);

    if (!history || history.length < 5) return null;

    const latest = history[history.length - 1];
    const price = latest.close;
    const performance = buildPerformanceFromHistory_(history, price);

    const fmpProfile = await safeFmpProfile_(candidate.fmp);
    const fmpRating = await safeFmpRating_(candidate.fmp);

    console.log(`FMP profile for ${candidate.fmp}: ${JSON.stringify(fmpProfile).slice(0, 700)}`);
    console.log(`FMP rating for ${candidate.fmp}: ${JSON.stringify(fmpRating).slice(0, 700)}`);

    const name = fmpProfile.companyName || candidate.display || userTicker;
    const currency = fmpProfile.currency || '';
    const marketCap = fmpProfile.mktCap ? formatLargeNumber_(fmpProfile.mktCap, currency) : 'N/A';
    const analystText = buildFmpRatingText_(fmpRating);

    return {
      source: 'EODHD EOD + FMP',
      symbol: candidate.eodhd,
      name,
      price,
      currency,
      marketCap,
      performance,
      analystText
    };
  } catch (error) {
    console.error(`EODHD candidate failed: ${candidate.eodhd}`);
    console.error(error);
    return null;
  }
}

async function fetchEodhdHistory_(symbol) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 430);

  const fromText = from.toISOString().slice(0, 10);
  const toText = to.toISOString().slice(0, 10);

  const url =
    `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}?from=${fromText}&to=${toText}&period=d&api_token=${encodeURIComponent(EODHD_API_KEY)}&fmt=json`;

  const data = await fetchJson(url);

  console.log(`EODHD raw response for ${symbol}: ${JSON.stringify(data).slice(0, 500)}`);

  if (!Array.isArray(data)) return [];

  return data
    .map(row => ({
      date: row.date,
      close: Number(row.adjusted_close || row.close)
    }))
    .filter(row => row.date && isFinite(row.close) && row.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function tryFinnhub_(candidate, userTicker) {
  if (!FINNHUB_API_KEY || !candidate.finnhub) return null;

  try {
    const quote = await fetchJson(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(candidate.finnhub)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );

    const profile = await safeFinnhubProfile_(candidate.finnhub);
    const recommendation = await safeFinnhubRecommendation_(candidate.finnhub);
    const metrics = await safeFinnhubMetrics_(candidate.finnhub);

    const price = quote && quote.c ? Number(quote.c) : null;

    if (!price && !profile.name) return null;

    return {
      source: 'Finnhub',
      symbol: candidate.finnhub,
      name: profile.name || candidate.display || userTicker,
      price,
      currency: profile.currency || '',
      marketCap: profile.marketCapitalization ? formatMarketCap_(profile.marketCapitalization) : 'N/A',
      performance: buildPerformanceFromFinnhubMetrics_(metrics),
      analystText: buildAnalystText_(recommendation && recommendation[0] ? recommendation[0] : null)
    };
  } catch (error) {
    console.error(`Finnhub candidate failed: ${candidate.finnhub}`);
    console.error(error);
    return null;
  }
}

async function safeFmpProfile_(symbol) {
  if (!symbol || !FMP_API_KEY) return {};

  try {
    const data = await fetchJson(
      `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(FMP_API_KEY)}`
    );

    if (Array.isArray(data) && data.length > 0) return data[0];

    return {};
  } catch (error) {
    console.error(`FMP profile failed for ${symbol}`);
    console.error(error);
    return {};
  }
}

async function safeFmpRating_(symbol) {
  if (!symbol || !FMP_API_KEY) return {};

  try {
    const data = await fetchJson(
      `https://financialmodelingprep.com/api/v3/rating/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(FMP_API_KEY)}`
    );

    if (Array.isArray(data) && data.length > 0) return data[0];

    return {};
  } catch (error) {
    console.error(`FMP rating failed for ${symbol}`);
    console.error(error);
    return {};
  }
}

function buildPerformanceFromHistory_(history, currentPrice) {
  if (!history || history.length < 5 || !currentPrice) return emptyPerformance_();

  const prices = history.map(row => row.close);

  return {
    week4: calculateReturn_(prices, 20, currentPrice),
    week13: calculateReturn_(prices, 63, currentPrice),
    week26: calculateReturn_(prices, 126, currentPrice),
    week52: calculateReturn_(prices, 252, currentPrice)
  };
}

function buildPerformanceFromFinnhubMetrics_(metrics) {
  const metric = metrics && metrics.metric ? metrics.metric : {};

  return {
    week4: formatMetricPercent_(firstAvailable_(metric, ['4WeekPriceReturnDaily', 'priceReturn1Month'])),
    week13: formatMetricPercent_(firstAvailable_(metric, ['13WeekPriceReturnDaily', 'priceReturn3Month'])),
    week26: formatMetricPercent_(firstAvailable_(metric, ['26WeekPriceReturnDaily', 'priceReturn6Month'])),
    week52: formatMetricPercent_(firstAvailable_(metric, ['52WeekPriceReturnDaily', 'priceReturn1Year']))
  };
}

function calculateReturn_(prices, tradingDaysAgo, currentPrice) {
  const index = Math.max(0, prices.length - 1 - tradingDaysAgo);
  const oldPrice = prices[index];

  if (!oldPrice || !currentPrice) return 'N/A';

  const change = ((currentPrice / oldPrice) - 1) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
}

function emptyPerformance_() {
  return {
    week4: 'N/A',
    week13: 'N/A',
    week26: 'N/A',
    week52: 'N/A'
  };
}

function buildFmpRatingText_(rating) {
  if (!rating || Object.keys(rating).length === 0) {
    return 'No analyst/rating data available';
  }

  const recommendation = rating.ratingRecommendation || rating.rating || 'N/A';
  const score = rating.ratingScore !== undefined ? rating.ratingScore : 'N/A';

  return (
    `Rating: ${recommendation}\n` +
    `Score: ${score}/5\n` +
    `DCF Score: ${rating.ratingDetailsDCFScore ?? 'N/A'}\n` +
    `ROE Score: ${rating.ratingDetailsROEScore ?? 'N/A'}\n` +
    `ROA Score: ${rating.ratingDetailsROAScore ?? 'N/A'}\n` +
    `DE Score: ${rating.ratingDetailsDEScore ?? 'N/A'}\n` +
    `PE Score: ${rating.ratingDetailsPEScore ?? 'N/A'}\n` +
    `PB Score: ${rating.ratingDetailsPBScore ?? 'N/A'}`
  );
}

function buildAnalystText_(analyst) {
  if (!analyst) return 'No analyst data available';

  const strongBuy = Number(analyst.strongBuy) || 0;
  const buy = Number(analyst.buy) || 0;
  const hold = Number(analyst.hold) || 0;
  const sell = Number(analyst.sell) || 0;
  const strongSell = Number(analyst.strongSell) || 0;

  const total = strongBuy + buy + hold + sell + strongSell;

  if (total === 0) {
    return 'No analyst data available';
  }

  const view = getAnalystView_(strongBuy, buy, hold, sell, strongSell);

  return (
    `Consensus: ${view}\n` +
    `Strong Buy: ${strongBuy}\n` +
    `Buy: ${buy}\n` +
    `Hold: ${hold}\n` +
    `Sell: ${sell}\n` +
    `Strong Sell: ${strongSell}`
  );
}

function getAnalystView_(strongBuy, buy, hold, sell, strongSell) {
  const positive = strongBuy + buy;
  const negative = sell + strongSell;

  if (strongBuy >= buy && strongBuy >= hold && strongBuy >= negative && strongBuy > 0) return 'Strong Buy';
  if (positive > hold && positive > negative) return 'Buy';
  if (negative > positive && negative > hold) return 'Sell';
  if (strongSell > 0 && negative >= positive) return 'Strong Sell';

  return 'Neutral';
}

async function safeFinnhubProfile_(symbol) {
  if (!symbol || !FINNHUB_API_KEY) return {};

  try {
    return await fetchJson(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );
  } catch {
    return {};
  }
}

async function safeFinnhubRecommendation_(symbol) {
  if (!symbol || !FINNHUB_API_KEY) return [];

  try {
    return await fetchJson(
      `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );
  } catch {
    return [];
  }
}

async function safeFinnhubMetrics_(symbol) {
  if (!symbol || !FINNHUB_API_KEY) return {};

  try {
    return await fetchJson(
      `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );
  } catch {
    return {};
  }
}

function firstAvailable_(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }

  return null;
}

function formatMetricPercent_(value) {
  const n = Number(value);
  if (!isFinite(n)) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function formatMarketCap_(marketCapMillions) {
  const value = Number(marketCapMillions);
  if (!value) return 'N/A';

  const absoluteValue = value * 1000000;
  return formatLargeNumber_(absoluteValue, 'USD');
}

function formatLargeNumber_(value, currency) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return 'N/A';

  const prefix = currency ? `${currency} ` : '';

  if (n >= 1000000000000) return `${prefix}${(n / 1000000000000).toFixed(2)}tn`;
  if (n >= 1000000000) return `${prefix}${(n / 1000000000).toFixed(2)}bn`;
  if (n >= 1000000) return `${prefix}${(n / 1000000).toFixed(2)}m`;

  return `${prefix}${n.toLocaleString()}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  return await response.json();
}

client.login(DISCORD_TOKEN).catch(error => {
  console.error('Bot login failed:');
  console.error(error);
});
