const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const manualTickerMap = {
  AEDAS: { symbol: 'AEDAS', micCode: 'XMAD', finnhub: 'AEDAS.MC' },
  HWG: { symbol: 'HWG', micCode: 'XLON', finnhub: 'HWG.L' },
  NDX1: { symbol: 'NDX1', micCode: 'XETR', finnhub: 'NDX1.DE' },
  REL: { symbol: 'REL', micCode: 'XLON', finnhub: 'REL.L' },
  SGRO: { symbol: 'SGRO', micCode: 'XLON', finnhub: 'SGRO.L' }
};

const commands = [
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Get a quick stock snapshot')
    .addStringOption(option =>
      option
        .setName('ticker')
        .setDescription('Ticker symbol, e.g. PLTR, REL, SGRO, LON:REL')
        .setRequired(true)
    )
].map(command => command.toJSON());

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

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
      await interaction.editReply(`Could not find reliable data for ${userTicker}. Try the exact exchange format, e.g. REL.L, SGRO.L, NDX1.DE, LON:REL, or NASDAQ:PLTR.`);
      return;
    }

    const {
      source,
      displaySymbol,
      requestedTicker,
      quote,
      performance,
      profile,
      recommendation
    } = resolved;

    const currentPrice = quote.price || null;
    const companyName = quote.name || profile.name || requestedTicker;
    const currency = quote.currency || profile.currency || '';
    const marketCap = profile.marketCapitalization
      ? formatMarketCap_(profile.marketCapitalization)
      : 'N/A';

    const analyst = Array.isArray(recommendation) && recommendation.length > 0
      ? recommendation[0]
      : null;

    const analystText = analyst ? buildAnalystText_(analyst) : 'No analyst data available';

    const message =
      `🔍 **STOCK SNAPSHOT**\n\n` +
      `**${companyName} (${displaySymbol})**\n` +
      `Requested: ${userTicker}\n` +
      `Source: ${source}\n\n` +
      `💰 Current Price: ${currentPrice ? `${currency} ${currentPrice}` : 'N/A'}\n` +
      `🏢 Market Cap: ${marketCap}\n\n` +
      `📊 **Performance**\n` +
      `4W: ${performance.week4}\n` +
      `13W: ${performance.week13}\n` +
      `26W: ${performance.week26}\n` +
      `52W: ${performance.week52}\n\n` +
      `📈 **Analyst View**\n` +
      analystText;

    await interaction.editReply(message);
  } catch (error) {
    console.error('Stock lookup failed:');
    console.error(error);
    await interaction.editReply(`Could not fetch data for ${userTicker}.`);
  }
});

async function resolveTicker_(userTicker) {
  const baseCandidates = buildTickerCandidates_(userTicker);

  console.log(`--- LOOKUP FOR ${userTicker} ---`);
  console.log(`Base candidates: ${JSON.stringify(baseCandidates)}`);

  const twelveCandidates = await buildTwelveDataCandidates_(userTicker, baseCandidates);

  console.log(`Twelve candidates: ${JSON.stringify(twelveCandidates)}`);

  for (const candidate of twelveCandidates) {
    const twelveResult = await tryTwelveData_(candidate, userTicker);

    if (twelveResult) {
      console.log(`Resolved ${userTicker} via Twelve Data as ${twelveResult.displaySymbol}`);
      return twelveResult;
    }
  }

  for (const candidate of baseCandidates) {
    const finnhubResult = await tryFinnhub_(candidate, userTicker);

    if (finnhubResult) {
      console.log(`Resolved ${userTicker} via Finnhub as ${finnhubResult.displaySymbol}`);
      return finnhubResult;
    }
  }

  console.log(`No useful data found for ${userTicker}`);
  return null;
}

