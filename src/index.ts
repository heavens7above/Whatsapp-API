import dotenv from 'dotenv';
dotenv.config();

import { BrowserManager } from './browser/browserManager';
import { SessionManager, SessionState } from './session/sessionManager';
import { createServer } from './api/server';
import { JobQueue } from './queue/jobQueue';
import logger from './utils/logger';

const PORT = process.env.PORT || 3000;

async function bootstrap() {
    logger.info('Starting Hardened WhatsApp Automation Service...');

    // 1. Initialize Browser Manager
    const browserManager = new BrowserManager();

    // 2. Initialize Session Manager
    const sessionManager = new SessionManager(browserManager);

    // 3. Initialize Job Queue
    const jobQueue = new JobQueue(async (jobData) => {
        return await sessionManager.sendMessage(jobData.phone, jobData.message);
    });

    // CRITICAL: Redis Fail-Closed Check with Graceful Backoff
    const connectRedisWithBackoff = async (retries = 5, delay = 1000) => {
        for (let i = 0; i < retries; i++) {
            try {
                const redis = jobQueue.getRedisConnection();
                await redis.ping();
                logger.info('Redis connection verified.');
                return;
            } catch (err: any) {
                logger.warn(`Redis connection failed (Attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`);
                if (i === retries - 1) {
                    logger.error('CRITICAL: Redis unreachable after retries. Service exiting (Fail-Closed).', err);
                    process.exit(1);
                }
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Exponential backoff
            }
        }
    };

    await connectRedisWithBackoff();

    // 4. Initialize API Server
    const app = createServer(sessionManager, jobQueue);

    // --- Coordination Logic ---

    // Handle Ban Event
    sessionManager.on('banned', async () => {
        logger.error('CRITICAL: Account BANNED. Pausing Queue and halting operations.');
        await jobQueue.setBanned(true); // Persist Ban
        await jobQueue.pause();
        // Send alert webhook? (Future)
    });

    // Handle Memory Watchdog Restart Request
    browserManager.on('restart_required', async () => {
        logger.warn('Memory Watchdog requested restart. Pausing queue...');
        await jobQueue.pause();
        
        logger.info('Queue paused. Restarting browser...');
        await browserManager.restartBrowser();
        
        logger.info('Browser restarted. Resuming queue...');
        await jobQueue.resume();
    });

    // Start Services
    if (await jobQueue.isBanned()) {
        logger.error('SERVICE LOCKED: Account is BANNED. Manual intervention required to clear Redis key "wa:banned".');
        // We do NOT init sessionManager to prevent further connection attempts
        return; 
    }

    await sessionManager.init();

    const server = app.listen(PORT, () => {
        logger.info(`API Server running on port ${PORT}`);
    });

    // Graceful Shutdown
    const shutdown = async (signal: string) => {
        logger.info(`${signal} received. Shutting down...`);
        server.close(async () => {
            logger.info('HTTP server closed.');
            await jobQueue.close();
            await browserManager.close();
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
    logger.error('Fatal Service Error', err);
    process.exit(1);
});
