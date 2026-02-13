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
            await page.goto(url, {
                 waitUntil: 'networkidle2',
                 timeout: 45000
            });
            
            // Wait for input to be ready
            const inputSelector = 'div[contenteditable="true"][data-tab="10"]';
            
            // Multiple validation steps to ensure we are actually in the chat
            try {
                // 1. Check for invalid number popup
                const invalidSelector = 'div[data-animate-modal-popup="true"]';
                const isInvalid = await page.waitForSelector(invalidSelector, { timeout: 8000 }).catch(() => null);
                if (isInvalid) {
                    const text = await page.evaluate((sel: string) => (document.querySelector(sel) as any)?.innerText, invalidSelector);
                    if (text?.toLowerCase().includes('invalid') || text?.toLowerCase().includes('incorrect')) {
                        throw new Error(`WhatsApp reports phone number as invalid: ${phone}`);
                    }
                }
            } catch (e: any) {
                if (e.message.includes('invalid')) throw e;
            }

            // 2. Wait for the actual message input
            await page.waitForSelector(inputSelector, { timeout: 30000 });
            await page.focus(inputSelector);
            
            // Random pause for realism
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
            
            // Human-like typing
            await this.browserManager.typeHumanLike(inputSelector, message);

            // Extra pause to let the "Send" button activate
            await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

            // USE ENTER KEY - Universal and more robust than button selectors
            logger.info('Pressing ENTER to send...');
            await page.keyboard.press('Enter');
            
            // Verification: Wait for the message bubble to actually appear in the page
            // We look for a selectable div containing our message text
            await new Promise(r => setTimeout(r, 2000));
            
            const messageSent = await page.evaluate((msg) => {
                const bubbles = Array.from(document.querySelectorAll('.message-out'));
                return bubbles.some(b => (b as HTMLElement).innerText.includes(msg));
            }, message);

            if (!messageSent) {
                logger.warn('Message bubble not detected after Enter. Trying visual click fallback...');
                const sendButton = await page.$('span[data-icon="send"]');
                if (sendButton) await sendButton.click();
                await new Promise(r => setTimeout(r, 3000));
            }

            this.failureCount = 0; 
            logger.info(`Message delivery sequence finished for ${phone}`);
            return true;
        } catch (error) {
            logger.error(`Failed to send message to ${phone}`, error);
            this.handleFailure();
            throw error; // Throw so BullMQ can handle retries
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
