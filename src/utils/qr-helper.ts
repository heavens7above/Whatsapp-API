import axios from 'axios';
import qrcode from 'qrcode-terminal';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
dotenv.config();

const BASE_URL = process.argv[2] || 'https://whatsapp-api-production-974f.up.railway.app';
const { API_KEY, ADMIN_KEY, API_SECRET } = process.env;

// Helper to canonicalize for HMAC
const canonicalize = (obj: any): any => {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(canonicalize);
    return Object.keys(obj).sort().reduce((result: any, key) => {
        result[key] = canonicalize(obj[key]);
        return result;
    }, {});
};

const signRequest = (body: any, secret: string) => {
    const timestamp = Date.now().toString();
    const bodyString = JSON.stringify(canonicalize(body));
    const payload = `${timestamp}.${bodyString}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return { signature, timestamp };
};

async function getQRCode() {
    if (!API_KEY || !ADMIN_KEY || !API_SECRET) {
        console.error('Error: API_KEY, ADMIN_KEY, and API_SECRET must be set in .env');
        process.exit(1);
    }

    try {
        console.log(`Connecting to ${BASE_URL}...`);
        
        // 1. Generate Token with HMAC Signature
        const body = {};
        const { signature, timestamp } = signRequest(body, API_SECRET);

        const tokenResponse = await axios.post(`${BASE_URL}/admin/generate-qr-token`, body, {
            headers: {
                'x-api-key': API_KEY,
                'x-admin-key': ADMIN_KEY,
                'x-signature': signature,
                'x-timestamp': timestamp
            }
        });

        const { qrAccessToken } = tokenResponse.data;
        console.log('Token generated safely. Fetching QR code data...');

        // 2. Fetch QR
        const qrResponse = await axios.get(`${BASE_URL}/qr?token=${qrAccessToken}`);
        const { qr } = qrResponse.data;

        if (!qr) {
            console.log('No QR code available. Is the session already active?');
            return;
        }

        console.log('\nScan this code with your WhatsApp app:\n');
        qrcode.generate(qr, { small: true });

    } catch (error: any) {
        console.error('Failed to get QR code:', error.response?.data || error.message);
    }
}

getQRCode();
