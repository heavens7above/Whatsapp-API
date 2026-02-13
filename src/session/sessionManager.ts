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
    private isSending = false;
    
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
                // Check multiple possible selectors for QR
                const qrCanvas = await page.$('canvas[aria-label="Scan me!"]');
                const qrContainer = await page.$('div[data-ref]');
                
                if (qrCanvas || qrContainer) {
                    const qrData = await page.evaluate(() => {
                        const selector = document.querySelector('div[data-ref]');
                        return selector ? selector.getAttribute('data-ref') : null;
                    });

                    if (qrData && qrData !== this.qrCode) {
                        this.qrCode = qrData;
                        this.state = SessionState.QR_PENDING;
                        logger.info(`QR Code detected: ${qrData.substring(0, 20)}...`);
                    }
                } else if (this.state === SessionState.QR_PENDING) {
                    // If we were pending but selectors disappeared, check if it's because we authenticated
                    const isAuthenticated = await page.$('#pane-side');
                    if (!isAuthenticated) {
                        logger.debug('QR selectors disappeared but not authenticated yet');
                    }
                }
            } catch (e) { 
                logger.debug('Error checking QR: ' + (e as Error).message);
            }
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

        const monitorInterval = setInterval(async () => {
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
                 // Skip monitor if we are actively sending a message (navigation hides pane)
                 if (this.isSending) return;

                 const isAuth = await page.$('#pane-side');
                 if (!isAuth) {
                     this.state = SessionState.DISCONNECTED;
                     logger.warn('Session disconnected!');
                 }
            } else {
                await checkQR();
                await checkAuth();
            }
        }, 3000); // Increased frequency to 3s for faster QR capture
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
        
        this.isSending = true;
        try {
            const page = this.browserManager.getPage();
            
            // Format phone for URL (ensure + prefix)
            const formattedPhone = phone.startsWith('+') ? phone.replace('+', '') : phone;
            const url = `https://web.whatsapp.com/send?phone=${formattedPhone}`;
            
            logger.info(`Navigating to chat: ${formattedPhone}`);
            // Faster navigation: don't wait for network idle as WhatsApp is heavy
            await page.goto(url, {
                 waitUntil: 'domcontentloaded',
                 timeout: 30000
            }).catch(e => logger.debug(`Navigation notice: ${e.message}`));
            
            const inputSelector = 'div[contenteditable="true"][data-tab="10"]';
            const invalidSelector = 'div[data-animate-modal-popup="true"]';

            // Wait for either the INPUT or the INVALID POPUP
            const result = await Promise.race([
                page.waitForSelector(inputSelector, { timeout: 20000 }).then(() => 'ready'),
                page.waitForSelector(invalidSelector, { timeout: 10000 }).then(() => 'invalid')
            ]).catch(() => 'timeout');

            if (result === 'invalid') {
                const text = await page.evaluate((sel: string) => (document.querySelector(sel) as any)?.innerText, invalidSelector);
                if (text?.toLowerCase().includes('invalid') || text?.toLowerCase().includes('incorrect')) {
                    throw new Error(`WhatsApp reports phone number as invalid: ${phone}`);
                }
            } else if (result === 'timeout') {
                throw new Error(`Timeout waiting for chat interface for ${phone}`);
            }

            // Small pause for stability
            await new Promise(r => setTimeout(r, 500));
            await page.focus(inputSelector);
            
            // Human-like typing with reduced delay for latency
            await this.browserManager.typeHumanLike(inputSelector, message);

            // Let "Send" button activate
            await new Promise(r => setTimeout(r, 200));

            // USE ENTER KEY
            logger.info('Pressing ENTER to send...');
            await page.keyboard.press('Enter');
            
            // Verification: Use waitForFunction for more reliability
            try {
                await page.waitForFunction((msg) => {
                    const bubbles = Array.from(document.querySelectorAll('.message-out'));
                    return bubbles.some(b => (b as HTMLElement).innerText.includes(msg));
                }, { timeout: 5000 }, message);
                logger.info(`Message delivery verified for ${phone}`);
            } catch (e) {
                logger.warn('Bubble verification timed out. Trying manual click fallback...');
                const sendButton = await page.$('[aria-label="Send"], span[data-icon="send"]');
                if (sendButton) {
                    await sendButton.click();
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            this.failureCount = 0; 
            return true;
        } catch (error) {
            logger.error(`Failed to send message to ${phone}`, error);
            this.handleFailure();
            throw error; 
        } finally {
            this.isSending = false;
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
