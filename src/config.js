import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const configJsonPath = path.resolve(projectRoot, 'config.json');

let localConfig = {};
if (fs.existsSync(configJsonPath)) {
  try {
    localConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
  } catch (err) {
    console.error('Error loading config.json:', err);
  }
}

function numberFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  bot: {
    host: process.env.MC_HOST ?? 'play.manacube.com',
    port: numberFromEnv('MC_PORT', 25565),
    version: process.env.MC_VERSION ?? '1.21.11',
    username: process.env.MC_USERNAME ?? 'MINIRUNNER',
    auth: process.env.MC_AUTH ?? 'microsoft',
    profilesFolder: path.resolve(projectRoot, process.env.PROFILES_FOLDER ?? '.minecraft-auth'),
    acceptResourcePack: process.env.ACCEPT_RESOURCE_PACK !== 'false',
    hardcoreDelayMs: numberFromEnv('HARDCORE_DELAY_MS', 5000),
    warpAfkDelayMs: numberFromEnv('WARP_AFK_DELAY_MS', 15000),
  },
  web: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    port: numberFromEnv('WEB_PORT', 3694),
  },
  wordsPath: process.env.WORD_LIST_PATH ?? path.resolve(projectRoot, 'words.txt'),
  discordWebhookUrl: localConfig.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? '',
  saveLocalConfig(updates) {
    Object.assign(config, updates);
    localConfig = { ...localConfig, ...updates };
    try {
      fs.writeFileSync(configJsonPath, JSON.stringify(localConfig, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('Error writing config.json:', err);
      return false;
    }
  },
};
