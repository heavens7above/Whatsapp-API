// src/queue/jobQueue.ts
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import logger from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Define Job Type
interface MessageJob {
    phone: string;
    message: string;
    idempotencyKey?: string;
}

export class JobQueue {
    private queue: Queue;
    private worker: Worker;
    private connection: IORedis;
    private isPaused = false;

    constructor(jobProcessor: (job: MessageJob) => Promise<boolean>) {
        this.connection = new IORedis(REDIS_URL, {
            maxRetriesPerRequest: null
        });

        // Initialize Queue
        this.queue = new Queue('whatsapp-messages', { 
            connection: this.connection as any,
            defaultJobOptions: {
                removeOnComplete: 1000,
                removeOnFail: 5000,
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000
                }
            }
        });

        // Initialize Worker
        this.worker = new Worker('whatsapp-messages', async (job) => {
            if (this.isPaused) {
                // If paused internally (e.g. restart), throw delay error to retry later?
                // Or better: worker.pause() handles this.
                // We shouldn't receive jobs if worker.pause() is called.
                return; 
            }

            logger.info(`Processing job ${job.id}: Sending to ${job.data.phone}`);
            
            // Check Daily Cap (Redis)
            // Dynamic Daily Cap (Ramp-up)
            const today = new Date().toISOString().split('T')[0];
            const dailyKey = `wa:daily-cap:${today}`;
            
            // Get or Set Start Date for Ramp-up calculation
            let startDateStr = await this.connection.get('wa:start-date');
            if (!startDateStr) {
                startDateStr = today;
                await this.connection.set('wa:start-date', startDateStr);
            }
            
            const startDate = new Date(startDateStr);
            const now = new Date();
            const daysSinceStart = Math.max(0, Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
            
            // Formula: Cap = min(100 + (days * 50), 2000)
            const dynamicLimit = Math.min(100 + (daysSinceStart * 50), 2000);
            
            const currentCount = await this.connection.incr(dailyKey);
            // Set expiry for daily key (24h) if new
            if (currentCount === 1) await this.connection.expire(dailyKey, 86400);

            if (currentCount > dynamicLimit) {
                 logger.warn(`Daily cap reached (${currentCount}/${dynamicLimit}). Rejecting job.`);
                 throw new Error('Daily cap reached');
            }

            return await jobProcessor(job.data);
        }, { 
            connection: this.connection as any,
            concurrency: 1, // STRICT SERIAL PROCESSING
            limiter: {
                max: 10, // Max 10 messages
                duration: 60000 // Per minute
            }
        });

        this.worker.on('completed', (job) => {
            logger.info(`Job ${job.id} completed!`);
        });

        this.worker.on('failed', (job, err) => {
            logger.error(`Job ${job?.id} failed: ${err.message}`);
        });
        
        logger.info('Redis JobQueue initialized with BullMQ');
    }

    async add(id: string, data: MessageJob): Promise<void> {
        if (this.isPaused) throw new Error('Queue is paused (Service Maintenance/Banned)');

        const jobId = data.idempotencyKey || id;
        
        await this.queue.add('send-message', data, {
            jobId: jobId, // Deduplication key
            timestamp: Date.now()
        });
        logger.info(`Job added to queue: ${jobId}`);
    }
    
    async getStats() {
        return await this.queue.getJobCounts();
    }

    async pause() {
        this.isPaused = true;
        await this.worker.pause();
        logger.warn('Job Queue PAUSED.');
    }

    async resume() {
        if (this.isPaused) {
            this.isPaused = false;
            await this.worker.resume();
            logger.info('Job Queue RESUMED.');
        }
    }

    async close() {
        await this.worker.close();
        await this.queue.close();
        await this.connection.quit();
    }
    
    // Accessor for Admin/QR Tokens and Ban State
    getRedisConnection() {
        return this.connection;
    }

    async isBanned(): Promise<boolean> {
        const banned = await this.connection.get('wa:banned');
        return banned === 'true';
    }

    async setBanned(status: boolean) {
        if (status) {
            await this.connection.set('wa:banned', 'true');
        } else {
            await this.connection.del('wa:banned');
        }
    }
}
