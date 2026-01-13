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
    'data_management.js'
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
                minifyIdentifiers: true,  // This creates a, b, c, d...
                minifySyntax: true,
                target: ['chrome100'],
                format: 'esm',
            });
            console.log(`   ✓ ${file}`);
        }
    }

    // Minify HTML
    console.log('📄 Minifying HTML...');
    htmlFiles.forEach(file => {
        if (fs.existsSync(file)) {
            execSync(`npx html-minifier-terser --collapse-whitespace --remove-comments --minify-css true --minify-js true -o ${path.join(DIST_DIR, file)} ${file}`);
            console.log(`   ✓ ${file}`);
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

    console.log('\n✅ Build complete!');
}

build().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
});