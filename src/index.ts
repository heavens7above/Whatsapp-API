import dotenv from 'dotenv';
dotenv.config();

import { BrowserManager } from './browser/browserManager';
import { SessionManager } from './session/sessionManager';
import { createServer } from './api/server';
import { JobQueue } from './queue/jobQueue';
import { createChildLogger, drainLogger } from './utils/logger';

const log = createChildLogger('bootstrap');
const PORT = process.env.PORT || 3000;

async function bootstrap() {
    log.info('Starting Hardened WhatsApp Automation Service', {
        nodeVersion: process.version,
        pid: process.pid,
        env: process.env.NODE_ENV || 'development',
        port: PORT,
    });

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
                log.info('Redis connection verified.');
                return;
            } catch (err: any) {
                log.warn(`Redis connection failed (Attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`, { error: err });
                if (i === retries - 1) {
                    log.error('CRITICAL: Redis unreachable after all retries. Service exiting (Fail-Closed).', { error: err });
                    await drainLogger();
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
        log.error('CRITICAL: Account BANNED. Pausing Queue and halting operations.');
        await jobQueue.setBanned(true);
        await jobQueue.pause();
    });

    // Handle Memory Watchdog Restart Request
    browserManager.on('restart_required', async () => {
        log.warn('Memory Watchdog triggered restart. Pausing queue...');
        await jobQueue.pause();

        log.info('Queue paused. Restarting browser...');
        await browserManager.restartBrowser();

        log.info('Browser restarted. Resuming queue...');
        await jobQueue.resume();
    });

    // Start Services
    if (await jobQueue.isBanned()) {
        log.error('SERVICE LOCKED: Account is BANNED. Manual intervention required to clear Redis key "wa:banned".');
        await drainLogger();
        return;
    }

    await sessionManager.init();

    const server = app.listen(PORT, () => {
        log.info(`API Server listening`, { port: PORT });
    });

    // ─── Graceful Shutdown ──────────────────────────────────────────────────
    const shutdown = async (signal: string) => {
        log.warn(`${signal} received — beginning graceful shutdown...`);

        server.close(async () => {
            log.info('HTTP server closed. Draining queue and browser...');

            try {
                await jobQueue.close();
                log.info('Job queue closed.');
            } catch (err) {
                log.error('Error closing job queue', { error: err });
            }

            try {
                await browserManager.close();
                log.info('Browser closed.');
            } catch (err) {
                log.error('Error closing browser', { error: err });
            }

            log.info('Shutdown complete. Goodbye.');
            await drainLogger();
            process.exit(0);
        });

        // Force-kill after 30s if graceful close hangs
        setTimeout(async () => {
            log.error('Graceful shutdown timed out (30s). Force-exiting.');
            await drainLogger();
            process.exit(1);
        }, 30000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // Catch truly unhandled promise rejections (last resort)
    process.on('unhandledRejection', async (reason) => {
        log.error('Unhandled Promise Rejection', { error: reason instanceof Error ? reason : String(reason) });
    });

    process.on('uncaughtException', async (err) => {
        log.error('Uncaught Exception — shutting down', { error: err });
        await drainLogger();
        process.exit(1);
    });
}

bootstrap().catch(async (err) => {
    // Use the root logger here in case child isn't set up yet
    const { default: rootLog } = await import('./utils/logger');
    rootLog.error('Fatal Service Error during bootstrap', { error: err });
    await drainLogger();
    process.exit(1);
});
