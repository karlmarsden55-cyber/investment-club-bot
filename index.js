const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Get a quick stock snapshot')
    .addStringOption(option =>
      option
        .setName('ticker')
        .setDescription('Ticker symbol, e.g. PLTR')
        .setRequired(true)
    )
].map(command => command.toJSON());

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log('Slash commands registered');
  } catch (error) {
    console.error('Slash command registration failed:');
    console.error(error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'stock') return;

  const ticker = interaction.options.getString('ticker').toUpperCase();

  await interaction.deferReply();

  try {
    const quote = await fetchJson(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );

    const profile = await fetchJson(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );

    const recommendation = await fetchJson(
      `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(FINNHUB_API_KEY)}`
    );

    const currentPrice = quote && quote.c ? quote.c : null;
    const companyName = profile && profile.name ? profile.name : ticker;
    const currency = profile && profile.currency ? profile.currency : '';
    const marketCap = profile && profile.marketCapitalization
      ? formatMarketCap_(profile.marketCapitalization)
      : 'N/A';

    const yahooPrices = await fetchYahooPrices_(ticker);
    const performance = calculatePerformance_(yahooPrices, currentPrice);

    const analyst = Array.isArray(recommendation) && recommendation.length > 0
      ? recommendation[0]
      : null;

    const analystText = analyst
      ? buildAnalystText_(analyst)
      : 'No analyst data available';

    const message =
      `🔍 **STOCK SNAPSHOT**\n\n` +
      `**${companyName} (${ticker})**\n\n` +
      `💰 Current Price: ${currentPrice ? `${currency} ${currentPrice}` : 'N/A'}\n` +
      `🏢 Market Cap: ${marketCap}\n\n` +
      `📊 **Performance**\n` +
      `30D: ${performance.d30}\n` +
      `90D: ${performance.d90}\n` +
      `180D: ${performance.d180}\n` +
      `1Y: ${performance.y1}\n\n` +
      `📈 **Analyst View**\n` +
      analystText;

    await interaction.editReply(message);
  } catch (error) {
    console.error('Stock lookup failed:');
    console.error(error);
    await interaction.editReply(`Could not fetch data for ${ticker}.`);
  }
});

async function fetchYahooPrices_(ticker) {
  const yahooTicker = convertToYahooTicker_(ticker);

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?range=1y&interval=1d`;

  const data = await fetchJson(url);

  const result = data &&
    data.chart &&
    data.chart.result &&
    data.chart.result[0];

  if (!result ||
      !result.indicators ||
      !result.indicators.quote ||
      !result.indicators.quote[0] ||
      !result.indicators.quote[0].close) {
    return [];
  }

  return result.indicators.quote[0].close.filter(price => price !== null);
}

function convertToYahooTicker_(ticker) {
  return String(ticker)
    .trim()
    .toUpperCase()
    .replace('.', '-');
}

function calculatePerformance_(prices, currentPrice) {
  if (!prices || prices.length === 0 || !currentPrice) {
    return {
      d30: 'N/A',
      d90: 'N/A',
      d180: 'N/A',
      y1: 'N/A'
    };
  }

  return {
    d30: calculateReturn_(prices, 30, currentPrice),
    d90: calculateReturn_(prices, 90, currentPrice),
    d180: calculateReturn_(prices, 180, currentPrice),
    y1: calculateReturn_(prices, 365, currentPrice)
  };
}

function calculateReturn_(prices, daysAgo, currentPrice) {
  const index = Math.max(0, prices.length - daysAgo);
  const oldPrice = prices[index];

  if (!oldPrice || !currentPrice) return 'N/A';

  const change = ((currentPrice / oldPrice) - 1) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
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

  if (strongBuy >= buy && strongBuy >= hold && strongBuy >= negative && strongBuy > 0) {
    return 'Strong Buy';
  }

  if (positive > hold && positive > negative) {
    return 'Buy';
  }

  if (negative > positive && negative > hold) {
    return 'Sell';
  }

  if (strongSell > 0 && negative >= positive) {
    return 'Strong Sell';
  }

  return 'Neutral';
}

function formatMarketCap_(marketCapMillions) {
  const value = Number(marketCapMillions);

  if (!value) return 'N/A';

  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}tn`;
  }

  if (value >= 1000) {
    return `$${(value / 1000).toFixed(2)}bn`;
  }

  return `$${value.toFixed(2)}m`;
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

client.login(DISCORD_TOKEN).catch(error => {
  console.error('Bot login failed:');
  console.error(error);
});
