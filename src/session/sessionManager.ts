// src/session/sessionManager.ts
import { Page } from 'puppeteer';
import { BrowserManager } from '../browser/browserManager';
import logger from '../utils/logger';
import { EventEmitter } from 'events';

export enum SessionState {
    INIT = 'INIT',
    QR_PENDING = 'QR_PENDING',
    AUTHENTICATED = 'AUTHENTICATED',
    DISCONNECTED = 'DISCONNECTED',
    RECONNECTING = 'RECONNECTING',
    SUSPECTED_BAN = 'SUSPECTED_BAN', // Quarantine State
    BANNED = 'BANNED',
    CIRCUIT_OPEN = 'CIRCUIT_OPEN'
}

export class SessionManager extends EventEmitter {
    private state: SessionState = SessionState.INIT;
    private browserManager: BrowserManager;
    private qrCode: string | null = null;
    
    // Circuit Breaker Stats
    private failureCount = 0;
    private lastFailureTime = 0;
    private readonly FAILURE_THRESHOLD = 5;
    private readonly RESET_TIMEOUT = 300000; // 5 minutes

    constructor(browserManager: BrowserManager) {
        super();
        this.browserManager = browserManager;
    }

    async init() {
        try {
            await this.browserManager.init();
            const page = this.browserManager.getPage();
            
            logger.info('Navigating to WhatsApp Web...');
            await page.goto('https://web.whatsapp.com', {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            this.monitorState(page);
            this.startHeartbeat(page);
        } catch (error) {
            logger.error('Failed to init session', error);
            this.state = SessionState.DISCONNECTED;
        }
    }

    private startHeartbeat(page: Page) {
        setInterval(async () => {
            if (this.state === SessionState.BANNED || this.state === SessionState.DISCONNECTED) return;
            try {
                await page.evaluate('1');
            } catch (err) {
                logger.error('Browser Heartbeat Failed! Restarting...', err);
                this.emit('restart_required');
            }
        }, 30000); // Check every 30s
    }

    private async monitorState(page: Page) {
        // ... (checkQR remains same) ...
        const checkQR = async () => {
             try {
                const qrSelector = 'canvas[aria-label="Scan me!"]';
                if (await page.$(qrSelector)) {
                    this.state = SessionState.QR_PENDING;
                    const qrData = await page.evaluate(() => {
                        const selector = document.querySelector('div[data-ref]');
                        return selector ? selector.getAttribute('data-ref') : null;
                    });
                    if (qrData) {
                        this.qrCode = qrData;
                        logger.info('QR Code detected (waiting for scan)');
                    }
                }
            } catch (e) { /* ignore */ }
        };

        // Check for Authentication logic with QUARANTINE BAN DETECTION
        const checkAuth = async () => {
            try {
                // Check if banned - improved detection (Multi-Signal)
                // Signal 1: Text Match
                const bodyText = await page.evaluate(() => document.body.innerText);
                const hasBanText = bodyText.includes('phone number is banned') || 
                                   bodyText.includes('banned from using WhatsApp');

                // Signal 2: Specific Selector
                const hasMainPane = await page.$('#pane-side');
                
                if (hasBanText && !hasMainPane && this.state !== SessionState.SUSPECTED_BAN) {
                     // QUARANTINE LOGIC
                     logger.warn('Potential Ban Detected. Entering QUARANTINE state for 30s verification.');
                     this.state = SessionState.SUSPECTED_BAN;
                        
                        // Wait 30s and re-verify
                        setTimeout(async () => {
                            logger.info('Verifying QUARANTINE state...');
                            try {
                                const newBodyText = await page.evaluate(() => document.body.innerText);
                                const confirmed = newBodyText.includes('phone number is banned') || 
                                                  newBodyText.includes('banned from using WhatsApp');
                                
                                if (confirmed) {
                                    this.state = SessionState.BANNED;
                                    logger.error('CRITICAL: Ban CONFIRMED after Quarantine.');
                                    // Dump HTML for audit (truncated)
                                    const html = await page.content();
                                    logger.error(`Ban HTML Snapshot: ${html.substring(0, 500)}...`);
                                    this.emit('banned');
                                } else {
                                    logger.info('Ban suspicion cleared. Resuming normal state.');
                                    this.state = SessionState.INIT; // Re-evaluate
                                }
                            } catch (e) { /* ignore */ }
                        }, 30000);
                        return;
                     }

                if ((await page.$('#pane-side')) && this.state !== SessionState.AUTHENTICATED) {
                    logger.info('Authenticated!');
                    this.state = SessionState.AUTHENTICATED;
                    this.qrCode = null;
                    this.failureCount = 0; // Reset circuit breaker
                }
            } catch (e) { /* ignore */ }
        };

        setInterval(async () => {
            if (this.state === SessionState.BANNED || this.state === SessionState.SUSPECTED_BAN) return;

            // Circuit Breaker logic
            if (this.state === SessionState.CIRCUIT_OPEN) {
                if (Date.now() - this.lastFailureTime > this.RESET_TIMEOUT) {
                    logger.info('Circuit Breaker resetting...');
                    this.state = SessionState.RECONNECTING;
                    this.failureCount = 0;
                    await page.reload();
                }
                return;
            }

            if (this.state === SessionState.AUTHENTICATED) {
                 const isAuth = await page.$('#pane-side');
                 if (!isAuth) {
                     this.state = SessionState.DISCONNECTED;
                     logger.warn('Session disconnected!');
                 }
            } else {
                await checkQR();
                await checkAuth();
            }
        }, 5000);
    }

    // Accessor for QR Code (Internal use only, masked in API)
    getQC() {
         return this.qrCode;
    }

    getStatus() {
        return {
            state: this.state,
            // SECURITY: Never return raw QR here anymore!
            qrAvailable: !!this.qrCode
        };
    }

    async sendMessage(phone: string, message: string): Promise<boolean> {
        if (this.state === SessionState.BANNED) throw new Error('Account BANNED');
        if (this.state === SessionState.CIRCUIT_OPEN) throw new Error('Circuit Open - Too many failures');
        
        if (this.state !== SessionState.AUTHENTICATED) {
            throw new Error('Session not authenticated');
        }
        
        try {
            const page = this.browserManager.getPage();
            // Stealth Navigation
             await page.goto(`https://web.whatsapp.com/send?phone=${phone}`, {
                 waitUntil: 'networkidle2'
            });
            
            const inputSelector = 'div[contenteditable="true"][data-tab="10"]';
            await page.waitForSelector(inputSelector, { timeout: 20000 });
            
            // Human-like typing using BrowserManager helper
            await this.browserManager.typeHumanLike(inputSelector, message);

            // Random pause before send
            await new Promise(r => setTimeout(r, Math.random() * 500 + 300));

            // Click send
            const sendButtonSelector = 'span[data-icon="send"]';
            await page.click(sendButtonSelector);
            
            // Wait for single tick at least to confirm send
            // await page.waitForSelector('span[data-icon="msg-check"]', { timeout: 5000 });

            this.failureCount = 0; 
            return true;
        } catch (error) {
            logger.error(`Failed to send message to ${phone}`, error);
            this.handleFailure();
            return false;
        }
    }

    private handleFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.failureCount >= this.FAILURE_THRESHOLD) {
            this.state = SessionState.CIRCUIT_OPEN;
            logger.error('Circuit Breaker TRIPPED. Pausing processing.');
        }
    }
}
