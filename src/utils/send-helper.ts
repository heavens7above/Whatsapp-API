import axios from 'axios';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
dotenv.config();

const DEFAULT_URL = 'https://whatsapp-api-production-974f.up.railway.app';
const { API_KEY, API_SECRET } = process.env;

// Smart argument parsing
let baseUrl = DEFAULT_URL;
let phone = '';
let message = '';

if (process.argv[2]?.startsWith('http')) {
    baseUrl = process.argv[2];
    phone = process.argv[3];
    message = process.argv[4];
} else {
    phone = process.argv[2];
    message = process.argv[3];
}

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

async function sendMessage() {
    if (!API_KEY || !API_SECRET) {
        console.error('Error: API_KEY and API_SECRET must be set in .env');
        process.exit(1);
    }

    if (!phone || !message) {
        console.log('\nUsage: npx ts-node src/utils/send-helper.ts <phone> "<message>"');
        console.log('Example: npx ts-node src/utils/send-helper.ts 917900261950 "Hello from helper! 🚀"\n');
        process.exit(1);
    }

    try {
        console.log(`Sending message to ${phone} via ${baseUrl}...`);
        
        const body = { phone, message };
        const { signature, timestamp } = signRequest(body, API_SECRET);

        const response = await axios.post(`${baseUrl}/send`, body, {
            headers: {
                'x-api-key': API_KEY,
                'x-signature': signature,
                'x-timestamp': timestamp
            }
        });

        console.log('✅ Message sent successfully!');
        console.log('Response:', response.data);

    } catch (error: any) {
        const errorMsg = error.response?.data?.error || error.response?.data || error.message;
        console.error('❌ Failed to send message:', errorMsg);
    }
}

sendMessage();
