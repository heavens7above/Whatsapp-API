// src/api/server.ts
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { authMiddleware, verifyHmacSignature, adminMiddleware } from './middleware';
import { SessionManager } from '../session/sessionManager';
import { JobQueue } from '../queue/jobQueue';
import logger from '../utils/logger';
import crypto from 'crypto';

export const createServer = (sessionManager: SessionManager, jobQueue: JobQueue) => {
    const app = express();

    // Trust proxy for Railway/production (CRITICAL for rate limiting)
    const isProduction = process.env.NODE_ENV?.toLowerCase() === 'production' || !!process.env.RAILWAY_STATIC_URL;
    if (isProduction) {
        logger.info('Production/Railway environment detected: Enabling trust proxy (1 hop)');
        // Trust exactly 1 hop (the Railway proxy). 
        // This is more secure than 'true' and satisfies express-rate-limit validations.
        app.set('trust proxy', 1);
    }
    
    // Log verification for debugging
    logger.debug(`Express trust proxy setting: ${app.get('trust proxy')}`);

    // Security & Parsing Middleware
    app.use(helmet());
    app.use(cors());
    app.use(express.json());

    // Rate Limiting - ensure this is created AFTER trust proxy is set
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, 
        max: 500, // Increased for admin access
        message: 'Too many requests, please try again later.',
        validate: { 
            trustProxy: false, // Silence the permissive trust proxy warning
            xForwardedForHeader: false 
        }
    });
    app.use(limiter);

    // Routes
    app.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    const secureMiddleware = [authMiddleware];
    if (process.env.API_SECRET) {
        secureMiddleware.push(verifyHmacSignature);
    }

    // --- Admin Endpoints (QR Token Management) ---
    
    // Generate QR Token (Admin Only)
    // POST /admin/generate-qr-token
    app.post('/admin/generate-qr-token', ...secureMiddleware, adminMiddleware, async (req, res) => {
        const redis = jobQueue.getRedisConnection();
        const ip = req.ip || 'unknown';
        
        // Rate Limit Binding: IP + Admin Key Hash (to prevent bypassing IP limit if key is shared/stolen)
        const adminKeyHash = crypto.createHash('sha256').update(req.headers['x-admin-key'] as string || 'none').digest('hex');
        const rateLimitKey = `wa:admin:ratelimit:${adminKeyHash}:${ip}`;
        
        // Strict Rate Limit: 5 per hour
        const currentUsage = await redis.incr(rateLimitKey);
        if (currentUsage === 1) {
            await redis.expire(rateLimitKey, 3600);
        }
        if (currentUsage > 5) {
             logger.warn(`Admin QR Rate Limit exceeded for IP ${ip}`);
             return res.status(429).json({ error: 'Too many QR generation attempts. Try again in an hour.' });
        }

        // Simple polling/wait for QR if browser just started
        let qrCode = sessionManager.getQC();
        if (!qrCode) {
            logger.info('QR not immediately available, waiting 5s...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            qrCode = sessionManager.getQC();
        }

        if (!qrCode) {
            return res.status(404).json({ error: 'No QR code available to share. Ensure the browser is at the login screen.' });
        }

        // Generate short-lived token
        const token = crypto.randomBytes(32).toString('hex');
        
        // Single Active Token Policy: Invalidate previous
        const oldToken = await redis.get('wa:qr-token:active');
        if (oldToken) {
            await redis.del(`qr-token:${oldToken}`);
        }

        // Store new token
        await redis.set('wa:qr-token:active', token, 'EX', 60);
        await redis.set(`qr-token:${token}`, 'valid', 'EX', 60);

        res.json({ 
            qrAccessToken: token, 
            expiresInSeconds: 60,
            url: `/qr?token=${token}` // Hint for client
        });
    });

    // Access QR (Token required)
    // GET /qr?token=...
    app.get('/qr', async (req, res) => {
        const token = req.query.token as string;
        if (!token) return res.status(400).send('Missing token');

        const redis = jobQueue.getRedisConnection();
        const valid = await redis.get(`qr-token:${token}`);
        
        if (!valid) {
             return res.status(403).send('Invalid or expired QR token');
        }

        // Burn the token (One-time use)
        await redis.del(`qr-token:${token}`);
        await redis.del('wa:qr-token:active');

        const qrCode = sessionManager.getQC();
        if (!qrCode) {
            return res.status(404).send('QR code expired or session active');
        }

        // Return QR (Raw string or generate image if needed. Returning JSON for simplicity, client renders)
        // Or better: Return a simple HTML page with QR rendered or just the string. 
        // Instructions said: "Return QR image/data"
        res.json({ qr: qrCode });
    });

    // --- Standard Endpoints ---

    app.get('/session-status', ...secureMiddleware, adminMiddleware, async (req, res) => {
        const status = sessionManager.getStatus();
        res.json(status); 
        // Note: `status` object no longer contains 'qr' string, only 'qrAvailable' boolean
    });

    app.post('/send', ...secureMiddleware, async (req, res) => {
        const { phone, message, idempotencyKey } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Missing phone or message' });
        }
        
        if (!/^\+?[1-9]\d{7,14}$/.test(phone)) {
            logger.warn(`Invalid phone number format: ${phone}`);
            return res.status(400).json({ error: 'Invalid phone number format. Use E.164.' });
        }

        const jobId = idempotencyKey || crypto.createHash('sha256').update(phone + message + Date.now()).digest('hex');

        try {
            await jobQueue.add(jobId, {
                phone, 
                message,
                idempotencyKey: jobId
            });
            res.status(202).json({ status: 'queued', jobId: jobId });
        } catch (err: any) {
            logger.error('Failed to enqueue job', err);
            res.status(500).json({ error: err.message || 'Internal Server Error' });
        }
    });

    app.post('/send-otp', ...secureMiddleware, async (req, res) => {
        const { phone, otp, idempotencyKey } = req.body;
        if (!phone || !otp) return res.status(400).json({ error: 'Missing phone or otp' });

        const message = `Your OTP is: ${otp}`;
        const jobId = idempotencyKey || crypto.createHash('sha256').update(phone + otp + 'otp').digest('hex');
        
         try {
            await jobQueue.add(jobId, {
                phone, 
                message,
                idempotencyKey: jobId
            });
            res.status(202).json({ status: 'queued', jobId: jobId });
        } catch (err: any) {
             logger.error('Failed to enqueue OTP job', err);
             res.status(500).json({ error: err.message || 'Internal Server Error' });
        }
    });

    return app;
};
