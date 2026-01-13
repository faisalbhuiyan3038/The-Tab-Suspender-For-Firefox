const fs = require('fs-extra');
const path = require('path');

const HTML_FILES = [
    'popup.html',
    'suspended.html',
    'data_management.html'
];

const LOCALES_DIR = './_locales';

function updateHtmlFiles() {
    // Read English messages to get the key-message mapping
    const enPath = path.join(LOCALES_DIR, 'en', 'messages.json');

    if (!fs.existsSync(enPath)) {
        console.error('❌ Run "npm run extract-strings" first!');
        process.exit(1);
    }

    const messages = fs.readJsonSync(enPath);

    // Create a reverse map: message text -> key
    const textToKey = {};
    Object.entries(messages).forEach(([key, value]) => {
        textToKey[value.message] = key;
    });

    HTML_FILES.forEach(file => {
        if (!fs.existsSync(file)) {
            console.log(`⚠ ${file} not found, skipping...`);
            return;
        }

        console.log(`📄 Updating ${file}...`);
        let content = fs.readFileSync(file, 'utf8');
        let changeCount = 0;

        // Replace text in elements with data-i18n attribute
        Object.entries(textToKey).forEach(([text, key]) => {
            // Escape special regex characters
            const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Pattern for elements with text content
            const patterns = [
                // <tag>Text</tag> -> <tag data-i18n="key">Text</tag>
                {
                    find: new RegExp(`(<(?:h[1-6]|p|button|label|span|a|th|td|option))(>)(${escapedText})(</(?:h[1-6]|p|button|label|span|a|th|td|option)>)`, 'g'),
                    replace: `$1 data-i18n="${key}"$2$3$4`
                },
                // <title>Text</title> -> <title data-i18n="key">Text</title>
                {
                    find: new RegExp(`(<title)(>)(${escapedText})(</title>)`, 'g'),
                    replace: `$1 data-i18n="${key}"$2$3$4`
                },
                // placeholder="Text" -> placeholder="Text" data-i18n-placeholder="key"
                {
                    find: new RegExp(`(placeholder="${escapedText}")(?![^>]*data-i18n-placeholder)`, 'g'),
                    replace: `$1 data-i18n-placeholder="${key}"`
                },
            ];

            patterns.forEach(({ find, replace }) => {
                const before = content;
                content = content.replace(find, replace);
                if (content !== before) changeCount++;
            });
        });

        // Check if i18n-loader.js is already included
        if (!content.includes('i18n-loader.js')) {
            // Add before closing </body> tag
            content = content.replace(
                '</body>',
                '    <script src="i18n-loader.js"></script>\n</body>'
            );
            changeCount++;
        }

        // Save updated file
        fs.writeFileSync(file, content);
        console.log(`   ✓ Made ${changeCount} changes`);
    });

    console.log('\n✅ HTML files updated!');
}

updateHtmlFiles();