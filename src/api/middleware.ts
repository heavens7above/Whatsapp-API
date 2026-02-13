// src/api/middleware.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger';

// HMAC Signature Validation
export const verifyHmacSignature = (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers['x-signature'] as string;
    const timestamp = req.headers['x-timestamp'] as string;
    const apiSecret = process.env.API_SECRET; // Different from API_KEY, used for signing

    if (!apiSecret) {
        logger.error('API_SECRET not configured');
        return res.status(500).json({ error: 'Service misconfiguration' });
    }

    if (!signature || !timestamp) {
        return res.status(401).json({ error: 'Missing signature or timestamp' });
    }

    // 1. Replay Protection (Timestamp check)
    const now = Date.now();
    const reqTime = parseInt(timestamp, 10);
    
    // Check for future timestamps (Clock Skew attack)
    if (reqTime > now + 5000) { // Allow 5s skew max
        logger.warn(`Rejected future timestamp request from ${req.ip}`);
        return res.status(400).json({ error: 'Invalid timestamp (future)' });
    }

    if (isNaN(reqTime) || Math.abs(now - reqTime) > 30000) { // 30 seconds window
        logger.warn(`Rejected stale request. Time diff: ${now - reqTime}ms`);
        return res.status(400).json({ error: 'Request expired' });
    }

    // 2. Verify Signature
    // Format: HMAC_SHA256(timestamp + "." + canonical_json(body), secret)
    // Canonical JSON: Sort keys recursively to ensure consistent signature
    const canonicalize = (obj: any): any => {
        if (typeof obj !== 'object' || obj === null) {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(canonicalize);
        }
        return Object.keys(obj).sort().reduce((result: any, key) => {
            result[key] = canonicalize(obj[key]);
            return result;
        }, {});
    };

    const bodyString = JSON.stringify(canonicalize(req.body));
    const payload = `${timestamp}.${bodyString}`;
    const expectedSignature = crypto
        .createHmac('sha256', apiSecret)
        .update(payload)
        .digest('hex');

    // Constant time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        logger.warn(`Invalid signature from ${req.ip}`);
        return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
};

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.API_KEY;

    if (!validKey) {
        logger.error('API_KEY not configured in environment');
        return res.status(500).json({ error: 'Service misconfiguration' });
    }

    if (!apiKey || apiKey !== validKey) {
        logger.warn(`Invalid API key attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
};

export const adminMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // Stricter check for admin actions (like getting QR)
    // For now, reuses API Key but logically could require a separate Admin Key or IP whitelist
    const apiKey = req.headers['x-admin-key'];
    const validAdminKey = process.env.ADMIN_KEY;

    if (validAdminKey && apiKey !== validAdminKey) {
        logger.warn(`Invalid Admin key attempt from ${req.ip}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    // If ADMIN_KEY not set, fallback to standard auth or deny? 
    // Secure default: Deny if not configured, or reuse Auth if explicit.
    // Let's reuse Auth if ADMIN_KEY is not set, but warn.
    if (!validAdminKey) {
       return authMiddleware(req, res, next);
    }

    next();
};
