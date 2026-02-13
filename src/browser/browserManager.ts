// src/browser/browserManager.ts
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import logger from '../utils/logger';
import { EventEmitter } from 'events';

puppeteer.use(StealthPlugin());

export class BrowserManager extends EventEmitter {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private isClosing = false;
    private userDataDir = process.env.CHROME_USER_DATA_DIR || '/app/chrome-data';

    constructor() {
        super();
        this.startMemoryWatchdog();
    }

    async init(): Promise<void> {
        if (this.browser) return;

        logger.info(`Initializing browser (Stealth) with user-data-dir: ${this.userDataDir}`);
        this.browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                `--user-data-dir=${this.userDataDir}`
            ],
            // executablePath: '/usr/bin/google-chrome-stable' // For Docker
        }) as unknown as Browser; // Cast because puppeteer-extra types can be tricky

        this.page = await this.browser.newPage();
        
        // Stealth: Randomize Viewport
        await this.page.setViewport({
            width: 1366 + Math.floor(Math.random() * 100),
            height: 768 + Math.floor(Math.random() * 100)
        });

        // Resource Efficiency: Block unnecessary resources
        await this.page.setRequestInterception(true);
        this.page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Additional Stealth: Hide stats
        await this.page.evaluateOnNewDocument(() => {
            // @ts-ignore
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
        });

        logger.info('Browser initialized');
    }

    getPage(): Page {
        if (!this.page) throw new Error('Browser not initialized');
        return this.page;
    }

    async close(): Promise<void> {
        if (this.isClosing) return;
        this.isClosing = true;
        
        // Stop watchdog logic during close to avoid race
        // (Implementation detail: interval continues but we set flag)

        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }

    // Stealth: Human-like typing
    async typeHumanLike(selector: string, text: string) {
        if (!this.page) return;
        await this.page.focus(selector);
        for (const char of text) {
            await this.page.keyboard.type(char, { delay: Math.random() * 100 + 30 }); // 30-130ms delay
            // Random pause
            if (Math.random() < 0.05) {
                await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
            }
        }
    }

    // Reliability: Memory Watchdog
    private startMemoryWatchdog() {
        setInterval(async () => {
            if (this.isClosing) return;
            const used = process.memoryUsage().rss / 1024 / 1024;
            if (used > 900) { // 900MB Threshold
                logger.warn(`Memory usage high (${Math.round(used)}MB). triggering safe restart...`);
                this.emit('restart_required');
            }
        }, 60000); // Check every minute
    }

    // Called by coordinator (index.ts) after pausing queue
    async restartBrowser() {
        logger.info('Performing safe browser restart...');
        await this.close();
        this.isClosing = false;
        // Wait a bit
        await new Promise(r => setTimeout(r, 2000));
        await this.init();
        logger.info('Browser restarted successfully.');
    }
}
