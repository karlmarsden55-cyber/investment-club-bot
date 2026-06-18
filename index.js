const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

if (!DISCORD_TOKEN) console.error('Missing DISCORD_TOKEN');
if (!CLIENT_ID) console.error('Missing CLIENT_ID');
if (!GUILD_ID) console.error('Missing GUILD_ID');
if (!FINNHUB_API_KEY) console.error('Missing FINNHUB_API_KEY');

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

    const companyName = profile.name || ticker;
    const price = quote.c ? quote.c : 'N/A';
    const marketCap = profile.marketCapitalization
      ? `$${Number(profile.marketCapitalization).toLocaleString()}m`
      : 'N/A';

    const analyst = Array.isArray(recommendation) && recommendation.length > 0
      ? recommendation[0]
      : null;

    let analystText = 'No analyst data available';

    if (analyst) {
      analystText =
        `Strong Buy: ${analyst.strongBuy}\n` +
        `Buy: ${analyst.buy}\n` +
        `Hold: ${analyst.hold}\n` +
        `Sell: ${analyst.sell}\n` +
        `Strong Sell: ${analyst.strongSell}`;
    }

    const message =
      `🔍 **STOCK SNAPSHOT**\n\n` +
      `**${companyName} (${ticker})**\n\n` +
      `Current Price: ${price}\n` +
      `Market Cap: ${marketCap}\n\n` +
      `**Analyst View**\n` +
      analystText;

    await interaction.editReply(message);
  } catch (error) {
    console.error('Stock lookup failed:');
    console.error(error);
    await interaction.editReply(`Could not fetch data for ${ticker}.`);
  }
});

client.login(DISCORD_TOKEN).catch(error => {
  console.error('Bot login failed:');
  console.error(error);
});
