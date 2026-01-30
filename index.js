const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const axios = require('axios');
const express = require('express');

// Configuration
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://discord.com/api/webhooks/1466639280502739098/vxNKnw2ax9LBmqZmfhgtxB98KqCvbfVIRMoNF9_2Yj75RCEct0wGrF7D6TxjxZNsKUxq';
const NEXUS_ADMIN_KEY = process.env.NEXUS_ADMIN_KEY || '7c15becb-67a0-42d5-a601-89508553a149';
const NEXUS_API_URL = 'https://discord.nexusdevtools.com/lookup/roblox';
const TRADES_URL = 'https://www.rolimons.com/trades';

// Aged items: Limited/LimitedU with RAP >= this (Robux)
const AGED_RAP_MIN = parseInt(process.env.AGED_RAP_MIN || '100000', 10);
// Minimum total value on Rolimons to consider (avoids empty/irrelevant profiles)
const MIN_ROLIMONS_VALUE = parseInt(process.env.MIN_ROLIMONS_VALUE || '100000', 10);
// Trade ads on Rolimons: only process users with trade ads in this range (inclusive)
const MIN_TRADE_ADS = parseInt(process.env.MIN_TRADE_ADS || '0', 10);
const MAX_TRADE_ADS = parseInt(process.env.MAX_TRADE_ADS || '500', 10);
// Aged = item held by user for at least this many years (requires ROBLOX_API_KEY for Cloud API v2)
const AGED_HELD_YEARS = parseFloat(process.env.AGED_HELD_YEARS || '5', 10);
// When using age filter: require at least this % of qualifying inventory (limited, RAP >= AGED_RAP_MIN) to be held AGED_HELD_YEARS+ yrs. 0 = any one item ok.
const AGED_INVENTORY_PERCENT_MIN = parseFloat(process.env.AGED_INVENTORY_PERCENT_MIN || '50', 10);
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || '';

const app = express();
const PORT = process.env.PORT || 3000;

let driver;
let processedUsers = new Set();
let totalLogged = 0;
let isScraping = false;
let retryCount = 0;
const MAX_RETRIES = 3;

