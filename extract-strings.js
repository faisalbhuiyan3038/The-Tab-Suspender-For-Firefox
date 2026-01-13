const fs = require('fs-extra');
const path = require('path');

const HTML_FILES = [
    'popup.html',
    'suspended.html',
    'data_management.html'
];

// Helper to create a valid key from text
function createKey(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 4)
        .map((word, index) =>
            index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join('');
}

function extractStrings() {
    const strings = {};
    const usedKeys = new Set();

    HTML_FILES.forEach(file => {
        if (!fs.existsSync(file)) {
            console.log(`⚠ ${file} not found, skipping...`);
            return;
        }

        console.log(`📄 Scanning ${file}...`);
        const content = fs.readFileSync(file, 'utf8');

        // Patterns to match text content
        const patterns = [
            { regex: /<title>([^<]+)<\/title>/g, type: 'title' },
            { regex: /<h[1-6][^>]*>([^<]+)<\/h[1-6]>/g, type: 'heading' },
            { regex: /<p[^>]*>([^<]+)<\/p>/g, type: 'paragraph' },
            { regex: /<button[^>]*>([^<]+)<\/button>/g, type: 'button' },
            { regex: /<label[^>]*>([^<]+)<\/label>/g, type: 'label' },
            { regex: /<span[^>]*>([^<]+)<\/span>/g, type: 'span' },
            { regex: /<a[^>]*>([^<]+)<\/a>/g, type: 'link' },
            { regex: /<th[^>]*>([^<]+)<\/th>/g, type: 'tableHeader' },
            { regex: /<td[^>]*>([^<]+)<\/td>/g, type: 'tableCell' },
            { regex: /<option[^>]*>([^<]+)<\/option>/g, type: 'option' },
            { regex: /placeholder="([^"]+)"/g, type: 'placeholder' },
            { regex: /title="([^"]+)"/g, type: 'titleAttr' },
            { regex: /aria-label="([^"]+)"/g, type: 'ariaLabel' },
        ];

        patterns.forEach(({ regex, type }) => {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const text = match[1].trim();

                // Skip empty, numbers only, or very short strings
                if (!text || text.length < 2 || /^[\s\d\W]+$/.test(text)) {
                    continue;
                }

                // Skip if already exists
                if (Object.values(strings).some(s => s.message === text)) {
                    continue;
                }

                // Create unique key
                let key = createKey(text);
                if (!key) key = type;

                let uniqueKey = key;
                let counter = 1;
                while (usedKeys.has(uniqueKey)) {
                    uniqueKey = `${key}${counter}`;
                    counter++;
                }
                usedKeys.add(uniqueKey);

                strings[uniqueKey] = {
                    message: text,
                    description: `${type} in ${file}`
                };
            }
        });
    });

    // Create _locales/en folder
    const enDir = './_locales/en';
    fs.ensureDirSync(enDir);

    // Save as messages.json
    fs.writeJsonSync(path.join(enDir, 'messages.json'), strings, { spaces: 2 });

    console.log(`\n✅ Extracted ${Object.keys(strings).length} strings`);
    console.log(`📁 Saved to: ${path.resolve(enDir, 'messages.json')}`);

    // Show extracted strings
    console.log('\n📋 Extracted keys:');
    Object.entries(strings).forEach(([key, value]) => {
        console.log(`   ${key}: "${value.message}"`);
    });

    return strings;
}

extractStrings();