async function buildTwelveDataCandidates_(userTicker, baseCandidates) {
  const candidates = [...baseCandidates];

  try {
    const searchSymbol = stripExchangePrefix_(userTicker)
      .replace(/\.(L|DE|MC|HK)$/i, '')
      .toUpperCase();

    const searchUrl =
      `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(searchSymbol)}&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

    const search = await fetchJson(searchUrl);

    console.log(`Twelve symbol search for ${searchSymbol}: ${JSON.stringify(search).slice(0, 1000)}`);

    const results = Array.isArray(search.data) ? search.data : [];

    results.forEach(item => {
      if (!item || !item.symbol) return;

      const foundSymbol = String(item.symbol).toUpperCase();

      if (foundSymbol !== searchSymbol) {
        return;
      }

      candidates.push({
        symbol: foundSymbol,
        micCode: item.mic_code || null,
        exchange: item.exchange || null,
        finnhub: mapFinnhubSymbolFromSearch_(item)
      });
    });
  } catch (error) {
    console.error('Twelve symbol search failed:');
    console.error(error);
  }

  return uniqueCandidates_(rankCandidates_(candidates, userTicker));
}

function rankCandidates_(candidates, userTicker) {
  const raw = stripExchangePrefix_(userTicker)
    .replace(/\.(L|DE|MC|HK)$/i, '')
    .toUpperCase();

  return candidates.sort((a, b) => {
    const aScore = scoreCandidate_(a, raw);
    const bScore = scoreCandidate_(b, raw);
    return bScore - aScore;
  });
}

function scoreCandidate_(candidate, raw) {
  let score = 0;

  if (candidate.symbol === raw) score += 20;
  if (candidate.micCode === 'XLON') score += 10;
  if (candidate.micCode === 'XETR') score += 8;
  if (candidate.micCode === 'XMAD' || candidate.micCode === 'BMEX') score += 8;
  if (candidate.micCode === 'XNAS' || candidate.micCode === 'XNYS') score += 6;

  return score;
}

async function tryTwelveData_(candidate, userTicker) {
  if (!TWELVE_DATA_API_KEY) {
    console.error('Missing TWELVE_DATA_API_KEY');
    return null;
  }

  try {
    const expectedSymbol = stripExchangePrefix_(userTicker)
      .replace(/\.(L|DE|MC|HK)$/i, '')
      .toUpperCase();

    if (candidate.symbol !== expectedSymbol) {
      console.log(`Rejected candidate ${candidate.symbol} because it does not exactly match ${expectedSymbol}`);
      return null;
    }

    const quoteUrl = buildTwelveDataUrl_('quote', candidate);
    const quoteRaw = await fetchJson(quoteUrl);

    console.log(`Twelve quote for ${JSON.stringify(candidate)}: ${JSON.stringify(quoteRaw).slice(0, 700)}`);

    if (isTwelveDataError_(quoteRaw)) return null;

    const quoteSymbol = String(quoteRaw.symbol || candidate.symbol).toUpperCase();

    if (quoteSymbol !== expectedSymbol) {
      console.log(`Rejected Twelve quote symbol ${quoteSymbol}; expected ${expectedSymbol}`);
      return null;
    }

    const price = firstNumber_([
      quoteRaw.close,
      quoteRaw.price,
      quoteRaw.previous_close
    ]);

    if (!price) return null;

    const timeSeriesUrl = buildTwelveDataUrl_('time_series', candidate, {
      interval: '1day',
      outputsize: '365'
    });

    let performance = emptyPerformance_();

    try {
      const timeSeries = await fetchJson(timeSeriesUrl);
      performance = buildPerformanceFromTwelveData_(timeSeries, price);
    } catch (error) {
      console.error(`Twelve time series failed for ${candidate.symbol}`);
      console.error(error);
    }

    const finnhubSymbol = candidate.finnhub || candidate.symbol;
    const profile = await safeFinnhubProfile_(finnhubSymbol);
    const recommendation = await safeFinnhubRecommendation_(finnhubSymbol);

    return {
      source: 'Twelve Data',
      displaySymbol: buildDisplaySymbol_(candidate),
      requestedTicker: userTicker,
      quote: {
        price,
        name: quoteRaw.name || quoteRaw.symbol || candidate.symbol,
        currency: quoteRaw.currency || ''
      },
      performance,
      profile,
      recommendation
    };
  } catch (error) {
    console.error(`Twelve candidate failed: ${JSON.stringify(candidate)}`);
    console.error(error);
    return null;
  }
}

async function tryFinnhub_(candidate, userTicker) {
  if (!FINNHUB_API_KEY) {
    console.error('Missing FINNHUB_API_KEY');
    return null;
  }

  const symbol = candidate.finnhub || candidate.symbol;

  try {
    const quote = await fetchJson(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );

    const profile = await safeFinnhubProfile_(symbol);
    const recommendation = await safeFinnhubRecommendation_(symbol);
    const metrics = await safeFinnhubMetrics_(symbol);

    const hasUsefulData =
      (quote && quote.c && Number(quote.c) > 0) ||
      (profile && profile.name) ||
      (metrics && metrics.metric && Object.keys(metrics.metric).length > 0);

    if (!hasUsefulData) return null;

    return {
      source: 'Finnhub',
      displaySymbol: symbol,
      requestedTicker: userTicker,
      quote: {
        price: quote && quote.c ? Number(quote.c) : null,
        name: profile && profile.name ? profile.name : symbol,
        currency: profile && profile.currency ? profile.currency : ''
      },
      performance: buildPerformanceFromFinnhubMetrics_(metrics),
      profile,
      recommendation
    };
  } catch (error) {
    console.error(`Finnhub candidate failed: ${symbol}`);
    console.error(error);
    return null;
  }
}

function buildTickerCandidates_(userTicker) {
  const raw = String(userTicker).trim().toUpperCase();

  if (manualTickerMap[raw]) {
    return [
      manualTickerMap[raw],
      { symbol: raw, micCode: null, exchange: null, finnhub: raw }
    ];
  }

  if (raw.includes(':')) {
    const [exchange, ticker] = raw.split(':');
    const micCode = mapExchangeToMicCode_(exchange);

    return uniqueCandidates_([
      { symbol: ticker, micCode, exchange: null, finnhub: mapFinnhubSymbol_(exchange, ticker) },
      { symbol: ticker, micCode: null, exchange: null, finnhub: ticker },
      { symbol: raw, micCode: null, exchange: null, finnhub: raw }
    ]);
  }

  if (raw.endsWith('.L')) {
    const ticker = raw.replace('.L', '');
    return uniqueCandidates_([
      { symbol: ticker, micCode: 'XLON', exchange: null, finnhub: raw },
      { symbol: raw, micCode: null, exchange: null, finnhub: raw }
    ]);
  }

  if (raw.endsWith('.DE')) {
    const ticker = raw.replace('.DE', '');
    return uniqueCandidates_([
      { symbol: ticker, micCode: 'XETR', exchange: null, finnhub: raw },
      { symbol: raw, micCode: null, exchange: null, finnhub: raw }
    ]);
  }

  if (raw.endsWith('.MC')) {
    const ticker = raw.replace('.MC', '');
    return uniqueCandidates_([
      { symbol: ticker, micCode: 'XMAD', exchange: null, finnhub: raw },
      { symbol: ticker, micCode: 'BMEX', exchange: null, finnhub: raw },
      { symbol: raw, micCode: null, exchange: null, finnhub: raw }
    ]);
  }

  if (raw.endsWith('.HK')) {
    const ticker = raw.replace('.HK', '');
    return uniqueCandidates_([
      { symbol: ticker, micCode: 'XHKG', exchange: null, finnhub: raw },
      { symbol: raw, micCode: null, exchange: null, finnhub: raw }
    ]);
  }

  return uniqueCandidates_([
    { symbol: raw, micCode: null, exchange: null, finnhub: raw },
    { symbol: raw, micCode: 'XLON', exchange: null, finnhub: `${raw}.L` },
    { symbol: raw, micCode: 'XETR', exchange: null, finnhub: `${raw}.DE` },
    { symbol: raw, micCode: 'XMAD', exchange: null, finnhub: `${raw}.MC` },
    { symbol: raw, micCode: 'BMEX', exchange: null, finnhub: `${raw}.MC` },
    { symbol: raw, micCode: 'XHKG', exchange: null, finnhub: `${raw}.HK` }
  ]);
}

function stripExchangePrefix_(ticker) {
  const raw = String(ticker).trim().toUpperCase();

  if (raw.includes(':')) {
    return raw.split(':')[1];
  }

  return raw;
}

function uniqueCandidates_(candidates) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    const key = `${candidate.symbol}|${candidate.micCode || ''}|${candidate.exchange || ''}|${candidate.finnhub || ''}`;

    if (!seen.has(key)) {
      seen.add(key);
      output.push(candidate);
    }
  }

  return output;
}

function mapExchangeToMicCode_(exchange) {
  const map = {
    LON: 'XLON',
    LSE: 'XLON',
    XLON: 'XLON',
    ETR: 'XETR',
    XETR: 'XETR',
    BME: 'XMAD',
    BMEX: 'BMEX',
    XMAD: 'XMAD',
    HKG: 'XHKG',
    HKEX: 'XHKG',
    NASDAQ: null,
    NYSE: null
  };

  return map[exchange] !== undefined ? map[exchange] : exchange;
}

function mapFinnhubSymbol_(exchange, ticker) {
  if (exchange === 'LON' || exchange === 'LSE' || exchange === 'XLON') return `${ticker}.L`;
  if (exchange === 'ETR' || exchange === 'XETR') return `${ticker}.DE`;
  if (exchange === 'BME' || exchange === 'BMEX' || exchange === 'XMAD') return `${ticker}.MC`;
  if (exchange === 'HKG' || exchange === 'HKEX') return `${ticker}.HK`;
  return ticker;
}

function mapFinnhubSymbolFromSearch_(item) {
  const symbol = String(item.symbol || '').toUpperCase();
  const mic = String(item.mic_code || '').toUpperCase();

  if (mic === 'XLON') return `${symbol}.L`;
  if (mic === 'XETR') return `${symbol}.DE`;
  if (mic === 'BMEX' || mic === 'XMAD') return `${symbol}.MC`;
  if (mic === 'XHKG') return `${symbol}.HK`;

  return symbol;
}

function buildTwelveDataUrl_(endpoint, candidate, extraParams = {}) {
  const params = new URLSearchParams();

  params.set('symbol', candidate.symbol);

  if (candidate.micCode) {
    params.set('mic_code', candidate.micCode);
  }

  if (candidate.exchange) {
    params.set('exchange', candidate.exchange);
  }

  for (const [key, value] of Object.entries(extraParams)) {
    params.set(key, value);
  }

  params.set('apikey', TWELVE_DATA_API_KEY);

  return `https://api.twelvedata.com/${endpoint}?${params.toString()}`;
}

function isTwelveDataError_(data) {
  if (!data) return true;
  if (data.status === 'error') return true;
  if (data.code || data.message) return true;
  return false;
}

function buildPerformanceFromTwelveData_(timeSeries, currentPrice) {
  if (!timeSeries || timeSeries.status === 'error' || !Array.isArray(timeSeries.values)) {
    return emptyPerformance_();
  }

  const prices = timeSeries.values
    .map(item => ({
      date: item.datetime,
      close: Number(item.close)
    }))
    .filter(item => isFinite(item.close) && item.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(item => item.close);

  if (prices.length < 5) return emptyPerformance_();

  const latestPrice = currentPrice || prices[prices.length - 1];

  return {
    week4: calculateReturn_(prices, 20, latestPrice),
    week13: calculateReturn_(prices, 63, latestPrice),
    week26: calculateReturn_(prices, 126, latestPrice),
    week52: calculateReturn_(prices, 252, latestPrice)
  };
}

function buildPerformanceFromFinnhubMetrics_(metrics) {
  const metric = metrics && metrics.metric ? metrics.metric : {};

  return {
    week4: formatMetricPercent_(firstAvailable_(metric, [
      '4WeekPriceReturnDaily',
      'priceReturn1Month',
      'monthToDatePriceReturnDaily'
    ])),
    week13: formatMetricPercent_(firstAvailable_(metric, [
      '13WeekPriceReturnDaily',
      'priceReturn3Month'
    ])),
    week26: formatMetricPercent_(firstAvailable_(metric, [
      '26WeekPriceReturnDaily',
      'priceReturn6Month'
    ])),
    week52: formatMetricPercent_(firstAvailable_(metric, [
      '52WeekPriceReturnDaily',
      'priceReturn1Year'
    ]))
  };
}

function emptyPerformance_() {
  return {
    week4: 'N/A',
    week13: 'N/A',
    week26: 'N/A',
    week52: 'N/A'
  };
}

function calculateReturn_(prices, tradingDaysAgo, currentPrice) {
  const index = Math.max(0, prices.length - 1 - tradingDaysAgo);
  const oldPrice = prices[index];

  if (!oldPrice || !currentPrice) return 'N/A';

  const change = ((currentPrice / oldPrice) - 1) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
}

function firstAvailable_(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }

  return null;
}

function firstNumber_(values) {
  for (const value of values) {
    const number = Number(value);

    if (isFinite(number) && number > 0) {
      return number;
    }
  }

  return null;
}

function formatMetricPercent_(value) {
  const n = Number(value);
  if (!isFinite(n)) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

async function safeFinnhubProfile_(symbol) {
  try {
    return await fetchJson(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );
  } catch (error) {
    return {};
  }
}

async function safeFinnhubRecommendation_(symbol) {
  try {
    return await fetchJson(
      `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );
  } catch (error) {
    return [];
  }
}

async function safeFinnhubMetrics_(symbol) {
  try {
    return await fetchJson(
      `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );
  } catch (error) {
    return {};
  }
}

function buildAnalystText_(analyst) {
  const strongBuy = Number(analyst.strongBuy) || 0;
  const buy = Number(analyst.buy) || 0;
  const hold = Number(analyst.hold) || 0;
  const sell = Number(analyst.sell) || 0;
  const strongSell = Number(analyst.strongSell) || 0;
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

function formatMarketCap_(marketCapMillions) {
  const value = Number(marketCapMillions);
  if (!value) return 'N/A';
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}tn`;
  if (value >= 1000) return `$${(value / 1000).toFixed(2)}bn`;
  return `$${value.toFixed(2)}m`;
}

function buildDisplaySymbol_(candidate) {
  if (candidate.micCode) return `${candidate.symbol}:${candidate.micCode}`;
  if (candidate.exchange) return `${candidate.symbol}:${candidate.exchange}`;
  return candidate.symbol;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return await response.json();
}

client.login(DISCORD_TOKEN).catch(error => {
  console.error('Bot login failed:');
  console.error(error);
});