app.get('/', (req, res) => {
    res.json({
        status: 'healthy',
        scraping: isScraping,
        totalLogged,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`🌐 Healthcheck server running on port ${PORT}`);
});

async function startScraper() {
    console.log('🔐 Initializing inventory checker...');
    const initialized = await initializeWebDriver();
    if (!initialized) {
        console.error('❌ Failed to initialize WebDriver. Will retry in 60s (server stays up for healthcheck).');
        setTimeout(startScraper, 60000);
        return;
    }
    console.log('🚀 Starting inventory checker (aged items + Discord)...');
    isScraping = true;
    await scrapeUserSources();
}

async function initializeWebDriver() {
    try {
        const chromeBin = process.env.CHROME_BIN;
        const chromedriverPath = process.env.CHROMEDRIVER_PATH;
        const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;

        const options = new chrome.Options();
        if (chromeBin) options.setChromeBinaryPath(chromeBin);
        options.addArguments(
            '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            '--disable-software-rasterizer', '--disable-gpu-compositing',
            '--ignore-certificate-errors', '--ignore-ssl-errors',
            '--window-size=1280,720', '--disable-web-security', '--disable-extensions',
            '--disable-images', '--disable-background-networking',
            '--disable-features=VizDisplayCompositor', '--disable-site-isolation-trials'
        );
        options.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        options.addArguments('--disable-blink-features=AutomationControlled', '--exclude-switches=enable-automation');

        let builder = new Builder().forBrowser('chrome').setChromeOptions(options);
        driver = await builder.build();

        console.log('✅ WebDriver initialized' + (isRailway ? ' (Railway)' : ''));
        return true;
    } catch (error) {
        console.error('❌ WebDriver error:', error.message);
        return false;
    }
}

/** Resolve Roblox username to userId (Rolimons often uses username in URL). */
async function getUserIdFromUsername(username) {
    try {
        const { data } = await axios.get('https://api.roblox.com/users/get-by-username', {
            params: { username },
            timeout: 8000
        });
        return data && data.Id ? String(data.Id) : null;
    } catch (_) {
        return null;
    }
}

/** Parse Cloud API v2 inventory, return assetIds held for AGED_HELD_YEARS+ and limited */
async function getAssetIdsHeldLongEnough(userId) {
    if (!ROBLOX_API_KEY) return null;
    const cutoff = Date.now() - AGED_HELD_YEARS * 365.25 * 24 * 60 * 60 * 1000;
    const assetIds = new Set();
    let pageToken = '';
    try {
        do {
            const url = `https://apis.roblox.com/cloud/v2/users/${userId}/inventory-items`;
            const params = { maxPageSize: 100 };
            if (pageToken) params.pageToken = pageToken;
            const { data } = await axios.get(url, {
                params,
                headers: { 'x-api-key': ROBLOX_API_KEY },
                timeout: 15000
            });
            const items = data.inventoryItems || [];
            for (const it of items) {
                const addTime = it.addTime;
                const details = it.assetDetails || {};
                const coll = details.collectibleDetails || {};
                const serial = coll.serialNumber != null && coll.serialNumber !== '';
                const assetId = details.assetId;
                if (!assetId || !serial) continue;
                if (addTime) {
                    const added = new Date(addTime).getTime();
                    if (added <= cutoff) assetIds.add(String(assetId));
                }
            }
            pageToken = data.nextPageToken || '';
        } while (pageToken);
        return assetIds;
    } catch (e) {
        console.error(`❌ Cloud API v2 error for user ${userId}:`, e.message);
        return null;
    }
}

/** Fetch collectibles; return { aged, totalQualifying }. Aged = limited, RAP >= AGED_RAP_MIN, and if API key set, held >= AGED_HELD_YEARS. totalQualifying = all limited with RAP >= AGED_RAP_MIN. */
async function getAgedItems(userId) {
    try {
        let heldLongEnoughAssetIds = null;
        if (ROBLOX_API_KEY && AGED_HELD_YEARS > 0) {
            heldLongEnoughAssetIds = await getAssetIdsHeldLongEnough(userId);
            if (heldLongEnoughAssetIds && heldLongEnoughAssetIds.size === 0) {
                return { aged: [], totalQualifying: 0 };
            }
        }

        const response = await axios.get(
            `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`,
            { params: { assetType: 'All', sortOrder: 'Desc', limit: 100 }, timeout: 15000 }
        );
        const items = response.data.data || [];
        const qualifying = items.filter((item) => {
            const rap = item.recentAveragePrice || 0;
            const isLimited = item.serialNumber != null && item.serialNumber !== '';
            return isLimited && rap >= AGED_RAP_MIN;
        });
        const aged = heldLongEnoughAssetIds === null
            ? qualifying
            : qualifying.filter((item) => {
                const aid = String(item.assetId != null ? item.assetId : item.id || '');
                return heldLongEnoughAssetIds.has(aid);
            });
        return { aged, totalQualifying: qualifying.length };
    } catch (error) {
        console.error(`❌ Inventory API error for user ${userId}:`, error.message);
        return { aged: [], totalQualifying: 0 };
    }
}

async function scrapeRolimonsUserProfile(profileUrl) {
    if (!driver) {
        return { value: 0, tradeAds: 0, avatarUrl: '', profileUrl };
    }
    try {
        await driver.get(profileUrl);
        await driver.sleep(3000);

        const getText = async (selector) => {
            try {
                const el = await driver.findElement(By.css(selector));
                return await el.getText();
            } catch {
                return '';
            }
        };

        const value = parseInt((await getText('#player_value')).replace(/,/g, '')) || 0;

        let tradeAds = 0;
        try {
            const selectors = [
                'span.card-title.mb-1.text-light.stat-data.text-nowrap',
                'span.stat-data.text-nowrap',
                '.stat-data.text-nowrap'
            ];
            for (const selector of selectors) {
                try {
                    const elements = await driver.findElements(By.css(selector));
                    for (const el of elements) {
                        const text = (await el.getText()).replace(/,/g, '');
                        if (text && /^\d+$/.test(text)) {
                            const n = parseInt(text, 10);
                            if (n >= 0 && n <= 100000) {
                                tradeAds = n;
                                break;
                            }
                        }
                    }
                    if (tradeAds > 0) break;
                } catch (_) {}
            }
        } catch (_) {}

        let avatarUrl = '';
        try {
            const img = await driver.findElement(By.css('img.mx-auto.d-block.w-100.h-100[src^="https://tr.rbxcdn.com/"]'));
            avatarUrl = await img.getAttribute('src') || '';
        } catch (_) {}

        return { value, tradeAds, avatarUrl, profileUrl };
    } catch (error) {
        console.error('❌ Profile scrape failed:', error.message);
        return { value: 0, tradeAds: 0, avatarUrl: '', profileUrl };
    }
}

function extractDiscordFromRecord(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.discord_tag) return String(record.discord_tag);
    if (record.discord_username && record.discriminator) return `${record.discord_username}#${record.discriminator}`;
    if (record.discord_username) return String(record.discord_username);
    if (record.username) return String(record.username);
    const key = Object.keys(record).find((k) => k.toLowerCase().includes('discord'));
    if (key && record[key]) return String(record[key]);
    return null;
}

