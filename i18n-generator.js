const fs = require('fs-extra');
const path = require('path');
const translate = require('google-translate-api-x');

const LOCALES_DIR = './_locales';

// Fixed language codes for google-translate-api-x
const TARGET_LANGUAGES = [
    { code: 'es', googleCode: 'es', name: 'Spanish' },
    { code: 'fr', googleCode: 'fr', name: 'French' },
    { code: 'de', googleCode: 'de', name: 'German' },
    { code: 'pt_BR', googleCode: 'pt', name: 'Portuguese' },
    { code: 'it', googleCode: 'it', name: 'Italian' },
    { code: 'ja', googleCode: 'ja', name: 'Japanese' },
    { code: 'ko', googleCode: 'ko', name: 'Korean' },
    { code: 'zh_CN', googleCode: 'zh-CN', name: 'Chinese Simplified' }, // Fixed!
    { code: 'zh_TW', googleCode: 'zh-TW', name: 'Chinese Traditional' },
    { code: 'hi', googleCode: 'hi', name: 'Hindi' },
    { code: 'ar', googleCode: 'ar', name: 'Arabic' },
    { code: 'ru', googleCode: 'ru', name: 'Russian' },
];

async function translateText(text, targetLangCode) {
    try {
        const result = await translate(text, {
            from: 'en',
            to: targetLangCode
        });
        return result.text;
    } catch (error) {
        console.error(`   ⚠ Translation error: ${error.message}`);
        return text; // Return original if failed
    }
}

async function generateLocales() {
    console.log('🌍 Starting translation...\n');

    // Read English messages
    const enPath = path.join(LOCALES_DIR, 'en', 'messages.json');

    if (!fs.existsSync(enPath)) {
        console.error('❌ English messages.json not found!');
        console.error('   Run "npm run extract-strings" first.');
        process.exit(1);
    }

    const englishStrings = fs.readJsonSync(enPath);
    const totalStrings = Object.keys(englishStrings).length;

    console.log(`📖 Found ${totalStrings} strings to translate\n`);

    // Translate to each language
    for (const lang of TARGET_LANGUAGES) {
        console.log(`⏳ Translating to ${lang.name} (${lang.code})...`);

        const translated = {};
        let count = 0;

        for (const [key, value] of Object.entries(englishStrings)) {
            count++;
            process.stdout.write(`   ${count}/${totalStrings}\r`);

            const translatedMessage = await translateText(value.message, lang.googleCode);

            translated[key] = {
                message: translatedMessage,
                description: value.description
            };

            // Delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 150));
        }

        // Save translated messages
        const langDir = path.join(LOCALES_DIR, lang.code);
        fs.ensureDirSync(langDir);
        fs.writeJsonSync(path.join(langDir, 'messages.json'), translated, { spaces: 2 });

        console.log(`✓ Created ${lang.code}/messages.json`);

        // Delay between languages
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('\n✅ Translation complete!');
    console.log(`📁 Locales saved in: ${path.resolve(LOCALES_DIR)}`);
}

generateLocales().catch(console.error);