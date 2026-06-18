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
    const quote = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`);
    const profile = await fetchJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_API_KEY}`);
    const recommendation = await fetchJson(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${FINNHUB_API_KEY}`);

    const candles = await fetchCandles_(ticker);

    const companyName = profile.name || ticker;
    const price = quote.c || null;
    const currency = profile.currency || '';
    const marketCap = profile.marketCapitalization
      ? `$${Number(profile.marketCapitalization).toLocaleString()}m`
      : 'N/A';

    const performance = calculatePerformance_(candles, price);

    const analyst = Array.isArray(recommendation) && recommendation.length > 0
      ? recommendation[0]
      : null;

    const analystText = analyst
      ? buildAnalystText_(analyst)
      : 'No analyst data available';

    const message =
      `🔍 **STOCK SNAPSHOT**\n\n` +
      `**${companyName} (${ticker})**\n\n` +
      `💰 Current Price: ${price ? `${currency} ${price}` : 'N/A'}\n` +
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

async function fetchCandles_(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const oneYearAgo = now - (370 * 24 * 60 * 60);

  return await fetchJson(
    `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${oneYearAgo}&to=${now}&token=${FINNHUB_API_KEY}`
  );
}

function calculatePerformance_(candles, currentPrice) {
  if (!candles || candles.s !== 'ok' || !candles.c || candles.c.length === 0 || !currentPrice) {
    return {
      d30: 'N/A',
      d90: 'N/A',
      d180: 'N/A',
      y1: 'N/A'
    };
  }

  return {
    d30: calculateReturn_(candles.c, 30, currentPrice),
    d90: calculateReturn_(candles.c, 90, currentPrice),
    d180: calculateReturn_(candles.c, 180, currentPrice),
    y1: calculateReturn_(candles.c, 365, currentPrice)
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
  return (
    `Strong Buy: ${analyst.strongBuy}\n` +
    `Buy: ${analyst.buy}\n` +
    `Hold: ${analyst.hold}\n` +
    `Sell: ${analyst.sell}\n` +
    `Strong Sell: ${analyst.strongSell}`
  );
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