async function lookupDiscordAndSend(robloxUsername, rolimonsData, agedItems) {
    try {
        const response = await axios.get(NEXUS_API_URL, {
            params: { query: robloxUsername },
            headers: { 'x-admin-key': NEXUS_ADMIN_KEY }
        });
        const body = response.data || {};
        const records = Array.isArray(body.data) ? body.data : [];
        if (!records.length) return false;

        const discordRecord = records[0];
        const discordValue = extractDiscordFromRecord(discordRecord);
        if (!discordValue) return false;

        await sendToWebhook(robloxUsername, discordValue, discordRecord, rolimonsData, agedItems);
        return true;
    } catch (error) {
        console.error(`❌ Nexus API error for ${robloxUsername}:`, error.message);
        return false;
    }
}

async function sendToWebhook(robloxUsername, discordUsername, discordRecord, rolimonsData, agedItems) {
    try {
        const fields = [
            { name: 'Discord', value: discordUsername, inline: false },
            { name: 'Roblox', value: robloxUsername, inline: true }
        ];
        if (discordRecord && (discordRecord.user_id || discordRecord.id)) {
            fields.push({ name: 'Discord ID', value: String(discordRecord.user_id || discordRecord.id), inline: true });
        }
        if (rolimonsData && rolimonsData.value) {
            fields.push({ name: 'Rolimons Value', value: rolimonsData.value.toLocaleString(), inline: true });
        }
        if (rolimonsData && rolimonsData.tradeAds != null) {
            fields.push({ name: 'Trade Ads', value: String(rolimonsData.tradeAds), inline: true });
        }

        const topAged = (agedItems || [])
            .sort((a, b) => (b.recentAveragePrice || 0) - (a.recentAveragePrice || 0))
            .slice(0, 5);
        const agedSummary = topAged.length
            ? topAged.map((i) => `${i.name || 'Item'}: ${(i.recentAveragePrice || 0).toLocaleString()} RAP`).join('\n')
            : 'N/A';
        fields.push({ name: `Aged Items (${(agedItems || []).length})`, value: agedSummary || '—', inline: false });

        if (rolimonsData && rolimonsData.profileUrl) {
            fields.push({ name: 'Rolimons', value: `[Profile](${rolimonsData.profileUrl})`, inline: false });
        }

        const embed = {
            title: '✨ Aged Items + Discord',
            color: 0x00ae86,
            fields,
            timestamp: new Date().toISOString()
        };
        if (rolimonsData && rolimonsData.avatarUrl) embed.thumbnail = { url: rolimonsData.avatarUrl };

        await axios.post(WEBHOOK_URL, { embeds: [embed] });
        console.log('✅ Webhook sent');
    } catch (e) {
        console.error('❌ Webhook error:', e.message);
    }
}

function isSessionInvalidError(err) {
    const msg = (err && err.message) ? String(err.message) : '';
    return /session ID|valid session|WebDriver\.quit|no longer be used/i.test(msg);
}

async function reinitDrivers() {
    try {
        if (driver) try { await driver.quit(); } catch (_) {}
    } catch (_) {}
    driver = null;
    await initializeWebDriver();
}

