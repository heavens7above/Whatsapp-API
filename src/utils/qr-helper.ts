import axios from 'axios';
import qrcode from 'qrcode-terminal';
import * as dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.argv[2] || 'https://whatsapp-api-production-974f.up.railway.app';
const API_KEY = process.env.API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;

async function getQRCode() {
    if (!API_KEY || !ADMIN_KEY) {
        console.error('Error: API_KEY and ADMIN_KEY must be set in .env');
        process.exit(1);
    }

    try {
        console.log(`Connecting to ${BASE_URL}...`);
        
        // 1. Generate Token
        const tokenResponse = await axios.post(`${BASE_URL}/admin/generate-qr-token`, {}, {
            headers: {
                'x-api-key': API_KEY,
                'x-admin-key': ADMIN_KEY
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
