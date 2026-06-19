const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const EODHD_API_KEY = process.env.EODHD_API_KEY;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const manualTickerMap = {
  REL: { eodhd: 'REL.LSE', finnhub: 'REL.L', region: 'UK' },
  SGRO: { eodhd: 'SGRO.LSE', finnhub: 'SGRO.L', region: 'UK' },
  HWG: { eodhd: 'HWG.LSE', finnhub: 'HWG.L', region: 'UK' },
  CWR: { eodhd: 'CWR.LSE', finnhub: 'CWR.L', region: 'UK' },
  NDX1: { eodhd: 'NDX1.XETRA', finnhub: 'NDX1.DE', region: 'EU' },
  AEDAS: { eodhd: 'AEDAS.MC', finnhub: 'AEDAS.MC', region: 'EU' }
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
      `📈 **Analyst View**\n` +
      `${resolved.analystText || 'No analyst data available'}`;

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
    if (candidate.region === 'US') {
      const finnhubResult = await tryFinnhub_(candidate, userTicker);
      if (finnhubResult) return finnhubResult;
    }
  }

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
        region: manualTickerMap[raw].region
      },
      {
        display: raw,
        eodhd: `${raw}.US`,
        finnhub: raw,
        region: 'US'
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
        region: mapExchangeToRegion_(exchange)
      },
      {
        display: ticker,
        eodhd: `${ticker}.US`,
        finnhub: ticker,
        region: 'US'
      }
    ];
  }

  if (raw.endsWith('.L')) {
    const ticker = raw.replace('.L', '');
    return [{ display: ticker, eodhd: `${ticker}.LSE`, finnhub: raw, region: 'UK' }];
  }

  if (raw.endsWith('.DE')) {
    const ticker = raw.replace('.DE', '');
    return [{ display: ticker, eodhd: `${ticker}.XETRA`, finnhub: raw, region: 'EU' }];
  }

  if (raw.endsWith('.MC')) {
    const ticker = raw.replace('.MC', '');
    return [{ display: ticker, eodhd: `${ticker}.MC`, finnhub: raw, region: 'EU' }];
  }

  return [
    { display: raw, eodhd: `${raw}.US`, finnhub: raw, region: 'US' },
    { display: raw, eodhd: `${raw}.LSE`, finnhub: `${raw}.L`, region: 'UK' },
    { display: raw, eodhd: `${raw}.XETRA`, finnhub: `${raw}.DE`, region: 'EU' },
    { display: raw, eodhd: `${raw}.MC`, finnhub: `${raw}.MC`, region: 'EU' }
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

function mapExchangeToRegion_(exchange) {
  const ex = String(exchange).toUpperCase();

  if (ex === 'NASDAQ' || ex === 'NYSE') return 'US';
  if (ex === 'LON' || ex === 'LSE' || ex === 'XLON') return 'UK';

  return 'EU';
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

async function tryEodhd_(candidate, userTicker) {
  if (!EODHD_API_KEY || !candidate.eodhd) return null;

  try {
    const history = await fetchEodhdHistory_(candidate.eodhd);

    console.log(`EODHD history for ${candidate.eodhd}: ${history.length} rows`);

    if (!history || history.length < 5) return null;

    const latest = history[history.length - 1];
    const price = latest.close;
    const performance = buildPerformanceFromHistory_(history, price);

    return {
      source: 'EODHD EOD',
      symbol: candidate.eodhd,
      name: candidate.display || userTicker,
      price,
      currency: '',
      marketCap: 'N/A',
      performance,
      analystText: 'No analyst data available'
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

  if (!Array.isArray(data)) return [];

  return data
    .map(row => ({
      date: row.date,
      close: Number(row.adjusted_close || row.close)
    }))
    .filter(row => row.date && isFinite(row.close) && row.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
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

function buildAnalystText_(analyst) {
  if (!analyst) return 'No analyst data available';

  const strongBuy = Number(analyst.strongBuy) || 0;
  const buy = Number(analyst.buy) || 0;
  const hold = Number(analyst.hold) || 0;
  const sell = Number(analyst.sell) || 0;
  const strongSell = Number(analyst.strongSell) || 0;

  const total = strongBuy + buy + hold + sell + strongSell;

  if (total === 0) return 'No analyst data available';

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

  if (absoluteValue >= 1000000000000) return `$${(absoluteValue / 1000000000000).toFixed(2)}tn`;
  if (absoluteValue >= 1000000000) return `$${(absoluteValue / 1000000000).toFixed(2)}bn`;
  if (absoluteValue >= 1000000) return `$${(absoluteValue / 1000000).toFixed(2)}m`;

  return `$${absoluteValue.toLocaleString()}`;
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
