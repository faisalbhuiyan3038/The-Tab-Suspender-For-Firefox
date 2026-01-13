const esbuild = require('esbuild');
const fs = require('fs-extra');
const { execSync } = require('child_process');
const path = require('path');

const DIST_DIR = './dist';

// JS files to bundle/minify
const jsFiles = [
    'background.js',
    'popup.js',
    'suspended.js',
    'data_management.js',
    'i18n-loader.js'  // Added i18n-loader
];

const htmlFiles = [
    'popup.html',
    'suspended.html',
    'data_management.html'
];

async function build() {
    // Clean dist folder
    console.log('🧹 Cleaning dist folder...');
    fs.removeSync(DIST_DIR);
    fs.mkdirSync(DIST_DIR, { recursive: true });

    // Minify JS files with esbuild
    console.log('📦 Minifying JavaScript...');
    for (const file of jsFiles) {
        if (fs.existsSync(file)) {
            await esbuild.build({
                entryPoints: [file],
                outfile: path.join(DIST_DIR, file),
                bundle: false,
                minify: true,
                minifyWhitespace: true,
                minifyIdentifiers: true,
                minifySyntax: true,
                target: ['chrome100'],
                format: 'esm',
            });
            console.log(`   ✓ ${file}`);
        } else {
            console.log(`   ⚠ ${file} not found, skipping...`);
        }
    }

    // Minify HTML
    console.log('📄 Minifying HTML...');
    htmlFiles.forEach(file => {
        if (fs.existsSync(file)) {
            execSync(`npx html-minifier-terser --collapse-whitespace --remove-comments --minify-css true --minify-js true -o ${path.join(DIST_DIR, file)} ${file}`);
            console.log(`   ✓ ${file}`);
        } else {
            console.log(`   ⚠ ${file} not found, skipping...`);
        }
    });

    // Copy manifest.json
    console.log('📋 Copying manifest.json...');
    fs.copySync('manifest.json', path.join(DIST_DIR, 'manifest.json'));
    console.log('   ✓ manifest.json');

    // Copy icons
    console.log('🖼️  Copying icons...');
    fs.copySync('icons', path.join(DIST_DIR, 'icons'));
    console.log('   ✓ icons/');

    // Copy _locales folder
    console.log('🌍 Copying locales...');
    if (fs.existsSync('_locales')) {
        fs.copySync('_locales', path.join(DIST_DIR, '_locales'));

        // Count locales
        const locales = fs.readdirSync('_locales').filter(f =>
            fs.statSync(path.join('_locales', f)).isDirectory()
        );
        console.log(`   ✓ _locales/ (${locales.length} languages)`);
    } else {
        console.log('   ⚠ _locales not found, skipping...');
    }

    // Build summary
    console.log('\n✅ Build complete!');
    console.log(`📁 Output: ${path.resolve(DIST_DIR)}`);

    // Show folder size
    const totalSize = getTotalSize(DIST_DIR);
    console.log(`📊 Total size: ${formatBytes(totalSize)}`);
}

// Helper: Calculate folder size
function getTotalSize(dir) {
    let size = 0;
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            size += getTotalSize(filePath);
        } else {
            size += stat.size;
        }
    }

    return size;
}

// Helper: Format bytes to readable string
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

build().catch((err) => {
    console.error('❌ Build failed:', err);
    process.exit(1);
});