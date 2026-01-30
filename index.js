const puppeteer = require('puppeteer');
const axios = require('axios');
const express = require('express');

// Configuration
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://discord.com/api/webhooks/1466639280502739098/vxNKnw2ax9LBmqZmfhgtxB98KqCvbfVIRMoNF9_2Yj75RCEct0wGrF7D6TxjxZNsKUxq';
const NEXUS_ADMIN_KEY = process.env.NEXUS_ADMIN_KEY || '7c15becb-67a0-42d5-a601-89508553a149';
const NEXUS_API_URL = 'https://discord.nexusdevtools.com/lookup/roblox';
const TRADES_URL = 'https://www.rolimons.com/trades';

const AGED_RAP_MIN = parseInt(process.env.AGED_RAP_MIN || '100000', 10);
const MIN_ROLIMONS_VALUE = parseInt(process.env.MIN_ROLIMONS_VALUE || '100000', 10);
const MIN_TRADE_ADS = parseInt(process.env.MIN_TRADE_ADS || '0', 10);
const MAX_TRADE_ADS = parseInt(process.env.MAX_TRADE_ADS || '500', 10);
const AGED_HELD_YEARS = parseFloat(process.env.AGED_HELD_YEARS || '5', 10);
const AGED_INVENTORY_PERCENT_MIN = parseFloat(process.env.AGED_INVENTORY_PERCENT_MIN || '50', 10);
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || '';

const app = express();
const PORT = process.env.PORT || 3000;

let browser;
let page;
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
    const initialized = await initializeBrowser();
    if (!initialized) {
        console.error('❌ Failed to initialize browser. Will retry in 60s (server stays up for healthcheck).');
        setTimeout(startScraper, 60000);
        return;
    }
    console.log('🚀 Starting inventory checker (aged items + Discord)...');
    isScraping = true;
    await scrapeUserSources();
}

