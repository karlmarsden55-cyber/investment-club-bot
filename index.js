const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const manualTickerMap = {
  AEDAS: 'AEDAS.MC',
  HWG: 'HWG.L',
  NDX1: 'NDX1.DE',
  REL: 'REL.L',
  SGRO: 'SGRO.L'
};

const commands = [
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Get a quick stock snapshot')
    .addStringOption(option =>
      option.setName('ticker').setDescription('Ticker symbol, e.g. PLTR, REL, SGRO').setRequired(true)
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
      await interaction.editReply(`Could not find data for ${userTicker}. Try the exchange version, e.g. REL.L, SGRO.L, NDX1.DE.`);
      return;
    }

    const { symbol, quote, profile, recommendation, metrics } = resolved;

    const currentPrice = quote && quote.c ? Number(quote.c) : null;
    const companyName = profile && profile.name ? profile.name : userTicker;
    const currency = profile && profile.currency ? profile.currency : '';
    const marketCap = profile && profile.marketCapitalization
      ? formatMarketCap_(profile.marketCapitalization)
      : 'N/A';

    const performance = buildPerformanceText_(metrics);

    const analyst = Array.isArray(recommendation) && recommendation.length > 0
      ? recommendation[0]
      : null;

    const analystText = analyst ? buildAnalystText_(analyst) : 'No analyst data available';

    const message =
      `🔍 **STOCK SNAPSHOT**\n\n` +
      `**${companyName} (${symbol})**\n` +
      `Requested: ${userTicker}\n\n` +
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
  const candidates = buildTickerCandidates_(userTicker);

  for (const symbol of candidates) {
    try {
      const quote = await fetchJson(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
      );

      const profile = await fetchJson(
        `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
      );

      const recommendation = await fetchJson(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
      );

      const metrics = await fetchJson(
        `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${encodeURIComponent(FINNHUB_API_KEY)}`
      );

      const hasUsefulData =
        (quote && quote.c && Number(quote.c) > 0) ||
        (profile && profile.name) ||
        (metrics && metrics.metric && Object.keys(metrics.metric).length > 0);

      if (hasUsefulData) {
        console.log(`Resolved ${userTicker} to ${symbol}`);
        return { symbol, quote, profile, recommendation, metrics };
      }
    } catch (error) {
      console.error(`Ticker candidate failed: ${symbol}`);
      console.error(error);
    }
  }

  return null;
}

function buildTickerCandidates_(userTicker) {
  const raw = String(userTicker).trim().toUpperCase();

  if (manualTickerMap[raw]) {
    return [manualTickerMap[raw], raw];
  }

  if (raw.includes(':')) {
    const [exchange, ticker] = raw.split(':');

    const mapped = [];

    if (exchange === 'LON') mapped.push(`${ticker}.L`);
    if (exchange === 'ETR') mapped.push(`${ticker}.DE`);
    if (exchange === 'BME') mapped.push(`${ticker}.MC`);
    if (exchange === 'HKG') mapped.push(`${ticker}.HK`);
    if (exchange === 'NASDAQ') mapped.push(ticker);
    if (exchange === 'NYSE') mapped.push(ticker);

    mapped.push(ticker);
    mapped.push(raw);

    return [...new Set(mapped)];
  }

  return [
    raw,
    `${raw}.L`,
    `${raw}.DE`,
    `${raw}.MC`,
    `${raw}.HK`
  ];
}

function buildPerformanceText_(metrics) {
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
