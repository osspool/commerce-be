// src/config/sections/google.config.js
import { warnIfMissing } from '../utils.js'; // Use warning instead of hard requirement

// Warn if not present, but do not block app start
warnIfMissing("GOOGLE_CLOUD_KEY_ENCODED");

let googleServiceAccount = null;
const encodedKey = process.env.GOOGLE_CLOUD_KEY_ENCODED;

if (encodedKey) {
    try {
        const jsonString = Buffer.from(encodedKey, 'base64').toString('utf8');
        const parsed = JSON.parse(jsonString);

        // Basic validation of parsed JSON structure
        if (parsed && typeof parsed === 'object' && parsed.private_key && parsed.client_email) {
            googleServiceAccount = parsed;
            console.log("Google Service Account credentials loaded.");
        } else {
            console.warn("GOOGLE_CLOUD_KEY_ENCODED is present but decoded JSON appears invalid or incomplete. Google integrations will be disabled.");
        }
    } catch (error) {
        console.warn("Failed to decode or parse GOOGLE_CLOUD_KEY_ENCODED. Google integrations will be disabled.", error);
    }
} else {
    console.warn("GOOGLE_CLOUD_KEY_ENCODED not provided. Google integrations will be disabled.");
}

export default {
    google: {
        serviceAccount: googleServiceAccount, // Null when missing/invalid
    }
};