async function initializeBrowser() {
    try {
        const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN;
        browser = await puppeteer.launch({
            headless: true,
            executablePath: executablePath || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--window-size=1280,720',
                '--no-zygote',
                '--disable-features=VizDisplayCompositor'
            ]
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (req.resourceType() === 'image') req.abort();
            else req.continue();
        });
        console.log('✅ Browser initialized' + (isRailway ? ' (Railway)' : ''));
        return true;
    } catch (error) {
        console.error('❌ Browser error:', error.message);
        return false;
    }
}

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
    if (!page) return { value: 0, tradeAds: 0, avatarUrl: '', profileUrl };
    try {
        await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 25000 });
        await new Promise((r) => setTimeout(r, 3000));

        const getText = async (selector) => {
            try {
                const el = await page.$(selector);
                return el ? await el.evaluate((e) => e.textContent || '') : '';
            } catch {
                return '';
            }
        };

        const value = parseInt((await getText('#player_value')).replace(/,/g, '')) || 0;

        let tradeAds = 0;
        const selectors = ['span.card-title.mb-1.text-light.stat-data.text-nowrap', 'span.stat-data.text-nowrap', '.stat-data.text-nowrap'];
        for (const selector of selectors) {
            try {
                const elements = await page.$$(selector);
                for (const el of elements) {
                    const text = (await el.evaluate((e) => e.textContent || '')).replace(/,/g, '');
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

        let avatarUrl = '';
        try {
            const img = await page.$('img.mx-auto.d-block.w-100.h-100[src^="https://tr.rbxcdn.com/"]');
            avatarUrl = img ? (await img.evaluate((e) => e.src || '')) : '';
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
    return /target closed|Session closed|browser.*closed|Protocol error/i.test(msg);
}

async function reinitBrowser() {
    try {
        if (page) try { await page.close(); } catch (_) {}
        if (browser) try { await browser.close(); } catch (_) {}
    } catch (_) {}
    browser = null;
    page = null;
    await initializeBrowser();
}

async function scrapeUserSources() {
    while (true) {
        try {
            console.log('\n🔄 New cycle...');
            await page.goto(TRADES_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise((r) => setTimeout(r, 8000));

            try {
                await page.waitForSelector('a.ad_creator_name[href*="/player/"]', { timeout: 30000 });
            } catch (e) {
                console.log('⚠️ No trade ad links found, waiting 30s...');
                await new Promise((r) => setTimeout(r, 30000));
                continue;
            }

            let userLinks = await page.$$('a.ad_creator_name[href*="/player/"]');
            if (userLinks.length === 0) {
                userLinks = await page.$$('a[href*="/player/"]');
            }

            console.log(`👥 Found ${userLinks.length} user links`);

            for (let i = 0; i < userLinks.length; i++) {
                try {
                    const links = await page.$$('a.ad_creator_name[href*="/player/"]');
                    if (links.length === 0) break;
                    const link = links[i];
                    if (!link) continue;

                    const username = (await link.evaluate((e) => e.textContent || '')).trim();
                    let profileUrl = (await link.evaluate((e) => e.getAttribute('href') || '')) || '';
                    if (profileUrl && !profileUrl.startsWith('http')) profileUrl = `https://www.rolimons.com${profileUrl}`;
                    const finalUsername = username || (profileUrl ? profileUrl.split('/').filter(Boolean).pop() || 'Unknown') : null;
                    if (!finalUsername) continue;

                    if (processedUsers.has(finalUsername)) continue;

                    let userId = null;
                    if (profileUrl) {
                        const last = profileUrl.split('/').filter(Boolean).pop();
                        if (last && !isNaN(last)) userId = last;
                    }
                    if (!userId && finalUsername) userId = await getUserIdFromUsername(finalUsername);

                    console.log(`🔍 [${i + 1}/${userLinks.length}] ${finalUsername}`);

                    const rolimons = await Promise.race([
                        scrapeRolimonsUserProfile(profileUrl),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
                    ]).catch(() => ({ value: 0, tradeAds: 0, avatarUrl: '', profileUrl }));

                    if (rolimons.value < MIN_ROLIMONS_VALUE) {
                        processedUsers.add(finalUsername);
                        continue;
                    }

                    const tradeAds = rolimons.tradeAds != null ? rolimons.tradeAds : 0;
                    if (tradeAds < MIN_TRADE_ADS || tradeAds > MAX_TRADE_ADS) {
                        console.log(`   ⏭️ Trade ads ${tradeAds} outside range [${MIN_TRADE_ADS}-${MAX_TRADE_ADS}], skipping ${finalUsername}`);
                        processedUsers.add(finalUsername);
                        continue;
                    }

                    if (!userId) {
                        processedUsers.add(finalUsername);
                        continue;
                    }

                    const { aged: agedItems, totalQualifying } = await getAgedItems(userId);
                    if (agedItems.length === 0) {
                        processedUsers.add(finalUsername);
                        continue;
                    }
                    const percentAged = totalQualifying > 0 ? (agedItems.length / totalQualifying) * 100 : 100;
                    if (AGED_INVENTORY_PERCENT_MIN > 0 && percentAged < AGED_INVENTORY_PERCENT_MIN) {
                        console.log(`   ⏭️ Only ${percentAged.toFixed(0)}% aged (need ${AGED_INVENTORY_PERCENT_MIN}%), skipping ${finalUsername}`);
                        processedUsers.add(finalUsername);
                        continue;
                    }

                    console.log(`   ✅ ${agedItems.length} aged / ${totalQualifying} qualifying (${percentAged.toFixed(0)}%), checking Discord...`);
                    const hit = await lookupDiscordAndSend(finalUsername, rolimons, agedItems);
                    processedUsers.add(finalUsername);
                    if (hit) {
                        totalLogged++;
                        console.log(`   🎉 Discord sent. Total hits: ${totalLogged}`);
                    }
                    await new Promise((r) => setTimeout(r, 5000));
                } catch (err) {
                    console.error(`❌ Error processing user:`, err.message);
                    if (isSessionInvalidError(err)) {
                        console.log('🔄 Browser session invalid, re-initializing and starting new cycle...');
                        await reinitBrowser();
                        break;
                    }
                }
            }

            console.log(`✅ Cycle done. Hits: ${totalLogged}. Next cycle in 10s...`);
            await new Promise((r) => setTimeout(r, 10000));
        } catch (error) {
            console.error('❌ Cycle error:', error.message);
            if (isSessionInvalidError(error)) {
                console.log('🔄 Browser session invalid, re-initializing...');
                await reinitBrowser();
                await new Promise((r) => setTimeout(r, 5000));
            } else {
                retryCount++;
                if (retryCount <= MAX_RETRIES) {
                    await reinitBrowser();
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
    if (page) try { await page.close(); } catch (_) {}
    if (browser) try { await browser.close(); } catch (_) {}
    process.exit(0);
}

process.on('SIGINT', cleanup);

console.log('🚀 Inventory checker (aged items + Discord)');
console.log(`   AGED_RAP_MIN: ${AGED_RAP_MIN}, MIN_ROLIMONS_VALUE: ${MIN_ROLIMONS_VALUE}, Trade ads: ${MIN_TRADE_ADS}-${MAX_TRADE_ADS}, Held ${AGED_HELD_YEARS}+ yrs: ${ROBLOX_API_KEY ? `yes, ${AGED_INVENTORY_PERCENT_MIN}%+ of inventory` : 'no (set ROBLOX_API_KEY for 5+ yr filter)'}`);
setTimeout(startScraper, 5000);