async function scrapeUserSources() {
    while (true) {
        try {
            console.log('\n🔄 New cycle...');
            await driver.get(TRADES_URL);
            await driver.sleep(8000);

            try {
                await driver.wait(until.elementLocated(By.css('a.ad_creator_name[href*="/player/"]')), 30000);
            } catch (e) {
                console.log('⚠️ No trade ad links found, waiting 30s...');
                await new Promise((r) => setTimeout(r, 30000));
                continue;
            }

            let userLinks = await driver.findElements(By.css('a.ad_creator_name[href*="/player/"]'));
            if (userLinks.length === 0) {
                userLinks = await driver.findElements(By.css('a[href*="/player/"]'));
            }

            console.log(`👥 Found ${userLinks.length} user links`);

            for (let i = 0; i < userLinks.length; i++) {
                try {
                    const links = await driver.findElements(By.css('a.ad_creator_name[href*="/player/"]'));
                    if (links.length === 0) break;
                    const link = links[i];
                    if (!link) continue;

                    let username = (await link.getText()) || (await link.getAttribute('textContent')) || '';
                    username = username.trim();
                    let profileUrl = (await link.getAttribute('href')) || '';
                    if (profileUrl && !profileUrl.startsWith('http')) profileUrl = `https://www.rolimons.com${profileUrl}`;
                    if (!username && profileUrl) {
                        const parts = profileUrl.split('/').filter(Boolean);
                        username = parts[parts.length - 1] || 'Unknown';
                    }
                    if (!username) continue;

                    if (processedUsers.has(username)) continue;

                    let userId = null;
                    if (profileUrl) {
                        const parts = profileUrl.split('/');
                        const last = parts[parts.length - 1];
                        if (last && !isNaN(last)) userId = last;
                    }
                    if (!userId && username) userId = await getUserIdFromUsername(username);

                    console.log(`🔍 [${i + 1}/${userLinks.length}] ${username}`);

                    const rolimons = await Promise.race([
                        scrapeRolimonsUserProfile(profileUrl),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
                    ]).catch(() => ({ value: 0, tradeAds: 0, avatarUrl: '', profileUrl }));

                    if (rolimons.value < MIN_ROLIMONS_VALUE) {
                        processedUsers.add(username);
                        continue;
                    }

                    const tradeAds = rolimons.tradeAds != null ? rolimons.tradeAds : 0;
                    if (tradeAds < MIN_TRADE_ADS || tradeAds > MAX_TRADE_ADS) {
                        console.log(`   ⏭️ Trade ads ${tradeAds} outside range [${MIN_TRADE_ADS}-${MAX_TRADE_ADS}], skipping ${username}`);
                        processedUsers.add(username);
                        continue;
                    }

                    if (!userId) {
                        processedUsers.add(username);
                        continue;
                    }

                    const { aged: agedItems, totalQualifying } = await getAgedItems(userId);
                    if (agedItems.length === 0) {
                        processedUsers.add(username);
                        continue;
                    }
                    const percentAged = totalQualifying > 0 ? (agedItems.length / totalQualifying) * 100 : 100;
                    if (AGED_INVENTORY_PERCENT_MIN > 0 && percentAged < AGED_INVENTORY_PERCENT_MIN) {
                        console.log(`   ⏭️ Only ${percentAged.toFixed(0)}% aged (need ${AGED_INVENTORY_PERCENT_MIN}%), skipping ${username}`);
                        processedUsers.add(username);
                        continue;
                    }

                    console.log(`   ✅ ${agedItems.length} aged / ${totalQualifying} qualifying (${percentAged.toFixed(0)}%), checking Discord...`);
                    const hit = await lookupDiscordAndSend(username, rolimons, agedItems);
                    processedUsers.add(username);
                    if (hit) {
                        totalLogged++;
                        console.log(`   🎉 Discord sent. Total hits: ${totalLogged}`);
                    }
                    await new Promise((r) => setTimeout(r, 5000));
                } catch (err) {
                    console.error(`❌ Error processing user:`, err.message);
                    if (isSessionInvalidError(err)) {
                        console.log('🔄 Driver session invalid, re-initializing and starting new cycle...');
                        await reinitDrivers();
                        break;
                    }
                }
            }

            console.log(`✅ Cycle done. Hits: ${totalLogged}. Next cycle in 10s...`);
            await new Promise((r) => setTimeout(r, 10000));
        } catch (error) {
            console.error('❌ Cycle error:', error.message);
            if (isSessionInvalidError(error)) {
                console.log('🔄 Driver session invalid, re-initializing...');
                await reinitDrivers();
                await new Promise((r) => setTimeout(r, 5000));
            } else {
                retryCount++;
                if (retryCount <= MAX_RETRIES) {
                    await reinitDrivers();
                    await new Promise((r) => setTimeout(r, 10000));
                } else {
                    retryCount = 0;
                    await new Promise((r) => setTimeout(r, 30000));
                }
            }
        }
    }
}

async function cleanup() {
    if (driver) try { await driver.quit(); } catch (_) {}
    process.exit(0);
}

process.on('SIGINT', cleanup);

console.log('🚀 Inventory checker (aged items + Discord)');
console.log(`   AGED_RAP_MIN: ${AGED_RAP_MIN}, MIN_ROLIMONS_VALUE: ${MIN_ROLIMONS_VALUE}, Trade ads: ${MIN_TRADE_ADS}-${MAX_TRADE_ADS}, Held ${AGED_HELD_YEARS}+ yrs: ${ROBLOX_API_KEY ? `yes, ${AGED_INVENTORY_PERCENT_MIN}%+ of inventory` : 'no (set ROBLOX_API_KEY for 5+ yr filter)'}`);
// Delay so healthcheck can succeed before Chrome init (Chrome can be slow/fail on Railway)
setTimeout(startScraper, 5000);
